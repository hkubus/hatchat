import HatKit
import SwiftUI

/// The conversation list: the root on iPhone, the sidebar on iPad.
///
/// Large title, the system search field, sections by date (Today, Yesterday,
/// Previous 7 Days, …), pull to refresh. Rename and delete are where iOS users
/// look for them — swipe a row, or long-press it — and delete is always
/// confirmed.
///
/// Each row shows what the conversation is doing: "Responding" while a turn
/// runs, an orange "Needs you" while one waits on an approval or a question.
/// Statuses only change on the server, so the list polls while any is active.
struct SessionsView: View {
    @Environment(ChatStore.self) private var store
    @Binding var selection: String?

    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var searching = false
    @State private var error: String?
    @State private var showSettings = false
    @State private var renaming: SessionSummary?
    @State private var renameText = ""
    @State private var deleting: SessionSummary?

    /// Typing pauses this long before the server is searched.
    private static let searchDebounce: Duration = .milliseconds(300)
    /// How often statuses refresh while a conversation is running or waiting.
    private static let statusPoll: Duration = .seconds(4)

    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var anyActive: Bool {
        store.sessions.contains { $0.status == .running || $0.status == .waiting }
    }

    private var sections: [(title: String, sessions: [SessionSummary])] {
        let sorted = store.sessions.sorted { $0.updatedAt > $1.updatedAt }
        let needle = trimmedQuery.lowercased()
        if !needle.isEmpty {
            let matches = sorted.filter { $0.title.lowercased().contains(needle) }
            return matches.isEmpty ? [] : [("Conversations", matches)]
        }
        var grouped: [(title: String, sessions: [SessionSummary])] = []
        for session in sorted {
            let title = dateBucket(session.updatedAt)
            if grouped.last?.title == title {
                grouped[grouped.count - 1].sessions.append(session)
            } else {
                grouped.append((title, [session]))
            }
        }
        return grouped
    }

    var body: some View {
        List(selection: $selection) {
            if let error {
                Banner(tone: .error, title: "Something went wrong", detail: error) { self.error = nil }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            ForEach(sections, id: \.title) { section in
                Section(section.title) {
                    ForEach(section.sessions) { session in
                        SessionRow(session: session)
                            .tag(session.id)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button("Delete", systemImage: "trash", role: .destructive) { deleting = session }
                                Button("Rename", systemImage: "pencil") { startRename(session) }
                            }
                            .contextMenu {
                                Button("Rename", systemImage: "pencil") { startRename(session) }
                                Button("Delete", systemImage: "trash", role: .destructive) { deleting = session }
                            }
                    }
                }
            }
            if !trimmedQuery.isEmpty, !hits.isEmpty {
                Section("Messages") {
                    ForEach(hits) { hit in
                        Button {
                            Task { await open(hit) }
                        } label: {
                            SearchHitRow(hit: hit)
                        }
                        .foregroundStyle(.primary)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Chats")
        .searchable(text: $query, prompt: "Search")
        .textInputAutocapitalization(.never)
        .refreshable {
            do {
                try await store.refreshSessions()
            } catch {
                fail(error)
            }
        }
        .overlay { emptyState }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Settings", systemImage: "gearshape") { showSettings = true }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("New Chat", systemImage: "square.and.pencil") {
                    Task { await newChat() }
                }
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .onAppear {
            // Titles and statuses may have changed while a conversation was open.
            Task { try? await store.refreshSessions() }
        }
        .task(id: anyActive) {
            guard anyActive else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: SessionsView.statusPoll)
                try? await store.refreshSessions()
            }
        }
        .task(id: trimmedQuery) {
            // The title filter is instant and local; the server's full-text
            // search waits for typing to pause. A new query cancels this task,
            // so a slow response can never overwrite a newer one.
            let needle = trimmedQuery
            guard !needle.isEmpty else {
                hits = []
                searching = false
                return
            }
            searching = true
            do {
                try await Task.sleep(for: SessionsView.searchDebounce)
                let result = try await store.client.search(needle)
                hits = result
            } catch {
                // Search is an extra: a server without it still filters titles.
                if !isCancellation(error) { hits = [] }
            }
            if !Task.isCancelled { searching = false }
        }
        .alert("Rename Conversation", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $renameText)
            Button("Cancel", role: .cancel) {}
            // Captured now: dismissing the alert clears `renaming` before the task runs.
            Button("Save") {
                let target = renaming
                Task { await rename(target) }
            }
        }
        .alert(
            "Delete Conversation?",
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { session in
            Button("Delete", role: .destructive) { Task { await delete(session) } }
            Button("Cancel", role: .cancel) {}
        } message: { session in
            Text("“\(session.title)” will be deleted. This can’t be undone.")
        }
    }

    @ViewBuilder
    private var emptyState: some View {
        if !trimmedQuery.isEmpty {
            if sections.isEmpty && hits.isEmpty {
                if searching {
                    ProgressView()
                } else {
                    ContentUnavailableView.search(text: trimmedQuery)
                }
            }
        } else if store.sessions.isEmpty {
            if store.ready {
                ContentUnavailableView {
                    Label("No Conversations", systemImage: "bubble.left.and.bubble.right")
                } description: {
                    Text("Conversations you start on this server show up here.")
                } actions: {
                    Button("Start a Chat") { Task { await newChat() } }
                        .buttonStyle(.borderedProminent)
                        .buttonBorderShape(.capsule)
                }
            } else {
                ProgressView()
            }
        }
    }

    private func fail(_ error: Error) {
        Haptics.error()
        self.error = describe(error)
    }

    private func newChat() async {
        error = nil
        Haptics.tap()
        do {
            try await store.newChat()
            selection = store.sessionId
        } catch {
            fail(error)
        }
    }

    /// Open the conversation a search hit is in, on the branch that holds it.
    private func open(_ hit: SearchHit) async {
        error = nil
        do {
            try await store.openMessage(sessionId: hit.sessionId, messageId: hit.messageId)
            selection = hit.sessionId
        } catch {
            fail(error)
        }
    }

    private func startRename(_ session: SessionSummary) {
        renameText = session.title
        renaming = session
    }

    private func rename(_ session: SessionSummary?) async {
        guard let session else { return }
        let title = renameText.trimmingCharacters(in: .whitespacesAndNewlines)
        renaming = nil
        guard !title.isEmpty, title != session.title else { return }
        do {
            try await store.renameSession(session.id, title: title)
        } catch {
            fail(error)
        }
    }

    private func delete(_ session: SessionSummary) async {
        Haptics.warning()
        do {
            try await store.deleteSession(session.id)
            if selection == session.id { selection = nil }
        } catch {
            fail(error)
        }
    }
}

private struct SessionRow: View {
    var session: SessionSummary

    private var tokens: String { formatTokens(usageTotal(session.usage)) }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                // Waiting gets a symbol, not just a colour, so it reads as
                // "needs you" rather than a busier kind of running.
                if session.status == .waiting {
                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.warn)
                } else if session.status == .running {
                    Circle().fill(.secondary).frame(width: 9, height: 9)
                }
                Text(session.title)
                    .font(.headline)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Text(listTime(session.updatedAt))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Text(metaLine)
                .font(.subheadline)
                .lineLimit(1)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }

    private var metaLine: AttributedString {
        var status: AttributedString
        switch session.status {
        case .waiting:
            status = AttributedString("Needs you · ")
            status.foregroundColor = Theme.warn
            status.font = .subheadline.weight(.semibold)
        case .running:
            status = AttributedString("Responding · ")
            status.font = .subheadline.weight(.semibold)
        default:
            status = AttributedString()
        }
        var rest = AttributedString(meta)
        rest.foregroundColor = .secondary
        return status + rest
    }

    private var meta: String {
        let count = "\(session.messageCount) \(session.messageCount == 1 ? "message" : "messages")"
        return tokens.isEmpty ? count : "\(count) · \(tokens) tokens"
    }
}

private struct SearchHitRow: View {
    var hit: SearchHit

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(hit.sessionTitle).font(.headline).lineLimit(1)
                Spacer(minLength: 4)
                Text(listTime(hit.createdAt)).font(.subheadline).foregroundStyle(.secondary)
            }
            Text(snippet)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .accessibilityHint("Opens the conversation at this message.")
    }

    /// The matched terms in bold, the way Messages shows search results.
    private var snippet: AttributedString {
        var text = AttributedString(hit.role == "user" ? "You: " : "")
        text.font = .subheadline.weight(.medium)
        for part in snippetParts(hit.snippet) {
            var run = AttributedString(part.text)
            if part.hit {
                run.font = .subheadline.weight(.semibold)
                run.foregroundColor = .primary
            }
            text += run
        }
        return text
    }
}
