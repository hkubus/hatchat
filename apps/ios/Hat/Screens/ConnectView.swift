import HatKit
import SwiftUI

/// First run: point the app at a hat server.
///
/// There is no login form on purpose. `HAT_AUTH_TOKEN` is accepted as a bearer
/// credential and exempt from the browser flow's cookie and CSRF token, so the
/// token is the whole of it. The URL and token are probed before being saved,
/// so a typo fails here, specifically, rather than on the first send.
struct ConnectView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 24) {
                    VStack(spacing: 8) {
                        Image(systemName: "server.rack")
                            .font(.system(size: 34, weight: .medium))
                            .foregroundStyle(.white)
                            .frame(width: 72, height: 72)
                            .background(Theme.accent, in: .rect(cornerRadius: 18, style: .continuous))
                            .padding(.bottom, 8)
                        Text("Connect to hat")
                            .font(.largeTitle.bold())
                        Text("Enter the address of your hat server and its access token.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .padding(.top, 40)

                    ConnectionForm(buttonTitle: "Connect", initial: app.config) { url, token in
                        try await app.connect(serverUrl: url, token: token)
                    }

                    Text(GlassSupport.isAvailable
                         ? "Liquid Glass is active on this device."
                         : "Liquid Glass needs iOS 26; the chrome uses a material blur.")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(20)
                .frame(maxWidth: 520)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color(uiColor: .systemGroupedBackground))
        }
    }
}

/// Server URL and token, probed before they are saved. Shared by the first-run
/// screen and Settings › Server.
struct ConnectionForm: View {
    var buttonTitle: String
    var initial: HatConfig
    var onSubmit: (_ serverUrl: String, _ token: String) async throws -> Void

    @State private var serverUrl = ""
    @State private var token = ""
    @State private var busy = false
    @State private var error: String?
    @State private var loaded = false

    private var normalized: String { normalizeServerUrl(serverUrl) }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            field(
                "Server URL",
                hint: normalized.isEmpty ? "The address the hat server is reachable at." : "Requests go to \(normalized)/api"
            ) {
                TextField("https://hat.example.ts.net", text: $serverUrl)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            field(
                "Access token",
                hint: "Stored in the iOS keychain and sent as a bearer token. Leave blank only if your server has no auth set."
            ) {
                SecureField("HAT_AUTH_TOKEN", text: $token)
                    .textContentType(.password)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }

            if let error {
                Banner(tone: .error, title: "Could not connect", detail: error)
            }

            Button {
                Task { await submit() }
            } label: {
                HStack {
                    if busy { ProgressView().tint(.white) }
                    Text(busy ? "Checking…" : buttonTitle).fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .buttonBorderShape(.capsule)
            .disabled(normalized.isEmpty || busy)
        }
        .padding(16)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: 20, style: .continuous))
        .onAppear {
            guard !loaded else { return }
            loaded = true
            serverUrl = initial.serverUrl
            token = initial.token
        }
    }

    private func field(_ label: String, hint: String, @ViewBuilder input: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.subheadline.weight(.semibold))
            input()
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color(uiColor: .tertiarySystemFill), in: .rect(cornerRadius: 10, style: .continuous))
            Text(hint).font(.footnote).foregroundStyle(.secondary)
        }
    }

    private func submit() async {
        busy = true
        error = nil
        defer { busy = false }
        do {
            try await onSubmit(serverUrl, token)
            Haptics.success()
        } catch {
            Haptics.error()
            self.error = describe(error)
        }
    }
}
