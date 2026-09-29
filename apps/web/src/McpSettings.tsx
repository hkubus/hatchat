import { useEffect, useMemo, useRef, useState } from "react";

export interface McpServerDraft {
  key: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  argsText: string;
  envText: string;
  url: string;
  token: string;
  trustReadOnlyHint: boolean;
}

interface ParsedServer {
  name?: string;
  transport?: string;
  command?: string;
  args?: unknown;
  env?: unknown;
  url?: string;
  token?: string;
  trustReadOnlyHint?: unknown;
}

function newKey(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizePreview(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_]/g, "_") || "server";
  return `mcp__${clean}__*`;
}

function parseArgsText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

function parseEnvText(text: string): { env: Record<string, string>; errors: string[] } {
  const env: Record<string, string> = {};
  const errors: string[] = [];
  text.split("\n").forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      errors.push(`env line ${i + 1}: expected KEY=value`);
      return;
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);
    if (!key) {
      errors.push(`env line ${i + 1}: empty key`);
      return;
    }
    env[key] = value;
  });
  return { env, errors };
}

function draftFromServer(server: ParsedServer): McpServerDraft {
  const args = Array.isArray(server.args) ? (server.args as unknown[]).map(String).join("\n") : "";
  const env =
    server.env && typeof server.env === "object"
      ? Object.entries(server.env as Record<string, unknown>)
          .map(([k, v]) => `${k}=${String(v ?? "")}`)
          .join("\n")
      : "";
  return {
    key: newKey(),
    name: typeof server.name === "string" ? server.name : "",
    transport: server.transport === "http" ? "http" : "stdio",
    command: typeof server.command === "string" ? server.command : "",
    argsText: args,
    envText: env,
    url: typeof server.url === "string" ? server.url : "",
    token: typeof server.token === "string" ? server.token : "",
    trustReadOnlyHint: server.trustReadOnlyHint !== false,
  };
}

function parseConfigToDrafts(config: Record<string, unknown>): {
  drafts: McpServerDraft[];
  rawError: string | null;
} {
  const structured = config.servers;
  if (Array.isArray(structured)) {
    return { drafts: (structured as ParsedServer[]).map(draftFromServer), rawError: null };
  }
  const json = config.serversJson;
  if (typeof json !== "string" || !json.trim()) return { drafts: [], rawError: null };
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return { drafts: [], rawError: "servers JSON must be an array." };
    return { drafts: (parsed as ParsedServer[]).map(draftFromServer), rawError: null };
  } catch {
    return { drafts: [], rawError: "Could not parse servers JSON — fix it below or start fresh." };
  }
}

export function draftToServer(draft: McpServerDraft): Record<string, unknown> {
  const { env } = parseEnvText(draft.envText);
  const base: Record<string, unknown> = {
    name: draft.name.trim(),
    transport: draft.transport,
  };
  if (draft.transport === "http") {
    base.url = draft.url.trim();
    if (draft.token.trim()) base.token = draft.token.trim();
  } else {
    base.command = draft.command.trim();
    const args = parseArgsText(draft.argsText);
    if (args.length > 0) base.args = args;
    if (Object.keys(env).length > 0) base.env = env;
  }
  // Only the opt-out is stored; the server treats a missing value as true.
  if (!draft.trustReadOnlyHint) base.trustReadOnlyHint = false;
  return base;
}

function validateDraft(draft: McpServerDraft, names: Map<string, number>): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) {
    errors.push("Name is required.");
  } else if ((names.get(draft.name.trim()) ?? 0) > 1) {
    errors.push(`Duplicate name "${draft.name.trim()}".`);
  }
  if (draft.transport === "http") {
    if (!draft.url.trim()) errors.push("URL is required for HTTP servers.");
    else if (!/^https?:\/\//i.test(draft.url.trim())) errors.push("URL must start with http:// or https://.");
  } else {
    if (!draft.command.trim()) errors.push("Command is required for stdio servers.");
  }
  errors.push(...parseEnvText(draft.envText).errors);
  return errors;
}

function blankDraft(transport: "stdio" | "http"): McpServerDraft {
  return {
    key: newKey(),
    name: "",
    transport,
    command: transport === "stdio" ? "npx" : "",
    argsText: transport === "stdio" ? "-y\n@modelcontextprotocol/server-filesystem\n/data" : "",
    envText: "",
    url: transport === "http" ? "https://" : "",
    token: "",
    trustReadOnlyHint: true,
  };
}

export default function McpConfigEditor({
  config,
  onChange,
  onValidityChange,
}: {
  config: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onValidityChange?: (valid: boolean) => void;
}) {
  const initial = useMemo(() => parseConfigToDrafts(config), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [drafts, setDrafts] = useState<McpServerDraft[]>(initial.drafts);
  const [rawError, setRawError] = useState<string | null>(initial.rawError);
  const [requireApproval, setRequireApproval] = useState<boolean>(
    config.requireApproval !== false,
  );
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const d of initial.drafts) map[d.key] = true;
    return map;
  });
  const [showRaw, setShowRaw] = useState(false);
  const [rawText, setRawText] = useState<string | null>(null);
  const [rawApplyError, setRawApplyError] = useState<string | null>(null);
  const lastEmitted = useRef<string>("");

  // Sync when the server round-trips a new config (e.g. after save).
  useEffect(() => {
    const signature = JSON.stringify(config);
    if (signature === lastEmitted.current) return;
    const parsed = parseConfigToDrafts(config);
    setDrafts(parsed.drafts);
    setRawError(parsed.rawError);
    setRequireApproval(config.requireApproval !== false);
    setExpanded(() => {
      const next: Record<string, boolean> = {};
      for (const d of parsed.drafts) next[d.key] = true;
      return next;
    });
  }, [config]);

  const nameCounts = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of drafts) {
      const name = d.name.trim();
      if (!name) continue;
      map.set(name, (map.get(name) ?? 0) + 1);
    }
    return map;
  }, [drafts]);

  const errorsByKey = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const d of drafts) map.set(d.key, validateDraft(d, nameCounts));
    return map;
  }, [drafts, nameCounts]);

  const allValid = useMemo(
    () => [...errorsByKey.values()].every((list) => list.length === 0),
    [errorsByKey],
  );

  useEffect(() => {
    onValidityChange?.(allValid);
  }, [allValid, onValidityChange]);

  // Push structured + legacy JSON string upstream so old servers keep working.
  useEffect(() => {
    const servers = drafts.map(draftToServer);
    const next = {
      ...config,
      servers,
      serversJson: JSON.stringify(servers, null, 2),
      requireApproval,
    };
    const signature = JSON.stringify(next);
    if (signature !== lastEmitted.current) {
      lastEmitted.current = signature;
      onChange(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, requireApproval]);

  function updateDraft(key: string, patch: Partial<McpServerDraft>): void {
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }

  function addServer(transport: "stdio" | "http"): void {
    const draft = blankDraft(transport);
    setDrafts((prev) => [...prev, draft]);
    setExpanded((prev) => ({ ...prev, [draft.key]: true }));
  }

  function removeServer(key: string): void {
    setDrafts((prev) => prev.filter((d) => d.key !== key));
  }

  function applyRaw(): void {
    if (rawText === null) return;
    try {
      const parsed: unknown = JSON.parse(rawText);
      if (!Array.isArray(parsed)) {
        setRawApplyError("JSON must be an array of servers.");
        return;
      }
      const nextDrafts = (parsed as ParsedServer[]).map(draftFromServer);
      setDrafts(nextDrafts);
      setExpanded(() => {
        const next: Record<string, boolean> = {};
        for (const d of nextDrafts) next[d.key] = true;
        return next;
      });
      setRawError(null);
      setRawApplyError(null);
      setShowRaw(false);
      setRawText(null);
    } catch {
      setRawApplyError("Invalid JSON — check commas and quotes.");
    }
  }

  const serialized = useMemo(() => JSON.stringify(drafts.map(draftToServer), null, 2), [drafts]);
  const effectiveRaw = rawText ?? serialized;

  return (
    <div className="mcp">
      {rawError && <p className="mcp-notice">{rawError}</p>}

      <div className="mcp-toolbar">
        <span className="mcp-count" aria-live="polite">
          {drafts.length === 0 ? "No servers" : `${drafts.length} server${drafts.length === 1 ? "" : "s"}`}
        </span>
        <div className="mcp-toolbar-actions">
          <button type="button" className="ghost mcp-add" onClick={() => addServer("stdio")}>
            + Stdio
          </button>
          <button type="button" className="ghost mcp-add" onClick={() => addServer("http")}>
            + HTTP
          </button>
        </div>
      </div>

      {drafts.length === 0 ? (
        <div className="mcp-empty">
          <p className="mcp-empty-title">Connect your first MCP server</p>
          <p className="mcp-empty-hint">
            Stdio servers run as commands on your runner (e.g.{" "}
            <code>npx -y @modelcontextprotocol/server-filesystem /data</code>). HTTP servers are
            remote endpoints you call over the network.
          </p>
          <div className="mcp-empty-actions">
            <button type="button" onClick={() => addServer("stdio")}>
              Add stdio server
            </button>
            <button type="button" className="ghost" onClick={() => addServer("http")}>
              Add HTTP server
            </button>
          </div>
        </div>
      ) : (
        <div className="mcp-list">
          {drafts.map((draft, index) => {
            const errors = errorsByKey.get(draft.key) ?? [];
            const isOpen = expanded[draft.key] ?? true;
            return (
              <div key={draft.key} className={`mcp-card${errors.length > 0 ? " invalid" : ""}`}>
                <button
                  type="button"
                  className="mcp-card-head"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded((prev) => ({ ...prev, [draft.key]: !isOpen }))}
                >
                  <span className="mcp-index">{index + 1}</span>
                  <span className="mcp-card-name">{draft.name.trim() || "Unnamed server"}</span>
                  <span className={`pill ${draft.transport === "http" ? "warn" : "ok"}`}>
                    {draft.transport === "http" ? "http" : "stdio"}
                  </span>
                  {errors.length > 0 && <span className="pill bad">{errors.length} issue{errors.length === 1 ? "" : "s"}</span>}
                  <span className="mcp-prefix mono" title="Tool name prefix">
                    {sanitizePreview(draft.name.trim())}
                  </span>
                  <span className={`mcp-chevron${isOpen ? " open" : ""}`} aria-hidden="true">
                    ▾
                  </span>
                </button>

                {isOpen && (
                  <div className="mcp-card-body">
                    <div className="mcp-grid">
                      <label className="mcp-field mcp-span">
                        <span className="mcp-label">Name</span>
                        <input
                          type="text"
                          placeholder="fs"
                          value={draft.name}
                          onChange={(e) => updateDraft(draft.key, { name: e.target.value })}
                          aria-label={`Server ${index + 1} name`}
                        />
                      </label>

                      <div className="mcp-field mcp-span">
                        <span className="mcp-label" id={`transport-${draft.key}`}>
                          Transport
                        </span>
                        <div
                          className="mcp-segmented"
                          role="group"
                          aria-labelledby={`transport-${draft.key}`}
                        >
                          {(["stdio", "http"] as const).map((t) => (
                            <button
                              key={t}
                              type="button"
                              className={`mcp-seg${draft.transport === t ? " active" : ""}`}
                              aria-pressed={draft.transport === t}
                              onClick={() => updateDraft(draft.key, { transport: t })}
                            >
                              {t === "stdio" ? "Stdio · runner" : "HTTP · remote"}
                            </button>
                          ))}
                        </div>
                        <span className="mcp-hint">
                          {draft.transport === "stdio"
                            ? "Runs as a command on your connected runner."
                            : "Calls a remote Streamable HTTP endpoint."}
                        </span>
                      </div>

                      {draft.transport === "stdio" ? (
                        <>
                          <label className="mcp-field">
                            <span className="mcp-label">Command</span>
                            <input
                              type="text"
                              className="mono"
                              placeholder="npx"
                              value={draft.command}
                              onChange={(e) => updateDraft(draft.key, { command: e.target.value })}
                              aria-label={`Server ${index + 1} command`}
                            />
                          </label>
                          <label className="mcp-field">
                            <span className="mcp-label">Args <span className="mcp-label-dim">· one per line</span></span>
                            <textarea
                              className="mcp-textarea mono"
                              rows={3}
                              placeholder={"-y\n@modelcontextprotocol/server-filesystem\n/data"}
                              value={draft.argsText}
                              onChange={(e) => updateDraft(draft.key, { argsText: e.target.value })}
                              aria-label={`Server ${index + 1} arguments`}
                            />
                          </label>
                          <label className="mcp-field mcp-span">
                            <span className="mcp-label">Env <span className="mcp-label-dim">· KEY=value per line</span></span>
                            <textarea
                              className="mcp-textarea mono"
                              rows={2}
                              placeholder={"API_KEY=…\n# lines starting with # are ignored"}
                              value={draft.envText}
                              onChange={(e) => updateDraft(draft.key, { envText: e.target.value })}
                              aria-label={`Server ${index + 1} environment`}
                            />
                          </label>
                        </>
                      ) : (
                        <>
                          <label className="mcp-field mcp-span">
                            <span className="mcp-label">URL</span>
                            <input
                              type="text"
                              className="mono"
                              placeholder="https://example.com/mcp"
                              value={draft.url}
                              onChange={(e) => updateDraft(draft.key, { url: e.target.value })}
                              aria-label={`Server ${index + 1} URL`}
                            />
                          </label>
                          <label className="mcp-field mcp-span">
                            <span className="mcp-label">Token <span className="mcp-label-dim">· optional</span></span>
                            <input
                              type="password"
                              className="mono"
                              autoComplete="off"
                              placeholder="Bearer token (stored with config)"
                              value={draft.token}
                              onChange={(e) => updateDraft(draft.key, { token: e.target.value })}
                              aria-label={`Server ${index + 1} token`}
                            />
                          </label>
                        </>
                      )}
                    </div>

                    {errors.length > 0 && (
                      <ul className="mcp-errors" role="alert">
                        {errors.map((err) => (
                          <li key={err}>{err}</li>
                        ))}
                      </ul>
                    )}

                    <div className="mcp-card-foot">
                      <button
                        type="button"
                        className="ghost mcp-remove"
                        onClick={() => removeServer(draft.key)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <label className="mcp-approval">
        <input
          type="checkbox"
          checked={requireApproval}
          onChange={(e) => setRequireApproval(e.target.checked)}
        />
        <span>
          <span className="mcp-approval-title">Require approval before running MCP tools</span>
          <span className="mcp-hint">
            Recommended — the model asks before calling a server tool. Tools a server marks
            read-only skip this unless that server sets <code>"trustReadOnlyHint": false</code>.
          </span>
        </span>
      </label>

      <div className="mcp-raw-toggle">
        <button
          type="button"
          className="ghost mcp-raw-btn"
          aria-expanded={showRaw}
          onClick={() => {
            setShowRaw((v) => !v);
            setRawText(null);
            setRawApplyError(null);
          }}
        >
          {showRaw ? "Hide JSON" : "Advanced: edit JSON"}
        </button>
      </div>

      {showRaw && (
        <div className="mcp-raw">
          <textarea
            className="mcp-textarea mono"
            rows={8}
            spellCheck={false}
            value={effectiveRaw}
            onChange={(e) => setRawText(e.target.value)}
            aria-label="MCP servers raw JSON"
          />
          {rawApplyError && (
            <p className="mcp-errors" role="alert">
              {rawApplyError}
            </p>
          )}
          <div className="mcp-raw-actions">
            <button type="button" className="ghost" onClick={applyRaw}>
              Apply JSON
            </button>
            <span className="mcp-hint">Applies to the cards above; saving still uses Save config.</span>
          </div>
        </div>
      )}
    </div>
  );
}
