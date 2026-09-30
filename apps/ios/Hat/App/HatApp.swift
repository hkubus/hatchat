import HatKit
import SwiftUI

/// The app shell. Three gates before any chat state exists:
///
///   1. Read the connection from the keychain.
///   2. With no server URL, the user has never connected: show Connect.
///   3. Otherwise mount the chat store above the navigation, so pushing and
///      popping screens never tears down a stream in flight.
@main
struct HatApp: App {
    @State private var app = AppModel()

    var body: some Scene {
        WindowGroup {
            Group {
                if let store = app.store {
                    ShellView()
                        .environment(store)
                        // A new connection is a new store; nothing carries over.
                        .id(ObjectIdentifier(store))
                } else {
                    ConnectView()
                }
            }
            .environment(app)
            .tint(Theme.accent)
        }
    }
}

/// Owns the connection. A 401 anywhere means the token was rotated on the
/// server, so the app forgets the connection and returns to Connect rather
/// than failing on every screen in turn.
@MainActor
@Observable
final class AppModel {
    private(set) var config: HatConfig
    private(set) var store: ChatStore?

    init() {
        config = Keychain.loadConfig() ?? .empty
        if !config.serverUrl.isEmpty { store = makeStore(config) }
    }

    private func makeStore(_ config: HatConfig) -> ChatStore {
        let client = HatClient(config: config, onUnauthorized: { [weak self] in
            Task { @MainActor in self?.disconnect() }
        })
        return ChatStore(client: client)
    }

    /// Probe the server, then save the connection and start over against it.
    func connect(serverUrl: String, token: String) async throws {
        let next = HatConfig(serverUrl: serverUrl, token: token)
        try await HatClient.probe(next)
        Keychain.saveConfig(next)
        config = next
        store = makeStore(next)
    }

    func disconnect() {
        guard store != nil else { return }
        Keychain.deleteConfig()
        config = .empty
        store = nil
    }
}
