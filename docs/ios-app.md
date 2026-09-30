# iOS app

`apps/ios` is a native SwiftUI client for the same hat server the web and
desktop apps talk to. It is a thin client: it holds the server address and a
bearer token, and nothing else. All the state — sessions, message tree,
secrets, plugin configuration, approvals — lives on the server.

- SwiftUI, iOS 18 and later, Swift 5 language mode.
- **No third-party dependencies.** Networking is `URLSession`, Markdown is a
  small block parser plus SwiftUI's inline `AttributedString(markdown:)`,
  pickers are `PhotosPicker`, `fileImporter` and `UIImagePickerController`.
- Liquid Glass on iOS 26, a material blur below it.

It replaced a React Native (Expo) app. The server contract, the screens and
the behaviour are the same; what changed is covered under
[What changed from the React Native app](#what-changed-from-the-react-native-app).

## Layout

```
apps/ios/
  project.yml                 XcodeGen spec; the .xcodeproj is generated, not committed
  scripts/test-hatkit.sh      HatKit tests against a throwaway server + runner
  HatKit/                     Swift package: everything that is not a view
    Sources/HatKit/
      Models.swift            wire format (messages, events, server resources)
      JSONValue.swift         arbitrary JSON (tool args, plugin config)
      SSE.swift               SSE frame parser (twin of @hat/core's sse.ts)
      ChatView.swift          transcript view-model (twin of @hat/core's chat-view.ts)
      ChatStore.swift         the chat state machine (@Observable)
      HatClient.swift         HTTP client + streaming over URLSessionDataDelegate
      Markdown.swift          Markdown block parser
      Format.swift            tokens, bytes, capability chips, snippets, dates
    Tests/HatKitTests/        unit tests + ServerTests (live server)
  Hat/                        the SwiftUI app
    App/                      entry point, connection (keychain), theme, glass
    Screens/                  Connect, Sessions, Shell, Model picker, Conversation settings
    Chat/                     ChatScreen (transcript, composer), MessageRow
    Settings/                 Settings sheet and its detail screens
    UI/                       Markdown view, attachments, shared components
    Assets.xcassets           app icon (light/dark/tinted), accent colour
```

The split is the point of the design. HatKit imports Foundation and
Observation only, so it builds and tests **on Linux** as well as on Apple
platforms. That covers the wire format, the stream bridge and the whole chat
state machine, and CI runs all of it against a real server. The app target
is views.

## Running it

You need Xcode 26 (for the iOS 26 SDK) and [XcodeGen](https://github.com/yonaskolb/XcodeGen):

```sh
brew install xcodegen
cd apps/ios
xcodegen generate
open Hat.xcodeproj           # run the Hat scheme on a simulator or device
```

Re-run `xcodegen generate` after adding or removing files. The project is
gitignored so it can never drift from `project.yml`.

You need a hat server the simulator can reach. The server binds `127.0.0.1` by
default, which the simulator *can* reach, so `localhost:8787` works there. For
a physical device, widen both of these:

```sh
HAT_HOST=0.0.0.0 HAT_AUTH_TOKEN=$(openssl rand -hex 32) pnpm dev:server
```

`HAT_CORS_ORIGINS` is not involved: a native client is not subject to CORS,
and it is a bearer client with no cookies. Put the server on Tailscale or
behind TLS rather than exposing it (see [Transport](#transport)).

## Tests

```sh
pnpm ios:test                               # everything, against a live server
cd apps/ios/HatKit && swift test            # unit tests only; ServerTests skip
```

`pnpm ios:test` (`apps/ios/scripts/test-hatkit.sh`) boots a server with the
fake provider and a runner on throwaway state, then runs `swift test` with
`HAT_TEST_SERVER` pointing at it. `ServerTests` drive `ChatStore` the way the
app does:

- a streamed turn settling on the stored transcript;
- regenerate and branch switching, fork, and Markdown export;
- Continue on a reply cut off at the length limit;
- a tool approval round trip through the runner, and an approval answered
  from a second store that reattached to the turn mid-way;
- a send refused while another reply runs giving its draft back, with the
  server's reason;
- Stop cancelling the turn on the server rather than only detaching;
- document upload, the HEIC rejection, and search;
- conversation settings, including resetting to the provider default, a new
  chat's settings reaching the server ("ask" included), and a restored
  conversation keeping its own reasoning effort;
- rename, delete, and the 401 path.

The CI `ios-core` job runs the same script on Linux.

`SSETests` and `ChatViewTests` hold the same cases as `packages/core`'s
`sse.test.ts` and `chat-view.test.ts`. The parser and the view-model now
exist twice, once per language. If you change the TypeScript, change the
Swift and its tests too; the matching cases are what keep the two honest.

On Linux, Swift 6.1's `libswiftObservation` references a symbol it does not
link, so the script passes `-Xlinker --allow-shlib-undefined` there.

## How it works

### The stream is a delegate, not `bytes(for:)`

The turn endpoint is a **POST** that answers with `text/event-stream`, so
`EventSource`-style APIs are out. `HatClient` reads the body with a
`URLSessionDataDelegate` (`SSEConnection`) that feeds each chunk to the frame
parser as it arrives, and hands the decoded events to an
`AsyncThrowingStream`. `URLSession.bytes(for:)` would be shorter, but Linux
Foundation lacks it, and the delegate keeps the client testable there.

The parser works on **bytes** and only decodes a frame once it is complete,
so a multi-byte character split across two chunks is reassembled before it
is decoded. `SSETests` splits a frame at every byte offset to pin that.

### Auth is the bearer token, not a login

The server's browser flow uses an HttpOnly session cookie plus a
double-submit CSRF token. `HAT_AUTH_TOKEN` is accepted as an
`Authorization: Bearer` credential and is **exempt from CSRF**. The app stores
the URL and token as one keychain item
(`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so it never travels in a
backup) and sends the token on every request. `/api/auth/*` is never called.
The `URLSession` has cookies switched off.

A 401 anywhere means the token was rotated on the server. `HatClient` reports
it once, and `AppModel` drops the connection and returns to Connect.

### The state machine

`ChatStore` is the port of the state block in `apps/web/src/App.tsx` (by way
of the React Native app's `useChat`). It is `@MainActor @Observable` and is
mounted once, above the navigation, so pushing and popping screens never
tears down a stream. Two invariants from the web client are load-bearing and
preserved:

- **Usage is counted once.** A `usage` event lands on the in-flight message
  it belongs to, so a turn's cost moves with its messages: into `messages`
  when they are promoted at the end of the turn, then replaced by the stored
  figures on refresh. There is no separate running tally.
- **A turn always ends in a refresh.** The streamed view is an optimistic
  projection; the server's path is the truth. Streamed messages are promoted
  into `messages` *before* the refetch, so the refetch is a reconciliation
  that cannot blank the last deltas.

`message.start` fires once per *model iteration*, so the in-flight state is a
**list**: a turn that calls tools produces several assistant messages, each
holding the tool cards for its own calls.

**Streamed text is published at about 12 fps.** Events update an unobserved
copy of the in-flight list, and the observed one catches up every 80 ms.
Markdown is re-parsed on each render, so rendering every token makes a long
reply stutter.

### Turns outlive their connection

The server keeps a turn running when the client disconnects, so two things
that look alike are different requests:

- **Stop** posts `/turn/cancel`, then drops the socket. Dropping it alone would
  stop the updates while the model kept generating and billing.
- **Leaving** (switching conversations, backgrounding) only detaches. Coming
  back reattaches via `GET /stream`.

The app reattaches on launch, on opening a conversation, and on returning to
the foreground (`scenePhase`). iOS suspends backgrounded apps freely, so on a
phone a turn outliving its connection is the common case.

Switching conversations clears the old one **at once**, not when the new one
has loaded. A reattach scheduled for the old conversation (at boot, say) then
finds it gone and stands down. It no longer marks the store busy under the
conversation being opened, which used to swallow the next send. The React
Native app had that race; `ServerTests` caught it in the port.

Reattaching mid-turn brings the message that made a tool call back with the
stored history (it was saved before the call ran), so the replayed
`tool.approval` and the `tool.result` are applied to that stored card too
(`applyStoredEffect`), and the approval panel looks at both lists. Without it,
an approval came back with no buttons and the turn waited on it. A tap is
recorded at once and put back to "requested" if the server rejects it.

**A send that goes nowhere gives its draft back**: an upload the server
rejects, a turn it refuses (409 while another reply runs, 429), or the user
opening another conversation before the message could go. The draft is kept
in `ChatStore.unsentDrafts` under the conversation it was written in, and the
composer takes it back only while that conversation is open, keeping any text
or attachments written since. Deleting the conversation drops it.

### Attachments

- **Images** come from Photo Library (`PhotosPicker`, which needs no
  permission prompt) or Camera. The server only accepts **PNG, JPEG, GIF and
  WebP**, because it reads dimensions from the file header with no native
  image dependency. The app checks the actual bytes (`sniffImageMime`) and
  re-encodes anything else, HEIC mostly, as JPEG before upload. It no longer
  rejects the photo, as the React Native app did.
- **Documents** come from Files (`fileImporter`). The server takes text, code
  and PDFs with extractable text, reads them to text on upload and puts a
  file part on the user message. The app sends each document's name in
  `attachmentNames`, because content is stored by hash and a repeated upload
  would otherwise keep its first name. Only size (25 MB) is checked
  client-side; anything else the server cannot read comes back with the
  server's own reason, which is shown as the error.
- **Stored attachments** need the bearer token, so views never fetch them
  directly. `ImageLoader` downloads through `HatClient` and caches by
  attachment id (attachments are immutable). Tapping a file card downloads it
  under its own name and opens it in **Quick Look**, which has Share, Save to
  Files and Markup built in.

## Screens

- **Connect**: server URL and token, probed against `GET /api/health`
  before being saved, so a typo fails immediately and specifically.
- **Chats**: the root on iPhone, the sidebar on iPad (`NavigationSplitView`).
  Sessions are grouped by date, with search, and swipe or long-press to rename
  or delete (delete is confirmed). Each row shows what the conversation is
  doing: "Responding" while a turn runs, an orange "Needs you" while one waits
  on an approval or an `ask_user` question. The list refetches when shown and
  polls every 4 s while anything is active.
- **Search**: the search field filters titles instantly and, once typing
  pauses, also runs the server's full-text search (`GET /api/search`). Matching
  messages appear in a Messages section with the matched terms in bold. Tapping
  one selects the branch that holds it (`POST …/select`) and opens it there.
- **Chat**: the streaming transcript, with:
  - Markdown, and collapsible tool cards and reasoning;
  - approvals at the composer, and branch navigation (`‹ n/m ›`);
  - regenerate, edit-and-resend, and Stop mid-turn;
  - camera, library and document attachments.

  A reply cut off at the output limit gets a **Continue** button
  (`POST …/continue`). Long-pressing a reply offers **Fork from Here**
  (`POST …/fork`). The options menu offers:
  - reasoning effort and tool approval;
  - Change Model and Instructions & Sampling;
  - **Export as Markdown…**, which goes to the share sheet;
  - usage and context fill.
- **Context fill**: the title's subtitle shows the model and how full its
  context window is (`· 42%`, orange from 80%). The figure is the latest
  model call's prompt plus reply over the model's `contextWindow`.
- **Conversation settings**: instructions, temperature and max reply tokens
  (`PATCH /api/sessions/:id`), saved with Save. An empty field means the
  provider default. The screen opens as a sheet from the options menu and is
  also pushed from Settings.
- **Model**: a sheet, grouped by provider, with search.
- **Settings**: a sheet with its own stack. The conversation section comes
  first (reasoning, tool approval, instructions & sampling, allowlist), then
  Providers, Plugins and Runners, then Server. Plugin settings are generated
  from the plugin's JSON schema.

## Native chrome and Liquid Glass

The app uses the system's own chrome everywhere, so on iOS 26 the navigation
bars, toolbar buttons, menus, sheets, search field and split view are Liquid
Glass without any code here.

Glass drawn by the app (`Hat/App/Glass.swift`) is limited to controls that
float over content, which is where the HIG puts it:

- the composer: the attach button and the input capsule, merged by
  `GlassEffectContainer`;
- the approval and edit panels above the composer;
- the jump-to-latest button;
- the image viewer's buttons.

Content stays solid: bubbles, tool cards and settings rows. Below iOS 26 the
same surfaces use `.regularMaterial`. Settings shows which one is active.

Other system behaviour the app leans on:

- **Keyboard.** The composer is a `safeAreaInset` on the transcript, so it
  rides the keyboard, and the transcript dismisses it interactively.
- **Context menus.** Long-pressing a message offers Copy, Select Text, Share,
  and Edit, or Regenerate and Fork from Here. Select Text opens a
  `UITextView` sheet with real selection handles.
- **Haptics** mark send, selection changes, a tool asking for approval, a
  reply finishing, and failures.

## Building

### Unsigned IPA in CI (free Apple ID)

[`.github/workflows/ios-ipa.yml`](../.github/workflows/ios-ipa.yml) runs on
`workflow_dispatch`, on a `mobile-v*` tag, and on pull requests that touch
`apps/ios`. It:

1. runs HatKit's unit tests;
2. generates the project with XcodeGen;
3. builds Release for devices with signing off;
4. uploads `hat-unsigned-ipa`.

Install the IPA with **SideStore**, which re-signs on-device and refreshes
itself. AltStore and Sideloadly also work. Free-account limits: apps expire
after **7 days**, at most **3** sideloaded apps at once, and **no push
notifications**.

### Signed builds (paid Apple Developer account)

Set your team in Xcode (Signing & Capabilities), then Product › Archive, and
distribute ad hoc or to TestFlight. To keep the team in the spec, add
`DEVELOPMENT_TEAM` to `project.yml`.

## Transport

iOS App Transport Security blocks plain HTTP. `project.yml` sets
`NSAllowsLocalNetworking`, which permits unqualified hostnames, `.local`, and
link-local addresses. That is enough for the simulator and for Tailscale. It
does **not** cover a plain-HTTP server on a LAN address like
`192.168.1.10:8787`. For that, terminate TLS in front of the server (Caddy,
Traefik, or a Tailscale HTTPS certificate) rather than adding
`NSAllowsArbitraryLoads`, which disables the protection app-wide.

A server address typed without a scheme gets `http://` only when it looks
local (localhost, an unqualified name, `.local`, a private, link-local or
Tailscale IP) and `https://` otherwise. When ATS does block a request, the
connect screen says so and suggests the `https://` address instead of showing
iOS's generic "secure connection required" error.

## What changed from the React Native app

- **No over-the-air updates.** Expo's `expo-updates` is gone, so every change
  ships as a build. On a free Apple ID that means rebuilding and re-signing,
  which SideStore's 7-day refresh already forces anyway.
- **iPad gets a sidebar** (`NavigationSplitView`) instead of the phone stack.
- **HEIC photos are converted to JPEG** instead of being rejected.
- **Files open in Quick Look** instead of going straight to the share sheet.
- **Return inserts a newline** in the composer; send with the button, as in
  Messages.
- **Minimum iOS is 18** (for `@Observable`, `onScrollGeometryChange` and the
  current split-view behaviour).
- The bundle id is unchanged (`chat.t3code.hat`), so the new build installs
  over the old one. The keychain item is new, so you connect once more.

## Known gaps

- **Push notifications.** "Turn finished" and "needs approval" alerts while
  the app is backgrounded would need APNs, and so a paid Apple Developer
  account. A turn that finishes, or starts waiting on you, while the app is
  suspended shows up on the next foreground.
- **JSON import** (`POST /api/sessions/import`) is web-only.
- **Offline / queued turns.** A send that fails on a dead connection surfaces
  as an error rather than being queued.
- **Syntax highlighting.** Fenced blocks get a monospace surface.
- **Markdown** is a pragmatic subset: paragraphs, headings, fenced code, nested
  and task lists, quotes, tables and rules, with SwiftUI's inline syntax.
  An image on a line of its own is shown if it is a data URL; one from the
  web is a "Load image from <host>" button, since fetching it would send
  whatever a steered reply put in its URL. Images inside a sentence, and
  HTML, are shown as text. Only `http`, `https`, `mailto` and `tel` links
  open; others are plain text.
- **The app icon** is still Expo's template placeholder (with dark and tinted
  variants). Real icon art, ideally an Icon Composer `.icon`, is still to do.
- **No device or simulator pass yet.** HatKit is covered end to end against a
  live server, but the SwiftUI layer has only been compiled by CI (it needs
  Xcode) and not yet exercised on hardware.
