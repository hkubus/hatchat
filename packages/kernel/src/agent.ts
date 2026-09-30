import type {
  ApprovalBroker,
  ApprovalDecision,
  AuditLog,
  ChatMessage,
  ChatRequest,
  ExecutionHost,
  FinishReason,
  KernelEvent,
  Logger,
  MessageMeta,
  NormalizedError,
  Part,
  Provider,
  ProviderCapabilities,
  ReasoningEffort,
  SecretStore,
  ToolContext,
  ToolPolicy,
  ToolSpec,
  Usage,
} from "@hat/core";
import { DEFAULT_TOOL_POLICY, addUsage, decideTool, newId, normalizeError } from "@hat/core";
import { estimateTextTokens, fitToContext, messageBudget } from "./context.js";
import { repairTranscript } from "./transcript.js";
import type { ProviderRegistry, ToolRegistry } from "./registries.js";

export interface AgentTurnInput {
  sessionId: string;
  history: ChatMessage[];
  model: string;
  signal: AbortSignal;
  /** When present, appended as a new user message; when omitted, continues from history. */
  userText?: string;
  /** Explicit user message parts (e.g. text + image attachments). */
  userParts?: Part[];
  toolPolicy?: ToolPolicy;
  reasoningEffort?: ReasoningEffort;
  /** Tools withheld from the model for this run (e.g. no nested sub-agents). */
  excludeTools?: string[];
  /** When false, messages are not reported through `onMessage` (ephemeral runs). Default true. */
  persist?: boolean;
  /** Receives out-of-band events that tools push while running (see `ToolContext.emit`). */
  emit?(event: KernelEvent): void;
  /** Per-conversation instructions from the user, appended to the system prompt. */
  instructions?: string;
  /** Sampling temperature; unset leaves the provider default. */
  temperature?: number;
  /** Cap on reply tokens per model call; unset leaves the provider default. */
  maxTokens?: number;
  /** Metadata stored on the new user message (e.g. marking a synthetic "continue"). */
  userMeta?: MessageMeta;
}

export interface KernelDeps {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  resolveHost(sessionId: string): Promise<ExecutionHost>;
  approval: ApprovalBroker;
  secrets: SecretStore;
  audit: AuditLog;
  logger: Logger;
  /**
   * Store a message the turn produced, under `parentId`: the turn's previous
   * message, or the end of its history for the first. A turn keeps to its own
   * chain, so its messages stay together even if the conversation's active
   * branch moves while it runs.
   */
  onMessage?(sessionId: string, message: ChatMessage, parentId: string | null): void;
  /** Resolve an attachment id to base64 data, for vision models. */
  resolveImage?(attachmentId: string): Promise<{ data: string; mime: string } | undefined>;
  /**
   * Base system prompt prepended to every turn. Kept out of stored history (it
   * is derived each turn) and merged into the first user message for providers
   * that do not support a native system role.
   */
  systemPrompt?: string;
  /**
   * Extra, per-session context appended to the system prompt each turn (e.g.
   * saved memories). Keep it stable between turns: it sits in the cached prefix.
   */
  systemContext?(sessionId: string): string | undefined | Promise<string | undefined>;
  /** Resolve a user-attached document to its text, inlined for the model. */
  resolveFile?(attachmentId: string): Promise<{ text: string } | undefined>;
  maxToolIterations?: number;
  maxToolResultChars?: number;
  /** Retries for a retryable provider error that arrives before any output. Default 3. */
  maxRetries?: number;
  /** First retry delay; doubles each attempt. Default 1000ms. */
  retryBaseDelayMs?: number;
  /**
   * How long a tool may take to return once its turn is stopped before the
   * call is abandoned. Default 3000ms.
   */
  stopGraceMs?: number;
}

/** What one model call produced, after any retries. */
interface ModelResult {
  text: string;
  reasoning: string;
  calls: ToolCallRecord[];
  usage?: Usage;
  finish: FinishReason;
}

interface ToolCallRecord {
  id: string;
  name: string;
  args: unknown;
}

/**
 * The agent loop: stream a provider response, and while it asks for tools,
 * gate them through approval and execute them on the resolved ExecutionHost,
 * feeding results back until the model stops calling tools.
 */
export class Agent {
  constructor(private readonly deps: KernelDeps) {}
  private readonly hostCache = new Map<string, Promise<ExecutionHost>>();

  private async resolveHostCached(sessionId: string): Promise<ExecutionHost> {
    // One workspace.ensure per session instead of one per tool call. Entries
    // live as long as the server and are cheap (a channel and a session id),
    // but a host whose runner has gone away is replaced, not reused: nothing
    // sent through it would ever be answered.
    const cached = this.hostCache.get(sessionId);
    if (cached) {
      const host = await cached.catch(() => undefined);
      if (host && !host.closed) return host;
      if (this.hostCache.get(sessionId) === cached) this.hostCache.delete(sessionId);
    }
    const fresh = this.deps.resolveHost(sessionId);
    this.hostCache.set(sessionId, fresh);
    // Drop on failure so the next call retries.
    fresh.catch(() => {
      if (this.hostCache.get(sessionId) === fresh) this.hostCache.delete(sessionId);
    });
    return fresh;
  }

  async *run(input: AgentTurnInput): AsyncGenerator<KernelEvent> {
    const turnId = newId("turn");
    const persist = input.persist !== false;
    // Each stored message goes under the one before it, starting from the end
    // of the history this turn was given.
    let parentId: string | null = input.history.at(-1)?.id ?? null;
    const onMessage = (message: ChatMessage): void => {
      if (!persist) return;
      this.deps.onMessage?.(input.sessionId, cloneMessage(message), parentId);
      parentId = message.id;
    };
    yield { type: "turn.start", turnId };

    const messages: ChatMessage[] = input.history.map(cloneMessage);
    if (input.userParts && input.userParts.length > 0) {
      const userMessage: ChatMessage = {
        id: newId("msg"),
        role: "user",
        parts: input.userParts.map((part) => structuredClone(part)),
        createdAt: Date.now(),
        ...(input.userMeta ? { meta: { ...input.userMeta } } : {}),
      };
      messages.push(userMessage);
      onMessage(userMessage);
    } else if (input.userText !== undefined) {
      const userMessage: ChatMessage = {
        id: newId("msg"),
        role: "user",
        parts: [{ type: "text", text: input.userText }],
        createdAt: Date.now(),
        ...(input.userMeta ? { meta: { ...input.userMeta } } : {}),
      };
      messages.push(userMessage);
      onMessage(userMessage);
    }

    await this.resolveAttachments(messages);

    const { provider, model } = this.deps.providers.resolve(input.model);
    const caps = provider.capabilities(model);
    const extra = await this.systemContextFor(input.sessionId);
    const instructions = input.instructions?.trim()
      ? `Instructions for this conversation, from the user:\n${input.instructions.trim()}`
      : undefined;
    const systemPrompt = [this.deps.systemPrompt?.trim(), extra?.trim(), instructions]
      .filter(Boolean)
      .join("\n\n");
    const tools = caps.toolCalls ? this.deps.tools.toToolSpecs(input.excludeTools) : undefined;

    // The request is rebuilt from `messages` before every model call: the
    // system prompt is applied to a copy (so it never reaches stored history)
    // and the copy is fitted to the context window, which a tool-heavy turn
    // can outgrow halfway through.
    let lastContextNote = "";
    const prepare = (list: ChatMessage[], withTools: ToolSpec[] | undefined) => {
      let fitted = repairTranscript(list);
      let note: string | undefined;
      if (caps.contextWindow) {
        const fixed =
          estimateTextTokens(systemPrompt) + (withTools ? estimateTextTokens(JSON.stringify(withTools)) : 0);
        const fit = fitToContext(
          fitted,
          messageBudget({ contextWindow: caps.contextWindow, maxOutputTokens: input.maxTokens, fixedTokens: fixed }),
        );
        fitted = fit.messages;
        const trimmed = [
          fit.elidedToolResults > 0 ? `elided ${fit.elidedToolResults} older tool outputs` : "",
          fit.droppedMessages > 0 ? `left out the ${fit.droppedMessages} oldest messages` : "",
        ].filter(Boolean);
        if (trimmed.length > 0) {
          note = `This conversation is near the model's context window, so this request ${trimmed.join(" and ")}. Stored history is unchanged.`;
        }
      }
      const out = toProviderMessages(fitted, caps);
      if (systemPrompt) applySystemPrompt(out, systemPrompt, caps);
      // Only speak up when the trimming changes, not on every iteration.
      const warning = note && note !== lastContextNote ? note : undefined;
      if (note) lastContextNote = note;
      return { messages: out, warning };
    };
    const requestFor = (list: ChatMessage[], withTools: ToolSpec[] | undefined) => {
      const prepared = prepare(list, withTools);
      const request: ChatRequest = {
        model,
        messages: prepared.messages,
        tools: withTools,
        // Stable per-session key so providers can route same-prefix requests
        // to the same prompt-cache shard (see `prompt_cache_key`).
        cacheKey: input.sessionId,
        temperature: input.temperature,
        maxTokens: input.maxTokens,
        // Only meaningful for providers that advertise the knob; "off" is the
        // provider's own default, so we leave the field unset.
        reasoningEffort:
          input.reasoningEffort && input.reasoningEffort !== "off" && caps.reasoningEffort
            ? input.reasoningEffort
            : undefined,
      };
      return { request, warning: prepared.warning };
    };
    const policy: ToolPolicy = input.toolPolicy ?? {
      ...DEFAULT_TOOL_POLICY,
      maxIterations: this.deps.maxToolIterations ?? DEFAULT_TOOL_POLICY.maxIterations,
    };
    const callCounts = new Map<string, number>();
    let failureStreak = 0;
    let guardTripped = false;
    // How the loop actually ended. A model can spend its whole tool budget and
    // never write an answer, leaving the turn dangling on a tool result; both
    // flags let the closing step below kick in.
    let endedNaturally = false;
    let endedOnError = false;

    for (let iteration = 0; iteration < policy.maxIterations; iteration++) {
      const assistantId = newId("msg");
      const assistant: ChatMessage = {
        id: assistantId,
        role: "assistant",
        parts: [],
        createdAt: Date.now(),
        meta: { provider: provider.id, model },
      };
      yield { type: "message.start", messageId: assistantId, role: "assistant" };

      const { request, warning } = requestFor(messages, tools);
      if (warning) yield { type: "warning", message: warning };
      const { text, reasoning, calls, usage, finish } = yield* this.callModel(
        provider,
        request,
        input.signal,
        assistantId,
      );

      if (reasoning) {
        assistant.parts.push({ type: "reasoning", text: reasoning });
      }
      if (text) {
        assistant.parts.push({ type: "text", text });
      }
      for (const call of calls) {
        assistant.parts.push({ type: "tool_call", id: call.id, name: call.name, args: call.args });
      }
      assistant.meta = {
        ...assistant.meta,
        ...(usage ? { usage } : {}),
        finishReason: finish,
        // Stopped by the user mid-reply: what streamed is kept, marked unfinished.
        ...(input.signal.aborted ? { incomplete: true } : {}),
      };
      messages.push(assistant);
      // A call that failed before producing anything leaves nothing to store:
      // an empty reply would only be replayed to the provider on every turn.
      if (assistant.parts.length > 0) onMessage(assistant);
      yield { type: "message.done", messageId: assistantId, finishReason: finish };

      if (finish === "error" || calls.length === 0) {
        endedOnError = finish === "error";
        endedNaturally = finish !== "error";
        break;
      }

      // A round counts toward the failure streak only when every call in it
      // failed for a reason the model controls. Parallel calls that fail
      // together are one mistake, not several, and a missing runner or a
      // user denial is not the model looping.
      let roundFailed = true;
      let roundCounted = false;
      for (const call of calls) {
        yield {
          type: "tool.call",
          messageId: assistantId,
          callId: call.id,
          name: call.name,
          args: call.args,
        };

        const signature = `${call.name}:${stableStringify(call.args)}`;
        const seen = callCounts.get(signature) ?? 0;

        let result: ToolOutcome;
        if (seen >= policy.maxDuplicateCalls) {
          result = {
            parts: [
              {
                type: "text",
                text: `Loop guard: "${call.name}" was called ${seen} times with identical arguments. Stopping.`,
              },
            ],
            isError: true,
          };
          guardTripped = true;
        } else {
          callCounts.set(signature, seen + 1);
          result = input.excludeTools?.includes(call.name)
            ? { parts: [{ type: "text", text: `Tool "${call.name}" is not available here.` }], isError: true }
            : await this.executeTool(call, input.sessionId, input.signal, policy, assistantId, input.emit);
        }

        if (!result.isError) roundFailed = false;
        else if (!result.external) roundCounted = true;

        const { parts, isError } = result;
        yield { type: "tool.result", callId: call.id, name: call.name, parts, isError };
        const toolMessage: ChatMessage = {
          id: newId("msg"),
          role: "tool",
          parts: [{ type: "tool_result", id: call.id, name: call.name, content: parts, isError }],
          createdAt: Date.now(),
        };
        messages.push(toolMessage);
        onMessage(toolMessage);
      }

      failureStreak = roundFailed && roundCounted ? failureStreak + 1 : roundFailed ? failureStreak : 0;
      if (failureStreak >= policy.maxConsecutiveFailures) guardTripped = true;
      // Stopped during the round: every call has its result stored, and a
      // model call now would only fail on the aborted signal.
      if (input.signal.aborted) break;
      if (guardTripped) break;
    }

    if (!endedNaturally && !endedOnError && caps.toolCalls && !input.signal.aborted) {
      yield* this.closeWithAnswer(
        input,
        provider,
        model,
        messages,
        (list) => requestFor(list, undefined),
        guardTripped ? "guard" : "iterations",
        onMessage,
      );
    }

    yield { type: "turn.done", turnId };
  }

  /**
   * The model ran out of tool budget (or tripped a loop guard) without ever
   * writing an answer, so the turn would otherwise end on a bare tool result.
   * Ask once more with tools withheld: the model can only produce prose, and
   * the turn always closes with a summary of what was gathered.
   */
  private async *closeWithAnswer(
    input: AgentTurnInput,
    provider: Provider,
    model: string,
    messages: ChatMessage[],
    requestFor: (list: ChatMessage[]) => { request: ChatRequest; warning?: string },
    reason: "iterations" | "guard",
    onMessage: (message: ChatMessage) => void,
  ): AsyncGenerator<KernelEvent> {
    yield {
      type: "warning",
      message:
        reason === "guard"
          ? "Tool loop guard tripped; asking the model to answer with what it has."
          : "Tool-call limit reached for this turn; asking the model to answer with what it has.",
    };

    const assistantId = newId("msg");
    yield { type: "message.start", messageId: assistantId, role: "assistant" };

    // The nudge is transient: it shapes this one call but is not persisted.
    const nudge: ChatMessage = {
      id: newId("msg"),
      role: "user",
      parts: [
        {
          type: "text",
          text:
            "You have reached the tool-call limit for this turn. Do not call any more tools. " +
            "Answer my last request now using the information you already have, and say briefly " +
            "what you could not determine.",
        },
      ],
      createdAt: Date.now(),
      meta: { synthetic: "close" },
    };
    const { request, warning } = requestFor([...messages, nudge]);
    if (warning) yield { type: "warning", message: warning };
    const { text, reasoning, usage, finish } = yield* this.callModel(
      provider,
      request,
      input.signal,
      assistantId,
    );

    const parts: Part[] = [];
    if (reasoning) parts.push({ type: "reasoning", text: reasoning });
    if (text) parts.push({ type: "text", text });
    if (parts.length > 0) {
      const assistant: ChatMessage = {
        id: assistantId,
        role: "assistant",
        parts,
        createdAt: Date.now(),
        meta: { provider: provider.id, model, ...(usage ? { usage } : {}), finishReason: finish },
      };
      messages.push(assistant);
      onMessage(assistant);
    }
    yield { type: "message.done", messageId: assistantId, finishReason: finish };
  }

  /**
   * Stream one model call into kernel events. A retryable failure (rate limit,
   * overloaded upstream, dropped connection) that arrives before the model has
   * produced anything is retried with backoff; once output has streamed, a
   * retry would duplicate it on screen, so the error surfaces instead.
   */
  private async *callModel(
    provider: Provider,
    request: ChatRequest,
    signal: AbortSignal,
    assistantId: string,
  ): AsyncGenerator<KernelEvent, ModelResult> {
    const maxRetries = this.deps.maxRetries ?? 3;
    let usage: Usage | undefined;
    for (let attempt = 0; ; attempt++) {
      const result: ModelResult = { text: "", reasoning: "", calls: [], finish: "stop" };
      let failure: NormalizedError | undefined;
      let produced = false;
      try {
        for await (const event of provider.chat(request, signal)) {
          switch (event.type) {
            case "text.delta":
              produced = true;
              result.text += event.text;
              yield { type: "text.delta", messageId: assistantId, text: event.text };
              break;
            case "reasoning.delta":
              produced = true;
              result.reasoning += event.text;
              yield { type: "reasoning.delta", messageId: assistantId, text: event.text };
              break;
            case "toolcall":
              produced = true;
              result.calls.push(event.call);
              break;
            case "usage":
              usage = addUsage(usage, event.usage);
              yield { type: "usage", usage: event.usage };
              break;
            case "done":
              result.finish = event.finishReason;
              break;
            case "error":
              failure = event.error;
              break;
          }
        }
      } catch (error) {
        failure = normalizeError(error, "provider_error");
        this.deps.logger.error("provider stream failed", failure);
      }
      result.usage = usage;
      if (!failure) return result;

      if (!failure.retryable || produced || signal.aborted || attempt >= maxRetries) {
        // A stop the user asked for is not a failure to report.
        if (!signal.aborted) yield { type: "error", error: failure };
        result.finish = "error";
        return result;
      }
      const delay = retryDelay(attempt, this.deps.retryBaseDelayMs ?? 1_000, failure.retryAfterMs);
      yield {
        type: "warning",
        message: `${firstLine(failure.message)} — retrying in ${Math.max(1, Math.round(delay / 1000))}s (attempt ${attempt + 2} of ${maxRetries + 1}).`,
      };
      if (!(await sleep(delay, signal))) {
        // Cancelled while waiting: the turn is over, not failed.
        return result;
      }
    }
  }

  private async systemContextFor(sessionId: string): Promise<string | undefined> {
    if (!this.deps.systemContext) return undefined;
    try {
      return await this.deps.systemContext(sessionId);
    } catch (error) {
      this.deps.logger.warn("system context failed", normalizeError(error, "system_context"));
      return undefined;
    }
  }

  /**
   * Swap attachment references for what the model can read: image bytes for
   * vision, and the text of documents the user attached. Artifacts the
   * assistant produced (file parts in tool results) stay as descriptions.
   */
  private async resolveAttachments(messages: ChatMessage[]): Promise<void> {
    for (const message of messages) {
      for (let i = 0; i < message.parts.length; i++) {
        const part = message.parts[i];
        if (part.type === "image" && part.source.kind === "attachment" && this.deps.resolveImage) {
          const resolved = await this.deps.resolveImage(part.source.id);
          message.parts[i] = resolved
            ? { type: "image", source: { kind: "data", data: resolved.data, mime: resolved.mime } }
            : { type: "text", text: `[attached image ${part.source.id} is unavailable]` };
        } else if (part.type === "file" && message.role === "user" && this.deps.resolveFile) {
          const resolved = await this.deps.resolveFile(part.id);
          if (!resolved) continue;
          message.parts[i] = {
            type: "text",
            text: `<file name=${JSON.stringify(part.name)} type=${JSON.stringify(part.mime)}>\n${resolved.text}\n</file>`,
          };
        }
      }
    }
  }

  private async executeTool(
    call: ToolCallRecord,
    sessionId: string,
    signal: AbortSignal,
    policy: ToolPolicy,
    messageId?: string,
    emit?: (event: KernelEvent) => void,
  ): Promise<ToolOutcome> {
    // Once the turn is stopped nothing new starts. The call still gets a
    // result, so the stored history answers every tool call.
    if (signal.aborted) return notRun(call.name);
    const tool = this.deps.tools.get(call.name);
    if (!tool) {
      return { parts: [{ type: "text", text: `Unknown tool: ${call.name}` }], isError: true };
    }

    const audit = (entry: {
      decision?: ApprovalDecision;
      ok?: boolean;
      detail?: string;
    }): void | Promise<void> =>
      this.deps.audit.record({
        at: Date.now(),
        sessionId,
        tool: tool.name,
        args: call.args,
        callId: call.id,
        ...entry,
      });

    const decision = decideTool(tool, call.args, policy);
    if (decision === "deny") {
      await audit({ decision: "deny", ok: false, detail: "blocked by policy" });
      return {
        parts: [{ type: "text", text: `Tool "${tool.name}" is blocked by the session policy.` }],
        isError: true,
        external: true,
      };
    }

    if (decision === "ask") {
      let answer: ApprovalDecision = "deny";
      try {
        answer = await this.deps.approval.request(
          {
            callId: call.id,
            tool: tool.name,
            args: call.args,
            sessionId,
            summary: describeCall(tool.name, call.args),
          },
          signal,
        );
      } catch (error) {
        this.deps.logger.warn("approval request failed", normalizeError(error, "approval"));
      }
      // Stopping the turn abandons the question; the user did not say no.
      if (signal.aborted) {
        await audit({ ok: false, detail: "turn stopped" });
        return notRun(tool.name);
      }
      if (answer === "deny") {
        await audit({ decision: answer, ok: false, detail: "denied" });
        return {
          parts: [{ type: "text", text: `Tool "${tool.name}" was denied by the user.` }],
          isError: true,
          external: true,
        };
      }
      await audit({ decision: answer });
    }

    try {
      // NOTE: approval mode `auto` is intentionally preserved — this host is
      // still gated by per-tool requiresApproval + loop guards when callers
      // choose `ask`/`allowlist`/`deny` per session.
      let host: ExecutionHost;
      try {
        host = await this.resolveHostCached(sessionId);
      } catch (error) {
        const normalized = normalizeError(error, "host_unavailable");
        await audit({ ok: false, detail: normalized.message });
        return {
          parts: [{ type: "text", text: `Tool "${tool.name}" failed: ${normalized.message}` }],
          isError: true,
          external: true,
        };
      }
      const ctx: ToolContext = {
        sessionId,
        host,
        secrets: this.deps.secrets,
        approval: this.deps.approval,
        audit: this.deps.audit,
        logger: this.deps.logger,
        signal,
        callId: call.id,
        messageId,
        emit,
      };
      const args = tool.schema ? tool.schema.parse(call.args) : call.args;
      const output = await settleOrAbandon(tool.execute(args, ctx), signal, this.deps.stopGraceMs ?? 3_000);
      const parts = truncateParts(output, this.deps.maxToolResultChars ?? 20_000);
      await audit({ ok: true });
      return { parts, isError: false };
    } catch (error) {
      const normalized = normalizeError(error, "tool_error");
      await audit({ ok: false, detail: normalized.message });
      return {
        parts: [{ type: "text", text: `Tool "${tool.name}" failed: ${normalized.message}` }],
        isError: true,
      };
    }
  }
}

interface ToolOutcome {
  parts: Part[];
  isError: boolean;
  /** Failed for a reason outside the model's control (no runner, denied, blocked). */
  external?: boolean;
}

/** The outcome of a call that never ran because its turn was stopped. */
function notRun(name: string): ToolOutcome {
  return {
    parts: [{ type: "text", text: `Tool "${name}" was not run: the turn was stopped.` }],
    isError: true,
    external: true,
  };
}

/**
 * Insert the base system prompt without persisting it. Providers that lack a
 * native system role get it merged ahead of the first user message; providers
 * that refuse a system prompt entirely are left alone.
 */
function applySystemPrompt(
  messages: ChatMessage[],
  prompt: string,
  caps: ProviderCapabilities,
): void {
  if (caps.systemPrompt === "none") return;
  const text = `${prompt}\n\nCurrent date: ${new Date().toISOString().slice(0, 10)} (UTC).`;

  if (caps.systemPrompt === "merge-first-user") {
    const firstUser = messages.find((message) => message.role === "user");
    if (firstUser) {
      firstUser.parts = [{ type: "text", text }, ...firstUser.parts];
      return;
    }
  }

  messages.unshift({
    id: newId("msg"),
    role: "system",
    parts: [{ type: "text", text }],
    createdAt: Date.now(),
  });
}

function toProviderMessages(
  messages: ChatMessage[],
  caps: ProviderCapabilities,
): ChatMessage[] {
  return messages.map((message) => {
    const clone = cloneMessage(message);
    if (!caps.vision) {
      clone.parts = clone.parts.map((part) =>
        part.type === "image"
          ? {
              type: "text" as const,
              text: "[image omitted: the selected model does not support vision]",
            }
          : part,
      );
    }
    return clone;
  });
}

/** Exponential backoff with jitter, deferring to a server-requested delay. */
function retryDelay(attempt: number, baseMs: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) return Math.min(retryAfterMs, 60_000);
  const exponential = baseMs * 2 ** attempt;
  return Math.min(30_000, exponential + Math.floor(Math.random() * baseMs * 0.25));
}

/**
 * Wait for a tool call, but not forever once its turn is stopped. A tool that
 * ignores its signal (a hung MCP server, a runner that stopped answering)
 * would otherwise keep the turn, and with it the conversation, busy. Tools
 * that do honour the signal get `graceMs` to hand back what they have.
 */
function settleOrAbandon<T>(work: Promise<T>, signal: AbortSignal, graceMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      timer = setTimeout(() => reject(new Error("the turn was stopped")), graceMs);
    };
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error);
      },
    );
  });
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function firstLine(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function describeCall(name: string, args: unknown): string {
  if (args && typeof args === "object" && "command" in args) {
    return String((args as { command: unknown }).command);
  }
  const json = JSON.stringify(args);
  return json.length > 200 ? `${json.slice(0, 200)}…` : json;
}

function truncateParts(parts: Part[], maxChars: number): Part[] {
  let remaining = maxChars;
  const out: Part[] = [];
  for (const part of parts) {
    if (part.type !== "text") {
      out.push(part);
      continue;
    }
    if (remaining <= 0) {
      out.push({ type: "text", text: "\n…[output truncated]" });
      break;
    }
    if (part.text.length <= remaining) {
      out.push(part);
      remaining -= part.text.length;
    } else {
      out.push({ type: "text", text: `${part.text.slice(0, remaining)}\n…[output truncated]` });
      remaining = 0;
      break;
    }
  }
  return out;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return structuredClone(message);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}
