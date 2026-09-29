import type { KernelEvent, ModelInfo, Part, ReasoningEffort, Usage } from "@hat/core";
import { REASONING_EFFORTS, addUsage, sumUsage, usageTotal } from "@hat/core";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Connect from "./Connect";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  RegenerateIcon,
} from "./icons";
import MessageImage from "./MessageImage";
import ModelPicker from "./ModelPicker";
import Settings from "./Settings";
import Sidebar from "./Sidebar";
import * as api from "./api";
import type { PathNode, PluginDescriptor, ProviderStatus, RunnerSummary, SessionSummary } from "./api";
import { capSummary, capTags, contextTag } from "./capTags";
import CreatorIcon from "./CreatorIcon";
import { creatorName, creatorSlug } from "./creators";
import { formatTokens, usageDetail } from "./tokens";
import type { HatConfig } from "./runtime";
import { isNativeShell, loadConfig } from "./runtime";

const Markdown = lazy(() => import("./Markdown"));

interface UiTool {
  callId: string;
  name: string;
  args: unknown;
  approval: "requested" | "approved" | "denied" | null;
  result?: string;
  isError?: boolean;
  running: boolean;
}

interface UiBranch {
  index: number;
  count: number;
  ids: string[];
}

interface UiMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning: string;
  tools: UiTool[];
  branch?: UiBranch;
  images: { src: string; attachmentId?: string }[];
  usage?: Usage;
}

interface PendingAttachment {
  file: File;
  previewUrl: string;
}

const DEFAULT_MODEL = "fake/fake-agent";

/** How close to the bottom the scroller has to be to keep following the stream. */
const NEAR_BOTTOM_PX = 72;

function textOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function reasoningOf(parts: Part[]): string {
  return parts
    .filter((p): p is Extract<Part, { type: "reasoning" }> => p.type === "reasoning")
    .map((p) => p.text)
    .join("");
}

function toolsOf(parts: Part[]): UiTool[] {
  return parts
    .filter((p): p is Extract<Part, { type: "tool_call" }> => p.type === "tool_call")
    .map((p) => ({
      callId: p.id,
      name: p.name,
      args: p.args,
      approval: null,
      running: true,
    }));
}

function imagesOf(parts: Part[]): { src: string; attachmentId?: string }[] {
  const out: { src: string; attachmentId?: string }[] = [];
  for (const part of parts) {
    if (part.type !== "image") continue;
    if (part.source.kind === "attachment") {
      out.push({ src: "", attachmentId: part.source.id });
    } else if (part.source.kind === "url") {
      out.push({ src: part.source.url });
    } else {
      out.push({ src: `data:${part.source.mime};base64,${part.source.data}` });
    }
  }
  return out;
}

/**
 * The one-word state shown at the end of a tool call's summary line.
 * Running and plain success are deliberately silent — a spinner marks the
 * former and a finished call needs no label.
 */
function toolStatus(t: UiTool): string | null {
  if (t.approval === "requested") return "awaiting approval";
  if (t.approval === "denied") return "denied";
  if (t.isError) return "failed";
  return null;
}

/**
 * The single line that identifies a tool call while collapsed. Shell calls get
 * their command, everything else gets the first line of whatever the tool
 * returned — the two things that actually tell you what the call was doing.
 */
function toolBrief(t: UiTool): string {
  if (t.args && typeof t.args === "object" && "command" in t.args) {
    return String((t.args as { command: unknown }).command);
  }
  const first = (t.result ?? "").split("\n").find((line) => line.trim().length > 0);
  return first?.trim() ?? "";
}

/** The full argument payload, formatted for the expanded body. */
function toolArgs(t: UiTool): string {
  if (t.args && typeof t.args === "object" && "command" in t.args) {
    return `$ ${String((t.args as { command: unknown }).command)}`;
  }
  return JSON.stringify(t.args, null, 2) ?? "";
}

/** Replace the in-flight message with `messageId`, or the newest one if unknown. */
function patchMessage(
  list: UiMessage[],
  messageId: string | undefined,
  fn: (m: UiMessage) => UiMessage,
): UiMessage[] {
  const known = messageId ? list.findIndex((m) => m.id === messageId) : -1;
  const index = known === -1 ? list.length - 1 : known;
  if (index < 0) return list;
  const next = [...list];
  next[index] = fn(next[index]);
  return next;
}

/**
 * Replace a tool by `callId`, searching newest message first. `tool.approval`
 * and `tool.result` carry no message id, so the call id is the only handle.
 */
function patchTool(
  list: UiMessage[],
  callId: string,
  fn: (t: UiTool) => UiTool,
): UiMessage[] {
  for (let i = list.length - 1; i >= 0; i--) {
    const index = list[i].tools.findIndex((t) => t.callId === callId);
    if (index === -1) continue;
    const tools = [...list[i].tools];
    tools[index] = fn(tools[index]);
    const next = [...list];
    next[i] = { ...next[i], tools };
    return next;
  }
  return list;
}

function CopyButton({ text, title }: { text: string; title: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  function copy(): void {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      className="icon-btn"
      onClick={copy}
      title={title}
      aria-label={title}
      aria-live="polite"
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

/** Rebuild the visible conversation from the server's active branch path. */
function buildMessages(path: PathNode[]): UiMessage[] {
  const out: UiMessage[] = [];
  for (const node of path) {
    const { message } = node;
    const branch: UiBranch = {
      index: node.siblingIndex,
      count: node.siblingCount,
      ids: node.siblingIds,
    };
    if (message.role === "user") {
      out.push({
        id: message.id,
        role: "user",
        text: textOf(message.parts),
        reasoning: "",
        tools: [],
        images: imagesOf(message.parts),
        branch,
      });
    } else if (message.role === "assistant") {
      out.push({
        id: message.id,
        role: "assistant",
        text: textOf(message.parts),
        reasoning: reasoningOf(message.parts),
        tools: toolsOf(message.parts),
        images: imagesOf(message.parts),
        branch,
        usage: message.meta?.usage,
      });
    } else if (message.role === "tool") {
      for (const part of message.parts) {
        if (part.type !== "tool_result") continue;
        for (let i = out.length - 1; i >= 0; i--) {
          const tool = out[i].tools.find((t) => t.callId === part.id);
          if (tool) {
            tool.result = textOf(part.content);
            tool.isError = part.isError;
            tool.running = false;
            break;
          }
        }
      }
    }
  }
  return out;
}

export default function App() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [config, setConfig] = useState<HatConfig | null>(null);
  const [auth, setAuth] = useState<{ required: boolean; authenticated: boolean } | null>(null);
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [plugins, setPlugins] = useState<PluginDescriptor[]>([]);
  const [runners, setRunners] = useState<RunnerSummary[]>([]);
  const [model, setModel] = useState(
    () => localStorage.getItem("hat.model") ?? DEFAULT_MODEL,
  );
  const [sessionId, setSessionId] = useState<string | null>(
    () => localStorage.getItem("hat.session"),
  );
  const [messages, setMessages] = useState<UiMessage[]>([]);
  // One entry per assistant message produced so far in the *current* turn. A
  // turn with tool calls emits several `message.start` events, and each one is a
  // separate message in the transcript — keeping only the last one made the
  // earlier tool calls and reasoning blink out of existence until the turn
  // ended and the whole history was refetched.
  const [inFlight, setInFlightState] = useState<UiMessage[]>([]);
  const inFlightRef = useRef<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [policyMode, setPolicyMode] = useState<"ask" | "auto" | "allowlist" | "deny">("auto");
  const [allowedToolsText, setAllowedToolsText] = useState("");
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("hat.favorites") ?? "[]");
      return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  });
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    const stored = localStorage.getItem("hat.effort");
    return (REASONING_EFFORTS as readonly string[]).includes(stored ?? "")
      ? (stored as ReasoningEffort)
      : "low";
  });
  const [editing, setEditing] = useState<{ messageId: string; text: string } | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [restoring, setRestoring] = useState(false);
  // Usage for the turn currently in flight. The server persists it onto the
  // assistant message, so this only exists to keep the readout moving live.
  const [liveUsage, setLiveUsage] = useState<Usage | undefined>(undefined);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /** Set while a turn is streaming so the composer can stop it. */
  const abortRef = useRef<AbortController | null>(null);
  /** False once the user scrolls up, so streaming stops yanking the view down. */
  const stickToBottom = useRef(true);
  /** Mirrors `sessionId` for callbacks that must not re-subscribe on change. */
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  /**
   * Monotonic id for `refreshSessions`. A slow, older list response must not
   * clobber a newer one, or a just-created session briefly vanishes from the
   * sidebar (concurrent refreshes happen after every turn and new chat).
   */
  const sessionsRequestRef = useRef(0);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = (): void => {
      stickToBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    };
    el.addEventListener("scroll", measure, { passive: true });
    measure();
    return () => el.removeEventListener("scroll", measure);
  }, []);

  /**
   * Events arrive one at a time off a single SSE reader, so a ref is the
   * source of truth for the in-flight turn and state only drives the render.
   */
  const setInFlight = useCallback((list: UiMessage[]): void => {
    inFlightRef.current = list;
    setInFlightState(list);
  }, []);

  const patchInFlight = useCallback(
    (fn: (list: UiMessage[]) => UiMessage[]): void => {
      setInFlight(fn(inFlightRef.current));
    },
    [setInFlight],
  );

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  function addFiles(files: Iterable<File>): void {
    const next: PendingAttachment[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      next.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    if (next.length > 0) setPending((prev) => [...prev, ...next]);
  }

  function removePending(index: number): void {
    setPending((prev) => {
      const target = prev[index];
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((_, i) => i !== index);
    });
  }

  function refreshModels(): Promise<void> {
    return api
      .getModels()
      .then(setModels)
      .catch((e: unknown) => setError(String(e)));
  }

  function refreshProviders(): Promise<void> {
    return api.getProviders().then(setProviders).catch(() => undefined);
  }

  function refreshPlugins(): Promise<void> {
    return api.getPlugins().then(setPlugins).catch(() => undefined);
  }

  function refreshSessions(): Promise<void> {
    const requestId = ++sessionsRequestRef.current;
    return api
      .listSessions()
      .then((list) => {
        if (requestId === sessionsRequestRef.current) setSessions(list);
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    void loadConfig().then(setConfig);
    api.setUnauthorizedHandler(() => setAuth((prev) => (prev ? { ...prev, authenticated: false } : prev)));
    void api
      .getAuthStatus()
      .then((status) => setAuth({ required: status.required, authenticated: status.authenticated }))
      .catch(() => setAuth({ required: false, authenticated: true }));
    return () => api.setUnauthorizedHandler(undefined);
  }, []);

  const authenticated = auth ? auth.authenticated : true;

  useEffect(() => {
    if (!authenticated) return;
    void refreshModels();
    void refreshProviders();
    void refreshPlugins();
    void refreshSessions();
    void api.getRunners().then(setRunners).catch(() => setRunners([]));
    const poll = setInterval(() => {
      void api.getRunners().then(setRunners).catch(() => setRunners([]));
    }, 3000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  useEffect(() => {
    localStorage.setItem("hat.model", model);
  }, [model]);

  useEffect(() => {
    localStorage.setItem("hat.effort", reasoningEffort);
  }, [reasoningEffort]);

  useEffect(() => {
    localStorage.setItem("hat.favorites", JSON.stringify(favorites));
  }, [favorites]);

  useEffect(() => {
    if (sessionId) localStorage.setItem("hat.session", sessionId);
    else localStorage.removeItem("hat.session");
  }, [sessionId]);

  /**
   * Reopen the conversation that was on screen before the reload. Everything
   * needed is already on the server, so a refresh mid-answer should not cost
   * the user their session.
   */
  useEffect(() => {
    if (!authenticated) return;
    const stored = localStorage.getItem("hat.session");
    if (!stored) return;
    let cancelled = false;
    setRestoring(true);
    void api
      .getSession(stored)
      .then((payload) => {
        // The user may have picked another session while this was in flight.
        if (cancelled || sessionIdRef.current !== stored) return;
        sessionIdRef.current = payload.session.id;
        setSessionId(payload.session.id);
        setMessages(buildMessages(payload.path));
        applySession(payload.session);
        stickToBottom.current = true;
        // If the model was mid-turn when the tab reloaded, keep watching it
        // instead of showing a frozen partial answer.
        void followActiveTurn(payload.session.id);
      })
      .catch((e: unknown) => {
        if (cancelled || sessionIdRef.current !== stored) return;
        // Gone is permanent, so the stale pointer is dropped. Everything else
        // — 401, a server that is still starting, no network at all — is not,
        // and the stored pointer survives to be retried on the next load.
        if (e instanceof api.HttpError && e.status === 404) {
          setSessionId(null);
          return;
        }
        // 401 is not this effect's problem: the unauthorized handler is already
        // showing the login screen, and the restore retries once past it.
        if (!(e instanceof api.HttpError && e.status === 401)) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  function toggleFavorite(id: string): void {
    setFavorites((prev) => (prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]));
  }

  useEffect(() => {
    if (models.length > 0 && !models.some((m) => m.id === model)) {
      setModel(models[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !stickToBottom.current) return;
    // Smooth for a new message, instant while tokens stream in: animating every
    // delta makes the view lag behind the text.
    el.scrollTo({ top: el.scrollHeight, behavior: inFlight.length > 0 ? "auto" : "smooth" });
  }, [messages, inFlight]);

  const selectedModel = models.find((m) => m.id === model);
  const effortSupported = Boolean(selectedModel?.capabilities.reasoningEffort);
  // `low` is the default, so only flag the control when the user has actually
  // pushed the model past it.
  const effortRaised = reasoningEffort === "medium" || reasoningEffort === "high";

  // Everything the visible branch has cost so far, plus the turn in flight.
  const sessionUsage = useMemo(
    () => sumUsage([...messages.map((m) => m.usage), liveUsage]),
    [messages, liveUsage],
  );
  const sessionTokens = usageTotal(sessionUsage);
  const sessionTokensLabel = formatTokens(sessionTokens);

  function handleEvent(event: KernelEvent): void {
    switch (event.type) {
      case "turn.start":
        setLiveUsage(undefined);
        break;
      case "usage":
        setLiveUsage((prev) => addUsage(prev, event.usage));
        break;
      case "message.start":
        // Append rather than replace: a tool-using turn emits one of these per
        // model iteration, and the previous ones stay on screen.
        patchInFlight((list) => [
          ...list,
          {
            id: event.messageId,
            role: "assistant",
            text: "",
            reasoning: "",
            tools: [],
            images: [],
          },
        ]);
        break;
      case "text.delta":
        patchInFlight((list) =>
          patchMessage(list, event.messageId, (m) => ({ ...m, text: m.text + event.text })),
        );
        break;
      case "session.title":
        // The header and the sidebar both read from `sessions`, so one update
        // covers both without waiting for the post-turn refetch.
        setSessions((prev) =>
          prev.map((s) => (s.id === event.sessionId ? { ...s, title: event.title } : s)),
        );
        break;
      case "reasoning.delta":
        patchInFlight((list) =>
          patchMessage(list, event.messageId, (m) => ({
            ...m,
            reasoning: m.reasoning + event.text,
          })),
        );
        break;
      case "tool.call":
        patchInFlight((list) =>
          patchMessage(list, event.messageId, (m) => ({
            ...m,
            tools: [
              ...m.tools,
              {
                callId: event.callId,
                name: event.name,
                args: event.args,
                approval: null,
                running: true,
              },
            ],
          })),
        );
        break;
      case "tool.approval":
        patchInFlight((list) =>
          patchTool(list, event.callId, (t) => ({ ...t, approval: event.status })),
        );
        break;
      case "tool.result":
        patchInFlight((list) =>
          patchTool(list, event.callId, (t) => ({
            ...t,
            running: false,
            isError: event.isError,
            result: textOf(event.parts),
          })),
        );
        break;
      case "error":
        setError(event.error.message);
        break;
      case "warning":
        setWarnings((prev) => [...prev, event.message]);
        break;
      default:
        break;
    }
  }

  function applySession(session: api.SessionRecord): void {
    setModel(session.model);
    setPolicyMode(session.approvalMode);
    setAllowedToolsText(session.allowedTools.join(", "));
    setReasoningEffort(session.reasoningEffort);
    // The header and sidebar both read from `sessions`, and the record we just
    // fetched is fresher than whatever the list was holding.
    setSessions((prev) =>
      prev.map((s) => (s.id === session.id ? { ...s, title: session.title } : s)),
    );
  }

  function parseAllowlist(text: string): string[] {
    return text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * Persist a bottom-bar setting for the active session. Failures are surfaced
   * rather than swallowed, so the control never silently drifts from the server.
   */
  function persist(patch: Parameters<typeof api.updateSession>[1]): void {
    if (!sessionId) return;
    void api.updateSession(sessionId, patch).catch((e: unknown) => {
      setError(String(e));
      void refresh(sessionId).catch(() => undefined);
    });
  }

  async function savePolicy(): Promise<void> {
    if (!sessionId) return;
    try {
      const updated = await api.updateSession(sessionId, {
        approvalMode: policyMode,
        allowedTools: parseAllowlist(allowedToolsText),
      });
      applySession(updated);
    } catch (e) {
      setError(String(e));
    }
  }

  /** Model changes must land immediately: the next turn is not guaranteed. */
  function changeModel(next: string): void {
    setModel(next);
    persist({ model: next });
  }

  function changeEffort(next: ReasoningEffort): void {
    setReasoningEffort(next);
    persist({ reasoningEffort: next });
  }

  function changePolicyMode(mode: typeof policyMode): void {
    setPolicyMode(mode);
    persist({ approvalMode: mode });
  }

  async function refresh(id: string): Promise<void> {
    const payload = await api.getSession(id);
    setMessages(buildMessages(payload.path));
    applySession(payload.session);
  }

  async function runStream(
    id: string,
    fn: (onEvent: (event: KernelEvent) => void, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    abortRef.current = controller;
    // Starting a turn is an explicit request to watch it, even from scrollback.
    stickToBottom.current = true;
    setBusy(true);
    setError(null);
    setInFlight([]);
    setWarnings([]);
    try {
      await fn(handleEvent, controller.signal);
    } catch (e) {
      // A turn the user stopped is not a failure; detaching is not either.
      if (!api.isAbortError(e)) setError(String(e));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      // If the user moved to another conversation, leave its view alone: the
      // turn keeps running server-side and these messages are persisted anyway.
      if (sessionIdRef.current === id) {
        // Hand the streamed turn to the history *before* the refetch. `refresh`
        // replaces the list wholesale from the server's branch path, so promoting
        // first means the refetch is a quiet reconciliation instead of a swap that
        // blanks the last few deltas — and if the refetch fails outright, the
        // turn the user just watched stream in is still on screen.
        const streamed = inFlightRef.current;
        if (streamed.length > 0) setMessages((prev) => [...prev, ...streamed]);
        setInFlight([]);
        await refresh(id).catch(() => undefined);
        await refreshSessions();
        // Drop the live figure only once the persisted usage is in `messages`,
        // otherwise the two would be added together and double-count.
        setLiveUsage(undefined);
        setBusy(false);
      }
    }
  }

  /**
   * Attach to a turn already running for `id` — after a reload, or when
   * switching back to a conversation the model is still working on. Does
   * nothing when the session is idle.
   */
  async function followActiveTurn(id: string): Promise<void> {
    if (sessionIdRef.current !== id) return;
    const controller = new AbortController();
    abortRef.current = controller;
    stickToBottom.current = true;
    setBusy(true);
    setError(null);
    setInFlight([]);
    setWarnings([]);
    try {
      const following = await api.followTurn(id, handleEvent, controller.signal);
      if (!following) return;
    } catch (e) {
      if (!api.isAbortError(e)) setError(String(e));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (sessionIdRef.current === id) {
        const streamed = inFlightRef.current;
        if (streamed.length > 0) setMessages((prev) => [...prev, ...streamed]);
        setInFlight([]);
        await refresh(id).catch(() => undefined);
        await refreshSessions();
        setLiveUsage(undefined);
        setBusy(false);
      }
    }
  }

  /** Detach this tab from the stream without cancelling the turn. */
  function detachStream(): void {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }

  /** Stop button: really cancel the turn, then detach. */
  function stop(): void {
    const id = sessionIdRef.current;
    if (id) void api.cancelTurn(id).catch(() => undefined);
    detachStream();
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const payload = await api.createSession(model);
    setSessionId(payload.session.id);
    setMessages(buildMessages(payload.path));
    await refreshSessions();
    if (policyMode !== "ask" || reasoningEffort !== "off") {
      const updated = await api.updateSession(payload.session.id, {
        approvalMode: policyMode,
        allowedTools: parseAllowlist(allowedToolsText),
        reasoningEffort,
      });
      applySession(updated);
    }
    return payload.session.id;
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if ((!text && pending.length === 0) || busy) return;
    const attachments = pending;
    setInput("");
    setPending([]);
    setError(null);

    let attachmentIds: string[] = [];
    try {
      attachmentIds = await Promise.all(
        attachments.map(async (a) => (await api.uploadAttachment(a.file)).id),
      );
    } catch (e) {
      setError(String(e));
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
      return;
    }

    setMessages((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}`,
        role: "user",
        text,
        reasoning: "",
        tools: [],
        images: attachments.map((a) => ({ src: a.previewUrl })),
      },
    ]);

    try {
      const id = await ensureSession();
      await runStream(id, (onEvent, signal) =>
        api.sendTurn(id, text, model, attachmentIds, onEvent, signal),
      );
    } catch (e) {
      if (!api.isAbortError(e)) setError(String(e));
      setBusy(false);
    } finally {
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    }
  }

  async function newChat(): Promise<void> {
    detachStream();
    setMessages([]);
    setInFlight([]);
    setError(null);
    setWarnings([]);
    setEditing(null);
    setView("chat");
    stickToBottom.current = true;
    const payload = await api.createSession(model);
    setSessionId(payload.session.id);
    applySession(payload.session);
    await refreshSessions();
  }

  async function openSession(id: string): Promise<void> {
    detachStream();
    setBusy(false);
    setError(null);
    setWarnings([]);
    setInFlight([]);
    setEditing(null);
    setView("chat");
    stickToBottom.current = true;
    const payload = await api.getSession(id);
    // Update the ref synchronously: `followActiveTurn` guards on it and runs
    // before React commits the state update.
    sessionIdRef.current = payload.session.id;
    setSessionId(payload.session.id);
    setMessages(buildMessages(payload.path));
    applySession(payload.session);
    void followActiveTurn(payload.session.id);
  }

  async function handleRename(id: string, title: string): Promise<void> {
    await api.renameSession(id, title);
    await refreshSessions();
  }

  async function handleDelete(id: string): Promise<void> {
    await api.deleteSession(id);
    if (id === sessionId) {
      setSessionId(null);
      setMessages([]);
      setInFlight([]);
    }
    await refreshSessions();
  }

  async function submitLogin(): Promise<void> {
    setLoginError(null);
    try {
      await api.login(password);
      setPassword("");
      const status = await api.getAuthStatus();
      setAuth({ required: status.required, authenticated: status.authenticated });
    } catch (e) {
      setLoginError(String(e));
    }
  }

  async function doLogout(): Promise<void> {
    detachStream();
    await api.logout();
    setAuth({ required: true, authenticated: false });
    setSessionId(null);
    setMessages([]);
    setInFlight([]);
  }

  async function regenerate(messageId: string): Promise<void> {
    if (!sessionId || busy) return;
    await runStream(sessionId, (onEvent, signal) =>
      api.regenerate(sessionId, messageId, onEvent, signal),
    );
  }

  async function submitEdit(): Promise<void> {
    if (!sessionId || !editing || busy) return;
    const { messageId, text } = editing;
    if (!text.trim()) return;
    setEditing(null);
    await runStream(sessionId, (onEvent, signal) =>
      api.editMessage(sessionId, messageId, text, onEvent, signal),
    );
  }

  async function switchBranch(messageId: string): Promise<void> {
    if (!sessionId || busy) return;
    const payload = await api.selectBranch(sessionId, messageId);
    setMessages(buildMessages(payload.path));
  }

  async function decide(callId: string, decision: "approve" | "deny"): Promise<void> {
    const previous = inFlightRef.current;
    patchInFlight((list) =>
      patchTool(list, callId, (t) => ({
        ...t,
        approval: decision === "deny" ? "denied" : "approved",
      })),
    );
    try {
      await api.resolveApproval(callId, decision, sessionId ?? undefined);
    } catch (e) {
      // Roll back the optimistic patch so the approval stays actionable.
      setInFlight(previous);
      setError(String(e));
    }
  }

  const currentTitle =
    view === "settings"
      ? "Settings"
      : sessions.find((s) => s.id === sessionId)?.title ?? "New chat";

  if (config && isNativeShell() && !config.serverUrl) {
    return (
      <Connect
        initial={config}
        onConnected={(saved) => {
          setConfig(saved);
          // Reload so every cached model/session/plugin list is re-fetched
          // from the newly configured server.
          window.location.reload();
        }}
      />
    );
  }

  if (auth && auth.required && !auth.authenticated) {
    return (
      <div className="login">
        <form
          className="login-card"
          onSubmit={(e) => {
            e.preventDefault();
            void submitLogin();
          }}
        >
          <div className="brand">Hat</div>
          <p className="settings-hint">Enter the server password to continue.</p>
          <input
            type="password"
            autoFocus
            value={password}
            placeholder="Password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={!password}>
            Sign in
          </button>
          {loginError && <div className="error">{loginError}</div>}
        </form>
      </div>
    );
  }

  function renderMessage(m: UiMessage, streamingNow = false): JSX.Element {
    // An optimistic user message has no server id yet, so the actions that need
    // one (regenerate, edit, branch) stay off it.
    const persisted = !m.id.startsWith("local-");

    return (
      <div key={m.id} className={`msg ${m.role}${streamingNow ? " streaming" : ""}`}>
        {editing?.messageId === m.id ? (
          <div className="edit-box">
            <textarea
              value={editing.text}
              onChange={(e) => setEditing({ messageId: m.id, text: e.target.value })}
              rows={3}
            />
            <div className="edit-actions">
              <button onClick={() => void submitEdit()} disabled={busy}>
                Save & resend
              </button>
              <button className="ghost" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            {m.reasoning && (
              <details className="reasoning">
                <summary>
                  <ChevronDownIcon className="disclosure" />
                  <span>reasoning</span>
                </summary>
                <pre className="aside-body">{m.reasoning}</pre>
              </details>
            )}

            {m.text && (
              <div className={`markdown ${m.role}`}>
                <Suspense fallback={<span className="md-fallback">{m.text}</span>}>
                  <Markdown>{m.text}</Markdown>
                </Suspense>
                {/* The caret lives inside the markdown block, not beside it:
                    as a sibling it would be a block-level flex item of `.msg`
                    and drop onto a line of its own. */}
                {streamingNow && <span className="caret" />}
              </div>
            )}

            {m.images.length > 0 && (
              <div className="msg-images">
                {m.images.map((img, index) => (
                  <MessageImage key={index} attachmentId={img.attachmentId} src={img.src} />
                ))}
              </div>
            )}

            {m.tools.map((t) => {
              const status = toolStatus(t);
              return (
                <details
                  key={t.callId}
                  className={`tool ${t.isError ? "err" : ""} ${t.approval === "requested" ? "awaiting" : ""}`}
                  // An approval is a blocking question, so it must be visible
                  // rather than folded away behind a click.
                  open={t.approval === "requested"}
                >
                  <summary>
                    <ChevronDownIcon className="disclosure" />
                    <span className="tool-name">{t.name}</span>
                    <span className="tool-brief">{toolBrief(t)}</span>
                    {t.running && t.approval !== "requested" ? (
                      <span className="tool-spinner" role="status" aria-label="Running" />
                    ) : (
                      status && <span className={`tool-status ${t.approval ?? ""}`}>{status}</span>
                    )}
                  </summary>
                  <div className="aside-body">
                    <pre className="tool-args">{toolArgs(t)}</pre>
                    {t.approval === "requested" && (
                      <div className="approval">
                        <button onClick={() => void decide(t.callId, "approve")}>Approve</button>
                        <button className="danger" onClick={() => void decide(t.callId, "deny")}>
                          Deny
                        </button>
                      </div>
                    )}
                    {t.result && <pre className="tool-result">{t.result}</pre>}
                  </div>
                </details>
              );
            })}
          </>
        )}

        {!streamingNow && !editing && (
          <div className="msg-actions">
            {m.branch && m.branch.count > 1 && (
              <span className="branch" role="group" aria-label={`Version ${m.branch.index + 1} of ${m.branch.count}`}>
                <button
                  className="icon-btn"
                  title="Previous version (regenerating creates versions)"
                  aria-label={`Previous version, currently ${m.branch.index + 1} of ${m.branch.count}`}
                  disabled={m.branch.index <= 0 || busy}
                  onClick={() => void switchBranch(m.branch!.ids[m.branch!.index - 1])}
                >
                  <ChevronLeftIcon />
                </button>
                <span className="branch-label" aria-hidden="true">
                  {m.branch.index + 1}/{m.branch.count}
                </span>
                <button
                  className="icon-btn"
                  title="Next version (regenerating creates versions)"
                  aria-label={`Next version, currently ${m.branch.index + 1} of ${m.branch.count}`}
                  disabled={m.branch.index >= m.branch.count - 1 || busy}
                  onClick={() => void switchBranch(m.branch!.ids[m.branch!.index + 1])}
                >
                  <ChevronRightIcon />
                </button>
              </span>
            )}
            {m.text && <CopyButton text={m.text} title="Copy message" />}
            {m.role === "assistant" && persisted && (
              <button
                className="icon-btn"
                title="Regenerate"
                aria-label="Regenerate"
                disabled={busy}
                onClick={() => void regenerate(m.id)}
              >
                <RegenerateIcon />
              </button>
            )}
            {m.role === "user" && persisted && (
              <button
                className="icon-btn"
                title="Edit"
                aria-label="Edit"
                disabled={busy}
                onClick={() => setEditing({ messageId: m.id, text: m.text })}
              >
                <EditIcon />
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="shell">
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        view={view}
        onSelect={(id) => void openSession(id)}
        onNew={() => void newChat()}
        onRename={(id, title) => void handleRename(id, title)}
        onDelete={(id) => void handleDelete(id)}
        onView={setView}
        onLogout={auth?.required ? () => void doLogout() : undefined}
      />
      <div className="app">
      <header className="header">
        <div className="header-title">
          <h1>{currentTitle}</h1>
        </div>
      </header>

      {view === "settings" ? (
        <Settings
          models={models}
          providers={providers}
          plugins={plugins}
          runners={runners}
          model={model}
          config={config}
          onModelChange={changeModel}
          onChanged={async () => {
            await Promise.all([refreshProviders(), refreshPlugins(), refreshModels()]);
          }}
        />
      ) : (
        <>
          {warnings.length > 0 && (
            <div className="warnings">
              {warnings.map((warning, index) => (
                <div key={index} className="warning">
                  {warning}
                </div>
              ))}
            </div>
          )}

          <div className="scroller" ref={scroller}>
            {restoring && messages.length === 0 && inFlight.length === 0 && (
              <div className="restoring">Restoring conversation…</div>
            )}

            {messages.length === 0 && inFlight.length === 0 && !restoring && (
              <div className="empty">
                <h2>Hat</h2>
                <p>
                  Try <code>run: echo hello from the runner</code>. Approve the tool call and it
                  runs on the runner.
                </p>
              </div>
            )}

            {messages.map((m) => renderMessage(m))}
            {/* The caret belongs to the message still being written, not to every
                one the turn has produced so far. */}
            {inFlight.map((m, i) => renderMessage(m, i === inFlight.length - 1))}
            {error && <div className="error">{error}</div>}
          </div>

          <div
            className="composer"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
            }}
          >
            <div className="composer-box">
              {pending.length > 0 && (
                <div className="chips">
                  {pending.map((attachment, index) => (
                    <span key={attachment.previewUrl} className="chip">
                      <img src={attachment.previewUrl} alt="pending" />
                      <button
                        className="chip-remove"
                        onClick={() => removePending(index)}
                        aria-label="Remove attachment"
                        title="Remove attachment"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={input}
                placeholder="Message hat…"
                aria-label="Message"
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  const files = [...e.clipboardData.files].filter((f) =>
                    f.type.startsWith("image/"),
                  );
                  if (files.length > 0) {
                    e.preventDefault();
                    addFiles(files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                    return;
                  }
                  if (e.key === "Escape" && busy) {
                    e.preventDefault();
                    stop();
                  }
                }}
                rows={1}
              />
              <div className="composer-actions">
                <button
                  className="icon-btn"
                  onClick={() => fileInput.current?.click()}
                  title="Attach images"
                  aria-label="Attach images"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.4 11.05 12.5 20a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
                  </svg>
                </button>
                {busy ? (
                  <button
                    className="send-btn stop"
                    onClick={stop}
                    title="Stop generating"
                    aria-label="Stop generating"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <rect x="7" y="7" width="10" height="10" rx="1.5" />
                    </svg>
                  </button>
                ) : (
                  <button
                    className="send-btn"
                    onClick={() => void send()}
                    disabled={!input.trim() && pending.length === 0}
                    title="Send"
                    aria-label="Send message"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                )}
              </div>

              <div className="composer-footer">
                <ModelPicker
                  models={models}
                  value={model}
                  favorites={favorites}
                  onChange={changeModel}
                  onToggleFavorite={toggleFavorite}
                />

                <select
                  className={`composer-select ${effortRaised ? "on" : ""}`}
                  value={reasoningEffort}
                  onChange={(e) => changeEffort(e.target.value as ReasoningEffort)}
                  disabled={!effortSupported}
                  aria-label="Reasoning effort"
                  title={
                    effortSupported
                      ? "How much the model should think before answering"
                      : `${selectedModel?.label ?? "This model"} does not expose a reasoning effort level`
                  }
                >
                  {REASONING_EFFORTS.map((effort) => (
                    <option key={effort} value={effort}>
                      {effort === "off" ? "effort: off" : `effort: ${effort}`}
                    </option>
                  ))}
                </select>

                <select
                  className={`composer-select ${policyMode !== "auto" ? "on" : ""}`}
                  value={policyMode}
                  onChange={(e) => changePolicyMode(e.target.value as typeof policyMode)}
                  aria-label="Tool policy"
                  title="Which tool calls run without asking you first"
                >
                  <option value="ask">tools: ask</option>
                  <option value="auto">tools: auto</option>
                  <option value="allowlist">tools: allowlist</option>
                  <option value="deny">tools: deny</option>
                </select>

                {policyMode === "allowlist" && (
                  <input
                    className="allowlist-input"
                    value={allowedToolsText}
                    placeholder="tool_a, tool_b"
                    aria-label="Allowed tools"
                    onChange={(e) => setAllowedToolsText(e.target.value)}
                    onBlur={() => void savePolicy()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                )}

                <span className="composer-spacer" />

                {selectedModel && (
                  <span className="composer-caps" title={capSummary(selectedModel)}>
                    <CreatorIcon slug={creatorSlug(selectedModel)} name={creatorName(selectedModel)} size={14} />
                    {capTags(selectedModel.capabilities).map((tag) => (
                      <span className="cap" key={tag.key} title={tag.title}>
                        {tag.label}
                      </span>
                    ))}
                    {contextTag(selectedModel.contextWindow) && (
                      <span className="ctx-label">
                        {contextTag(selectedModel.contextWindow)!.label}
                      </span>
                    )}
                  </span>
                )}

                {sessionTokensLabel && (
                  <span
                    className="token-count"
                    title={`${usageDetail(sessionUsage)} tokens in this conversation`}
                  >
                    {sessionTokensLabel} tokens
                  </span>
                )}
              </div>
            </div>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
          </div>
        </>
      )}
      </div>
    </div>
  );
}
