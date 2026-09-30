import HatKit
import SwiftUI

/// The connected app: conversations in a sidebar, the open one beside it.
///
/// A `NavigationSplitView`, so iPhone gets the stack Messages uses (the list
/// at the root, the conversation pushed on top) and iPad gets a sidebar.
/// Settings, the model picker and the conversation settings are sheets.
struct ShellView: View {
    @Environment(ChatStore.self) private var store
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass

    /// The conversation shown in the detail column. Driving this is what opens
    /// one; the store follows it.
    @State private var selection: String?
    @State private var columnVisibility = NavigationSplitViewVisibility.automatic

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            SessionsView(selection: $selection)
        } detail: {
            if selection != nil {
                ChatScreen(selection: $selection)
            } else {
                ContentUnavailableView(
                    "No Conversation Selected",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Pick a conversation, or start a new one.")
                )
            }
        }
        .task {
            await store.boot()
            // With a sidebar there is room to show the restored conversation at
            // once; on iPhone the list stays the first thing you see.
            if sizeClass == .regular, let id = store.sessionId { selection = id }
        }
        .onChange(of: selection) { _, id in
            // Opening is only needed when the store is not already there: the
            // New Chat, fork and search paths switch the store first.
            guard let id, id != store.sessionId else { return }
            Task {
                do {
                    try await store.openSession(id)
                } catch {
                    store.report(describe(error))
                }
            }
        }
        .onChange(of: scenePhase) { old, new in
            // A suspended socket is not a reliable stream, but the turn kept
            // running on the server: coming back asks what is happening.
            if new == .active, old != .active { store.didBecomeActive() }
        }
    }
}
