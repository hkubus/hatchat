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
  Part,
  Provider,
  ProviderCapabilities,
  ReasoningEffort,
  SecretStore,
  ToolContext,
  ToolPolicy,
  Usage,
} from "@hat/core";
import { DEFAULT_TOOL_POLICY, addUsage, decideTool, newId, normalizeError } from "@hat/core";
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
}

export interface KernelDeps {
  providers: ProviderRegistry;
  tools: ToolRegistry;
  resolveHost(sessionId: string): Promise<ExecutionHost>;
  approval: ApprovalBroker;
  secrets: SecretStore;
  audit: AuditLog;
  logger: Logger;
  onMessage?(sessionId: string, message: ChatMessage): void;
  /** Resolve an attachment id to base64 data, for vision models. */
  resolveImage?(attachmentId: string): Promise<{ data: string; mime: string } | undefined>;
  /**
   * Base system prompt prepended to every turn. Kept out of stored history (it
   * is derived each turn) and merged into the first user message for providers
   * that do not support a native system role.
   */
  systemPrompt?: string;
  maxToolIterations?: number;
  maxToolResultChars?: number;
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

  private resolveHostCached(sessionId: string): Promise<ExecutionHost> {
    // One workspace.ensure per turn instead of one per tool call.
    let cached = this.hostCache.get(sessionId);
    if (!cached) {
      cached = this.deps.resolveHost(sessionId);
      this.hostCache.set(sessionId, cached);
      // Drop on failure so the next call retries; drop after the turn
      // via clearHostCache? Kept per Agent instance (per server) — entries
      // are cheap (a channel + workspace) and keyed by session.
      cached.catch(() => this.hostCache.delete(sessionId));
    }
    return cached;
  }

  async *run(input: AgentTurnInput): AsyncGenerator<KernelEvent> {
    const turnId = newId("turn");
    yield { type: "turn.start", turnId };

    const messages: ChatMessage[] = input.history.map(cloneMessage);
    if (input.userParts && input.userParts.length > 0) {
      const userMessage: ChatMessage = {
        id: newId("msg"),
        role: "user",
        parts: input.userParts.map((part) => structuredClone(part)),
        createdAt: Date.now(),
      };
      messages.push(userMessage);
      this.deps.onMessage?.(input.sessionId, cloneMessage(userMessage));
    } else if (input.userText !== undefined) {
      const userMessage: ChatMessage = {
        id: newId("msg"),
        role: "user",
        parts: [{ type: "text", text: input.userText }],
        createdAt: Date.now(),
      };
      messages.push(userMessage);
      this.deps.onMessage?.(input.sessionId, cloneMessage(userMessage));
    }

    await this.resolveAttachmentImages(messages);

    const { provider, model } = this.deps.providers.resolve(input.model);
    const caps = provider.capabilities(model);
    if (this.deps.systemPrompt?.trim()) {
      applySystemPrompt(messages, this.deps.systemPrompt, caps);
    }
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

      const calls: ToolCallRecord[] = [];
      let text = "";
      let reasoning = "";
      let usage: Usage | undefined;
      let finish: FinishReason = "stop";

      const request: ChatRequest = {
        model,
        messages: toProviderMessages(messages, caps),
        tools: caps.toolCalls ? this.deps.tools.toToolSpecs() : undefined,
        // Only meaningful for providers that advertise the knob; "off" is the
        // provider's own default, so we leave the field unset.
        reasoningEffort:
          input.reasoningEffort && input.reasoningEffort !== "off" && caps.reasoningEffort
            ? input.reasoningEffort
            : undefined,
      };

      try {
        for await (const event of provider.chat(request, input.signal)) {
          switch (event.type) {
            case "text.delta":
              text += event.text;
              yield { type: "text.delta", messageId: assistantId, text: event.text };
              break;
            case "reasoning.delta":
              reasoning += event.text;
              yield { type: "reasoning.delta", messageId: assistantId, text: event.text };
              break;
            case "toolcall":
              calls.push(event.call);
              break;
            case "usage":
              usage = addUsage(usage, event.usage);
              yield { type: "usage", usage: event.usage };
              break;
            case "done":
              finish = event.finishReason;
              break;
            case "error":
              yield { type: "error", error: event.error };
              finish = "error";
              break;
          }
        }
      } catch (error) {
        const normalized = normalizeError(error, "provider_error");
        this.deps.logger.error("provider stream failed", normalized);
        yield { type: "error", error: normalized };
        finish = "error";
      }

      if (reasoning) {
        assistant.parts.push({ type: "reasoning", text: reasoning });
      }
      if (text) {
        assistant.parts.push({ type: "text", text });
      }
      for (const call of calls) {
        assistant.parts.push({ type: "tool_call", id: call.id, name: call.name, args: call.args });
      }
      if (usage) {
        assistant.meta = { ...assistant.meta, usage };
      }
      messages.push(assistant);
      this.deps.onMessage?.(input.sessionId, cloneMessage(assistant));
      yield { type: "message.done", messageId: assistantId, finishReason: finish };

      if (finish === "error" || calls.length === 0) {
        endedOnError = finish === "error";
        endedNaturally = finish !== "error";
        break;
      }

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

        let result: { parts: Part[]; isError: boolean };
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
          result = await this.executeTool(call, input.sessionId, input.signal, policy);
        }

        failureStreak = result.isError ? failureStreak + 1 : 0;
        if (failureStreak >= policy.maxConsecutiveFailures) guardTripped = true;

        const { parts, isError } = result;
        yield { type: "tool.result", callId: call.id, name: call.name, parts, isError };
        const toolMessage: ChatMessage = {
          id: newId("msg"),
          role: "tool",
          parts: [{ type: "tool_result", id: call.id, name: call.name, content: parts, isError }],
          createdAt: Date.now(),
        };
        messages.push(toolMessage);
        this.deps.onMessage?.(input.sessionId, cloneMessage(toolMessage));
      }

      if (guardTripped) break;
    }

    if (!endedNaturally && !endedOnError && caps.toolCalls) {
      yield* this.closeWithAnswer(
        input,
        provider,
        model,
        caps,
        messages,
        guardTripped ? "guard" : "iterations",
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
    caps: ProviderCapabilities,
    messages: ChatMessage[],
    reason: "iterations" | "guard",
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
    };
    const request: ChatRequest = {
      model,
      messages: toProviderMessages([...messages, nudge], caps),
      reasoningEffort:
        input.reasoningEffort && input.reasoningEffort !== "off" && caps.reasoningEffort
          ? input.reasoningEffort
          : undefined,
    };

    let text = "";
    let reasoning = "";
    let usage: Usage | undefined;
    try {
      for await (const event of provider.chat(request, input.signal)) {
        switch (event.type) {
          case "text.delta":
            text += event.text;
            yield { type: "text.delta", messageId: assistantId, text: event.text };
            break;
          case "reasoning.delta":
            reasoning += event.text;
            yield { type: "reasoning.delta", messageId: assistantId, text: event.text };
            break;
          case "usage":
            usage = addUsage(usage, event.usage);
            yield { type: "usage", usage: event.usage };
            break;
          case "error":
            yield { type: "error", error: event.error };
            break;
          default:
            break;
        }
      }
    } catch (error) {
      this.deps.logger.error("closing answer failed", normalizeError(error, "provider_error"));
    }

    const parts: Part[] = [];
    if (reasoning) parts.push({ type: "reasoning", text: reasoning });
    if (text) parts.push({ type: "text", text });
    if (parts.length > 0) {
      const assistant: ChatMessage = {
        id: assistantId,
        role: "assistant",
        parts,
        createdAt: Date.now(),
        meta: { provider: provider.id, model, ...(usage ? { usage } : {}) },
      };
      messages.push(assistant);
      this.deps.onMessage?.(input.sessionId, cloneMessage(assistant));
    }
    yield { type: "message.done", messageId: assistantId, finishReason: "stop" };
  }

  private async resolveAttachmentImages(messages: ChatMessage[]): Promise<void> {
    if (!this.deps.resolveImage) return;
    for (const message of messages) {
      for (let i = 0; i < message.parts.length; i++) {
        const part = message.parts[i];
        if (part.type !== "image" || part.source.kind !== "attachment") continue;
        const resolved = await this.deps.resolveImage(part.source.id);
        message.parts[i] = resolved
          ? { type: "image", source: { kind: "data", data: resolved.data, mime: resolved.mime } }
          : { type: "text", text: `[attached image ${part.source.id} is unavailable]` };
      }
    }
  }

  private async executeTool(
    call: ToolCallRecord,
    sessionId: string,
    signal: AbortSignal,
    policy: ToolPolicy,
  ): Promise<{ parts: Part[]; isError: boolean }> {
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
      if (answer === "deny") {
        await audit({ decision: answer, ok: false, detail: "denied" });
        return {
          parts: [{ type: "text", text: `Tool "${tool.name}" was denied by the user.` }],
          isError: true,
        };
      }
      await audit({ decision: answer });
    }

    try {
      // NOTE: approval mode `auto` is intentionally preserved — this host is
      // still gated by per-tool requiresApproval + loop guards when callers
      // choose `ask`/`allowlist`/`deny` per session.
      const host = await this.resolveHostCached(sessionId);
      const ctx: ToolContext = {
        sessionId,
        host,
        secrets: this.deps.secrets,
        approval: this.deps.approval,
        audit: this.deps.audit,
        logger: this.deps.logger,
        signal,
      };
      const args = tool.schema ? tool.schema.parse(call.args) : call.args;
      const parts = truncateParts(await tool.execute(args, ctx), this.deps.maxToolResultChars ?? 20_000);
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
