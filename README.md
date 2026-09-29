# hat

A plugin-based, multi-provider chat app. M0 wires the hardest architectural
decision first: **the chat server never executes anything itself** — a separate
runner process does, over an authenticated WebSocket link.

```
web (React) ──SSE──▶ server ──WS /link──▶ runner ──▶ shell / fs / (later MCP)
                      │
                      ├─ providers (M0: fake; M1: openrouter, deepseek)
                      ├─ kernel agent loop + tool loop
                      ├─ approvals (client-gated)
                      └─ auth + secrets (never on the runner)
```

## Layout

| Package | Role |
|---|---|
| `@hat/core` | Canonical contracts: messages, provider, tool, `ExecutionHost`, `ToolContext`, kernel events |
| `@hat/runner-protocol` | Versioned zod schemas for the server↔runner link |
| `@hat/kernel` | Registries, `PluginHost`, and the agent loop (stream → tool calls → approval → execute → repeat) |
| `@hat/plugin-sdk` | Re-exports `z` + core types and `definePlugin()` for authoring plugins |
| `@hat/host-remote` | `ExecutionHost` over the link (the server has no local exec adapter) |
| `@hat/tool-shell` | `shell_exec` built-in tool |
| `@hat/provider-openai` | Shared OpenAI-compatible streaming client (SSE, tools, reasoning, vision, usage) |
| `@hat/provider-openrouter` / `@hat/provider-deepseek` | Provider configs + per-model capability metadata |
| `@hat/crypto` | AES-256-GCM secret encryption + master-key loading |
| `@hat/store-sqlite` | SQLite sessions, branching message tree, encrypted secrets |
| `@hat/server` | Hono API, SSE turn stream, approval broker, runner registry, providers |
| `@hat/runner` | Dial-out execution host: workspaces, process execution, fs, fetch |
| `apps/web` | Streaming UI: grouped model picker, tool cards, approvals, branch navigation |
| `apps/desktop` | Tauri v2 shell around `apps/web` for the same UI in a native window |
| `apps/mobile` | React Native (Expo) iOS client: the same server, screens rewritten for touch |

## Providers (M1)

OpenRouter and DeepSeek share one OpenAI-compatible client
(`@hat/provider-openai`): streaming, tool-call assembly, `reasoning` /
`reasoning_content` deltas, vision content parts, and usage.

A provider is registered only when its key is present. Set keys via env
(`OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`) or at runtime:

```sh
curl -X POST localhost:8787/api/secrets \
  -H 'content-type: application/json' \
  -d '{"name":"OPENROUTER_API_KEY","value":"sk-or-..."}'
# restart the server to register the provider
```

Capabilities are per model and drive the loop: `deepseek-reasoner` reports
`toolCalls: false`, so tools are not offered to it. OpenRouter capabilities are
derived from each model's `supported_parameters` and `input_modalities`.

## Authentication (M6)

Single-user password auth. Set `HAT_AUTH_PASSWORD` (or a precomputed
`HAT_AUTH_PASSWORD_HASH=scrypt$<salt>$<hash>`) to require login; leave unset and
the API is open (dev only).

- `POST /api/auth/login` verifies the password with **scrypt** and sets an
  HttpOnly, SameSite=Lax **signed session cookie** (HMAC over a payload with an
  expiry) plus a readable `hat_csrf` cookie.
- Mutating requests authenticated by cookie must send `x-csrf-token` matching
  the cookie (double-submit); bearer-token requests are exempt.
- Login is **rate-limited** (10 attempts / 15 min per IP).
- `HAT_AUTH_TOKEN` still works as a bearer credential for automation (curl,
  scripts) and bypasses CSRF.
- `HAT_COOKIE_SECURE=true` when serving over HTTPS. The web UI shows a login
  screen and a sign-out button automatically.
- Native shells (desktop/mobile) skip cookies entirely and send
  `Authorization: Bearer $HAT_AUTH_TOKEN`; they need the origin in
  `HAT_CORS_ORIGINS`.

Multi-user is intentionally out of scope (single account).

## Artifacts & object storage (M6)

Blob storage goes through an `ArtifactStore` port with two backends:

- **local** (default): files under `HAT_UPLOAD_DIR`, served by the server.
- **S3-compatible**: set `HAT_S3_BUCKET` + credentials (AWS S3, MinIO, R2, ...).
  Uploads are PUT with SigV4 header signing (no SDK), and the API hands the
  browser a **presigned GET URL** so reads go straight to the bucket.

Attachment bytes stay content-addressed (sha256) and deduped; switching backends
is config-only. Install nothing extra — SigV4 is hand-rolled and verified against
AWS's published test vector.

## Multi-runner scheduling (M6)

`RunnerRegistry` selects a runner per request: filter by requirements
(`tags`, `os`, `runtimes`) then choose the **least busy** (in-flight jobs +
processes). `GET /api/runners` reports each runner's load.

## Sandbox tier (M6)

`HAT_EXEC_SANDBOX=container` wraps every `shell_exec` on the runner in a
throwaway container (`docker run --rm -i --network <n> --memory <m> --cpus <c>
--pids-limit 512 -v <workspace>:/workspace -w /workspace <image> sh -lc <cmd>`).
Defaults to `host`. Requires a container runtime on the runner; the image should
include the tools you expect (e.g. `node:22-slim`, or your own).

## MCP (M5)

The `mcp` plugin connects to Model Context Protocol servers and exposes their
tools, namespaced as `mcp__<server>__<tool>` (auto-mapped to valid wire names).
Configure it in **Settings → Plugins → MCP servers** with a JSON array:

```json
[
  {
    "name": "fs",
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"]
  },
  { "name": "remote", "transport": "http", "url": "https://mcp.example.com/mcp", "token": "..." }
]
```

- **stdio** servers run on the **runner**, via a duplex `proc.*` link primitive
  (spawn + open stdin + streamed stdout). The server process never spawns them.
- **http** uses the Streamable HTTP transport (JSON or SSE responses, session id
  propagation) on the server.
- MCP tools carry their real JSON Schema (`Tool.parameters`), so no zod
  conversion is needed.
- Tools require approval by default. The exception is a tool whose
  `annotations` say `readOnlyHint: true` without `destructiveHint: true`: it
  runs without asking. Annotations are only hints from the server, so a missing
  or malformed hint keeps the approval. To ignore a server's hints entirely, set
  `"trustReadOnlyHint": false` on that server. `requireApproval: false` on the
  plugin still turns approval off for every MCP tool.
- `notifications/tools/list_changed` is wired; server→client requests we don't
  implement (sampling, elicitation) are declined with a JSON-RPC error, which
  servers handle gracefully.

`scripts/fake-mcp-server.mjs` is a minimal stdio server used by the smoke test.

### Runner dependency

A stdio server is spawned **on the runner**, so the `mcp` plugin cannot connect
one at boot if no runner has dialed in yet. It is wired up automatically as
runners come and go:

- a runner joining (re)spawns the servers and registers their tools;
- a runner leaving does **not** unregister the tools. The model has already been
  handed the tool list, so pulling the tools mid-turn would answer a call with
  `Unknown tool`. Instead the tool reports that no runner is connected, and
  works again once one returns.

Only the first arrival and the last departure trigger this, so a runner that
reconnects under the same id does not churn the tool list.

### Scout

[Scout](../scout) ships its own stdio MCP server, so it needs no MCP work here —
point the plugin at the built artifact and its 18 read tools appear as
`mcp__scout__*`. The MCP server runs on the runner and talks to Scout's API over
HTTP, so the runner needs to reach `scout.internal.gaycats.ovh`.

```sh
# Build the MCP server once in Scout's checkout (it is not committed).
cd ../scout && npm run build          # -> dist-mcp/mcp.js
```

Settings → Plugins → MCP servers:

```json
[
  {
    "name": "scout",
    "transport": "stdio",
    "command": "node",
    "args": ["/root/scout/dist-mcp/mcp.js"],
    "env": { "SCOUT_API_URL": "http://scout.internal.gaycats.ovh" }
  }
]
```

- `dist-mcp/mcp.js` keeps its bare imports external, so it needs Scout's
  `node_modules` next to it — it is not a standalone bundle. It also needs
  Node ≥ 22.5, which is above hat's own `engines.node: ">=20"`.
- Scout is read-only over MCP unless `SCOUT_MCP_ALLOW_WRITES` is set, which
  additionally exposes 10 mutating tools. Hat skips approval for tools marked
  `readOnlyHint`, but that trusts Scout's own labels; leaving the variable unset
  is the stronger control, and `"trustReadOnlyHint": false` makes every Scout
  tool ask.
- `scout://status` and `scout://dashboard` are MCP *resources*; hat's client
  implements tools only, so they are not exposed.
- `search_listings` and the scan tools perform real marketplace scans over the
  network and can take a couple of minutes (Scout allows 120s per request).

## Web search

The `websearch` plugin adds a `web_search` tool (title, URL, snippet) backed by
two keyless options, chosen in **Settings → Plugins → Web search**:

- **duckduckgo** (default) — scrapes DuckDuckGo's HTML endpoint; no key or
  account. It is best-effort, so markup changes can degrade or empty results.
- **searxng** — set `searxngUrl` to a self-hosted instance with the `json`
  output format enabled (`search.formats: [json]`).

`maxResults` sets the default result count (the model can pass `limit` per call,
max 20) and `requireApproval` gates each search (off by default — searches are
read-only). The search request is made by the **server process** directly, like
provider calls, so no key or query crosses the runner link.

## System prompt

Every turn is prefixed with a base system prompt that is never stored in
history. The default (`packages/server/src/prompt.ts`) establishes that hat is a
**general-purpose assistant** whose tools come from optional plugins — so the
model does not mistake one connected integration (an MCP server, the shell, a
search backend, …) for its identity or the point of the conversation. Override
it verbatim with `HAT_SYSTEM_PROMPT`. Providers that cannot take a system role
get it merged into the first user message instead.

## Browser

The `browser` plugin adds a `browser` tool backed by headless Chromium
(Playwright, `playwright-core`). It runs on the **server**, not the runner, and
keeps one page per conversation, closed after an idle timeout.

| action | what it does | approval |
|---|---|---|
| `open` | navigate to `url`; return title, text, links | auto |
| `read` | re-read the current page | auto |
| `click` | click `selector` | ask |
| `type` | fill `selector` with `text` | ask |
| `press` | press `key` (optionally on `selector`) | ask |
| `screenshot` | full-page PNG, returned as an image | auto |
| `back` | history back | auto |
| `close` | end the session | auto |

`selector` is a Playwright selector, so CSS (`#id`, `button.submit`) and
text/role selectors (`text=Sign in`, `role=button[name=Next]`) both work.

Config (Settings → Plugins → Browser): `executablePath` (or `HAT_BROWSER_PATH`),
`headless`, `maxTextChars`, `maxLinks`, `idleTimeoutMs`, `navigationTimeoutMs`,
and `requireApproval` (override; default asks only for click/type/press). A
Chromium build is required: the plugin uses the Playwright browser cache by
default, or point `executablePath` at any Chromium/Chrome binary.

## Vision + attachments (M4)

Attach images by button, paste, or drag-and-drop. Uploads are content-addressed
(sha256), deduped, and stored under `HAT_UPLOAD_DIR`; dimensions are read from
PNG/GIF/JPEG headers with no native image dependency.

Messages reference attachments by id. The kernel resolves them to base64 data
URLs **only for vision-capable models**; for others the image is replaced with an
omitted-note and the capability check warns in the chat. This keeps large
blobs out of stored messages and off the wire unless needed.

## Tool policies + capability checks (M3)

Each conversation has a **tool policy** (editable in the chat toolbar):

- `ask` (default) — tools that require approval prompt you.
- `auto` — run tools without asking.
- `allowlist` — auto-run only the listed tools, ask for the rest.
- `deny` — block all tool execution.

Policies are persisted per session. The agent also has **loop guards**: it stops
after N identical (name+args) calls and after N consecutive failures, so a model
can't spin forever. A turn is also capped at `HAT_MAX_TOOL_ITERATIONS`
(default 100) tool steps; when the budget (or a guard) is hit, the agent makes one
final call **with tools withheld** so the turn closes with a written answer
instead of dangling on a tool result, and emits a `warning` explaining why.

**Capability checks** compare the conversation's needs (vision from image
parts, tool calls once tools are used) against the selected model. On a mismatch
you get a warning in the chat and the model is left alone — switching models is
always your decision, made from the model picker in the composer.

## Plugins (M2)

Providers and tools are contributed by plugins. `PluginHost` activates them,
tracks what each one registers, and unregisters those contributions when a
plugin is disabled, errors, or is reconfigured.

- **Lifecycle**: `activate(ctx)` / `deactivate()`. `ctx.register.provider/tool`,
  `ctx.getConfig()`, `ctx.secrets`, `ctx.logger`.
- **Status**: `active`, `disabled`, `needs-config` (a required secret is unset),
  or `error` (bad config or a thrown activation, with partial registrations
  rolled back).
- **Config**: declared as a zod schema; converted to JSON Schema for the settings
  UI, which renders a form (string/number/boolean/enum) and saves via the API.
- **Secrets**: declare `requiresSecrets: ["OPENROUTER_API_KEY"]`; the plugin
  reads them through `ctx.secrets`. Values never leave the server.
- **Built-in plugins**: `openrouter`, `deepseek` (providers), `shell` (the
  `shell_exec` tool), `websearch` (the `web_search` tool), `browser` (the
  `browser` tool), `mcp`, `fake` (test provider).

### External plugins

Drop ESM modules into `HAT_PLUGINS_DIR` (default `./plugins`) that default-export
a `Plugin`. They are **trusted and in-process** (sandboxing is a later milestone):

```js
import { definePlugin, z } from "@hat/plugin-sdk";

export default definePlugin({
  id: "example-echo",
  name: "Example echo tool",
  version: "0.1.0",
  activate(ctx) {
    ctx.register.tool({
      name: "example_echo",
      description: "Echo text back.",
      schema: z.object({ text: z.string() }),
      async execute(args) {
        return [{ type: "text", text: `echo: ${args.text}` }];
      },
    });
  },
});
```

See `plugins/example.mjs`. Manage everything under **Settings → Plugins**.

## Persistence + branching (M1)

Sessions, messages and secrets live in SQLite (`node:sqlite`, no native build).
Messages form a **tree**; the active path is root→leaf, so:

- **Regenerate** an assistant message → sets the leaf to its user parent and
  re-runs, creating a sibling assistant branch.
- **Edit** a user message → sets the leaf to its parent and re-runs with new
  text, creating a sibling user branch.
- The UI shows `‹ n/m ›` on any message with siblings to switch branches.

Secrets (provider keys) are encrypted with AES-256-GCM using a master key from
`HAT_MASTER_KEY` or a generated key file.

The browser keeps the open session in `localStorage` (`hat.session`) and
reloads it on boot, so a refresh mid-conversation lands you back in it.

**A turn outlives the connection.** Refreshing the tab or switching
conversations closes the SSE stream but only *detaches* the viewer — the model
keeps running on the server, messages keep persisting, and opening the session
again reattaches to the live turn (`GET /api/sessions/:id/stream`, which
replays the pending tail and then follows). The send button's **Stop** (or
`Esc`) is a separate, explicit
`POST /api/sessions/:id/turn/cancel` that really aborts the turn, so a runaway
generation or a hung tool stops promptly instead of only being hidden.

The view only follows the stream while you are already at the bottom — scroll
up to read back without being yanked down on every delta.

## Desktop app (M7)

`apps/desktop` is a **Tauri v2 shell around the same web UI** — there is no
duplicated frontend. It is a thin client: it stores the address of a hat server
and the token used to reach it, and nothing else. Run a server (and runner)
separately, then:

```sh
pnpm dev:desktop            # native window against the vite dev server
pnpm bundle                 # release bundles in apps/desktop/src-tauri/target/release/bundle
```

The window opens on a connect screen (server URL + `HAT_AUTH_TOKEN`), also
editable later in **Settings → Connection**. Because the UI is served from the
shell's own origin, two small pieces make the API reachable from it:

- **CORS allowlist** (`HAT_CORS_ORIGINS`, defaulting to the Tauri origins plus
  the vite dev server). Credentials are *not* allowed cross-origin: the desktop
  app authenticates with the **bearer token** (CSRF-exempt), while the browser
  app stays same-origin with its session cookie.
- **Runtime connection config** (`apps/web/src/runtime.ts`) so requests resolve
  against the configured server instead of a relative path. Empty config in a
  browser tab = today's behaviour, unchanged.

One server-side change was needed to make streaming work in the WebKitGTK
webview: the turn stream now sends an SSE `: keepalive` comment every
`HAT_SSE_KEEPALIVE_MS` (1s). WebKit withholds a streamed `fetch()` body until
the next network chunk arrives (WebKit bug 322545), so a turn that pauses —
waiting on a tool approval, say — appeared to freeze even though the server had
already sent the events. Keepalives also stop proxies closing idle streams.

See [docs/desktop-app.md](docs/desktop-app.md) for the architecture, the
Tauri↔web bridge, and what's deliberately out of scope.

## iOS app (M7)

`apps/mobile` is a React Native (Expo) client for the same server — not a
WebView of the web app, so the screens are written for touch and the streaming
is native. Like the desktop shell it is a thin client: it stores the address of
a hat server and the token used to reach it, and nothing else.

```sh
pnpm dev:mobile          # Metro
cd apps/mobile && eas build --profile device --platform ios
```

Three things about it are worth knowing before changing it, all of which are
subtle and cost real time to rediscover:

- **Streaming goes through `expo/fetch`, not `fetch`.** React Native's built-in
  `fetch` buffers the response body, so a turn would not render until the model
  had finished. `EventSource` is not an option: the turn endpoint is a POST.
- **Auth is the bearer token, not a login.** `HAT_AUTH_TOKEN` is CSRF-exempt
  server-side, so the app never touches `/api/auth/*` and needs no cookie jar.
  The token lives in the iOS keychain. React Native does not enforce CORS, so
  `HAT_CORS_ORIGINS` is not involved.
- **A turn outlives its connection**, so the Stop button and "leave" are
  different requests. Stop posts `POST /api/sessions/:id/turn/cancel` and then
  drops the socket — closing the socket alone would stop the updates while the
  model kept generating with nobody watching. Leaving only detaches, and the app
  reattaches to a live turn (`GET /api/sessions/:id/stream`) on launch, on
  opening a conversation, and when it returns to the foreground. This is what
  makes it work on iOS, where the system suspends backgrounded apps freely.
- **The SSE frame parser moved to `@hat/core`.** It is wire-format code that the
  web, desktop, and mobile clients all have to agree on, so it now sits next to
  the `KernelEvent` union it decodes rather than being copied per client.

`@hat/core` ships raw TypeScript, so `apps/mobile/metro.config.js` has to
transpile it out of `node_modules` and rewrite the `.js` extensions its ESM-style
relative imports carry. If the app stops bundling, that file is the first thing
to check.

The chrome is native: a `react-native-screens` stack (large titles, system
search, `UIBarButtonItem`s with SF Symbols and pull-down menus). The floating
composer uses Liquid Glass through `expo-glass-effect` on iOS 26 and falls back
to `expo-blur` elsewhere. See [docs/ios-app.md](docs/ios-app.md).

EAS device builds need a paid Apple Developer account. For a free Apple ID,
[`.github/workflows/ios-ipa.yml`](.github/workflows/ios-ipa.yml) builds an
unsigned IPA on a GitHub macOS runner for SideStore to sign on-device (7-day
expiry, 3 apps at a time).

The tool-loop view keeps **one assistant message per model iteration**, because
that is what the server emits: a turn that calls tools produces several
`message.start` events and each holds the tool cards for the calls made in it.
Approvals are resolved with the session id, which is what lets the server reject
a decision aimed at another conversation.

See [docs/ios-app.md](docs/ios-app.md) for the architecture, the state machine,
and what is deliberately out of scope.

## Run (dev)

```sh
corepack enable && corepack prepare pnpm@9 --activate
pnpm install
pnpm dev          # starts server :8787, runner, and web :5173 in parallel
```

Open http://localhost:5173, type `run: echo hello`, approve the tool call, and
watch it execute on the runner.

Environment: copy `.env.example` to `.env` and adjust. Both server and runner
default `HAT_ENROLL_TOKEN=dev-enroll-token`, so dev works with no config.

```sh
pnpm typecheck    # tsc across all packages
pnpm test         # node:test unit tests (providers, crypto, store, SSE parser, chat view-model)
pnpm smoke        # boots server + runner, exercises turn/approval/branching
```

## Run (compose)

```sh
HAT_ENROLL_TOKEN=$(openssl rand -hex 16) HAT_AUTH_TOKEN=$(openssl rand -hex 32) docker compose up --build
```

The runner publishes **no ports** — it dials out to `server:8787/link`.

## The execution link

- Runner connects out with `hello { v, runnerId, enrollToken, caps }`; the
  server checks protocol version + enroll token and replies `hello.ok`.
- Server sends `workspace.ensure`, `exec.start|stdin|cancel`, `fs.*`, `net.fetch`
  with correlation ids; runner streams `exec.stdout|stderr|exit` and `*.result`.
- Jobs are killed on cancel, timeout, or output-cap breach (process tree).
- The runner holds no provider keys, database, or auth state. Secrets and
  approval live only on the server and never cross the link.

## Security posture (internet-facing)

This is a single-user app. Before exposing it:

1. **Set `HAT_AUTH_TOKEN`.** With it unset, `/api` is unauthenticated.
2. Prefer passkeys/session cookies over a bearer token (M6 work) and terminate
   TLS at a reverse proxy (Caddy/Traefik).
3. The `shell_exec` tool is approval-gated per command by default. Keep it that
   way until the container isolation tier (M6) lands.
4. Strongest cheap win: put both server and runner behind Tailscale/WireGuard
   and don't expose ports at all.

## Roadmap

- **M0 (done)** execution link end-to-end: runner, protocol, kernel loop,
  approvals, `shell_exec`, streaming UI.
- **M1 (done)** OpenRouter + DeepSeek over a shared OpenAI-compatible base;
  per-model capabilities; SQLite persistence, message branching, encrypted
  secrets; grouped model picker + branch controls.
- **M2 (done)** Plugin host: lifecycle, contribution tracking, enable/disable,
  zod-backed config forms, declared permissions/secrets, external plugin loading
  from `./plugins`, settings UI. Providers + shell tool converted to plugins.
- **M3 (done)** Tool-loop policies (ask/auto/allowlist/deny) + loop guards, and
  capability checks with in-chat warnings.
- **M4 (done)** Vision input: content-addressed attachments, upload/serve API,
  attach/paste/drop UI, resolve-to-data only for vision models.
- **M5 (done)** MCP plugin: stdio servers on the runner (duplex process link) +
  Streamable HTTP, namespaced tools with real JSON Schema, list-changed
  notifications.
- **M6 (done)** Object-store artifacts (local + S3, presigned GET), multi-runner
  scheduling (tags + least-busy), container sandbox tier, single-user password
  auth (scrypt + signed session cookie + CSRF + rate limiting). Multi-user is
  intentionally out of scope.
- **M7 (started)** Tauri desktop: the shell, connection config, CORS and SSE
  keepalives are in place and a full turn (stream → approval → runner → result)
  works in the app. Still open: packaging/signing, OS keychain for the token.
  A React Native (Expo) iOS app now shares the same server and the SSE parser,
  with EAS Build configured and an unsigned-IPA workflow for free Apple IDs.
  Still open there: native tab bars for system Liquid Glass, and a device.
