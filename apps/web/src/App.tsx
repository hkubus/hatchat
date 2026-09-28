import type { KernelEvent, ModelInfo, Part, ReasoningEffort } from "@hat/core";
import { REASONING_EFFORTS } from "@hat/core";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import Connect from "./Connect";
import MessageImage from "./MessageImage";
import Settings from "./Settings";
import Sidebar from "./Sidebar";
import * as api from "./api";
import type { PathNode, PluginDescriptor, ProviderStatus, RunnerSummary, SessionSummary } from "./api";
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
}

interface PendingAttachment {
  file: File;
  previewUrl: string;
}

const DEFAULT_MODEL = "fake/fake-agent";

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
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [streaming, setStreaming] = useState<UiMessage | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [policyMode, setPolicyMode] = useState<"ask" | "auto" | "allowlist" | "deny">("ask");
  const [allowedToolsText, setAllowedToolsText] = useState("");
  const [autoRoute, setAutoRoute] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort>(() => {
    const stored = localStorage.getItem("hat.effort");
    return (REASONING_EFFORTS as readonly string[]).includes(stored ?? "")
      ? (stored as ReasoningEffort)
      : "off";
  });
  const [editing, setEditing] = useState<{ messageId: string; text: string } | null>(null);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
    return api.listSessions().then(setSessions).catch(() => undefined);
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
    if (models.length > 0 && !models.some((m) => m.id === model)) {
      setModel(models[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return [...map.entries()];
  }, [models]);

  const selectedModel = models.find((m) => m.id === model);
  const effortSupported = Boolean(selectedModel?.capabilities.reasoningEffort);

  function handleEvent(event: KernelEvent): void {
    switch (event.type) {
      case "message.start":
        setStreaming({
          id: event.messageId,
          role: "assistant",
          text: "",
          reasoning: "",
          tools: [],
          images: [],
        });
        break;
      case "text.delta":
        setStreaming((s) => (s ? { ...s, text: s.text + event.text } : s));
        break;
      case "reasoning.delta":
        setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + event.text } : s));
        break;
      case "tool.call":
        setStreaming((s) =>
          s
            ? {
                ...s,
                tools: [
                  ...s.tools,
                  {
                    callId: event.callId,
                    name: event.name,
                    args: event.args,
                    approval: null,
                    running: true,
                  },
                ],
              }
            : s,
        );
        break;
      case "tool.approval":
        setStreaming((s) =>
          s
            ? {
                ...s,
                tools: s.tools.map((t) =>
                  t.callId === event.callId ? { ...t, approval: event.status } : t,
                ),
              }
            : s,
        );
        break;
      case "tool.result":
        setStreaming((s) =>
          s
            ? {
                ...s,
                tools: s.tools.map((t) =>
                  t.callId === event.callId
                    ? {
                        ...t,
                        running: false,
                        isError: event.isError,
                        result: textOf(event.parts),
                      }
                    : t,
                ),
              }
            : s,
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
    setAutoRoute(session.autoRoute);
    setReasoningEffort(session.reasoningEffort);
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
        autoRoute,
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

  function changeAutoRoute(enabled: boolean): void {
    setAutoRoute(enabled);
    persist({ autoRoute: enabled });
  }

  async function refresh(id: string): Promise<void> {
    const payload = await api.getSession(id);
    setMessages(buildMessages(payload.path));
    applySession(payload.session);
  }

  async function runStream(
    id: string,
    fn: (onEvent: (event: KernelEvent) => void) => Promise<void>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setStreaming(null);
    setWarnings([]);
    try {
      await fn(handleEvent);
    } catch (e) {
      setError(String(e));
    } finally {
      await refresh(id).catch(() => undefined);
      await refreshSessions();
      setStreaming(null);
      setBusy(false);
    }
  }

  async function ensureSession(): Promise<string> {
    if (sessionId) return sessionId;
    const payload = await api.createSession(model);
    setSessionId(payload.session.id);
    setMessages(buildMessages(payload.path));
    await refreshSessions();
    if (policyMode !== "ask" || autoRoute || reasoningEffort !== "off") {
      const updated = await api.updateSession(payload.session.id, {
        approvalMode: policyMode,
        allowedTools: parseAllowlist(allowedToolsText),
        autoRoute,
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
      await runStream(id, (onEvent) => api.sendTurn(id, text, model, attachmentIds, onEvent));
    } catch (e) {
      setError(String(e));
      setBusy(false);
    } finally {
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    }
  }

  async function newChat(): Promise<void> {
    setMessages([]);
    setStreaming(null);
    setError(null);
    setWarnings([]);
    setEditing(null);
    setView("chat");
    const payload = await api.createSession(model);
    setSessionId(payload.session.id);
    applySession(payload.session);
    await refreshSessions();
  }

  async function openSession(id: string): Promise<void> {
    setBusy(false);
    setError(null);
    setWarnings([]);
    setStreaming(null);
    setEditing(null);
    setView("chat");
    const payload = await api.getSession(id);
    setSessionId(payload.session.id);
    setMessages(buildMessages(payload.path));
    applySession(payload.session);
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
      setStreaming(null);
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
    await api.logout();
    setAuth({ required: true, authenticated: false });
    setSessionId(null);
    setMessages([]);
    setStreaming(null);
  }

  async function regenerate(messageId: string): Promise<void> {
    if (!sessionId || busy) return;
    await runStream(sessionId, (onEvent) => api.regenerate(sessionId, messageId, onEvent));
  }

  async function submitEdit(): Promise<void> {
    if (!sessionId || !editing || busy) return;
    const { messageId, text } = editing;
    if (!text.trim()) return;
    setEditing(null);
    await runStream(sessionId, (onEvent) => api.editMessage(sessionId, messageId, text, onEvent));
  }

  async function switchBranch(messageId: string): Promise<void> {
    if (!sessionId || busy) return;
    const payload = await api.selectBranch(sessionId, messageId);
    setMessages(buildMessages(payload.path));
  }

  async function decide(callId: string, decision: "approve" | "deny"): Promise<void> {
    setStreaming((s) =>
      s
        ? {
            ...s,
            tools: s.tools.map((t) =>
              t.callId === callId
                ? { ...t, approval: decision === "deny" ? "denied" : "approved" }
                : t,
            ),
          }
        : s,
    );
    await api.resolveApproval(callId, decision);
  }

  const runnerOnline = runners.length > 0;
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
          <div className="brand">hat</div>
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
    return (
      <div key={m.id} className={`msg ${m.role}`}>
        <div className="msg-head">
          <span className={`role-dot ${m.role}`} />
          <span className="role">{m.role === "user" ? "You" : "Assistant"}</span>
          {m.branch && m.branch.count > 1 && (
            <span className="branch">
              <button
                className="ghost tiny"
                disabled={m.branch.index <= 0 || busy}
                onClick={() => void switchBranch(m.branch!.ids[m.branch!.index - 1])}
              >
                ‹
              </button>
              <span className="branch-label">
                {m.branch.index + 1}/{m.branch.count}
              </span>
              <button
                className="ghost tiny"
                disabled={m.branch.index >= m.branch.count - 1 || busy}
                onClick={() => void switchBranch(m.branch!.ids[m.branch!.index + 1])}
              >
                ›
              </button>
            </span>
          )}
          {m.role === "assistant" && !m.id.startsWith("local-") && (
            <button className="ghost tiny" disabled={busy} onClick={() => void regenerate(m.id)}>
              regenerate
            </button>
          )}
          {m.role === "user" && !m.id.startsWith("local-") && (
            <button
              className="ghost tiny"
              disabled={busy}
              onClick={() => setEditing({ messageId: m.id, text: m.text })}
            >
              edit
            </button>
          )}
        </div>

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
                <summary>reasoning</summary>
                <pre>{m.reasoning}</pre>
              </details>
            )}
            {m.text && (
              <div className={`markdown ${m.role}`}>
                <Suspense fallback={<span className="md-fallback">{m.text}</span>}>
                  <Markdown>{m.text}</Markdown>
                </Suspense>
              </div>
            )}
            {streamingNow && m.text && <span className="caret" />}
          </>
        )}

        {m.images.length > 0 && (
          <div className="msg-images">
            {m.images.map((img, index) => (
              <MessageImage key={index} attachmentId={img.attachmentId} src={img.src} />
            ))}
          </div>
        )}

        {m.tools.map((t) => (
          <div key={t.callId} className={`tool ${t.isError ? "err" : ""}`}>
            <div className="tool-head">
              <span className="tool-name">{t.name}</span>
              <span className={`tool-status ${t.approval ?? ""}`}>
                {t.running
                  ? t.approval === "requested"
                    ? "awaiting approval"
                    : "running"
                  : t.approval === "denied"
                    ? "denied"
                    : t.isError
                      ? "failed"
                      : "done"}
              </span>
            </div>
            <pre className="tool-args">
              {typeof t.args === "object" && t.args && "command" in t.args
                ? `$ ${String((t.args as { command: unknown }).command)}`
                : JSON.stringify(t.args)}
            </pre>
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
        ))}
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
        <div className="header-right">
          <span className={`status ${runnerOnline ? "ok" : "bad"}`}>
            <span className="dot" />
            {runnerOnline ? runners.map((r) => r.id).join(", ") : "runner offline"}
          </span>
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
            {messages.length === 0 && !streaming && (
              <div className="empty">
                <h2>hat</h2>
                <p>
                  Try <code>run: echo hello from the runner</code>. Approve the tool call and it
                  runs on the runner.
                </p>
              </div>
            )}

            {messages.map((m) => renderMessage(m))}
            {streaming && renderMessage(streaming, true)}
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
                      <button className="chip-remove" onClick={() => removePending(index)}>
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
                onChange={(e) => setInput(e.target.value)}
                onPaste={(e) => {
                  if (e.clipboardData.files.length > 0) {
                    e.preventDefault();
                    addFiles(e.clipboardData.files);
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                rows={1}
              />
              <div className="composer-actions">
                <button
                  className="icon-btn"
                  onClick={() => fileInput.current?.click()}
                  title="Attach images"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21.4 11.05 12.5 20a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />
                  </svg>
                </button>
                <button
                  className="send-btn"
                  onClick={() => void send()}
                  disabled={busy || (!input.trim() && pending.length === 0)}
                  title="Send"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </div>

              <div className="composer-footer">
                <select
                  className="composer-select model-select"
                  value={model}
                  onChange={(e) => changeModel(e.target.value)}
                  aria-label="Model"
                  title={model}
                >
                  {groups.length === 0 && <option value={DEFAULT_MODEL}>{DEFAULT_MODEL}</option>}
                  {groups.map(([provider, list]) => (
                    <optgroup key={provider} label={provider}>
                      {list.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>

                <select
                  className={`composer-select ${reasoningEffort !== "off" ? "on" : ""}`}
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
                  className={`composer-select ${policyMode !== "ask" ? "on" : ""}`}
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

                <label
                  className={`composer-toggle ${autoRoute ? "on" : ""}`}
                  title="Switch models automatically when the current one cannot handle the message"
                >
                  <input
                    type="checkbox"
                    checked={autoRoute}
                    onChange={(e) => changeAutoRoute(e.target.checked)}
                  />
                  auto-route
                </label>

                <span className="composer-spacer" />

                {selectedModel && (
                  <span className="composer-caps" title={`${selectedModel.label} capabilities`}>
                    {selectedModel.capabilities.toolCalls && <span className="cap">tools</span>}
                    {selectedModel.capabilities.vision && <span className="cap">vision</span>}
                    {selectedModel.capabilities.reasoning && <span className="cap">reasoning</span>}
                    {selectedModel.contextWindow && (
                      <span className="cap muted">
                        {Math.round(selectedModel.contextWindow / 1000)}k ctx
                      </span>
                    )}
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
