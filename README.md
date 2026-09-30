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
| `apps/ios` | Native SwiftUI iOS client: the same server, with its non-UI core (`HatKit`) tested on Linux |

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
# the plugin reloads and the provider registers immediately
```

Capabilities are per model and drive the loop: `deepseek-reasoner` reports
`toolCalls: false`, so tools are not offered to it. OpenRouter capabilities are
derived from each model's `supported_parameters` and `input_modalities`, and
each model's context window comes from `context_length`.

**Retries.** A rate limit (429), timeout (408) or overloaded upstream (5xx,
including OpenRouter's in-stream errors) or a dropped connection is retried
with exponential backoff, honouring `Retry-After`, up to `HAT_PROVIDER_RETRIES`
times (default 3). Only failures that arrive *before* the model has produced
anything are retried — once text has streamed, a retry would duplicate it on
screen, so the error surfaces instead. Each retry shows as a warning in the chat.

**Cut-off replies.** Each assistant message stores why the model stopped. A
reply that hit the output limit (`finish_reason: length`) gets a **Continue**
button: `POST /api/sessions/:id/continue` sends a synthetic user message asking
the model to pick up where it stopped. Clients hide that message, so the answer
reads as one continuous reply.

## Authentication (M6)

Single-user password auth. Set `HAT_AUTH_PASSWORD` (or a precomputed
`HAT_AUTH_PASSWORD_HASH=scrypt$<salt>$<hash>`) to require login; leave unset and
the API is open (dev only).

- `POST /api/auth/login` verifies the password with **scrypt** and sets an
  HttpOnly, SameSite=Lax **signed session cookie** (HMAC over a payload with an
  expiry) plus a readable `hat_csrf` cookie.
- Mutating requests authenticated by cookie must send `x-csrf-token` matching
  the cookie (double-submit); bearer-token requests are exempt.
- Login is **rate-limited** (10 attempts / 15 min per client address). The
  address is the connection's own: `X-Forwarded-For` is believed only from the
  proxies listed in `HAT_TRUSTED_PROXIES`, since anyone can send it. Behind a
  reverse proxy, list its address there, or every client shares one limit.
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

In the `container` tier every `shell_exec` on the runner runs in a throwaway
container (`docker run --rm -i --network <n> --memory <m> --cpus <c>
--pids-limit 512 -v <workspace>:/workspace -w /workspace <image> sh -lc <cmd>`),
hardened with `--cap-drop=ALL`, `no-new-privileges` and a read-only root
filesystem. The image should include the tools you expect (e.g. `node:22-slim`,
or your own).

`HAT_EXEC_SANDBOX` picks the tier:

- `auto` (default): at startup the runner probes for a working runtime (docker,
  then podman; 5s timeout each) and uses `container` if one answers, otherwise
  `host`.
- `container`: always sandbox. The runner refuses to start if no runtime works.
- `host`: run commands directly on the runner, with its privileges.

`HAT_SANDBOX_RUNTIME` pins the runtime binary (e.g. `podman` or a full path);
only that one is probed. The runner logs the chosen tier and why at startup,
and advertises it as `capabilities.sandbox` (`host` | `container`) in
`GET /api/runners`. The compose runner has no runtime (and no Docker socket), so
it is pinned to `host`.

Inside the container:

- The command runs as the runner's own uid:gid, so files it writes to the
  workspace belong to the runner's user (`--userns=keep-id` on rootless podman;
  container root, which maps to the runner's user, on rootless docker). Run the
  runner as a non-root user: a root runner means uid 0 in the container, with
  all capabilities dropped.
- `HOME` is `/workspace`. Per-command env is forwarded as `-e KEY`, with values
  kept out of the runtime's argv; names that would steer the runtime CLI
  (`DOCKER_*`, `CONTAINER_*`, `XDG_*`, proxies, ...) are dropped.
- Each container is named `hat-<job id>-<random>`. On cancel, timeout, output
  cap, link loss or runner shutdown the runner runs `<runtime> rm -f <name>`
  (best-effort, 5s timeout), since killing the CLI alone leaves it running.

Background processes and the Python tool (shell-mode processes) stay on the
**host** under `auto`, because the default image has no `python3` and the
default network is `none`. Set `HAT_SANDBOX_PROCESSES=container` to sandbox them
too (with an image that has what they need). An explicit
`HAT_EXEC_SANDBOX=container` sandboxes them by default, and
`HAT_SANDBOX_PROCESSES=host` opts them out. stdio MCP servers always run on the
host.

The file tools (`read_file`, `write_file`, `list_dir`, ...) are not sandboxed
commands: the runner performs them itself, on its host. They resolve symlinks
and refuse any path that ends up outside the session workspace, so a link left
there by a command, a cloned repo or an unpacked archive can't lead them
elsewhere on the machine. Dangling links and special files (FIFOs, devices) are
refused too.

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
- Nothing waits on a server forever: requests time out (a minute; ten for a tool
  call, since some do real work), Stop cancels a running call and sends the
  server `notifications/cancelled`, and an HTTP error or a response that never
  answers fails the request. `tools/list` follows `nextCursor`, and tool names
  that sanitize alike (`get-item`, `get_item`) get a short hash to stay distinct.

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
  Node ≥ 22.5, which hat's own `engines.node: ">=22.18"` already covers.
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

## Ceneo (price checks)

The `ceneo` plugin checks prices of **new** products on
[Ceneo.pl](https://www.ceneo.pl), the Polish price comparison site. It is
keyless and on by default:

- `ceneo_search` — products matching a query with their lowest price (PLN),
  shop count, rating and key specs; optional `min_price` / `max_price` filters.
- `ceneo_product` — the shop offers for one product (id from the search, or a
  ceneo.pl URL), cheapest first, with shop rating and delivery. Ceneo renders
  only the first ~15 offers server-side, so the tool says when the list is
  partial.

While the plugin is active, the system prompt tells the model to use Ceneo
for the price of anything bought new. When a Scout MCP server is connected
(`mcp__scout__*` tools), it also says to keep Scout for second-hand listings or
products Ceneo doesn't carry. Like web search, requests go from the server
process and parse Ceneo's HTML, so markup changes can degrade results. Each
request has its own 20 s timeout and a 5 MB size cap, and redirects are only
followed within ceneo.pl. `maxResults` sets the default number of products and offers
(max 30).

## System prompt

Every turn is prefixed with a base system prompt that is never stored in
history. The default (`packages/server/src/prompt.ts`) establishes that hat is a
**general-purpose assistant** whose tools come from optional plugins — so the
model does not mistake one connected integration (an MCP server, the shell, a
search backend, …) for its identity or the point of the conversation. Override
it verbatim with `HAT_SYSTEM_PROMPT`. Providers that cannot take a system role
get it merged into the first user message instead.

Each conversation can add its own **instructions** (appended to the system
prompt), a **temperature** and a **max reply tokens** cap — the sliders button
in the chat header, or `PATCH /api/sessions/:id` with `instructions`,
`temperature` (0–2, `null` for the default) and `maxTokens`. They travel with
the conversation when it is forked or exported.

## Context window

Every turn replays the active branch, so a long conversation — or a few large
tool outputs — would eventually overflow the model and fail. Before each model
call the kernel (`packages/kernel/src/context.ts`) estimates the request and,
when it would not fit the model's window (minus room for the reply), first
replaces **old tool outputs** with a short placeholder (the latest round of
results, parallel calls included, is never touched), then leaves out the
**oldest exchanges**, adding a note that it did. A Continue, or the closing
"answer now" nudge, counts as part of the exchange before it, so the reply it
refers to is never the part left out. Only the request is trimmed: stored
history is unchanged, and a model with a larger window sees everything again.

The estimate counts about 3.5 characters a token, one a character for Chinese,
Japanese and Korean, and nothing for stored reasoning, which is never sent back.

Cuts are made in pages of a quarter of the budget, so the start of the request
stays byte-identical across turns until the conversation has grown by another
page — prompt caching keeps working. The chat shows a warning when trimming
starts, and the composer shows how full the window was on the last call.

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

**Private networks.** The browser runs in the server's network and `web_fetch`
in the runner's, and both go where a model points them, so neither may reach a
private address: loopback, the private ranges, link-local (cloud metadata),
carrier-grade NAT (Tailscale), IPv6 unique-local. Host names are resolved and
every address checked, and so is each redirect hop. The browser goes through a
small filtering proxy that connects only to the address it checked, so a page's
redirects, links, subresources and WebSockets are covered too. To let them
reach your own services, list the host names in `HAT_ALLOW_PRIVATE_HOSTS`
(comma-separated, `*.lan` for a whole domain) on the server (browser) and the
runner (`web_fetch`).

## Vision + attachments (M4)

Attach images by button, paste, or drag-and-drop. Uploads are content-addressed
(sha256), deduped, and stored under `HAT_UPLOAD_DIR`; dimensions are read from
PNG/GIF/JPEG headers with no native image dependency.

**Documents** — text, Markdown, CSV, JSON, source code and **PDFs** — attach
the same way. Their text is extracted once on upload (PDFs via `unpdf`, loaded
lazily), stored next to the blob (capped at 400k characters), and inlined into
the user's message for the model as `<file name="…">…</file>`. The stored
message keeps only a `file` part, which the UI shows as a card you can preview
or download. Binary files and scanned PDFs without a text layer are rejected
with a message saying so. Pasting a very long text into the web composer turns
it into a `.txt` attachment.

Messages reference attachments by id. The kernel resolves them to base64 data
URLs **only for vision-capable models**; for others the image is replaced with an
omitted-note and the capability check warns in the chat. This keeps large
blobs out of stored messages and off the wire unless needed.

## Tool policies + capability checks (M3)

Each conversation has a **tool policy** (editable in the chat toolbar):

- `ask` — tools that require approval prompt you.
- `auto` (default) — run tools without asking.
- `allowlist` — auto-run only the listed tools, ask for the rest.
- `deny` — block all tool execution.

Policies are persisted per session. The agent also has **loop guards**: it stops
after N identical (name+args) calls and after N consecutive failures, so a model
can't spin forever. A turn is also capped at `HAT_MAX_TOOL_ITERATIONS`
(default 100) tool steps; when the budget (or a guard) is hit, the agent makes one
final call **with tools withheld** so the turn closes with a written answer
instead of dangling on a tool result, and emits a `warning` explaining why.

An approval (or an `ask_user` question) **waits for you** — the turn keeps
running server-side while you are away, so a timeout would silently deny
whatever the model was doing. Set `HAT_APPROVAL_TIMEOUT_MINUTES` to give up
after a while instead. The session list reports each conversation as `idle`,
`running` or `waiting` (blocked on you), shown as a dot in the sidebar.

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
a `Plugin`. Each one runs **in its own child process**, not in the server:

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

The same plugin API works across the process boundary
(`packages/server/src/plugin-isolation/`): the server registers proxy
tools/providers that forward calls over IPC, provider streams come back as
events, and aborts are passed on as cancellations. Zod schemas stay in the
child, which validates tool args and config itself and sends the server JSON
Schema.

- **Environment**: the child gets none of the server's env vars (only
  `NODE_ENV`, `TZ`, `LANG`), so no `HAT_MASTER_KEY`, `HAT_AUTH_*` or provider keys.
- **Sandbox** (Node >= 22.18): the child runs under Node's permission model.
  It can read only the plugin directory and the code it imports (`node_modules`
  and linked workspace packages). It can't write files, spawn processes, start
  workers or load native addons. On older Node the child still runs in its own
  process with a scrubbed env, but without the filesystem sandbox (a warning is
  logged).
- **Secrets**: `ctx.secrets.get` serves only the names in `requiresSecrets`,
  and only secrets saved in hat *for that plugin*, never the server's
  environment. A plugin names its own secrets, so the name proves nothing:
  hat's (`HAT_*`) and those of the built-in plugins (`OPENROUTER_API_KEY`, ...)
  can't be declared, and a secret saved for another plugin, or for none, is
  not served (the plugin is refused before it starts). Save one for a plugin
  with its id:

  ```sh
  curl -X POST localhost:8787/api/secrets -H 'content-type: application/json' \
    -d '{"name":"WEATHER_API_KEY","value":"...","plugin":"weather"}'
  ```

  A secret saved before secrets recorded their plugin goes to the one
  installed plugin that declares its name, and is that plugin's from then on;
  if several declare it, save it again with `plugin`.
- **Tool context**: `sessionId`, `callId`, `signal`, `logger` and `secrets`.
  `ctx.host` forwards to the call's execution host, stays pinned to that session,
  and works only while the call runs. Each part needs its declared permission:
  `runner:exec` (exec), `runner:fs` (fs), `runner:net` (fetch). `ctx.processHost`,
  `runnerAvailable`, approval requests and `emit` are not available.
- **Lifecycle**: every activation starts a fresh process. Disabling or
  reconfiguring kills it. If it crashes, the plugin goes to `error` with the
  reason and its tools/providers are unregistered; re-enable it to restart.
- **Limits**: network access isn't restricted (Node's permission model has no
  network control). A `requiresApproval` predicate is treated as "always ask".
  Provider `capabilities(model)` answers from the last `listModels()` result.
  `id`, `requiresSecrets` and `permissions` are read once at startup.

`HAT_PLUGINS_ISOLATION=off` loads external plugins into the server process
instead, where they are fully trusted, as before.

## Persistence + branching (M1)

Sessions, messages and secrets live in SQLite (`node:sqlite`, no native build).
Messages form a **tree**; the active path is root→leaf, so:

- **Regenerate** an assistant message → sets the leaf to its user parent and
  re-runs, creating a sibling assistant branch.
- **Edit** a user message → sets the leaf to its parent and re-runs with new
  text, creating a sibling user branch.
- The UI shows `‹ n/m ›` on any message with siblings to switch branches.
- **Fork** any message → a new conversation holding the path up to it, with the
  same settings (`POST /api/sessions/:id/fork`).

**Search.** User and assistant text is indexed with SQLite FTS5. The sidebar
search box filters titles and, from two characters, searches message contents
(`GET /api/search?q=`). Opening a hit switches to the branch holding that
message and scrolls to it.

**Export / import.** `GET /api/sessions/:id/export?format=markdown` is the
active branch as a readable transcript; the default JSON is the whole message
tree with settings and attachments inline, and `POST /api/sessions/import`
recreates it as a new conversation (fresh ids, attachments re-stored). Both are
in the chat header's download menu; import is in the sidebar.

**Deleting** a conversation takes what it left behind with it: a reply still
running is stopped, plugins let go of what they kept for it (background
processes, the Python interpreter, a browser page), each connected runner stops
its jobs and deletes its workspace, and attachments no other conversation uses
are deleted, bytes included. Uploads are shared by content, so one uploaded
(by any conversation) in the last day is kept: another composer may be about
to send the same file. A runner that is offline at the time keeps its copy of
the workspace.

**Notifications.** The web app can notify you (Settings → Preferences, opt-in)
when a reply is ready or a conversation needs you while the tab is in the
background. Reaching a closed tab or a suspended phone would need server push,
which is not built.

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
generation or a hung tool stops promptly instead of only being hidden. A tool
that ignores the cancel is abandoned after a few seconds.

**One turn per conversation.** While a reply is running, starting another in
the same conversation (send, continue, regenerate or edit, from another tab or
device) is refused with `409` until it is stopped: two turns writing at once
would interleave their messages into a history providers reject. A turn that
was just stopped gets a few seconds to store its last messages before the new
one starts. Each turn stores its messages as its own chain, so switching
branches while it runs leaves its reply under its own question.

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

`apps/ios` is a native SwiftUI client for the same server — not a WebView of
the web app. Like the desktop shell it is a thin client: it stores the address
of a hat server and the token used to reach it, and nothing else. It has no
third-party dependencies.

```sh
pnpm ios:test                                  # HatKit against a live server + runner
cd apps/ios && xcodegen generate && open Hat.xcodeproj
```

It is split in two. `apps/ios/HatKit` is a Swift package with everything that
is not a view: wire models, the SSE parser, the transcript view-model, the
HTTP client and the chat store. It imports no UIKit or SwiftUI, so it builds
and tests on Linux, and CI drives it against a real server and runner.
`apps/ios/Hat` is the SwiftUI app. Things worth knowing before changing it:

- **The parser and view-model exist twice.** `SSE.swift` and `ChatView.swift`
  are ports of `@hat/core`'s `sse.ts` and `chat-view.ts`, and their tests hold
  the same cases. Change one, change both.
- **Streaming reads a POST body through a `URLSessionDataDelegate`.**
  `EventSource` is GET-only, and `URLSession.bytes(for:)` does not exist on
  Linux Foundation.
- **Auth is the bearer token, not a login.** `HAT_AUTH_TOKEN` is CSRF-exempt
  server-side, so the app never touches `/api/auth/*` and needs no cookie jar.
  The token lives in the iOS keychain.
- **A turn outlives its connection**, so the Stop button and "leave" are
  different requests. Stop posts `POST /api/sessions/:id/turn/cancel` and then
  drops the socket — closing the socket alone would stop the updates while the
  model kept generating with nobody watching. Leaving only detaches, and the app
  reattaches to a live turn (`GET /api/sessions/:id/stream`) on launch, on
  opening a conversation, and when it returns to the foreground.

The chrome is the system's own (navigation split view, toolbars, menus,
sheets, search), so it is Liquid Glass on iOS 26 without code; the floating
composer uses `glassEffect` there and a material blur below.

For a free Apple ID,
[`.github/workflows/ios-ipa.yml`](.github/workflows/ios-ipa.yml) builds an
unsigned IPA on a GitHub macOS runner for SideStore to sign on-device (7-day
expiry, 3 apps at a time). Every build of `main` is published as a release and
listed in the SideStore source `https://hkubus.github.io/hatchat/source.json`,
so SideStore installs and updates it directly.

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

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs all three plus the
web build on every push to `main` and every pull request.

## Run (compose)

```sh
HAT_ENROLL_TOKEN=$(openssl rand -hex 16) HAT_AUTH_TOKEN=$(openssl rand -hex 32) docker compose up --build
```

Compose refuses to start without both tokens: the server's port is published,
so an empty `HAT_AUTH_TOKEN` would leave the API — and the runner's shell — open
to anyone who can reach it. Keep them in a `.env` file next to
`docker-compose.yml` (compose reads it) so later commands see the same values.

The server keeps conversations, uploads and the master key that encrypts saved
secrets in the `server-data` volume, so they survive rebuilds; back it up. Both
images install from the lockfile and run as the unprivileged `node` user.

Upgrading from an image that ran the runner as root: its `runner-workspaces`
volume is root-owned. The runner's entrypoint starts as root just long enough
to hand that directory to `node`, then drops privileges before the runner
starts, so no manual step is needed. If you start the runner with `--user`, it
cannot do that; it exits with a message naming the directory to `chown`.

The runner publishes **no ports** — it dials out to `server:8787/link`.

## The execution link

- Runner connects out with `hello { v, runnerId, enrollToken, caps }`; the
  server checks protocol version + enroll token and replies `hello.ok`.
- Server sends `workspace.ensure`, `exec.start|stdin|cancel`, `fs.*`, `net.fetch`
  with correlation ids; runner streams `exec.stdout|stderr|exit` and `*.result`.
- Jobs are killed on cancel, timeout, or output-cap breach (process tree).
- The server pings each runner every 15s and drops one that stops answering
  (a machine that vanished without closing its socket), and a request its
  runner never answers fails after 2 minutes: neither leaves a turn waiting.
- The runner holds no provider keys, database, or auth state. Secrets and
  approval live only on the server and never cross the link.

## Security posture (internet-facing)

This is a single-user app. Before exposing it:

1. **Set `HAT_AUTH_TOKEN`.** With it unset, `/api` is unauthenticated.
2. Prefer password login (session cookie + CSRF, `HAT_AUTH_PASSWORD`) for the
   browser over sharing the bearer token, and terminate TLS at a reverse proxy
   (Caddy/Traefik) with `HAT_COOKIE_SECURE=true`.
3. Run the runner as a non-root user where a container runtime is available,
   so `shell_exec` gets the container sandbox tier (the `auto` default picks it
   up; set `HAT_EXEC_SANDBOX=container` to make it mandatory), and check
   `capabilities.sandbox` in `GET /api/runners`. Keep `shell_exec` approval-gated
   per command (the default) on any runner still in the `host` tier. Background
   processes and the Python tool stay on the host under `auto`: keep them
   approval-gated too, or sandbox them with `HAT_SANDBOX_PROCESSES=container`.
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
  A native SwiftUI iOS app (which replaced the first React Native one) shares
  the same server, with its core tested against a live server in CI and an
  unsigned-IPA workflow for free Apple IDs. Still open there: a device pass.
- **M8 (done)** Long-conversation robustness and everyday chat features:
  context-window fitting, provider retries with backoff, Continue for cut-off
  replies, per-conversation instructions and sampling settings, document (text,
  code, PDF) attachments, fork, Markdown/JSON export and import, message search
  in the UI, session status and opt-in notifications, a shared chat view-model
  for all clients, sandboxed external plugins, MCP `readOnlyHint`, the `auto`
  sandbox tier, and CI (typecheck, tests, web build, smoke).
