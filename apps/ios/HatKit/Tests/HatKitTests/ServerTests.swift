import Foundation
import XCTest
@testable import HatKit

/// End to end against a real hat server running the fake provider: the
/// client, the stream bridge and the chat state machine together, the way the
/// app drives them. Skipped unless `HAT_TEST_SERVER` points at a server (with
/// a runner connected, for the tool cases); `HAT_TEST_TOKEN` is its
/// `HAT_AUTH_TOKEN`, if it has one. See `apps/ios/README.md`.
@MainActor
final class ServerTests: XCTestCase {
    private var config: HatConfig!

    override func setUp() async throws {
        guard let server = ProcessInfo.processInfo.environment["HAT_TEST_SERVER"], !server.isEmpty else {
            throw XCTSkip("HAT_TEST_SERVER is not set")
        }
        config = HatConfig(serverUrl: server, token: ProcessInfo.processInfo.environment["HAT_TEST_TOKEN"] ?? "")
    }

    private final class MemoryPrefs: PrefsStore {
        var values: [String: String] = [:]
        func string(forKey key: String) -> String? { values[key] }
        func set(_ value: String, forKey key: String) { values[key] = value }
    }

    private func bootedStore(prefs: MemoryPrefs = MemoryPrefs(), newChat: Bool = true) async throws -> ChatStore {
        let store = ChatStore(client: HatClient(config: config), prefs: prefs)
        await store.boot()
        XCTAssertTrue(store.ready)
        XCTAssertTrue(store.models.contains { $0.id == "fake/fake-agent" }, "the fake provider is registered")
        guard newChat else { return store }
        store.setModel("fake/fake-agent")
        try await store.newChat()
        return store
    }

    /// A store whose turn in its own conversation is paused on an approval.
    private func storePausedOnApproval(_ command: String) async throws -> (ChatStore, Task<Bool, Never>) {
        let store = try await bootedStore()
        _ = try await store.client.updateSession(id: store.sessionId!, SessionPatch(approvalMode: .ask))
        let turn = Task { await store.send("run: \(command)", attachments: []) }
        try await waitUntil("the approval request") { store.pendingApproval != nil }
        return (store, turn)
    }

    /// Poll the main actor until `condition` holds, or fail after `timeout`.
    private func waitUntil(_ what: String, timeout: TimeInterval = 20, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("timed out waiting for \(what)")
                return
            }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    func testProbeAndUnauthorized() async throws {
        try await HatClient.probe(config)
        guard !config.token.isEmpty else { return }

        let bad = HatConfig(serverUrl: config.serverUrl, token: "not-the-token")
        do {
            try await HatClient.probe(bad)
            XCTFail("a wrong token must be rejected")
        } catch {
            XCTAssertEqual(describe(error), "That server wants a different token.")
        }

        let fired = expectation(description: "onUnauthorized")
        let client = HatClient(config: bad, onUnauthorized: { fired.fulfill() })
        _ = try? await client.sessions()
        await fulfillment(of: [fired], timeout: 5)
    }

    func testSendStreamsAndSettlesOnTheStoredTranscript() async throws {
        let store = try await bootedStore()
        await store.send("hello from swift", attachments: [])

        XCTAssertNil(store.error)
        XCTAssertFalse(store.busy)
        XCTAssertEqual(store.inFlight, [], "streamed messages are promoted at the end of the turn")
        XCTAssertEqual(store.messages.map(\.role), [.user, .assistant])
        XCTAssertFalse(store.messages[0].id.hasPrefix(localPrefix), "the refresh swapped in the stored message")
        XCTAssertTrue(store.messages[1].text.contains("You said: \"hello from swift\""), store.messages[1].text)
        XCTAssertTrue(store.sessions.contains { $0.id == store.sessionId })

        // Idle now, so there is nothing to follow.
        let following = try await store.client.followTurn(sessionId: store.sessionId!) { _ in }
        XCTAssertFalse(following)

        // A second version of the reply.
        let reply = store.messages[1].id
        await store.regenerate(reply)
        XCTAssertEqual(store.messages.last?.branch?.count, 2)
        await store.switchBranch(to: reply)
        XCTAssertEqual(store.messages.last?.id, reply)

        let markdown = try await store.client.exportMarkdown(id: store.sessionId!)
        XCTAssertTrue(markdown.contains("hello from swift"))

        // Fork from the reply: a new conversation holding the same path.
        let original = store.sessionId
        try await store.fork(at: reply)
        XCTAssertNotEqual(store.sessionId, original)
        XCTAssertEqual(store.messages.count, 2)
    }

    func testContinueFinishesATruncatedReply() async throws {
        let store = try await bootedStore()
        await store.send("long: a truncated thought", attachments: [])
        XCTAssertEqual(store.messages.last?.finishReason, "length")
        XCTAssertTrue(store.canContinue)
        XCTAssertNotNil(store.contextUsage.map(\.tokens) ?? store.sessionUsage.outputTokens)

        await store.continueReply()
        XCTAssertFalse(store.canContinue)
        XCTAssertEqual(store.messages.filter { $0.role == .user }.count, 1, "the Continue nudge is hidden")
        XCTAssertTrue(store.messages.last?.text.contains("the rest of the reply") == true)
    }

    func testToolApprovalRoundTrip() async throws {
        let store = try await bootedStore()
        store.setPolicyMode(.ask)
        // `setPolicyMode` persists in the background; let it land before the turn.
        _ = try await store.client.updateSession(id: store.sessionId!, SessionPatch(approvalMode: .ask))

        let turn = Task { await store.send("run: echo hi-from-runner", attachments: []) }
        try await waitUntil("the approval request") { store.pendingApproval != nil }
        let call = try XCTUnwrap(store.pendingApproval)
        XCTAssertEqual(call.name, "shell_exec")
        XCTAssertEqual(toolSummary(call), "echo hi-from-runner")

        await store.decide(call.callId, .approve)
        _ = await turn.value

        XCTAssertNil(store.error)
        let tool = try XCTUnwrap(store.messages.flatMap(\.tools).first { $0.callId == call.callId })
        XCTAssertFalse(tool.running)
        XCTAssertTrue(tool.result?.contains("hi-from-runner") == true, tool.result ?? "no result")
    }

    func testStopCancelsTheTurnOnTheServer() async throws {
        let store = try await bootedStore()
        _ = try await store.client.updateSession(id: store.sessionId!, SessionPatch(approvalMode: .ask))

        let turn = Task { await store.send("run: echo never", attachments: []) }
        try await waitUntil("the approval request") { store.pendingApproval != nil }
        store.stop()
        _ = await turn.value

        XCTAssertFalse(store.busy)
        XCTAssertNil(store.error, "a stopped turn is not a failure")
        // The server really cancelled it, rather than the client merely detaching.
        var status: SessionStatus?
        for _ in 0..<100 {
            status = try await store.client.sessions().first { $0.id == store.sessionId }?.status
            if status == .idle { break }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTAssertEqual(status, .idle)
    }

    func testDocumentsAndSearch() async throws {
        let store = try await bootedStore()
        let marker = "zebra\(Int.random(in: 1000...9999))"
        let document = PendingAttachment(data: Data("notes about \(marker)\n".utf8), name: "notes.txt", mime: "text/plain", kind: .document)
        await store.send("see attached", attachments: [document])

        XCTAssertNil(store.error)
        let user = try XCTUnwrap(store.messages.first { $0.role == .user })
        XCTAssertEqual(user.files.map(\.name), ["notes.txt"])
        let stored = try await store.client.attachment(id: user.files[0].id)
        XCTAssertTrue(String(decoding: stored.data, as: UTF8.self).contains(marker))

        let rejected = PendingAttachment(data: Data([0, 1, 2]), name: "photo.heic", mime: "image/heic", kind: .image)
        await store.send("with a photo", attachments: [rejected])
        XCTAssertTrue(store.error?.contains("PNG, JPEG, GIF, and WebP") == true, store.error ?? "no error")

        await store.send("remember the \(marker)", attachments: [])
        let hits = try await store.client.search(marker)
        XCTAssertTrue(hits.contains { $0.sessionId == store.sessionId }, "\(hits)")
    }

    func testConversationSettingsAndRename() async throws {
        let store = try await bootedStore()
        try await store.updateConversation(ConversationSettings(instructions: "Be brief.", temperature: 0.4, maxTokens: 256))
        XCTAssertEqual(store.session?.instructions, "Be brief.")
        XCTAssertEqual(store.session?.temperature, 0.4)
        XCTAssertEqual(store.session?.maxTokens, 256)

        try await store.updateConversation(ConversationSettings(instructions: "", temperature: nil, maxTokens: nil))
        XCTAssertNil(store.session?.temperature, "null resets to the provider default")
        XCTAssertNil(store.session?.maxTokens)

        let id = try XCTUnwrap(store.sessionId)
        try await store.renameSession(id, title: "Renamed from Swift")
        XCTAssertEqual(store.title, "Renamed from Swift")
        try await store.deleteSession(id)
        XCTAssertNil(store.sessionId)
        XCTAssertFalse(store.sessions.contains { $0.id == id })

        // With no conversation open, sending creates one and keeps the message.
        // The settings shown carry over, "ask" included: the server would
        // otherwise create it as auto.
        store.setPolicyMode(.ask)
        let turn = Task { await store.send("first words", attachments: []) }
        try await waitUntil("the new conversation") { store.sessionId != nil }
        XCTAssertEqual(store.messages.first?.text, "first words", "the optimistic message survives the create")
        _ = await turn.value
        XCTAssertEqual(store.messages.map(\.role), [.user, .assistant])
        XCTAssertEqual(store.policyMode, .ask)
        XCTAssertEqual(store.session?.approvalMode, .ask)
    }

    func testARestoredConversationKeepsItsOwnSettings() async throws {
        let first = try await bootedStore()
        let id = try XCTUnwrap(first.sessionId)
        _ = try await first.client.updateSession(id: id, SessionPatch(reasoningEffort: .high))

        // The last-used effort is "off", but that is what a new chat starts with.
        let prefs = MemoryPrefs()
        prefs.values = ["session": id, "model": "fake/fake-agent", "effort": "off"]
        let relaunched = try await bootedStore(prefs: prefs, newChat: false)
        XCTAssertEqual(relaunched.sessionId, id)
        XCTAssertEqual(relaunched.reasoningEffort, .high)
        XCTAssertEqual(relaunched.model, relaunched.session?.model)
    }

    /// Opened on another device (or after a relaunch) while a call waits for
    /// approval: the call is on a stored message, and must still be answerable.
    func testAnApprovalCanBeAnsweredAfterReattaching() async throws {
        let (first, turn) = try await storePausedOnApproval("echo answered-after-reattaching")
        let id = try XCTUnwrap(first.sessionId)
        let callId = try XCTUnwrap(first.pendingApproval?.callId)

        let second = try await bootedStore(newChat: false)
        try await second.openSession(id)
        try await waitUntil("the replayed approval request") { second.pendingApproval?.callId == callId }
        XCTAssertTrue(second.busy)
        XCTAssertTrue(second.messages.contains { $0.tools.contains { $0.callId == callId } }, "the card is the stored one")

        await second.decide(callId, .approve)
        XCTAssertNil(second.error)
        XCTAssertNil(second.pendingApproval, "the tap is recorded at once")
        _ = await turn.value
        try await waitUntil("the reattached turn to end") { !second.busy }

        XCTAssertNil(second.error)
        let tool = try XCTUnwrap(second.messages.flatMap(\.tools).first { $0.callId == callId })
        XCTAssertFalse(tool.running)
        XCTAssertTrue(tool.result?.contains("answered-after-reattaching") == true, tool.result ?? "no result")
    }

    /// A send the server refuses gives its draft back, with the server's reason.
    func testARefusedSendGivesTheDraftBack() async throws {
        let first = try await bootedStore()
        let id = try XCTUnwrap(first.sessionId)
        // Open the conversation elsewhere while it is idle, then start a turn in it.
        let second = try await bootedStore(newChat: false)
        try await second.openSession(id)
        try await waitUntil("the second store to settle") { !second.busy }
        _ = try await first.client.updateSession(id: id, SessionPatch(approvalMode: .ask))
        let turn = Task { await first.send("run: echo first", attachments: []) }
        try await waitUntil("the approval request") { first.pendingApproval != nil }

        let note = PendingAttachment(data: Data("a note\n".utf8), name: "note.txt", mime: "text/plain", kind: .document)
        let sent = await second.send("  and another thing ", attachments: [note])
        XCTAssertFalse(sent)
        XCTAssertEqual(second.error, "a reply is still running in this conversation; stop it first")
        XCTAssertFalse(second.messages.contains { $0.id.hasPrefix(localPrefix) }, "the refused message is not shown as sent")
        XCTAssertEqual(second.takeUnsentDraft(for: id), UnsentDraft(text: "and another thing", attachments: [note]))
        XCTAssertNil(second.takeUnsentDraft(for: id), "given back once")

        // A rejected upload gives the draft back too.
        let photo = PendingAttachment(data: Data([0, 1, 2]), name: "photo.heic", mime: "image/heic", kind: .image)
        let uploaded = await second.send("look", attachments: [photo])
        XCTAssertFalse(uploaded)
        XCTAssertEqual(second.unsentDrafts[id]?.attachments, [photo])

        await first.decide(first.pendingApproval!.callId, .deny)
        _ = await turn.value
        // Deleting the conversation drops what was held for it.
        try await second.deleteSession(id)
        XCTAssertNil(second.unsentDrafts[id])
    }

    func testTheLastConversationOpenedWins() async throws {
        let store = try await bootedStore()
        let first = try XCTUnwrap(store.sessionId)
        try await store.newChat()
        let second = try XCTUnwrap(store.sessionId)

        // Tap A, then B while A may still be loading: whichever answer
        // arrives last, the later tap wins.
        let a = Task { try await store.openSession(first) }
        try await waitUntil("the first open to start") { store.sessionId != second }
        try await store.openSession(second)
        try await a.value
        XCTAssertEqual(store.sessionId, second)
    }
}
