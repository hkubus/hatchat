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

## Verified so far

- `cargo check --all-targets` clean; app launches under Xvfb and renders the
  chat against a live server.
- CORS verified by hand against a running server: allowed origin gets
  `access-control-allow-origin`, a foreign origin does not, preflight returns
  204 with the right methods/headers, and unauthenticated requests still 401.
