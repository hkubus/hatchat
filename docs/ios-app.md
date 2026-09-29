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
  App.tsx                     shell: connect gate + native stack navigator
  index.ts                    Expo entry point
  app.json                    native config (bundle id, permissions, plugins)
  eas.json                    EAS build profiles
  metro.config.js             monorepo resolution (read this one)
  src/
    api.ts                    typed HTTP + SSE client
    runtime.ts                connection config in the keychain
    useChat.ts                chat state machine
    search.ts                 search-snippet formatting (pure, tested)
    theme.ts                  colour + type tokens
    navigation.ts             route types + chat-store context
    Glass.tsx                 Liquid Glass with an expo-blur fallback
    haptics.ts                haptic feedback, named by intent
    tokens.ts / capTags.ts    formatting helpers
    screens/                  Connect, Sessions, Chat, Model, Conversation
      settings/               the Settings sheet: its own nested stack
    ui/                       controls, List, Menu, Icon (SF Symbols),
                              barItems, Sheets, Markdown, MessageRow
```

The transcript view-model (`buildMessages`, `readEvent`, `applyEffect`,
`contextFill`, `endsTruncated`) lives in `packages/core/src/chat-view.ts` and is
shared with the web and desktop clients; the app imports it from `@hat/core`.

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

Liquid Glass only renders in a binary built with the **iOS 26 SDK** (Xcode 26)
and running on iOS 26. To check that, use a **dev build** built with Xcode 26.
`expo-dev-client` is already a devDependency:

```sh
cd apps/mobile
npx expo run:ios                      # builds and launches a dev client
npx expo prebuild --platform ios --clean
npx expo run:ios --device             # physical device
```

## Shipping JavaScript without a build

Builds are the scarce resource (EAS quota, or the free-Apple-ID sideload
cycle), so the app ships with `expo-updates`. After one build that contains
it, any change that is only JavaScript or assets reaches installed apps
over the air. You don't need to rebuild for it.

One-time setup, **before the next build**. Without the update URL,
`expo-updates` is compiled in but disabled, and that build can never receive
an update:

```sh
cd apps/mobile
eas login
eas update:configure     # writes expo.updates.url and the project id into app.json
```

The `ios-ipa` workflow refuses to build while `expo.updates.url` is missing.

Publishing an update:

```sh
cd apps/mobile
eas update --channel production --message "what changed"
```

The app checks on launch and applies the update on the *next* launch
(`fallbackToCacheTimeout: 0`, so startup never waits on the network).
`app.json` pins the channel through `updates.requestHeaders`, because the
GitHub-built IPA is not built by EAS and so gets no channel from `eas.json`.

`runtimeVersion` uses the `appVersion` policy: an update only applies to
binaries with the same `version`. **Bump `version` in `app.json` whenever
native code changes** (a new native dependency, a config plugin, `app.json`
native settings). Then build once. Otherwise an update could be sent to a
binary that lacks the native code it expects.

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
- **Chats** — the root: sessions grouped by date, search, swipe or
  long-press to rename or delete (delete is confirmed). Each row shows what
  the conversation is doing: a blue dot and "Responding" while a turn runs,
  an orange symbol and "Needs you" while one waits on a tool approval or an
  `ask_user` question. The list refetches on focus and polls every few
  seconds while anything is running or waiting.
- **Search** — the bar's search field filters titles instantly and, once
  typing pauses, also runs the server's full-text search (`GET /api/search`).
  Matching messages appear in a Messages section with the matched terms in
  bold. Tapping one selects the branch that holds it (`POST …/select`) and
  opens the conversation there.
- **Chat** — streaming transcript, markdown, collapsible tool cards and
  reasoning, approvals at the composer, branch navigation (`‹ n/m ›`),
  regenerate, edit-and-resend, camera, library and document attachments,
  stop mid-turn. A reply cut off at the output limit gets a **Continue**
  button under it (`POST …/continue`), which streams the rest as a normal
  turn. The server's "continue" nudge is a hidden user message, so the
  continuation reads as the rest of the reply. Long-pressing a reply offers
  **Fork from Here** (`POST …/fork`), which switches to a new conversation
  holding the path up to that reply. Fork is offered on replies only,
  because a fork that ends on a user message has nothing to regenerate or
  continue. The options menu has **Export as Markdown…**, which fetches the
  active branch as Markdown and hands the text to the share sheet.
- **Context fill** — the title's subtitle shows the model and how full its
  context window is (`· 42%`, orange from 80%). The figure is the last model
  call's prompt plus reply over the selected model's `contextWindow`
  (`contextFill`). The options menu's Usage section spells it out. The kernel
  trims old context itself when it has to, and says so in a warning banner.
- **Conversation** — instructions, temperature and max reply tokens for this
  conversation (`PATCH /api/sessions/:id`), saved with the bar's Save button.
  It opens as a sheet from the options menu (Instructions & Sampling…) and is
  also pushed from Settings. An empty field means the provider default.
- **Model** — a sheet, grouped by provider, with search.
- **Settings** — a sheet with its own stack: conversation (reasoning, tool
  approval, instructions & sampling, allowlist), then Providers, Plugins,
  Runners and Server, each pushing its detail screen.

### The state machine

`src/useChat.ts` is the port of the state block in `apps/web/src/App.tsx`. Two
invariants from the web client are load-bearing and preserved:

- **Usage is counted once.** A `usage` event lands on the in-flight message
  it belongs to, so a turn's cost moves with its messages: into `messages`
  when they are promoted at the end of the turn, then replaced by the stored
  figures on refresh. There is no separate running tally. (There used to be
  `liveUsage`, which had to be cleared at exactly the right moment; with usage
  on the messages as well it would count every token twice.) `message.done`
  stamps the finish reason on its message, which is what `endsTruncated` reads
  to offer Continue.
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

**Documents** come from the composer's "+" → Choose File (`expo-document-picker`,
no iCloud entitlement, so it works on a free Apple ID). The server takes text,
code and PDFs with extractable text. It reads them to text on upload, inlines
that for the model, and puts a file part on the user message. The app sends
each document's name in `attachmentNames`, because stored content is keyed by
hash and a repeated upload would otherwise keep its first name. Documents show
as file cards above the user's bubble (`UiMessage.files`); tapping one
downloads it and opens the share sheet. The picker checks only size and image
format. Anything else the server cannot read (a scanned PDF, a binary file)
comes back with the server's own reason.

Adding `expo-document-picker` is a native change, so `app.json`'s `version` went
to 0.2.0 and a new build is needed before an OTA update that uses it.

The server only accepts **PNG, JPEG, GIF, and WebP** — it reads image dimensions
from the file header with no native image dependency, so an unrecognised format
comes back as a 415 rather than being stored unreadable. That matters on iOS
specifically: `expo-image-picker` returns HEIC for most camera-roll photos. The
picker filters against `isAcceptedImageType` and says so before the upload,
rather than failing with a 415 after the user has composed a message.

## Native chrome and Liquid Glass

The app uses the system's own chrome wherever there is one, rather than drawing
a lookalike:

- **Navigation is a native stack** (`@react-navigation/native-stack` on
  `react-native-screens`, i.e. `UINavigationController`). The layout matches
  Messages: the conversation list is the root, with a large title and the
  system search field. The conversation is pushed on top. Settings and the
  model picker are page sheets. Bars are transparent over scrolling content,
  so on iOS 26 the system draws the scroll-edge effect. Below iOS 26 they use
  the `systemChromeMaterial` blur.
- **Bar buttons are `UIBarButtonItem`s** (`src/ui/barItems.tsx`), with SF
  Symbol icons and native pull-down `UIMenu`s. The conversation's options
  (reasoning effort, tool approval, model, instructions & sampling, export,
  usage and context) are one such menu. On iOS 26 the
  system puts these items in its grouped glass capsules. `unstable_header*Items`
  is iOS-only, so every item also renders as a plain button on web and Android.
  A menu falls back to opening Settings, which has the same controls.
- **Icons are SF Symbols** via `expo-symbols` (`src/ui/Icon.tsx`), with a text
  stand-in off iOS.
- **Menus are `UIMenu`s** (`src/ui/Menu.tsx` over `@react-native-menu/menu`).
  Long-pressing a message or a conversation opens the system context menu.
  Messages offer Copy, Select Text, Share and Edit, or Regenerate and Fork
  from Here; a conversation offers Rename and Delete. The composer's "+" is a
  pull-down with Camera, Photo Library and Choose File. The Settings pickers
  are pop-up buttons.
- **Conversations swipe** (`ReanimatedSwipeable`) to reveal Rename and
  Delete, as in Mail. Delete is always confirmed in a destructive alert.
- **The keyboard is tracked frame by frame** with
  `react-native-keyboard-controller`. The composer is pinned to the keyboard
  through interactive dismissal, and the transcript's inset grows with it.
  Insets are owned explicitly (header on top, composer plus keyboard as a real
  `contentInset` below) so that the *native* `scrollToEnd` lands on the last
  message. FlatList's JS `scrollToEnd` ignores insets.
- **Haptics** (`src/haptics.ts`) mark send, selection changes, a tool asking
  for approval, a reply finishing, and failures.

Liquid Glass drawn in JS (`src/Glass.tsx`, over `expo-glass-effect`) is limited
to the controls that float over content, which is where the HIG puts it. That
means the composer (an attach button and the input capsule, merged by
`GlassContainer`), the tool-approval and edit panels above it, attachment
thumbnails, the jump-to-latest button, and the image viewer's buttons. Content stays solid: message bubbles, tool cards, settings rows, and
the connect form.

`Glass.tsx` checks both `isLiquidGlassAvailable()` and
`isGlassEffectAPIAvailable()`. Some iOS 26 betas shipped without the runtime
API and crash if you use it. Everywhere else it renders an `expo-blur` pane
with a tint, laid out as siblings behind the children so that the caller's
layout style applies the same way in both paths. Settings shows which material
is active.

## Transcript details

- **Tool approvals surface at the composer.** A call waiting for approval
  shows a glass Approve/Deny panel above the input, so it cannot be scrolled
  out of reach, and the approval buttons on the tool card stay enabled for
  the whole wait.
- **Reasoning and tool output are collapsed** by default ("Thought process",
  or the tool name with its status). Either can run to hundreds of lines.
- **Code blocks scroll sideways** instead of wrapping, and have a Copy button.
- **Streaming renders at about 12 fps.** Markdown is re-parsed on every render,
  so rendering every token makes long replies stutter. Row callbacks are
  stable, so a token re-renders only the message it lands in.
- **Images** are thumbnails in the composer and open full-screen from the
  transcript, with pinch to zoom.
- **HEIC** is avoided at the source: the photo picker asks iOS for the
  compatible (JPEG) representation. The type check stays as a backstop.
- **Select Text** opens the message in a sheet with real selection handles. A
  long press in the transcript opens the context menu, so selection can't live
  there.

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

- **Push notifications.** "Turn finished" and "needs approval" alerts while the
  app is backgrounded would need push (APNs), which needs a paid Apple
  Developer account. Not implemented. A turn that finishes, or starts
  waiting on you, while the app is suspended shows up on the next
  foreground: the chat reattaches, and the Chats list shows "Needs you".
- **JSON import** (`POST /api/sessions/import`) is web-only. The app exports
  Markdown for reading; moving a whole conversation tree between servers is
  easier from a desktop.
- **Offline / queued turns.** A turn needs a live stream, and the app has no
  retry: a send that fails on a dead connection surfaces as an error rather than
  being queued.
- **iPad split view.** iPad uses the same stack as iPhone; a sidebar split
  (`UISplitViewController`) would suit the larger screen better.
- **The app icon is Expo's template placeholder.** Dark and tinted variants are
  generated from it (`assets/icon-dark.png`, `assets/icon-tinted.png`), but
  real icon art — ideally an Icon Composer `.icon` for iOS 26 — is still to do.
- **Syntax highlighting** in the transcript. `highlight.js` is ~1 MB of
  grammars, which is not worth the bundle on a phone; fenced blocks get a
  monospace surface instead.
- **Android and web** are configured but unverified; only iOS was bundled.
- **No device has run this.** Everything here has been typechecked,
  unit-tested, bundled and prebuilt, and the server contract has been checked
  against `packages/server` by hand. No simulator or hardware pass has been
  done yet.
