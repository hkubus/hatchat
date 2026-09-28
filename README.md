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
  conversion is needed; `requiresApproval` defaults to true.
- `notifications/tools/list_changed` is wired; server→client requests we don't
  implement (sampling, elicitation) are declined with a JSON-RPC error, which
  servers handle gracefully.

`scripts/fake-mcp-server.mjs` is a minimal stdio server used by the smoke test.

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
can't spin forever.

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
  `shell_exec` tool), `fake` (test provider).

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
pnpm test         # node:test unit tests (providers, crypto, store)
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
- **M7** Tauri desktop + React Native mobile over the same kernel/UI.
