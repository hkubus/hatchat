# Desktop app (Tauri)

Status: **in progress.** The app builds and runs; the shell is deliberately thin.

## Goal & shape

`apps/desktop` is a **native window around the existing web UI**. It contains no
chat logic, no provider keys, and no database — it is a client that stores the
address of a hat server and the token used to reach it:

```
apps/desktop (Tauri v2, Rust shell)
  └── apps/web (the same React UI the browser app serves)
        └── hat server :8787  (sessions, secrets, approvals)
              └── runner      (execution)
```

Because the UI is the same bundle, `apps/web` stays the single place chat
behaviour lives; the desktop app is the shell, packaging, and connection
settings. There is deliberately **no duplicated `apps/desktop` frontend**.

## Running it

Start a server (and runner) first — the desktop app is a client, it does not
spawn either:

```sh
pnpm dev:server
pnpm dev:runner
pnpm dev:desktop      # opens the native window against the vite dev server
```

`tauri dev` runs the web dev server itself via `beforeDevCommand`, so
`pnpm --filter @hat/desktop dev` is enough once the API server is up. The window
opens on the connect screen; enter `http://127.0.0.1:8787` and, if the server has
`HAT_AUTH_TOKEN` set, that token.

For a real bundle:

```sh
pnpm --filter @hat/web build
pnpm --filter @hat/desktop bundle     # or: pnpm bundle (turbo, builds web first)
```

Artifacts land in `apps/desktop/src-tauri/target/release/bundle/`
(AppImage/deb/rpm on Linux, dmg on macOS, msi/nsis on Windows). Requires the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for the host
platform (Rust, plus `libwebkit2gtk-4.1-dev` and friends on Linux).

## How the UI reaches the API

The shell loads the UI from its own asset origin (`tauri://localhost` on
macOS/Linux, `http://tauri.localhost` on Windows), so `/api/...` no longer
resolves to the server. Two pieces make that work:

1. **`apps/web/src/runtime.ts`** resolves every request against a runtime
   connection config instead of hardcoding a relative path. In the browser the
   config is empty and everything stays same-origin behind the vite proxy, so
   **the browser app is unaffected**. The config is read through a tiny bridge
   rather than by importing a host SDK, so `apps/web` has no Tauri (or Expo)
   dependency:

   | Host | Bridge |
   |---|---|
   | Browser | `localStorage` (`hat.connection`) |
   | Tauri | `window.__TAURI__.core.invoke` → `load_config` / `save_config` Rust commands |

   The Rust side stores `{ serverUrl, token }` in the app config dir as
   `connection.json`, written `0600` on unix.

2. **CORS on the server**, restricted to an allowlist
   (`HAT_CORS_ORIGINS`, defaulting to the three Tauri origins). Credentials are
   *not* allowed: the desktop app authenticates with the **bearer token**
   (`HAT_AUTH_TOKEN`), which is CSRF-exempt, while the browser app stays
   same-origin and keeps its session cookie + double-submit CSRF. This is the
   same conclusion the [iOS plan](ios-app-plan.md) reaches for native clients.

Attachments are fetched through the API client and rendered as object URLs
(`MessageImage.tsx`) because an `<img src>` request cannot carry the bearer
header.

## Deliberate non-goals for now

- **No sidecars.** The app does not bundle or spawn the server/runner; that is a
  separate milestone if we want a one-click install.
- **No updater, tray, deep links, or autostart** yet — nothing in the M7 goal
  needs them.
- **Token at rest** is a `0600` file, not an OS keychain. The token is not a hat
  secret (it authenticates *to* the server, which holds the real ones), but
  moving it to the platform keychain via `tauri-plugin-stronghold` is the obvious
  hardening step before distributing binaries.
- **Single window, single server.** No support for switching servers without a
  reload (Settings → Connection → Disconnect returns to the connect screen).

## The WebKit streaming problem (and the fix)

The first end-to-end attempt streamed the assistant text and then **froze**: the
tool card and its Approve/Deny buttons never appeared, even though the server
had written every frame.

Diagnosis, in order:

1. `curl` against the same endpoint received all ten frames — so not the server.
2. A logging proxy in front of the server showed every frame reaching the
   webview's socket as its own chunk, so not the network.
3. Instrumenting the page's SSE reader showed it had consumed five chunks and
   then simply stopped awaiting more, while the page kept polling other
   endpoints normally.

That is [WebKit bug 322545](https://bugs.webkit.org/show_bug.cgi?id=322545): a
streaming `fetch()` body is **withheld until the next network chunk arrives**
when the reader is busy. Whenever a turn pauses — waiting for a tool approval, or
on a slow provider — the events the server already sent sit in WebKit's buffer
until something else arrives on the socket.

The fix is the standard SSE keepalive: the turn stream writes a `: keepalive`
comment every `HAT_SSE_KEEPALIVE_MS` (default 1s) while the turn is idle
(`packages/server/src/sse.ts`, unit-tested). The withheld frames are delivered
on the next tick, and idle streams no longer risk being dropped by proxies.

This affects any WebKitGTK client (the Linux desktop app). Chromium/WebKit-on-macOS
do not need it, but the keepalive is harmless for them.

## Verified

Driven end to end under Xvfb against a live server + runner:

- `cargo check --all-targets` clean; the window launches and renders.
- Connect screen → bearer token → sessions, models, plugins, runner load.
- `run: echo …` → text streams → tool card appears (after the keepalive fix)
  → **Approve** → the runner executes → result and final message stream back.
- Settings → Connection shows the persisted server URL and masked token.
- CORS by hand against a running server: the allowed origin gets
  `access-control-allow-origin`, a foreign origin does not, preflight returns
  204 with the right methods/headers, and unauthenticated requests still 401.
- `pnpm typecheck`, `pnpm test`, and the SSE keepalive unit tests pass.

Not verified here: a release bundle (`tauri build` needs the bundling toolchain
for each platform) and the macOS/Windows shells.
