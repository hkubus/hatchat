import type { KernelEvent, ModelInfo, ReasoningEffort, UiMessage } from "@hat/core";
import {
  REASONING_EFFORTS,
  applyEffect,
  applyStoredEffect,
  approvalForDecision,
  buildMessages,
  contextFill,
  endsTruncated,
  readEvent,
  sumUsage,
  usageTotal,
} from "@hat/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatSettings from "./ChatSettings";
import Connect from "./Connect";
import ComposerMenu, { type MenuOption } from "./ComposerMenu";
import { BulbIcon, DownloadIcon, HatMark, MenuIcon, PaperclipIcon, SlidersIcon, WrenchIcon } from "./icons";
import MessageView, { type MessageActions } from "./MessageView";
import ModelPicker from "./ModelPicker";
import Settings from "./Settings";
import Sidebar from "./Sidebar";
import * as api from "./api";
import type { PluginDescriptor, ProviderStatus, RunnerSummary, SearchHit, SessionSummary } from "./api";
import { modelName } from "./creators";
import { notify } from "./notifications";
import { formatTokens, cacheHitLabel, usageDetail } from "./tokens";
import UsageMeter from "./UsageMeter";
import type { HatConfig } from "./runtime";
import { isNativeShell, loadConfig, saveConfig } from "./runtime";

interface PendingAttachment {
  file: File;
  /** Object URL for image previews; documents show their name instead. */
  previewUrl?: string;
}

/** Pasting more than this much text attaches it as a file instead. */
const PASTE_AS_FILE_CHARS = 8_000;

type SessionSettings = Pick<api.SessionRecord, "instructions" | "temperature" | "maxTokens">;

const NO_SETTINGS: SessionSettings = { instructions: "", temperature: null, maxTokens: null };

const DEFAULT_MODEL = "fake/fake-agent";

type PolicyMode = api.SessionRecord["approvalMode"];

const EFFORT_LABEL: Record<ReasoningEffort, string> = { off: "Off", low: "Low", medium: "Medium", high: "High" };

const EFFORT_OPTIONS: ReadonlyArray<MenuOption<ReasoningEffort>> = [
  { value: "off", label: "Off", description: "Answer straight away" },
  { value: "low", label: "Low", description: "A quick think first (default)" },
  { value: "medium", label: "Medium", description: "More deliberate, a bit slower" },
  { value: "high", label: "High", description: "Thinks hardest; slowest and costliest" },
];

const POLICY_LABEL: Record<PolicyMode, string> = { auto: "Auto", ask: "Ask", allowlist: "Allowlist", deny: "Blocked" };

const POLICY_OPTIONS: ReadonlyArray<MenuOption<PolicyMode>> = [
  { value: "auto", label: "Auto", description: "Tools run without asking (default)" },
  { value: "ask", label: "Ask", description: "Confirm risky tool calls first" },
  { value: "allowlist", label: "Allowlist", description: "Listed tools run; the rest ask", keepOpen: true },
  { value: "deny", label: "Blocked", description: "Every tool call is refused" },
];

/** How close to the bottom the scroller has to be to keep following the stream. */
const NEAR_BOTTOM_PX = 72;

export default function App() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [config, setConfig] = useState<HatConfig | null>(null);
  const [auth, setAuth] = useState<{ required: boolean; authenticated: boolean; password?: boolean } | null>(null);
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
  const [policyMode, setPolicyMode] = useState<PolicyMode>("auto");
  const [allowedToolsText, setAllowedToolsText] = useState("");
  /** `ask_user` calls answered here, hidden until their result arrives. */
  const [answered, setAnswered] = useState<ReadonlySet<string>>(() => new Set());
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
  const [sessionSettings, setSessionSettings] = useState<SessionSettings>(NO_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Narrow screens only: the sidebar is a drawer over the chat. */
  const [navOpen, setNavOpen] = useState(false);
  /** A message opened from search, briefly highlighted and scrolled to. */
  const [highlightId, setHighlightId] = useState<string | null>(null);
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
  /** Last status seen per session, to notice a turn finishing or needing the user. */
  const statusRef = useRef(new Map<string, SessionSummary["status"]>());

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = (): void => {
      stickToBottom.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    };
    el.addEventListener("scroll", measure, { passive: true });
    measure();
    // Content also grows without any state change (images decoding, the
    // lazily loaded Markdown renderer, action rows appearing once a turn
    // settles). While pinned to the bottom, follow it.
    const resize = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    const observeChildren = (): void => {
      resize.disconnect();
      for (const child of Array.from(el.children)) resize.observe(child);
    };
    observeChildren();
    const mutations = new MutationObserver(observeChildren);
    mutations.observe(el, { childList: true });
    return () => {
      el.removeEventListener("scroll", measure);
      resize.disconnect();
      mutations.disconnect();
    };
    // The scroller only exists in the chat view, and is a new element each
    // time that view mounts.
  }, [view, auth]);

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
      // Anything else is sent as a document; the server reads text, code and
      // PDFs and rejects what it cannot, with a message saying so.
      const previewable = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
      next.push({ file, previewUrl: previewable ? URL.createObjectURL(file) : undefined });
    }
    if (next.length > 0) setPending((prev) => [...prev, ...next]);
  }

  function removePending(index: number): void {
    setPending((prev) => {
      const target = prev[index];
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
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
        if (requestId !== sessionsRequestRef.current) return;
        noticeTransitions(list);
        setSessions(list);
      })
      .catch(() => undefined);
  }

  /**
   * Notify (when enabled and the tab is hidden) as a conversation finishes a
   * turn or starts waiting on the user — for any conversation, not only the
   * one on screen, since turns keep running server-side.
   */
  function noticeTransitions(list: SessionSummary[]): void {
    const seen = statusRef.current;
    for (const session of list) {
      const before = seen.get(session.id);
      const now = session.status ?? "idle";
      if (before !== undefined && before !== now) {
        const open = (): void => void openSession(session.id);
        if (now === "waiting") notify(session.title, "Needs your input", `hat-${session.id}`, open);
        else if (now === "idle" && before === "running") notify(session.title, "Reply ready", `hat-${session.id}`, open);
      }
      seen.set(session.id, now);
    }
  }

  useEffect(() => {
    void loadConfig().then(setConfig);
    api.setUnauthorizedHandler(() => setAuth((prev) => (prev ? { ...prev, authenticated: false } : prev)));
    void api
      .getAuthStatus()
      .then((status) => setAuth(status))
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

  // Keep sidebar status (and notifications) moving while any conversation is
  // busy; idle servers are not polled.
  const anyActive = busy || sessions.some((s) => s.status && s.status !== "idle");
  useEffect(() => {
    if (!authenticated || !anyActive) return;
    const poll = setInterval(() => void refreshSessions(), 4000);
    return () => clearInterval(poll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated, anyActive]);

  // `openSession` sets the messages and the highlight in one render, so the
  // target is in the DOM by the time this runs. Keyed on the id alone: later
  // message updates (a turn streaming in) must not pull the view back.
  useEffect(() => {
    if (!highlightId) return;
    document.getElementById(`msg-${highlightId}`)?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(timer);
  }, [highlightId]);

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
    // A long way off (e.g. after jumping to a search hit) jumps too: the scroll
    // events of a long animation would read as the user scrolling away.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const jump = inFlight.length > 0 || distance > el.clientHeight;
    el.scrollTo({ top: el.scrollHeight, behavior: jump ? "auto" : "smooth" });
  }, [messages, inFlight]);

  const selectedModel = models.find((m) => m.id === model);
  const effortSupported = Boolean(selectedModel?.capabilities.reasoningEffort);
  // `low` is the default, so only flag the control when the user has actually
  // pushed the model past it.
  const effortRaised = reasoningEffort === "medium" || reasoningEffort === "high";

  // Everything the visible branch has cost so far, plus the turn in flight
  // (in-flight messages accumulate their usage as it streams).
  const visibleMessages = useMemo(() => [...messages, ...inFlight], [messages, inFlight]);
  const sessionUsage = useMemo(() => sumUsage(visibleMessages.map((m) => m.usage)), [visibleMessages]);
  const fill = contextFill(visibleMessages, selectedModel?.contextWindow);
  const canContinue = !busy && inFlight.length === 0 && endsTruncated(messages);
  const sessionTokens = usageTotal(sessionUsage);
  const sessionTokensLabel = formatTokens(sessionTokens);
  const sessionCacheLabel = cacheHitLabel(sessionUsage);

  function handleEvent(event: KernelEvent): void {
    const effect = readEvent(event);
    switch (effect.kind) {
      case "session-title":
        // The header and the sidebar both read from `sessions`, so one update
        // covers both without waiting for the post-turn refetch.
        setSessions((prev) =>
          prev.map((s) => (s.id === effect.sessionId ? { ...s, title: effect.title } : s)),
        );
        break;
      case "error":
        setError(effect.message);
        break;
      case "warning":
        setWarnings((prev) => [...prev, effect.message]);
        break;
      case "none":
      case "reset-usage":
        break;
      default:
        // Append rather than replace on message.start: a tool-using turn emits
        // one per model iteration, and the previous ones stay on screen.
        patchInFlight((list) => applyEffect(list, effect));
        // After attaching mid-turn, the call waiting for approval is on a
        // stored message: its approval request and result land there.
        if (effect.kind === "tool-approval" || effect.kind === "tool-result") {
          setMessages((list) => applyStoredEffect(list, effect));
        }
        break;
    }
    // A blocked turn is worth a notification straight away, not on the next poll.
    const id = sessionIdRef.current;
    const needsYou =
      (event.type === "tool.approval" && event.status === "requested") ||
      (event.type === "tool.call" && event.name === "ask_user");
    if (id && needsYou) {
      const title = sessions.find((s) => s.id === id)?.title ?? "hat";
      notify(title, event.type === "tool.call" ? "The assistant has a question" : "A tool call needs approval", `hat-${id}`);
    }
  }

  function applySession(session: api.SessionRecord): void {
    setModel(session.model);
    setPolicyMode(session.approvalMode);
    setAllowedToolsText(session.allowedTools.join(", "));
    setReasoningEffort(session.reasoningEffort);
    setSessionSettings({
      instructions: session.instructions ?? "",
      temperature: session.temperature ?? null,
      maxTokens: session.maxTokens ?? null,
    });
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

  function changePolicyMode(mode: PolicyMode): void {
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

    const revoke = (): void =>
      attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    let uploaded: api.AttachmentRecord[] = [];
    try {
      uploaded = await Promise.all(attachments.map((a) => api.uploadAttachment(a.file)));
    } catch (e) {
      // Nothing was sent, so give the user their draft back.
      setInput(text);
      setPending(attachments);
      setError(e instanceof Error ? e.message : String(e));
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
        images: attachments.flatMap((a) => (a.previewUrl ? [{ src: a.previewUrl }] : [])),
        files: uploaded.flatMap((record, index) =>
          record.kind === "document"
            ? [{ id: record.id, name: attachments[index].file.name, mime: record.mime, size: record.size }]
            : [],
        ),
      },
    ]);

    try {
      const id = await ensureSession();
      await runStream(id, (onEvent, signal) =>
        api.sendTurn(
          id,
          text,
          model,
          uploaded.map((record, index) => ({ id: record.id, name: attachments[index].file.name })),
          onEvent,
          signal,
        ),
      );
    } catch (e) {
      if (!api.isAbortError(e)) setError(String(e));
      setBusy(false);
    } finally {
      revoke();
    }
  }

  /** Finish a reply that stopped at the output limit. */
  async function continueReply(): Promise<void> {
    if (!sessionId || busy) return;
    await runStream(sessionId, (onEvent, signal) => api.continueTurn(sessionId, onEvent, signal));
  }

  async function forkFrom(messageId: string): Promise<void> {
    if (!sessionId) return;
    try {
      const payload = await api.forkSession(sessionId, messageId);
      await refreshSessions();
      await openSession(payload.session.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function saveChatSettings(patch: SessionSettings): Promise<void> {
    if (!sessionId) return;
    applySession(await api.updateSession(sessionId, patch));
  }

  async function exportChat(format: "markdown" | "json"): Promise<void> {
    if (!sessionId) return;
    try {
      await api.exportSession(sessionId, format);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function importChat(file: File): Promise<void> {
    try {
      const payload = await api.importSession(file);
      await refreshSessions();
      await openSession(payload.session.id);
    } catch (e) {
      setView("chat");
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function openHit(hit: SearchHit): Promise<void> {
    await openSession(hit.sessionId, hit.messageId);
  }

  async function newChat(): Promise<void> {
    detachStream();
    setMessages([]);
    setInFlight([]);
    setError(null);
    setWarnings([]);
    setEditing(null);
    setView("chat");
    setSettingsOpen(false);
    stickToBottom.current = true;
    const payload = await api.createSession(model);
    setSessionId(payload.session.id);
    applySession(payload.session);
    await refreshSessions();
  }

  /**
   * Open a conversation. With `messageId`, make sure the branch holding that
   * message is the active one and bring the message into view.
   */
  async function openSession(id: string, messageId?: string): Promise<void> {
    detachStream();
    setBusy(false);
    setError(null);
    setWarnings([]);
    setInFlight([]);
    setEditing(null);
    setView("chat");
    stickToBottom.current = true;
    setSettingsOpen(false);
    let payload = await api.getSession(id);
    if (messageId && !payload.path.some((node) => node.message.id === messageId)) {
      payload = await api.selectBranch(id, messageId).catch(() => payload);
    }
    if (messageId) {
      stickToBottom.current = false;
      setHighlightId(messageId);
    }
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
      setAuth(await api.getAuthStatus());
    } catch (e) {
      setLoginError(String(e));
    }
  }

  async function doLogout(): Promise<void> {
    detachStream();
    await api.logout();
    // A native shell is signed in by its token, so signing out forgets it.
    if (config && isNativeShell()) setConfig(await saveConfig({ ...config, token: "" }));
    setAuth((prev) => ({ required: true, authenticated: false, password: prev?.password }));
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
    // The card is in flight, or stored if this tab attached mid-turn.
    const mark = (status: "requested" | "approved" | "denied"): void => {
      patchInFlight((list) => applyEffect(list, { kind: "tool-approval", callId, status }));
      setMessages((list) => applyStoredEffect(list, { kind: "tool-approval", callId, status }));
    };
    mark(approvalForDecision(decision));
    try {
      await api.resolveApproval(callId, decision, sessionId ?? undefined);
    } catch (e) {
      // Roll back the optimistic mark so the approval stays actionable.
      mark("requested");
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
    // A native shell signs in with its token alone (a session cookie would not
    // cross from its origin to the server's), so what it needs is a token the
    // server accepts, not a password.
    if (config && isNativeShell()) {
      return (
        <Connect
          initial={config}
          notice={config.token ? "The server did not accept this app's token." : "The server needs this app's token."}
          onConnected={(saved) => {
            setConfig(saved);
            window.location.reload();
          }}
        />
      );
    }
    if (!auth.password) {
      return (
        <div className="login">
          <div className="login-card">
            <div className="brand">Hat</div>
            <p className="settings-hint">
              This server only accepts its API token, which a browser tab does not send. Set{" "}
              <code>HAT_AUTH_PASSWORD</code> on the server to sign in here, or use the desktop app with
              the token.
            </p>
          </div>
        </div>
      );
    }
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

  const messageActions: MessageActions = {
    busy,
    sessionId,
    editing,
    answered,
    onEditChange: (messageId, text) => setEditing({ messageId, text }),
    onEditSubmit: () => void submitEdit(),
    onEditCancel: () => setEditing(null),
    onRegenerate: (messageId) => void regenerate(messageId),
    onFork: (messageId) => void forkFrom(messageId),
    onSwitchBranch: (messageId) => void switchBranch(messageId),
    onDecide: (callId, decision) => void decide(callId, decision),
    onAnswer: async (callId, answer) => {
      if (!sessionId) return;
      await api.answerQuestion(callId, sessionId, answer);
      setAnswered((prev) => new Set(prev).add(callId));
    },
  };

  return (
    <div className={`shell ${navOpen ? "nav-open" : ""}`}>
      <Sidebar
        sessions={sessions}
        activeId={sessionId}
        view={view}
        onSelect={(id) => {
          setNavOpen(false);
          void openSession(id);
        }}
        onNew={() => {
          setNavOpen(false);
          void newChat();
        }}
        onRename={(id, title) => void handleRename(id, title)}
        onDelete={(id) => void handleDelete(id)}
        onView={(next) => {
          setNavOpen(false);
          setView(next);
        }}
        onLogout={auth?.required ? () => void doLogout() : undefined}
        onOpenHit={(hit) => {
          setNavOpen(false);
          void openHit(hit);
        }}
        onImport={(file) => {
          setNavOpen(false);
          void importChat(file);
        }}
      />
      {navOpen && <div className="nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <div className="app">
      <header className="header">
        <button
          className="icon-btn nav-toggle"
          onClick={() => setNavOpen(true)}
          aria-label="Show conversations"
          title="Conversations"
        >
          <MenuIcon />
        </button>
        <div className="header-title">
          <h1>{currentTitle}</h1>
        </div>
        {view === "chat" && sessionId && (
          <div className="header-actions">
            <button
              className={`icon-btn ${settingsOpen ? "on" : ""} ${sessionSettings.instructions ? "dot" : ""}`}
              onClick={() => setSettingsOpen((open) => !open)}
              title="Conversation settings: instructions, temperature, reply length"
              aria-label="Conversation settings"
              aria-expanded={settingsOpen}
            >
              <SlidersIcon />
            </button>
            <details className="menu">
              <summary className="icon-btn" title="Export this conversation" aria-label="Export">
                <DownloadIcon />
              </summary>
              <div className="menu-items" role="menu">
                <button role="menuitem" onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); void exportChat("markdown"); }}>
                  Markdown (this branch)
                </button>
                <button role="menuitem" onClick={(e) => { e.currentTarget.closest("details")?.removeAttribute("open"); void exportChat("json"); }}>
                  JSON (everything, re-importable)
                </button>
              </div>
            </details>
          </div>
        )}
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
          onOpenSession={(id) => void openSession(id)}
          onChanged={async () => {
            await Promise.all([refreshProviders(), refreshPlugins(), refreshModels()]);
          }}
        />
      ) : (
        <>
          {settingsOpen && sessionId && (
            <ChatSettings
              settings={sessionSettings}
              onSave={saveChatSettings}
              onClose={() => setSettingsOpen(false)}
            />
          )}

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
                <HatMark className="empty-mark" />
                <h2>What can I help with?</h2>
                {selectedModel && <p>Talking to {modelName(selectedModel)}. Drop in files, or ask it to run something.</p>}
              </div>
            )}

            {messages.map((m) => (
              <MessageView key={m.id} m={m} highlighted={m.id === highlightId} actions={messageActions} />
            ))}
            {/* The caret belongs to the message still being written, not to every
                one the turn has produced so far. */}
            {inFlight.map((m, i) => (
              <MessageView key={m.id} m={m} streamingNow={i === inFlight.length - 1} actions={messageActions} />
            ))}
            {canContinue && (
              <div className="continue-row">
                <button onClick={() => void continueReply()}>Continue</button>
                <span>The reply stopped at the output limit.</span>
              </div>
            )}
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
                    <span
                      key={`${attachment.file.name}-${attachment.file.size}-${index}`}
                      className={`chip ${attachment.previewUrl ? "" : "doc"}`}
                      title={attachment.file.name}
                    >
                      {attachment.previewUrl ? (
                        <img src={attachment.previewUrl} alt={attachment.file.name} />
                      ) : (
                        <span className="chip-doc">
                          <span className="chip-ext">
                            {attachment.file.name.split(".").pop()?.slice(0, 4).toUpperCase() || "FILE"}
                          </span>
                          <span className="chip-name">{attachment.file.name}</span>
                        </span>
                      )}
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
                  const files = [...e.clipboardData.files];
                  if (files.length > 0) {
                    e.preventDefault();
                    addFiles(files);
                    return;
                  }
                  // A wall of pasted text (a log, a file's contents) reads better
                  // as an attachment than as a composer the height of the screen.
                  const text = e.clipboardData.getData("text/plain");
                  if (text.length > PASTE_AS_FILE_CHARS) {
                    e.preventDefault();
                    addFiles([new File([text], "pasted-text.txt", { type: "text/plain" })]);
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
              <div className="composer-bar">
                <button
                  className="icon-btn"
                  onClick={() => fileInput.current?.click()}
                  title="Attach images, PDFs, text or code files"
                  aria-label="Attach files"
                >
                  <PaperclipIcon />
                </button>

                <ModelPicker
                  models={models}
                  value={model}
                  favorites={favorites}
                  onChange={changeModel}
                  onToggleFavorite={toggleFavorite}
                />

                {/* Only for models that take a reasoning effort: a disabled
                    control nobody can use is just noise in the bar. */}
                {effortSupported && (
                  <ComposerMenu
                    label="Reasoning effort"
                    icon={<BulbIcon />}
                    value={reasoningEffort}
                    options={EFFORT_OPTIONS}
                    onChange={changeEffort}
                    display={reasoningEffort === "low" ? undefined : EFFORT_LABEL[reasoningEffort]}
                    tone={effortRaised ? "accent" : undefined}
                    title={`Reasoning effort: ${EFFORT_LABEL[reasoningEffort]}`}
                  />
                )}

                <ComposerMenu
                  label="Tool calls"
                  icon={<WrenchIcon />}
                  value={policyMode}
                  options={POLICY_OPTIONS}
                  onChange={changePolicyMode}
                  display={policyMode === "auto" ? undefined : POLICY_LABEL[policyMode]}
                  tone={policyMode === "deny" ? "warn" : policyMode === "auto" ? undefined : "accent"}
                  title={`Tool calls: ${POLICY_LABEL[policyMode]}`}
                  onClose={policyMode === "allowlist" ? () => void savePolicy() : undefined}
                  footer={
                    policyMode === "allowlist" && (
                      <label className="cmenu-field">
                        <span>Allowed tools</span>
                        <input
                          value={allowedToolsText}
                          placeholder="tool_a, tool_b"
                          autoFocus
                          onChange={(e) => setAllowedToolsText(e.target.value)}
                          onBlur={() => void savePolicy()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") e.currentTarget.blur();
                          }}
                        />
                      </label>
                    )
                  }
                />

                <span className="composer-spacer" />

                <UsageMeter
                  fraction={fill ? fill.fraction : null}
                  tokensLabel={sessionTokensLabel ? `${sessionTokensLabel} tokens` : ""}
                  title={[
                    fill &&
                      `${Math.round(fill.fraction * 100)}% of the context window: the last request used ${formatTokens(fill.tokens)} of ${formatTokens(selectedModel?.contextWindow ?? 0)} tokens. Near the limit, older tool output and messages are left out of requests.`,
                    sessionTokensLabel &&
                      `${usageDetail(sessionUsage)} tokens in this conversation${sessionCacheLabel ? ` (${sessionCacheLabel})` : ""}.`,
                  ]
                    .filter(Boolean)
                    .join("\n")}
                />

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
            </div>
            <input
              ref={fileInput}
              type="file"
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
