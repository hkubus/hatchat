# iOS app plan (no Mac, free Apple ID, sideloaded)

Status: **planned, not started.** Captured while the focus moved back to the web app.

## Goal & constraints

- Native-ish iOS app for `hat` that talks to the existing server.
- **No Mac owned.** Free Apple ID (not the $99 program).
- **7-day re-signing is acceptable.**
- Want the authentic iOS 26 **Liquid Glass** look where possible.

## The one hard constraint

You can write code anywhere, but a real iOS binary needs the **iOS SDK**, which
ships only with **Xcode**, which runs only on **macOS**. Open-source Swift on
Linux has no iOS SDK / SwiftUI / UIKit. So every route below builds on macOS —
the only question is whether it's *your* Mac or a cloud one.

- No macOS anywhere → **PWA only** (no native build; `backdrop-filter` lookalike,
  not real Liquid Glass).
- No Mac owned → build on **hosted macOS**: GitHub Actions `macos-*` runners
  (free for public repos), EAS Build, Codemagic, or a rented cloud Mac.

## Options considered

| Approach | Reuses web UI | Real Liquid Glass | Build | Notes |
|---|---|---|---|---|
| PWA | yes (100%) | no | none | No App Store, no Mac, but not a native app |
| Capacitor | yes (100%) | no (WebView) | Xcode → macOS CI | Fastest real installable app |
| Tauri v2 iOS | yes | no (WebView) | Xcode → macOS CI | Unifies with desktop target |
| **Expo / React Native** | logic/types only | **yes** (via native module) | EAS or GH macOS | Reuse `@hat/core`, rewrite screens |
| SwiftUI | no | yes (free: `.glassEffect()`) | EAS not applicable → GH macOS | Best fidelity, full rewrite |

## Chosen approach

**Expo (React Native) + free-Apple-ID sideload**, built as an **unsigned IPA** on
a GitHub Actions macOS runner, installed and signed on-device by **SideStore**.

Why not EAS managed signing for the free route: EAS's managed device builds
assume a **paid** Apple account; free personal-team signing isn't supported by
that flow. (If we ever pay, EAS internal distribution / TestFlight becomes the
easy button — see "If we go paid".)

Install layer: **SideStore** re-signs on-device after a one-time setup, so no
computer is needed for the weekly refresh. AltStore classic needs AltServer on a
Windows/macOS machine on the LAN; Sideloadly (Win/macOS) is the simplest one-off.

## App architecture

- Standalone `apps/mobile` (Expo). Optionally add to the pnpm workspace and
  depend on `@hat/core` for shared types (Expo supports monorepos; may need
  `metro.config.js` workspace settings).
- Talks to the same server over HTTP + SSE. No server changes required.
- Screens: connect (server URL + token), conversation list, chat (streaming,
  tool cards, approvals), settings (models, plugins).

### Auth: use the bearer token, not cookies

The server's login sets an HttpOnly session cookie + requires CSRF, which is
awkward in a native client. `HAT_AUTH_TOKEN` is already accepted as a bearer
credential and is CSRF-exempt.

- Server: set `HAT_AUTH_TOKEN=<long-random>`.
- App: store server URL + token in `expo-secure-store`, send
  `Authorization: Bearer <token>` on every request.

### Streaming client (critical detail)

Use `expo/fetch` (Expo SDK 52+), which supports streaming response bodies. RN's
default `fetch` buffers and cannot stream the turn SSE. `EventSource` is not
usable because the turn endpoint is a **POST**.

```ts
import { fetch as expoFetch } from "expo/fetch";

const headers = () => ({
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
});

export async function runTurn(sessionId: string, text: string, onEvent: (e: any) => void) {
  const res = await expoFetch(`${base}/api/sessions/${sessionId}/turn`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ text }),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i = buf.indexOf("\n\n");
    while (i !== -1) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) onEvent(JSON.parse(line.slice(5).trim()));
      }
      i = buf.indexOf("\n\n");
    }
  }
}
```

Approvals: `POST /api/approvals/:callId` (same as `apps/web`).
Attachments: `expo-image-picker` → append `{ uri, name, type }` to `FormData` →
`POST /api/attachments` (no `content-type` header; let it set the boundary).

## Liquid Glass native module

Real Liquid Glass is Apple's `UIGlassEffect` / SwiftUI `.glassEffect()`, usable
only when compiled against the **iOS 26 SDK (Xcode 26)** and only on iOS 26+.
React Native can host real native views, so a small Expo module surfaces it.

`modules/liquid-glass/ios/LiquidGlassModule.swift`:

```swift
import ExpoModulesCore
import UIKit

final class GlassView: ExpoView {
  private let blur = UIVisualEffectView(effect: nil)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    blur.translatesAutoresizingMaskIntoConstraints = false
    addSubview(blur)
    NSLayoutConstraint.activate([
      blur.leadingAnchor.constraint(equalTo: leadingAnchor),
      blur.trailingAnchor.constraint(equalTo: trailingAnchor),
      blur.topAnchor.constraint(equalTo: topAnchor),
      blur.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    if #available(iOS 26.0, *) {
      blur.effect = UIGlassEffect()                        // real Liquid Glass
    } else {
      blur.effect = UIBlurEffect(style: .systemMaterial)   // fallback
    }
  }
}

public final class LiquidGlassModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiquidGlass")
    View(GlassView.self) {}
  }
}
```

`modules/liquid-glass/expo-module.config.json`:

```json
{ "platforms": ["apple"], "apple": { "modules": ["LiquidGlassModule"] } }
```

TS wrapper with fallback:

```tsx
import { requireNativeViewManager } from "expo-modules-core";
import { BlurView } from "expo-blur";
import { Platform } from "react-native";

const NativeGlass = Platform.OS === "ios" ? requireNativeViewManager("LiquidGlass") : null;

export function Glass({ children, style }: { children?: React.ReactNode; style?: any }) {
  if (NativeGlass) return <NativeGlass style={style}>{children}</NativeGlass>;
  return <BlurView intensity={40} tint="systemMaterial" style={style}>{children}</BlurView>;
}
```

Notes:
- SwiftUI `.glassEffect()` via `UIHostingController` is the alternative; UIKit's
  `UIGlassEffect` is fewer moving parts.
- Use **native tab bars** (Expo Router native tabs) on iOS 26 so the system
  renders glass automatically instead of JS-drawn chrome.

## Build pipeline (free path): unsigned IPA in CI

EAS managed signing assumes a paid account, so for the free route build the
unsigned IPA on a GitHub Actions macOS runner.

```sh
npx expo prebuild -p ios --clean
```

```yaml
# .github/workflows/ios-ipa.yml
name: ios-ipa
on: workflow_dispatch
jobs:
  build:
    runs-on: macos-15            # choose an image whose default Xcode is 26+
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx expo prebuild -p ios --clean
      - run: cd ios && pod install
      - name: Build unsigned
        run: |
          WS=$(ls -d ios/*.xcworkspace | head -1)
          xcodebuild -workspace "$WS" -scheme "$(basename ios/*.xcodeproj .xcodeproj)" \
            -configuration Release -sdk iphoneos -derivedDataPath build \
            CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""
      - name: Package IPA
        run: |
          mkdir -p Payload
          cp -R build/Build/Products/Release-iphoneos/*.app Payload/
          zip -r hat-unsigned.ipa Payload
      - uses: actions/upload-artifact@v4
        with: { name: hat-unsigned-ipa, path: hat-unsigned.ipa }
```

Then download `hat-unsigned.ipa` and install:

- **SideStore** — signs with the free Apple ID and re-signs **on-device**; no
  computer needed after the one-time setup (WireGuard loopback pair file).
- **AltStore classic** — AltServer on Windows/macOS on the LAN, auto-refresh.
- **Sideloadly** — Win/macOS, simplest one-off.

First install of SideStore itself usually needs a computer (or another installed
app) once; after that it self-refreshes.

## Free-account limits

- Apps expire after **7 days** → weekly re-sign.
- Max **3** sideloaded apps at once.
- **No push notifications** (APNs needs a paid team); some entitlements
  (keychain groups, app groups) unavailable. SecureStore keychain access is fine.

## Gotchas

- **Xcode 26 / iOS 26 SDK** required for Liquid Glass; keep the blur fallback for
  older iOS. Select a CI image that has Xcode 26+.
- **ATS**: iOS blocks plain HTTP except localhost. Serve the server over HTTPS
  (reverse proxy + cert) or use Tailscale, else a dev-only ATS exception.
- **Streaming**: use `expo/fetch`; not `EventSource`, not default `fetch`.
- **CSRF**: irrelevant with the bearer token — don't also log in via cookies.

## If we go paid ($99/yr)

- Drop the sideload layer: **EAS internal distribution** (1-year ad-hoc install
  link) or **TestFlight** (90-day builds). EAS managed signing just works then.
- Unlocks push notifications and full entitlements.

## First steps when we pick this up

1. `npx create-expo-app hat-mobile` (or add `apps/mobile` to the workspace).
2. Configure `app.json` (bundle id, scheme) and `eas.json`.
3. Implement the API client (bearer + `expo/fetch` streaming) and connect screen.
4. Add the `liquid-glass` local module.
5. Push, run the CI workflow, install the unsigned IPA via SideStore.
