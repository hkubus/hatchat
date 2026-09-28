import type { ModelInfo } from "@hat/core";
import { useEffect, useMemo, useState } from "react";
import type { HatConfig } from "./runtime";
import { isNativeShell, normalizeServerUrl, saveConfig } from "./runtime";
import type { JsonSchemaProperty, PluginDescriptor, ProviderStatus, RunnerSummary } from "./api";
import {
  deleteSecret,
  setPluginConfig,
  setPluginEnabled,
  setSecret,
} from "./api";
import { capTags, contextTag } from "./capTags";
import CreatorIcon from "./CreatorIcon";
import { creatorName, creatorSlug } from "./creators";

interface SettingsProps {
  models: ModelInfo[];
  runners: RunnerSummary[];
  providers: ProviderStatus[];
  plugins: PluginDescriptor[];
  model: string;
  /** Connection settings; only present in native shells. */
  config?: HatConfig | null;
  onModelChange: (model: string) => void;
  onChanged: () => Promise<void>;
}

function ConnectionForm({ config }: { config: HatConfig }): JSX.Element {
  const [serverUrl, setServerUrl] = useState(config.serverUrl);
  const [token, setToken] = useState(config.token);
  const [message, setMessage] = useState<string | null>(null);

  async function persist(next: HatConfig): Promise<void> {
    setMessage(null);
    try {
      await saveConfig(next);
      // Everything on screen came from the old server; reload to reset state.
      window.location.reload();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="settings-row">
      <div className="settings-row-head">
        <span className="settings-name">hat server</span>
      </div>
      <div className="settings-row-body">
        <input
          value={serverUrl}
          aria-label="Server URL"
          placeholder="http://127.0.0.1:8787"
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <input
          type="password"
          value={token}
          aria-label="Access token"
          placeholder="Access token"
          onChange={(e) => setToken(e.target.value)}
        />
        <button onClick={() => void persist({ serverUrl: normalizeServerUrl(serverUrl), token })}>
          Save
        </button>
        <button className="ghost" onClick={() => void persist({ serverUrl: "", token: "" })}>
          Disconnect
        </button>
        {message && <span className="settings-msg">{message}</span>}
      </div>
    </div>
  );
}

function statusClass(status: PluginDescriptor["status"]): string {
  if (status === "active") return "ok";
  if (status === "needs-config") return "warn";
  if (status === "error") return "bad";
  return "";
}

function ProviderRow({
  provider,
  onChanged,
}: {
  provider: ProviderStatus;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (!value.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await setSecret(provider.secretName, value.trim());
      setValue("");
      setMessage("saved");
      await onChanged();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clear(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      await deleteSecret(provider.secretName);
      setMessage("cleared");
      await onChanged();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-row">
      <div className="settings-row-head">
        <span className="settings-name">{provider.label}</span>
        <span className={`pill ${provider.registered ? "ok" : provider.configured ? "warn" : ""}`}>
          {provider.registered ? "active" : provider.configured ? "key set" : "not configured"}
        </span>
      </div>
      <div className="settings-row-body">
        <input
          className="secret-input"
          type="password"
          autoComplete="off"
          placeholder={
            provider.configured ? "•••••••• (enter a new key to replace)" : provider.secretName
          }
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
        />
        <button onClick={() => void save()} disabled={busy || !value.trim()}>
          Save
        </button>
        {provider.configured && (
          <button className="ghost" onClick={() => void clear()} disabled={busy}>
            Clear
          </button>
        )}
        {message && <span className="settings-msg">{message}</span>}
      </div>
    </div>
  );
}

function ConfigField({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: JsonSchemaProperty;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = <span className="cfg-label">{schema.description ?? name}</span>;

  if (schema.type === "boolean") {
    return (
      <label className="cfg-field cfg-check">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  const { type } = schema;
  if (type === "string" || type === undefined) {
    if (/json/i.test(name)) {
      return (
        <label className="cfg-field">
          {label}
          <textarea
            className="cfg-textarea"
            rows={4}
            value={value === undefined || value === null ? "" : String(value)}
            onChange={(e) => onChange(e.target.value)}
          />
        </label>
      );
    }
  }

  return (
    <label className="cfg-field">
      {label}
      {schema.enum ? (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {schema.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={schema.type === "number" || schema.type === "integer" ? "number" : "text"}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) =>
            onChange(
              schema.type === "number" || schema.type === "integer"
                ? e.target.value === ""
                  ? undefined
                  : Number(e.target.value)
                : e.target.value,
            )
          }
        />
      )}
    </label>
  );
}

function PluginCard({
  plugin,
  onChanged,
}: {
  plugin: PluginDescriptor;
  onChanged: () => Promise<void>;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>(() => ({ ...plugin.config }));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setConfig({ ...plugin.config });
  }, [plugin]);

  const properties = plugin.configSchema?.properties ?? {};
  const hasConfig = Object.keys(properties).length > 0;

  async function toggle(enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      await setPluginEnabled(plugin.id, enabled);
      await onChanged();
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      await setPluginConfig(plugin.id, config);
      setMessage("saved");
      await onChanged();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-row">
      <div className="settings-row-head">
        <span className="settings-name">{plugin.name}</span>
        <span className="settings-version">v{plugin.version}</span>
        <span className={`pill ${statusClass(plugin.status)}`}>{plugin.status}</span>
        <span className="pill muted">{plugin.source}</span>
        <label className="cfg-toggle">
          <input
            type="checkbox"
            checked={plugin.enabled}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          enabled
        </label>
      </div>
      {plugin.description && <p className="settings-hint">{plugin.description}</p>}
      {plugin.error && <p className="settings-error">{plugin.error}</p>}
      <div className="settings-meta">
        <span className="settings-hint mono">{plugin.id}</span>
        {plugin.requiresSecrets.length > 0 && (
          <span className="settings-hint">needs: {plugin.requiresSecrets.join(", ")}</span>
        )}
        {plugin.permissions.length > 0 && (
          <span className="settings-hint">perms: {plugin.permissions.join(", ")}</span>
        )}
      </div>

      {hasConfig && (
        <div className="cfg-form">
          {Object.entries(properties).map(([key, schema]) => (
            <ConfigField
              key={key}
              name={key}
              schema={schema}
              value={config[key]}
              onChange={(value) => setConfig((prev) => ({ ...prev, [key]: value }))}
            />
          ))}
          <div className="cfg-actions">
            <button className="ghost" onClick={() => void save()} disabled={busy}>
              Save config
            </button>
            {message && <span className="settings-msg">{message}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Settings({
  models,
  runners,
  providers,
  plugins,
  model,
  config,
  onModelChange,
  onChanged,
}: SettingsProps) {
  const groups = useMemo(() => {
    const map = new Map<string, ModelInfo[]>();
    for (const m of models) {
      const list = map.get(m.provider) ?? [];
      list.push(m);
      map.set(m.provider, list);
    }
    return [...map.entries()];
  }, [models]);

  return (
    <div className="settings">
      <section className="settings-section">
        <h2>Providers &amp; API keys</h2>
        <p className="settings-hint">
          Keys are encrypted at rest on the server and never sent back to the browser. Provider
          plugins activate as soon as their key is set.
        </p>
        {providers.map((p) => (
          <ProviderRow key={p.id} provider={p} onChanged={onChanged} />
        ))}
      </section>

      <section className="settings-section">
        <h2>Plugins ({plugins.length})</h2>
        <p className="settings-hint">
          Built-in and external plugins contribute providers and tools. Disabling a plugin
          unregisters everything it adds.
        </p>
        {plugins.map((plugin) => (
          <PluginCard key={plugin.id} plugin={plugin} onChanged={onChanged} />
        ))}
      </section>

      {isNativeShell() && config && (
        <section className="settings-section">
          <h2>Connection</h2>
          <p className="settings-hint">
            This desktop app is a client: it stores the server address and token on this machine and
            talks to a hat server you run separately.
          </p>
          <ConnectionForm config={config} />
        </section>
      )}

      <section className="settings-section">
        <h2>Preferences</h2>
        <div className="settings-row">
          <div className="settings-row-head">
            <span className="settings-name">Default model</span>
          </div>
          <div className="settings-row-body">
            <select className="model" value={model} onChange={(e) => onModelChange(e.target.value)}>
              {groups.length === 0 && <option value="fake/fake-agent">fake/fake-agent</option>}
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
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>Execution runners</h2>
        {runners.length === 0 ? (
          <p className="settings-hint">
            No runner connected. Start the runner and make sure it can reach the server's{" "}
            <code>/link</code> endpoint.
          </p>
        ) : (
          runners.map((r) => (
            <div key={r.id} className="settings-row">
              <div className="settings-row-head">
                <span className="settings-name">{r.id}</span>
                <span className="pill ok">connected</span>
              </div>
              <div className="settings-row-body">
                <span className="settings-hint">
                  {r.capabilities.os}/{r.capabilities.arch} · tags:{" "}
                  {r.capabilities.tags.join(", ") || "none"}
                </span>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="settings-section">
        <h2>Models ({models.length})</h2>
        {models.map((m) => (
          <div key={m.id} className="settings-row compact">
            <CreatorIcon slug={creatorSlug(m)} name={creatorName(m)} size={14} />
            <span className="settings-name mono">{m.id}</span>
            <span className="caps">
              {capTags(m.capabilities).map((tag) => (
                <span className="cap" key={tag.key} title={tag.title}>
                  {tag.label}
                </span>
              ))}
              {contextTag(m.contextWindow) && (
                <span className="ctx-label" title={contextTag(m.contextWindow)!.title}>
                  {contextTag(m.contextWindow)!.label}
                </span>
              )}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
