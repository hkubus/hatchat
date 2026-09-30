import { useState } from "react";
import type { HatConfig } from "./runtime";
import { normalizeServerUrl, saveConfig } from "./runtime";

/**
 * First-run screen for native shells (Tauri desktop, and later mobile).
 *
 * The shell loads the UI from its own asset origin, so it needs to be told
 * which hat server to talk to. The token is the server's `HAT_AUTH_TOKEN`;
 * leave it empty for a server running without auth.
 */
export default function Connect({
  initial,
  notice,
  onConnected,
}: {
  initial: HatConfig;
  /** Why the screen is back, e.g. the server stopped accepting the token. */
  notice?: string;
  onConnected: (config: HatConfig) => void;
}): JSX.Element {
  const [serverUrl, setServerUrl] = useState(initial.serverUrl);
  const [token, setToken] = useState(initial.token);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const base = normalizeServerUrl(serverUrl);
    if (!base) {
      setError("Enter the address of your hat server");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Probe before saving: proves the address is reachable, that the server
      // allows this app's origin, and that it accepts the token.
      const res = await fetch(`${base}/api/health`, {
        headers: token.trim() ? { authorization: `Bearer ${token.trim()}` } : {},
      });
      if (res.status === 401) {
        throw new Error(
          token.trim()
            ? "The server did not accept this token. It must be the server's HAT_AUTH_TOKEN."
            : "This server requires a token: its HAT_AUTH_TOKEN.",
        );
      }
      if (!res.ok) throw new Error(`server responded ${res.status}`);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
      return;
    }
    try {
      const saved = await saveConfig({ serverUrl: base, token });
      onConnected(saved);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="brand">Hat</div>
        {notice && <div className="error">{notice}</div>}
        <p className="settings-hint">
          Connect to a hat server. Run <code>pnpm dev</code> on the machine that hosts it, then point
          this app at that address.
        </p>
        <input
          autoFocus
          value={serverUrl}
          placeholder="http://127.0.0.1:8787"
          aria-label="Server URL"
          onChange={(e) => setServerUrl(e.target.value)}
        />
        <input
          type="password"
          value={token}
          placeholder="Access token (optional)"
          aria-label="Access token"
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="settings-hint">
          The token is the server&apos;s <code>HAT_AUTH_TOKEN</code>. Leave it blank if the server runs
          without auth.
        </p>
        <button type="submit" disabled={busy || !serverUrl.trim()}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
