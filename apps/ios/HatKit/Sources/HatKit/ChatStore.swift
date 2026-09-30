import Foundation
import Observation

/// Small, non-secret UI preferences: the last model, effort and conversation.
public protocol PrefsStore: AnyObject {
    func string(forKey key: String) -> String?
    func set(_ value: String, forKey key: String)
}

public final class UserDefaultsPrefs: PrefsStore {
    private let defaults: UserDefaults
    private let prefix = "hat.pref."

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func string(forKey key: String) -> String? {
        defaults.string(forKey: prefix + key)
    }

    public func set(_ value: String, forKey key: String) {
        defaults.set(value, forKey: prefix + key)
    }
}

/// An image or document the user has picked but not sent yet.
public struct PendingAttachment: Hashable, Sendable, Identifiable {
    public enum Kind: Hashable, Sendable { case image, document }

    public var id = UUID()
    public var data: Data
    public var name: String
    public var mime: String
    /// `image` goes to the model as pixels; a `document` (text, code, PDF) is
    /// read as text by the server and shown as a file card.
    public var kind: Kind

    public init(data: Data, name: String, mime: String, kind: Kind) {
        self.data = data
        self.name = name
        self.mime = mime
        self.kind = kind
    }
}

/// What the composer held when a send went nowhere: given back so nothing
/// the user wrote is lost.
public struct UnsentDraft: Hashable, Sendable {
    public var text: String
    public var attachments: [PendingAttachment]

    public init(text: String, attachments: [PendingAttachment]) {
        self.text = text
        self.attachments = attachments
    }
}

/// Instructions, temperature and max reply tokens for one conversation.
public struct ConversationSettings: Hashable, Sendable {
    public var instructions: String
    public var temperature: Double?
    public var maxTokens: Int?

    public init(instructions: String, temperature: Double?, maxTokens: Int?) {
        self.instructions = instructions
        self.temperature = temperature
        self.maxTokens = maxTokens
    }
}

/// Prefix of ids the app makes up for things shown before the server has
/// stored them: the optimistic user message and its document cards.
public let localPrefix = "local-"

/// The chat state machine — the port of the state block in `apps/web/src/App.tsx`.
///
/// Mounted once, above the navigation stack, so pushing and popping screens
/// never tears down a stream in flight. Two invariants from the web client are
/// load-bearing:
///
///   - **Usage is counted once.** A `usage` event lands on the in-flight message
///     it belongs to, so a turn's cost moves with its messages: into `messages`
///     when they are promoted at the end of the turn, then replaced by the
///     stored figures on refresh. There is no separate running tally that would
///     have to be cleared at exactly the right moment.
///   - **A turn always ends in a refresh.** The streamed view is an optimistic
///     projection; the server's path is the truth. Streamed messages are
///     promoted *before* the refetch, so the refetch is a reconciliation that
///     cannot blank the last deltas, and if it fails what streamed stays.
///
/// Turns outlive their connection on the server. **Stop** posts `/turn/cancel`
/// and then drops the socket; **leaving** (switching conversations,
/// backgrounding) only detaches, and coming back reattaches via `/stream`.
@MainActor
@Observable
public final class ChatStore {
    public static let defaultModel = "fake/fake-agent"

    /// Streamed text is published at about 12 frames a second. Markdown is
    /// re-parsed on every render, so rendering each token makes a long reply
    /// stutter; this still reads as live typing.
    public static let publishInterval: Duration = .milliseconds(80)

    public let client: HatClient
    @ObservationIgnored private let prefs: PrefsStore

    public private(set) var ready = false
    public private(set) var models: [ModelInfo] = []
    public private(set) var sessions: [SessionSummary] = []
    public private(set) var runners: [RunnerSummary] = []
    public private(set) var sessionId: String?
    public private(set) var session: SessionRecord?
    public private(set) var messages: [UiMessage] = []
    /// Assistant messages for the turn in flight, one per model iteration.
    public private(set) var inFlight: [UiMessage] = []
    public private(set) var busy = false
    public var error: String?
    public private(set) var warnings: [String] = []
    public private(set) var model = ChatStore.defaultModel
    public private(set) var reasoningEffort: ReasoningEffort = .off
    public private(set) var policyMode: ApprovalMode = .ask
    public private(set) var allowedTools: [String] = []
    /// Drafts of sends that went nowhere (an upload rejected, the turn refused,
    /// the user moved on mid-upload), by the conversation they were written in.
    /// The composer takes one back when its conversation is open, so a draft
    /// never lands in another conversation's composer; deleting the
    /// conversation drops it.
    public private(set) var unsentDrafts: [String: UnsentDraft] = [:]

    /// The in-flight list as of the latest event; `inFlight` trails it by at
    /// most one publish interval.
    @ObservationIgnored private var liveInFlight: [UiMessage] = []
    @ObservationIgnored private var publishPending = false
    @ObservationIgnored private var streamTask: Task<Error?, Never>?
    /// Identity of the turn whose events may touch state. Guards against a late
    /// event from an abandoned turn landing in the conversation opened since,
    /// and tells a turn's own cleanup whether it is still the current one.
    @ObservationIgnored private var turnId: Int?
    @ObservationIgnored private var turnSeq = 0
    @ObservationIgnored private var booted = false
    /// Bumped on every switch of conversation, so a slow load that finishes
    /// after the user has already picked another one is dropped.
    @ObservationIgnored private var switchSeq = 0

    public init(client: HatClient, prefs: PrefsStore = UserDefaultsPrefs()) {
        self.client = client
        self.prefs = prefs
    }

    // MARK: Derived

    /// Everything the visible branch has cost, including the turn in flight.
    public var sessionUsage: Usage {
        sumUsage(messages.map(\.usage) + inFlight.map(\.usage))
    }

    public var selectedModel: ModelInfo? {
        models.first { $0.id == model }
    }

    /// How full the selected model's context window is, by the latest model call.
    public var contextUsage: (tokens: Int, fraction: Double, window: Int)? {
        guard let window = selectedModel?.contextWindow else { return nil }
        guard let fill = contextFill(messages + inFlight, contextWindow: window) else { return nil }
        return (fill.tokens, fill.fraction, window)
    }

    /// The conversation ends on a reply cut off at the output limit, and nothing runs.
    public var canContinue: Bool {
        !busy && inFlight.isEmpty && endsTruncated(messages)
    }

    /// The first tool call in the turn that is waiting for approval. After
    /// reattaching mid-turn it is on a stored message rather than in flight.
    public var pendingApproval: UiTool? {
        (messages + inFlight).lazy.flatMap(\.tools).first { $0.running && $0.approval == .requested }
    }

    /// An `ask_user` question blocking the turn, if any.
    public var pendingQuestionId: String? {
        inFlight.lazy.flatMap(\.tools).first { $0.name == "ask_user" && $0.running && !$0.answered }?.callId
    }

    public var title: String {
        sessions.first { $0.id == sessionId }?.title ?? session?.title ?? "New Chat"
    }

    // MARK: Boot

    /// Load the server's lists and restore the last conversation. Runs once.
    public func boot() async {
        guard !booted else { return }
        booted = true
        defer { ready = true }

        async let modelList = try? client.models()
        async let runnerList = try? client.runners()
        let (loadedModels, loadedRunners) = await (modelList ?? [], runnerList ?? [])
        let list = (try? await client.sessions()) ?? []
        models = loadedModels
        runners = loadedRunners
        sessions = list

        // Restore the last conversation, so a relaunch mid-thread lands back in
        // it. One that has since been deleted falls back to the most recent.
        let stored = prefs.string(forKey: "session") ?? ""
        let target = list.first { $0.id == stored }?.id ?? list.max { $0.updatedAt < $1.updatedAt }?.id
        var restored = false
        if let target, let payload = try? await client.session(id: target) {
            show(payload)
            restored = true
            // A turn started before the app was closed may still be running; on
            // iOS that is the common case, since the system suspends apps freely.
            Task { await followActiveTurn(payload.session.id) }
        }

        // The last-used model and effort are what a new chat starts with. A
        // restored conversation keeps its own: applied over it, they would
        // switch its model on the next send.
        guard !restored else { return }
        let storedModel = prefs.string(forKey: "model") ?? ""
        if models.contains(where: { $0.id == storedModel }) {
            model = storedModel
        } else if !models.contains(where: { $0.id == model }), let first = models.first {
            model = first.id
        }
        if let effort = prefs.string(forKey: "effort").flatMap(ReasoningEffort.init(rawValue:)) {
            reasoningEffort = effort
        }
    }

    /// Reattach when the app comes back to the foreground. A socket suspended
    /// mid-stream is not a reliable stream, but the turn kept running.
    public func didBecomeActive() {
        // Only when not already following: restarting would drop deltas.
        guard let id = sessionId, turnId == nil else { return }
        Task { await followActiveTurn(id) }
    }

    // MARK: Internals

    private func applySession(_ next: SessionRecord) {
        session = next
        model = next.model
        policyMode = next.approvalMode
        allowedTools = next.allowedTools
        reasoningEffort = next.reasoningEffort
    }

    private func show(_ payload: SessionPayload) {
        sessionId = payload.session.id
        messages = buildMessages(payload.path)
        applySession(payload.session)
        prefs.set(payload.session.id, forKey: "session")
    }

    private func refresh(_ id: String) async throws {
        let payload = try await client.session(id: id)
        // The user may have moved on while this was loading.
        guard sessionId == id else { return }
        messages = buildMessages(payload.path)
        applySession(payload.session)
    }

    public func refreshSessions() async throws {
        sessions = try await client.sessions()
    }

    private func setInFlight(_ list: [UiMessage]) {
        liveInFlight = list
        inFlight = list
    }

    private func updateInFlight(_ update: ([UiMessage]) -> [UiMessage]) {
        liveInFlight = update(liveInFlight)
        guard !publishPending else { return }
        publishPending = true
        Task {
            try? await Task.sleep(for: ChatStore.publishInterval)
            publishPending = false
            inFlight = liveInFlight
        }
    }

    private func handle(_ event: KernelEvent, turn: Int) {
        guard turnId == turn else { return }
        let effect = readEvent(event)
        switch effect {
        case .resetUsage, .none:
            // Nothing to reset: usage lives on the in-flight messages.
            break
        case let .finishMessage(messageId, _):
            // Durable on the server now. The finish reason lets a truncated
            // reply offer Continue even if the post-turn refresh fails.
            updateInFlight { list in
                applyEffect(list, effect).map { message in
                    var message = message
                    if message.id == messageId { message.streaming = false }
                    return message
                }
            }
        case let .error(message):
            error = message
        case let .warning(message):
            warnings.append(message)
        case let .sessionTitle(sessionId, title):
            // Patched in place so the header updates while the turn runs.
            if let index = sessions.firstIndex(where: { $0.id == sessionId }) {
                sessions[index].title = title
            }
        case .toolApproval, .toolResult:
            applyToolEffect(effect)
        default:
            updateInFlight { applyEffect($0, effect) }
        }
    }

    /// Apply a tool approval or result to the card it concerns: in flight, or,
    /// after reattaching mid-turn, on the stored message that made the call.
    /// Stored cards are only touched when the call is not in flight, so a call
    /// id a provider reuses cannot restamp an old card.
    private func applyToolEffect(_ effect: ChatEffect) {
        updateInFlight { applyEffect($0, effect) }
        let callId: String
        switch effect {
        case let .toolApproval(id, _), let .toolResult(id, _, _, _, _): callId = id
        default: return
        }
        guard !liveInFlight.contains(where: { $0.tools.contains { $0.callId == callId } }) else { return }
        messages = applyStoredEffect(messages, effect)
    }

    /// Settle the view once a turn ends, however it ended: promote what
    /// streamed, then reconcile with the server.
    private func finishTurn(_ id: String) async {
        let streamed = liveInFlight.map { message -> UiMessage in
            var message = message
            message.streaming = false
            return message
        }
        if !streamed.isEmpty { messages += streamed }
        setInFlight([])
        try? await refresh(id)
        try? await refreshSessions()
        busy = false
    }

    private typealias Run = (_ onEvent: @escaping @Sendable (KernelEvent) async -> Void) async throws -> Void

    /// Run one stream to its end as the current turn. Returns what it failed
    /// with, if anything: an `HttpError` means the server refused the turn
    /// before it started.
    @discardableResult
    private func runStream(_ id: String, _ run: @escaping Run) async -> Error? {
        turnSeq += 1
        let turn = turnSeq
        turnId = turn
        busy = true
        error = nil
        warnings = []
        setInFlight([])

        // The store lives as long as the app, so holding it for a turn is fine.
        let task = Task { @MainActor () -> Error? in
            do {
                try await run { event in await self.handle(event, turn: turn) }
                return nil
            } catch {
                // A turn the user stopped or left is not a failure.
                if !isCancellation(error), turnId == turn { self.error = describe(error) }
                return error
            }
        }
        streamTask = task
        let failure = await task.value

        // Skipped once the turn has been abandoned: its cleanup would otherwise
        // overwrite the conversation the user moved to.
        guard turnId == turn else { return failure }
        streamTask = nil
        turnId = nil
        if sessionId == id {
            // Publish the last deltas before they are promoted.
            inFlight = liveInFlight
            await finishTurn(id)
        } else {
            busy = false
        }
        return failure
    }

    /// Close the socket but leave the turn running server-side.
    private func detachStream() {
        streamTask?.cancel()
        streamTask = nil
    }

    /// Leave the turn because the user is going elsewhere. Deliberately does
    /// not cancel it: coming back reattaches.
    private func abandonTurn() {
        turnId = nil
        detachStream()
        busy = false
    }

    /// Start switching conversations. The old one is cleared at once rather
    /// than when the new one has loaded, so a reattach scheduled for it (at
    /// boot, or on returning to the foreground) finds it gone and stands down
    /// instead of marking the store busy under the conversation being opened.
    private func leaveConversation() {
        switchSeq += 1
        abandonTurn()
        sessionId = nil
        session = nil
        messages = []
        error = nil
        warnings = []
        setInFlight([])
    }

    /// Reattach to a turn already running for `id`; returns at once when idle.
    public func followActiveTurn(_ id: String) async {
        guard sessionId == id else { return }
        await runStream(id) { [client] onEvent in
            try await client.followTurn(sessionId: id, onEvent: onEvent)
        }
    }

    private func ensureSession() async throws -> String {
        if let sessionId { return sessionId }
        let seq = switchSeq
        let (mode, tools, effort) = (policyMode, allowedTools, reasoningEffort)
        let payload = try await client.createSession(model: model)
        // Opened another conversation meanwhile: this one is no longer where
        // the user is, so it must not take over.
        guard seq == switchSeq else { throw CancellationError() }
        // Not `show`: a new session's path is empty, and replacing the
        // transcript with it would drop the message being sent.
        sessionId = payload.session.id
        applySession(payload.session)
        prefs.set(payload.session.id, forKey: "session")
        try? await refreshSessions()
        // What the composer showed is this chat's settings. Always sent: a new
        // session gets the server's defaults (auto approval), which need not
        // match, and skipping "ask" left a chat set to ask running tools
        // without asking.
        let updated = try await client.updateSession(
            id: payload.session.id,
            SessionPatch(approvalMode: mode, allowedTools: tools, reasoningEffort: effort)
        )
        if sessionId == payload.session.id { applySession(updated) }
        return payload.session.id
    }

    // MARK: Actions

    public func clearError() {
        error = nil
    }

    /// Raise a client-side problem: a rejected file, a failed request.
    public func report(_ message: String) {
        error = message
    }

    /// The draft a send gave back to the conversation `id`, if any, taken so
    /// it is given back once. The composer calls this when `id` is open.
    public func takeUnsentDraft(for id: String) -> UnsentDraft? {
        unsentDrafts.removeValue(forKey: id)
    }

    /// Send a message. Returns false when nothing went out: an upload was
    /// rejected, the server refused the turn (another reply still running, too
    /// many turns), or the user opened another conversation before it could
    /// go. The draft is then kept in `unsentDrafts` for the conversation it
    /// was written in.
    @discardableResult
    public func send(_ text: String, attachments: [PendingAttachment]) async -> Bool {
        guard !busy else { return false }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty || !attachments.isEmpty else { return false }
        error = nil

        let origin = sessionId
        let seq = switchSeq
        func giveBack(to id: String?) {
            guard let id else { return }
            unsentDrafts[id] = UnsentDraft(text: body, attachments: attachments)
        }

        // Upload first, so a rejected file fails before anything is persisted.
        var ids: [String] = []
        var names: [String: String] = [:]
        do {
            for attachment in attachments {
                let record = try await client.upload(UploadFile(data: attachment.data, name: attachment.name, mime: attachment.mime))
                ids.append(record.id)
                // Stored content is keyed by hash, so the name travels with the turn.
                if record.kind == "document" { names[record.id] = attachment.name }
            }
        } catch {
            if seq == switchSeq { self.error = describe(error) }
            giveBack(to: origin)
            return false
        }
        // The user opened another conversation while the files went up: the
        // message belongs to the one it was written in, so it waits there.
        guard seq == switchSeq else {
            giveBack(to: origin)
            return false
        }

        // Show the message now; the post-turn refresh swaps in the stored one.
        let stamp = Int(Date().timeIntervalSince1970 * 1000)
        let localId = "\(localPrefix)\(stamp)"
        messages.append(UiMessage(
            id: localId,
            role: .user,
            text: body,
            images: attachments.filter { $0.kind == .image }.map {
                UiImage(src: "data:\($0.mime);base64,\($0.data.base64EncodedString())")
            },
            // `local-` ids mark these as not stored yet, so the card does not
            // offer a download until the refresh swaps in the real ones.
            files: attachments.filter { $0.kind == .document }.map {
                UiFile(id: "\(localPrefix)\($0.id)", name: $0.name, mime: $0.mime, size: $0.data.count)
            }
        ))

        let id: String
        do {
            id = try await ensureSession()
        } catch {
            // No conversation to send to, so nothing went out.
            if seq == switchSeq {
                messages.removeAll { $0.id == localId }
                if !isCancellation(error) { self.error = describe(error) }
            }
            giveBack(to: seq == switchSeq ? sessionId ?? origin : origin)
            return false
        }
        // Created for this message, but the user has moved on since.
        guard seq == switchSeq else {
            giveBack(to: id)
            return false
        }
        let model = self.model
        let failure = await runStream(id) { [client] onEvent in
            try await client.sendTurn(
                sessionId: id, text: body, model: model, attachmentIds: ids,
                attachmentNames: names, onEvent: onEvent
            )
        }
        // An HTTP error comes only from the stream's start: the server said no
        // before a turn began (the post-turn refresh has already dropped the
        // optimistic message). The reason is on `error`.
        guard failure is HttpError else { return true }
        giveBack(to: id)
        return false
    }

    /// The Stop button: ask the server to cancel, then drop the socket.
    public func stop() {
        if let id = sessionId {
            Task { [client] in try? await client.cancelTurn(sessionId: id) }
        }
        detachStream()
    }

    public func newChat() async throws {
        leaveConversation()
        let seq = switchSeq
        let payload = try await client.createSession(model: model)
        guard seq == switchSeq else { return }
        sessionId = payload.session.id
        applySession(payload.session)
        prefs.set(payload.session.id, forKey: "session")
        try? await refreshSessions()
    }

    public func openSession(_ id: String) async throws {
        leaveConversation()
        let seq = switchSeq
        let payload = try await client.session(id: id)
        // Tapping A then B quickly: A's answer arriving last must not win.
        guard seq == switchSeq else { return }
        show(payload)
        // This conversation may have a turn of its own in flight — started on
        // another device, or before the app was suspended.
        Task { await followActiveTurn(payload.session.id) }
    }

    public func renameSession(_ id: String, title: String) async throws {
        _ = try await client.updateSession(id: id, SessionPatch(title: title))
        try await refreshSessions()
    }

    public func deleteSession(_ id: String) async throws {
        try await client.deleteSession(id: id)
        unsentDrafts.removeValue(forKey: id)
        if id == sessionId {
            abandonTurn()
            sessionId = nil
            session = nil
            messages = []
            setInFlight([])
            prefs.set("", forKey: "session")
        }
        try await refreshSessions()
    }

    public func regenerate(_ messageId: String) async {
        guard let id = sessionId, !busy else { return }
        await runStream(id) { [client] onEvent in
            try await client.regenerate(sessionId: id, messageId: messageId, onEvent: onEvent)
        }
    }

    /// Stream the rest of a reply that was cut off at the output limit.
    public func continueReply() async {
        guard let id = sessionId, !busy else { return }
        await runStream(id) { [client] onEvent in
            try await client.continueTurn(sessionId: id, onEvent: onEvent)
        }
    }

    /// Start a new conversation from the path up to `messageId` and switch to it.
    public func fork(at messageId: String) async throws {
        guard let id = sessionId, !busy else { return }
        let payload = try await client.forkSession(id: id, messageId: messageId)
        // A fork is idle by construction, so there is no turn to follow.
        leaveConversation()
        show(payload)
        try? await refreshSessions()
    }

    /// Open a conversation on the branch that holds `messageId` (a search hit).
    public func openMessage(sessionId: String, messageId: String) async throws {
        _ = try await client.selectBranch(sessionId: sessionId, messageId: messageId)
        try await openSession(sessionId)
    }

    public func updateConversation(_ settings: ConversationSettings) async throws {
        // A new chat has no server session until its first message.
        let id = try await ensureSession()
        applySession(try await client.updateSession(id: id, SessionPatch(
            instructions: settings.instructions,
            temperature: .some(settings.temperature),
            maxTokens: .some(settings.maxTokens)
        )))
    }

    public func editMessage(_ messageId: String, text: String) async {
        guard let id = sessionId, !busy, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        await runStream(id) { [client] onEvent in
            try await client.editMessage(sessionId: id, messageId: messageId, text: text, onEvent: onEvent)
        }
    }

    public func switchBranch(to messageId: String) async {
        guard let id = sessionId, !busy else { return }
        do {
            let payload = try await client.selectBranch(sessionId: id, messageId: messageId)
            guard sessionId == id else { return }
            messages = buildMessages(payload.path)
        } catch {
            self.error = describe(error)
        }
    }

    public func decide(_ callId: String, _ decision: ApprovalDecision) async {
        // Recorded at once: a button that sits there looking live through the
        // round trip makes the tool look hung. The card is in flight, or stored
        // if the app reattached to the turn.
        func mark(_ status: ApprovalStatus) {
            let effect = ChatEffect.toolApproval(callId: callId, status: status)
            setInFlight(applyEffect(liveInFlight, effect))
            if !liveInFlight.contains(where: { $0.tools.contains { $0.callId == callId } }) {
                messages = applyStoredEffect(messages, effect)
            }
        }
        mark(approvalForDecision(decision))
        guard let id = sessionId else { return }
        let seq = switchSeq
        do {
            try await client.resolveApproval(callId: callId, decision: decision, sessionId: id)
        } catch {
            guard seq == switchSeq else { return }
            // Bring the buttons back: the approval is still pending.
            mark(.requested)
            self.error = describe(error)
        }
    }

    /// Answer a pending `ask_user` question.
    public func answer(_ callId: String, _ text: String) async {
        guard let id = sessionId, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        // Marked in both lists: after a reload the pending question lives in
        // the stored messages. The `tool.result` that follows fills in the rest.
        func mark(_ answered: Bool) {
            let update: ([UiMessage]) -> [UiMessage] = { list in
                list.map { message in
                    var message = message
                    for i in message.tools.indices where message.tools[i].callId == callId {
                        message.tools[i].answered = answered
                    }
                    return message
                }
            }
            setInFlight(update(liveInFlight))
            messages = update(messages)
        }
        mark(true)
        do {
            try await client.answerQuestion(callId: callId, answer: text, sessionId: id)
        } catch {
            // A 404 means it is no longer pending; anything else can be retried.
            if (error as? HttpError)?.status != 404 { mark(false) }
            self.error = describe(error)
        }
    }

    // MARK: Conversation settings

    private func persist(_ patch: SessionPatch) {
        guard let id = sessionId else { return }
        Task {
            do {
                _ = try await client.updateSession(id: id, patch)
            } catch {
                self.error = describe(error)
                // Pull the truth back so the control cannot silently drift.
                try? await refresh(id)
            }
        }
    }

    public func setModel(_ next: String) {
        model = next
        prefs.set(next, forKey: "model")
        // Must land at once: the next turn is not guaranteed.
        persist(SessionPatch(model: next))
    }

    public func setEffort(_ next: ReasoningEffort) {
        reasoningEffort = next
        prefs.set(next.rawValue, forKey: "effort")
        persist(SessionPatch(reasoningEffort: next))
    }

    public func setPolicyMode(_ next: ApprovalMode) {
        policyMode = next
        persist(SessionPatch(approvalMode: next))
    }

    public func setAllowedTools(_ next: [String]) {
        allowedTools = next
        persist(SessionPatch(allowedTools: next))
    }
}

/// True for the errors a cancelled request surfaces as.
public func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError { return true }
    if let error = error as? URLError, error.code == .cancelled { return true }
    return false
}

/// Turn anything thrown into something worth showing a user.
public func describe(_ error: Error) -> String {
    if let error = error as? LocalizedError, let description = error.errorDescription { return description }
    return error.localizedDescription
}
