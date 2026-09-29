# iOS app

`apps/mobile` is a React Native (Expo) client for the same hat server the web
and desktop apps talk to. It is a thin client: it holds the server address and
a bearer token, and nothing else. All the state — sessions, message tree,
secrets, plugin configuration, approvals — lives on the server.

- Expo SDK 57, React Native 0.86, React 19, New Architecture enabled.
- Bundled with Metro from inside the pnpm workspace.
- Ships via **EAS Build**; `ios` / `ios-ipa` below covers the free-Apple-ID case.

## Layout

```
apps/mobile/
  App.tsx                     shell: connect gate + three tabs
  index.ts                    Expo entry point
  app.json                    native config (bundle id, permissions, plugins)
  eas.json                    EAS build profiles
  metro.config.js             monorepo resolution (read this one)
  modules/liquid-glass/       local Expo module: real UIGlassEffect
    ios/LiquidGlassModule.swift
    ios/LiquidGlassModule.podspec
    expo-module.config.json
    index.ts                  JS binding
  src/
    api.ts                    typed HTTP + SSE client
    runtime.ts                connection config in the keychain
    chat.ts                   transcript view-model (pure, tested)
    chat.test.ts
    useChat.ts                chat state machine
    theme.ts                  colour + type tokens
    Glass.tsx                 glass with an expo-blur fallback
    tokens.ts / capTags.ts    formatting helpers
    screens/                  Connect, Chat, Sessions, Settings
    ui/                       controls, Markdown, MessageRow, ModelPickerBar
```

## Running it

```sh
pnpm install
pnpm dev:mobile          # Metro; press i for the simulator
```

You need a hat server the simulator can reach. The server binds `127.0.0.1` by
default, which the iOS simulator *can* reach, so `localhost:8787` works there.
For a physical device you must widen both of these:

```sh
HAT_HOST=0.0.0.0 HAT_AUTH_TOKEN=$(openssl rand -hex 32) pnpm dev:server
```

`HAT_CORS_ORIGINS` is not involved: React Native does not enforce CORS, and the
app is a bearer client with no cookies. Put the server on Tailscale or behind
TLS rather than exposing it — see "Transport" below.

The local `liquid-glass` module is native code, so it only exists in a **dev
build**, not in Expo Go. `expo-dev-client` is already a devDependency:

```sh
cd apps/mobile
npx expo run:ios                      # builds and launches a dev client
npx expo prebuild --platform ios --clean
npx expo run:ios --device             # physical device
```

## Three things that are not obvious

### Streaming needs `expo/fetch`, not `fetch`

React Native's built-in `fetch` is whatwg-fetch over `XMLHttpRequest`, which
buffers the whole response before exposing a body. A turn would not render
until the model had finished. `expo/fetch` is a native implementation that
returns a real `ReadableStream`, which `src/api.ts` reads chunk by chunk and
feeds to the SSE parser.

`EventSource` is not an alternative: the turn endpoint is a **POST**.

`apps/web/src/sse.ts` moved to `packages/core/src/sse.ts` when this app was
written. The frame parser is wire-format code that all three clients have to
agree on, so it lives next to the `KernelEvent` union it decodes rather than
being copied per client. Its tests moved with it.

### The SSE parser lives in `@hat/core`, which ships raw TypeScript

`@hat/core`'s package.json is `"exports": { ".": "./src/index.ts" }` — no build
step. Two consequences, both handled in `metro.config.js`:

- Metro's default `transformIgnorePatterns` ignores everything under
  `node_modules`, so it would not transpile `@hat/core` and would choke on
  `interface` and `export type`.
- The repo's packages are written for Node's ESM resolver, so their relative
  imports carry a `.js` extension that only exists in the emitted JavaScript
  (`import { x } from "./errors.js"` inside a `.ts` file). Metro's `sourceExts`
  handling *appends* extensions rather than substituting them, so it looks for
  `errors.js.ts` and gives up. `config.resolver.resolveRequest` rewrites those
  specifiers to the sibling `.ts`.

What is deliberately **not** set is `disableHierarchicalLookup`. Metro's walk up
the directory tree is what finds a package's dependencies in pnpm's nested
store; turning it off breaks every transitive dependency.

Verify the whole thing still bundles after touching any of this:

```sh
cd apps/mobile && npx expo export --platform ios --output-dir /tmp/hat-export
```

### Auth is the bearer token, not a login

The server's browser flow sets an HttpOnly session cookie and requires a
double-submit CSRF token on every mutation. A native client has no good use for
either: no cookie jar, nothing to keep in sync with a login screen.

`HAT_AUTH_TOKEN` is accepted as an `Authorization: Bearer` credential and is
**exempt from CSRF** — the auth middleware returns before the CSRF check is
reached. So the app stores the token in the iOS keychain via `expo-secure-store`
and sends it on every request. `/api/auth/*` is never called.

`setUnauthorizedHandler` is registered in `App.tsx` above the chat state: a 401
anywhere means the token was rotated server-side, so the app clears its config
and returns to the connect screen instead of failing on each screen in turn.

## Screens

- **Connect** — server URL + token, probed against `GET /api/health` before
  being saved, so a typo fails immediately and specifically.
- **Chat** — streaming transcript, markdown, tool cards with inline
  approve/deny, reasoning behind a disclosure, branch navigation (`‹ n/m ›`),
  regenerate, edit-and-resend, image attachments, stop mid-turn.
- **Chats** — the session list, with in-place rename and a two-step delete.
- **Settings** — tool policy, provider keys, plugins, runners, connection.

### The state machine

`src/useChat.ts` is the port of the state block in `apps/web/src/App.tsx`. Two
invariants from the web client are load-bearing and preserved:

- **Usage is not double-counted.** `liveUsage` accumulates the turn in flight
  and is cleared only *after* the post-turn refresh has folded the server's
  stored usage into `messages`. Clearing it earlier counts the same tokens
  twice.
- **A turn always ends in a refresh.** The streamed view is an optimistic
  projection; the server's path is the truth. Streamed messages are promoted
  into `messages` *before* the refetch, so the refetch is a reconciliation that
  cannot blank the last deltas — and if it fails outright, what streamed in
  stays on screen.

`message.start` fires once per *model iteration*, not once per turn, so the
in-flight state is a **list**. A turn that calls tools produces several
assistant messages and each keeps the tool cards for the calls made in it.

### Turns outlive their connection

The server lets a turn keep running when the client disconnects, so the client
has to distinguish two different things that used to be the same request:

- **Stop** posts `/turn/cancel`, then drops the socket. Aborting alone would
  just stop the updates while the model kept generating and billing with nobody
  watching.
- **Leaving** (switching conversations, backgrounding) only detaches. The turn
  carries on, and coming back reattaches via `GET /stream`.

This is what makes the app survive iOS. The system suspends backgrounded apps
freely, so on a phone a turn outliving its connection is the common case rather
than the exception — the app reattaches on boot, on opening a conversation, and
on returning to the foreground (`AppState`).

### Attachments

`<Image>` fetches its own `src` and cannot carry the bearer token, so stored
attachments are downloaded as data URLs and handed to `<Image>` directly. The
server caps uploads at 25 MiB, and `fetchAttachmentBase64` encodes in 8 KB
chunks to stay under Hermes' `String.fromCharCode` argument limit.

The server only accepts **PNG, JPEG, GIF, and WebP** — it reads image dimensions
from the file header with no native image dependency, so an unrecognised format
comes back as a 415 rather than being stored unreadable. That matters on iOS
specifically: `expo-image-picker` returns HEIC for most camera-roll photos. The
picker filters against `isAcceptedImageType` and says so before the upload,
rather than failing with a 415 after the user has composed a message.

## Liquid Glass

`modules/liquid-glass` is a local Expo module exposing a view whose backing is
`UIGlassEffect` on iOS 26+ and `UIBlurEffect(.systemMaterial)` below that.

`src/Glass.tsx` picks between it and a plain `expo-blur` pane. The availability
probe has to be `requireOptionalNativeModule`, checked *before*
`requireNativeViewManager`: the latter does not fail when a view is
unregistered, it returns a host component pointing at a view that does not
exist, which renders as a red box rather than falling back.

Real Liquid Glass needs the **iOS 26 SDK** (Xcode 26). The Swift `#available`
guard keeps the module compiling against older SDKs, where it just never takes
the iOS 26 branch.

### Known gap: the tab bar is not native

The tab bar in `App.tsx` is drawn in JS. A real `UITabBarController` gets the
Liquid Glass treatment from the system for free, and a JS-drawn bar will never
match it. Moving to Expo Router's native tabs is the open follow-up here; it is
the one place this app knowingly trades the platform idiom for simplicity.
Settings reports which material is active, so it is visible at runtime.

## Building

### EAS Build (needs a paid Apple Developer account)

```sh
cd apps/mobile
eas login
eas build:configure          # one-time; writes the project id into app.json
eas build --profile device --platform ios   # ad hoc, install from a link
eas build --profile production --platform ios
```

Profiles in `eas.json`:

| Profile | Distribution | Use |
|---|---|---|
| `development` | internal, simulator | dev client for local iteration |
| `device` | internal, ad hoc | install on your own devices, 1-year links |
| `production` | store | App Store / TestFlight |

The `development` profile targets the **simulator**, so it needs no signing team
at all and works on a free account. That is the one EAS build you can make
without paying.

### Free Apple ID: unsigned IPA in CI

EAS's managed device builds assume a paid team, so the free route is to build
unsigned on a hosted macOS runner and sign on-device.
[`.github/workflows/ios-ipa.yml`](../.github/workflows/ios-ipa.yml) does this on
`workflow_dispatch` or a `mobile-v*` tag, and uploads `hat-unsigned-ipa`.

Then install it with **SideStore**, which re-signs **on-device** and refreshes
itself, so no computer is needed after a one-time setup. AltStore (needs
AltServer on the LAN) and Sideloadly (Win/macOS, simplest one-off) also work.

Free-account limits: apps expire after **7 days**, max **3** sideloaded apps at
once, and **no push notifications** — APNs needs a paid team. Keychain storage
works fine, which is all this app needs.

## Transport

iOS App Transport Security blocks plain HTTP. `app.json` sets
`NSAllowsLocalNetworking`, which permits unqualified hostnames, `.local`, and
link-local addresses — enough for the simulator and for Tailscale. It does
**not** cover a plain-HTTP server on a LAN address like `192.168.1.10:8787`;
for that, terminate TLS in front of the server (Caddy, Traefik, or a Tailscale
HTTPS certificate) rather than adding `NSAllowsArbitraryLoads`, which disables
the protection app-wide.

## Known gaps

- **Push notifications** (needs a paid team) — so a turn that finishes while the
  app is suspended is noticed only on next foreground, not as a notification.
- **Offline / queued turns.** A turn needs a live stream, and the app has no
  retry: a send that fails on a dead connection surfaces as an error rather than
  being queued.
- **Expo Router with native tabs**, for the system Liquid Glass tab bar (see
  above). The JS tab bar wraps the native module, so it is translucent, but it
  is not the system control.
- **Syntax highlighting** in the transcript. `highlight.js` is ~1 MB of
  grammars, which is not worth the bundle on a phone; fenced blocks get a
  monospace surface instead.
- **Android and web** are configured but unverified; only iOS was bundled.
- **No device has run this.** Everything here has been typechecked, unit-tested,
  and bundled, and the server contract is verified against `packages/server`
  by hand — but no simulator or hardware pass has been done, so the Liquid Glass
  path in particular is compile-time-guarded and unexercised.
