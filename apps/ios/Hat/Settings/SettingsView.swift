import HatKit
import SwiftUI

enum SettingsRoute: Hashable {
    case providers
    case provider(String)
    case plugins
    case plugin(String)
    case runners
    case allowlist
    case conversation
    case connection
}

/// The Settings sheet: the current conversation's settings first, then the
/// server's providers, plugins and runners, then the connection. It has its
/// own navigation stack, so detail screens push inside the sheet.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SettingsHome()
                .navigationTitle("Settings")
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
                .navigationDestination(for: SettingsRoute.self) { route in
                    switch route {
                    case .providers: ProvidersView()
                    case let .provider(id): ProviderView(providerId: id)
                    case .plugins: PluginsView()
                    case let .plugin(id): PluginView(pluginId: id)
                    case .runners: RunnersView()
                    case .allowlist: AllowlistView()
                    case .conversation: ConversationSettingsView(asSheet: false)
                    case .connection: ConnectionSettingsView()
                    }
                }
        }
    }
}

/// Something fetched from the server for a settings screen: the value, the
/// last error, and a confirmation after a change.
@MainActor
@Observable
final class Loadable<Value> {
    var value: Value?
    var error: String?
    var notice: String?

    func load(_ fetch: () async throws -> Value) async {
        do {
            value = try await fetch()
            error = nil
        } catch {
            if !isCancellation(error) { self.error = describe(error) }
        }
    }

    /// Run a change, report how it went, and refetch on success.
    @discardableResult
    func change(_ notice: String, run: () async throws -> Void, refetch: () async throws -> Value) async -> Bool {
        error = nil
        self.notice = nil
        do {
            try await run()
        } catch {
            Haptics.error()
            self.error = describe(error)
            return false
        }
        Haptics.success()
        self.notice = notice
        await load(refetch)
        return true
    }
}

/// Notices at the top of a settings list.
struct Notices<Value>: View {
    var data: Loadable<Value>
    var errorTitle = "Request failed"

    var body: some View {
        if data.error != nil || data.notice != nil {
            Section {
                if let error = data.error {
                    Banner(tone: .error, title: errorTitle, detail: error)
                }
                if let notice = data.notice {
                    Banner(tone: .info, title: notice) { data.notice = nil }
                }
            }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
        }
    }
}

/// The coloured tile a settings row leads with, as in the Settings app.
struct SettingsLabel: View {
    var title: String
    var icon: String
    var color: Color

    var body: some View {
        Label {
            Text(title)
        } icon: {
            Image(systemName: icon)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 28, height: 28)
                .background(color, in: .rect(cornerRadius: 7, style: .continuous))
        }
    }
}

private struct Overview {
    var providers: [ProviderStatus]
    var plugins: [PluginDescriptor]
    var runners: [RunnerSummary]
}

private struct SettingsHome: View {
    @Environment(ChatStore.self) private var store
    @Environment(AppModel.self) private var app
    @State private var data = Loadable<Overview>()
    @State private var confirmDisconnect = false

    private static let policyNotes: [ApprovalMode: String] = [
        .ask: "Tools that require approval pause the turn and wait for you.",
        .auto: "Every tool runs without asking. Only do this for a runner you trust.",
        .allowlist: "Only the allowed tools run unattended; everything else asks.",
        .deny: "All tool execution is blocked. Useful for a pure chat conversation.",
    ]

    private var reasoning: Bool { store.selectedModel?.capabilities.reasoningEffort == true }

    private var conversationFooter: String {
        [
            reasoning ? "Reasoning sets how long the current model thinks before answering." : nil,
            Self.policyNotes[store.policyMode],
            "These settings apply to the current conversation.",
        ].compactMap { $0 }.joined(separator: " ")
    }

    private var tuningSummary: String {
        let tuned = [
            !(store.session?.instructions ?? "").isEmpty,
            store.session?.temperature != nil,
            store.session?.maxTokens != nil,
        ].filter { $0 }.count
        return tuned == 0 ? "Default" : "\(tuned) set"
    }

    private var host: String {
        let url = app.config.serverUrl
        guard let range = url.range(of: "://") else { return url.isEmpty ? "Not set" : url }
        return String(url[range.upperBound...])
    }

    var body: some View {
        List {
            Notices(data: data, errorTitle: "Could not load settings")

            Section {
                if reasoning {
                    Picker(selection: Binding(get: { store.reasoningEffort }, set: { store.setEffort($0) })) {
                        ForEach(ReasoningEffort.allCases, id: \.self) { Text($0.label).tag($0) }
                    } label: {
                        SettingsLabel(title: "Reasoning", icon: "brain", color: .indigo)
                    }
                    .pickerStyle(.menu)
                }
                Picker(selection: Binding(get: { store.policyMode }, set: { store.setPolicyMode($0) })) {
                    ForEach(ApprovalMode.allCases, id: \.self) { Text($0.label).tag($0) }
                } label: {
                    SettingsLabel(title: "Tool Approval", icon: "hand.raised.fill", color: .blue)
                }
                .pickerStyle(.menu)
                NavigationLink(value: SettingsRoute.conversation) {
                    LabeledContent {
                        Text(tuningSummary)
                    } label: {
                        SettingsLabel(title: "Instructions & Sampling", icon: "text.bubble.fill", color: .orange)
                    }
                }
                if store.policyMode == .allowlist {
                    NavigationLink(value: SettingsRoute.allowlist) {
                        LabeledContent {
                            Text("\(store.allowedTools.count)")
                        } label: {
                            SettingsLabel(title: "Allowed Tools", icon: "checklist", color: .teal)
                        }
                    }
                }
            } header: {
                Text("Conversation")
            } footer: {
                Text(conversationFooter)
            }

            Section("Server") {
                NavigationLink(value: SettingsRoute.providers) {
                    LabeledContent {
                        if let overview = data.value {
                            Text("\(overview.providers.filter(\.configured).count) of \(overview.providers.count) set")
                        }
                    } label: {
                        SettingsLabel(title: "Providers", icon: "key.fill", color: .orange)
                    }
                }
                NavigationLink(value: SettingsRoute.plugins) {
                    LabeledContent {
                        if let overview = data.value {
                            let issues = overview.plugins.filter { $0.status == "error" || $0.status == "needs-config" }.count
                            if issues > 0 {
                                Badge(label: issues == 1 ? "1 issue" : "\(issues) issues", tone: .warn)
                            } else {
                                Text("\(overview.plugins.count)")
                            }
                        }
                    } label: {
                        SettingsLabel(title: "Plugins", icon: "puzzlepiece.extension.fill", color: .purple)
                    }
                }
                NavigationLink(value: SettingsRoute.runners) {
                    LabeledContent {
                        if let overview = data.value { Text("\(overview.runners.count) online") }
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            SettingsLabel(title: "Runners", icon: "server.rack", color: .green)
                            if data.value?.runners.isEmpty == true {
                                Text("None connected — tools will fail")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                                    .padding(.leading, 40)
                            }
                        }
                    }
                }
            }

            Section {
                NavigationLink(value: SettingsRoute.connection) {
                    LabeledContent {
                        Text(host)
                    } label: {
                        SettingsLabel(title: "Server", icon: "network", color: .blue)
                    }
                }
                LabeledContent {
                    Text(GlassSupport.isAvailable ? "Liquid Glass" : "Material Blur")
                } label: {
                    SettingsLabel(title: "Chrome", icon: "sparkles", color: .gray)
                }
            } header: {
                Text("Connection")
            } footer: {
                if !GlassSupport.isAvailable {
                    Text("Liquid Glass needs iOS 26; until then the chrome uses a material blur.")
                }
            }

            Section {
                Button("Disconnect", role: .destructive) {
                    Haptics.warning()
                    confirmDisconnect = true
                }
            }
        }
        .task {
            await data.load {
                async let providers = store.client.providers()
                async let plugins = store.client.plugins()
                async let runners = store.client.runners()
                return try await Overview(providers: providers, plugins: plugins, runners: runners)
            }
        }
        .alert("Disconnect from this server?", isPresented: $confirmDisconnect) {
            Button("Disconnect", role: .destructive) { app.disconnect() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("To reconnect you will need the server URL and its access token again.")
        }
    }
}

struct ConnectionSettingsView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ConnectionForm(buttonTitle: "Save", initial: app.config) { url, token in
                    // A new connection replaces the chat store, and with it this sheet.
                    try await app.connect(serverUrl: url, token: token)
                }
                Text("The connection is checked before it is saved.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 16)
            }
            .padding(16)
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .navigationTitle("Server")
        .navigationBarTitleDisplayMode(.inline)
    }
}
