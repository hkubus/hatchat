import Foundation
import XCTest
@testable import HatKit

/// The same cases as `packages/core/src/chat-view.test.ts`.
final class ChatViewTests: XCTestCase {
    private var seq = 0

    private func node(_ role: String, _ parts: [Part], meta: MessageMeta? = nil) -> PathNode {
        seq += 1
        return PathNode(message: ChatMessage(id: "m\(seq)", role: role, parts: parts, createdAt: Double(seq), meta: meta))
    }

    private func apply(_ events: [KernelEvent], to list: [UiMessage] = []) -> [UiMessage] {
        events.reduce(list) { applyEffect($0, readEvent($1)) }
    }

    // MARK: buildMessages

    func testFlattensThePathIntoRows() {
        let out = buildMessages([node("user", [.text("hello")]), node("assistant", [.text("hi")])])
        XCTAssertEqual(out.map(\.role), [.user, .assistant])
        XCTAssertEqual(out.map(\.text), ["hello", "hi"])
    }

    func testFoldsAToolResultIntoItsCallersCard() {
        let out = buildMessages([
            node("user", [.text("run it")]),
            node("assistant", [.toolCall(id: "call_1", name: "shell_exec", args: ["command": "ls"])]),
            node("tool", [.toolResult(id: "call_1", name: "shell_exec", content: [.text("a.txt")], isError: false)]),
        ])
        XCTAssertEqual(out.count, 2, "the tool message itself is not a row")
        let tool = out[1].tools[0]
        XCTAssertEqual(tool.callId, "call_1")
        XCTAssertEqual(tool.result, "a.txt")
        XCTAssertFalse(tool.running)
    }

    func testKeepsAStillRunningCallRunning() {
        let out = buildMessages([node("assistant", [.toolCall(id: "call_1", name: "shell_exec", args: [:])])])
        XCTAssertTrue(out[0].tools[0].running)
        XCTAssertNil(out[0].tools[0].result)
    }

    func testCarriesBranchesAndUsage() {
        var first = node("user", [.text("q")])
        first.siblingIndex = 1
        first.siblingCount = 3
        first.siblingIds = ["a", "b", "c"]
        let out = buildMessages([first, node("assistant", [.text("a")], meta: MessageMeta(usage: Usage(inputTokens: 5, outputTokens: 7)))])
        XCTAssertEqual(out[0].branch, UiBranch(index: 1, count: 3, ids: ["a", "b", "c"]))
        XCTAssertEqual(out[1].usage, Usage(inputTokens: 5, outputTokens: 7))
    }

    func testResolvesEachImageSourceKind() {
        let out = buildMessages([node("user", [
            .image(.attachment("att_1", mime: "image/png")),
            .image(.url("https://x/y.png", mime: "image/png")),
            .image(.data("AAA", mime: "image/jpeg")),
        ])])
        XCTAssertEqual(out[0].images, [
            UiImage(src: "", attachmentId: "att_1"),
            UiImage(src: "https://x/y.png"),
            UiImage(src: "data:image/jpeg;base64,AAA"),
        ])
    }

    func testTextAndReasoning() {
        XCTAssertEqual(buildMessages([node("assistant", [.text("a"), .text("b"), .text("c")])])[0].text, "abc")
        let out = buildMessages([node("assistant", [.reasoning("think "), .text("answer"), .reasoning("more")])])
        XCTAssertEqual(out[0].text, "answer")
        XCTAssertEqual(out[0].reasoning, "think more")
    }

    func testShowsDocumentsAndHidesTheContinueNudge() {
        let out = buildMessages([
            node("user", [.text("see attached"), .file(id: "att_9", name: "notes.txt", mime: "text/plain", size: 12)]),
            node("assistant", [.text("partial")], meta: MessageMeta(finishReason: "length")),
            node("user", [.text("Continue")], meta: MessageMeta(synthetic: "continue")),
            node("assistant", [.text(" rest")]),
        ])
        XCTAssertEqual(out.map(\.role), [.user, .assistant, .assistant])
        XCTAssertEqual(out[0].files, [UiFile(id: "att_9", name: "notes.txt", mime: "text/plain", size: 12)])
        XCTAssertEqual(out[1].finishReason, "length")
    }

    // MARK: readEvent / applyEffect

    func testReadEventMapsEachEvent() {
        XCTAssertEqual(readEvent(.turnStart(turnId: "t")), .resetUsage)
        XCTAssertEqual(readEvent(.messageStart(messageId: "m1")), .startMessage(id: "m1"))
        XCTAssertEqual(readEvent(.textDelta(messageId: "m1", text: "hi")), .appendText(messageId: "m1", text: "hi"))
        XCTAssertEqual(
            readEvent(.toolResult(callId: "c1", name: "shell_exec", parts: [.text("done")], isError: false)),
            .toolResult(callId: "c1", result: "done", images: [], files: [], isError: false)
        )
        XCTAssertEqual(readEvent(.error(NormalizedError(code: "boom", message: "it broke"))), .error("it broke"))
        XCTAssertEqual(readEvent(.sessionTitle(sessionId: "s", title: "Fix")), .sessionTitle(sessionId: "s", title: "Fix"))
        XCTAssertEqual(readEvent(.turnDone(turnId: "t")), ChatEffect.none)
    }

    func testMessageDoneStampsOnlyItsOwnMessage() {
        var list = [UiMessage.emptyAssistant("m1"), .emptyAssistant("m2")]
        list = applyEffect(list, readEvent(.messageDone(messageId: "m1", finishReason: "length")))
        XCTAssertEqual(list[0].finishReason, "length")
        XCTAssertNil(list[1].finishReason)
        XCTAssertEqual(applyEffect(list, readEvent(.messageDone(messageId: "zz", finishReason: "stop"))), list)
    }

    func testUsageAccumulatesOnTheNewestMessage() {
        let list = apply([.usage(Usage(inputTokens: 10, outputTokens: 2)), .usage(Usage(outputTokens: 3))], to: [.emptyAssistant("m1")])
        XCTAssertEqual(list[0].usage?.inputTokens, 10)
        XCTAssertEqual(list[0].usage?.outputTokens, 5)
        XCTAssertNil(list[0].usage?.cachedTokens, "no cache statistics reported")
    }

    func testContextFillReadsTheLatestCall() {
        let rows = [
            UiMessage(id: "a", role: .assistant, usage: Usage(inputTokens: 100, outputTokens: 10)),
            UiMessage(id: "b", role: .user),
            UiMessage(id: "c", role: .assistant, usage: Usage(inputTokens: 700, outputTokens: 100)),
            UiMessage(id: "d", role: .user),
        ]
        let fill = contextFill(rows, contextWindow: 1000)
        XCTAssertEqual(fill?.tokens, 800)
        XCTAssertEqual(fill?.fraction, 0.8)
        XCTAssertNil(contextFill(rows, contextWindow: nil))
        XCTAssertNil(contextFill([UiMessage(id: "u", role: .user)], contextWindow: 1000))
    }

    func testEndsTruncated() {
        XCTAssertTrue(endsTruncated([UiMessage(id: "a", role: .assistant, finishReason: "length")]))
        XCTAssertFalse(endsTruncated([UiMessage(id: "a", role: .assistant, finishReason: "stop")]))
        XCTAssertFalse(endsTruncated([UiMessage(id: "a", role: .assistant, finishReason: "length"), UiMessage(id: "u", role: .user)]))
        XCTAssertFalse(endsTruncated([]))
    }

    func testAFullTurnFoldsIntoOneMessage() {
        let list = apply([
            .messageStart(messageId: "m1"),
            .textDelta(messageId: "m1", text: "Hello"),
            .textDelta(messageId: "m1", text: " world"),
            .toolCall(messageId: "m1", callId: "c1", name: "shell_exec", args: ["command": "ls"]),
            .toolApproval(callId: "c1", status: .requested),
            .toolResult(callId: "c1", name: "shell_exec", parts: [.text("a.txt")], isError: false),
            .messageDone(messageId: "m1", finishReason: "tool_calls"),
        ])
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list[0].text, "Hello world")
        XCTAssertEqual(list[0].tools, [UiTool(
            callId: "c1", name: "shell_exec", args: ["command": "ls"], approval: .requested,
            result: "a.txt", isError: false, running: false
        )])
    }

    func testEveryIterationOfAToolTurnStaysOnScreen() {
        let list = apply([
            .messageStart(messageId: "m1"),
            .toolCall(messageId: "m1", callId: "c1", name: "shell_exec", args: [:]),
            .toolResult(callId: "c1", name: "shell_exec", parts: [.text("a")], isError: false),
            .messageDone(messageId: "m1", finishReason: "tool_calls"),
            .messageStart(messageId: "m2"),
            .textDelta(messageId: "m2", text: "found a"),
            .messageDone(messageId: "m2", finishReason: "stop"),
        ])
        XCTAssertEqual(list.map(\.id), ["m1", "m2"])
        XCTAssertEqual(list[0].tools[0].result, "a")
        XCTAssertEqual(list[1].text, "found a")
        XCTAssertEqual(list[1].tools, [])
    }

    func testToolEventsFindTheirCallerByCallId() {
        var list = apply([
            .messageStart(messageId: "m1"),
            .toolCall(messageId: "m1", callId: "c1", name: "shell_exec", args: [:]),
            .messageStart(messageId: "m2"),
            .toolCall(messageId: "m2", callId: "c2", name: "shell_exec", args: [:]),
        ])
        list = applyEffect(list, readEvent(.toolResult(callId: "c1", name: "shell_exec", parts: [.text("only c1")], isError: false)))
        XCTAssertEqual(list[0].tools[0].result, "only c1")
        XCTAssertFalse(list[0].tools[0].running)
        XCTAssertNil(list[1].tools[0].result)
        XCTAssertTrue(list[1].tools[0].running)
    }

    func testUnknownIdsAndEarlyEventsAreHarmless() {
        XCTAssertEqual(applyEffect([.emptyAssistant("m1")], .appendText(messageId: "m_unknown", text: "tail"))[0].text, "tail")
        XCTAssertEqual(applyEffect([], .appendText(messageId: "m1", text: "x")), [])
        XCTAssertEqual(applyEffect([], .toolCall(messageId: "m1", callId: "c", name: "n", args: [:])), [])
        let list = apply([.messageStart(messageId: "m1"), .toolCall(messageId: "m1", callId: "c1", name: "n", args: [:])])
        XCTAssertNil(applyEffect(list, .toolApproval(callId: "other", status: .approved))[0].tools[0].approval)
        XCTAssertEqual(applyEffect(list, readEvent(.toolResult(callId: "nope", name: "t", parts: [], isError: false))), list)
    }

    func testResultArtifactsFromStoredAndLiveResults() {
        let file = Part.file(id: "att_1", name: "a.txt", mime: "text/plain", size: 3)
        let stored = buildMessages([
            node("assistant", [.toolCall(id: "c1", name: "create_artifact", args: ["name": "a.txt"])]),
            node("tool", [.toolResult(id: "c1", name: "create_artifact", content: [.text("ok"), file], isError: false)]),
        ])
        XCTAssertEqual(stored[0].tools[0].files.first?.id, "att_1")

        var live = applyEffect([.emptyAssistant("m")], .toolCall(messageId: "m", callId: "c1", name: "python", args: [:]))
        live = applyEffect(live, readEvent(.toolResult(callId: "c1", name: "t", parts: [file], isError: false)))
        XCTAssertEqual(live[0].tools[0].files.first?.name, "a.txt")
        XCTAssertFalse(live[0].tools[0].running)

        let split = toolResultOf([.text("saved"), .image(.data("AAA", mime: "image/png")), .file(id: "att_9", name: "report.csv", mime: "text/csv", size: 2048)])
        XCTAssertEqual(split.result, "saved")
        XCTAssertEqual(split.images, [UiImage(src: "data:image/png;base64,AAA")])
        XCTAssertEqual(split.files, [UiFile(id: "att_9", name: "report.csv", mime: "text/csv", size: 2048)])
    }

    // MARK: Tool cards

    func testToolSummary() {
        func summary(_ name: String, _ args: JSONValue) -> String {
            toolSummary(UiTool(callId: "c", name: name, args: args, running: false))
        }
        XCTAssertEqual(summary("shell_exec", ["command": "ls -la"]), "ls -la")
        XCTAssertEqual(summary("shell_exec", ["cmd": "pwd"]), "pwd")
        XCTAssertEqual(summary("read", ["path": "/tmp/x"]), "path: \"/tmp/x\"")
        XCTAssertEqual(summary("n", "raw string"), "raw string")
        XCTAssertEqual(summary("n", [:]), "")
        XCTAssertEqual(summary("n", nil), "")
        XCTAssertEqual(summary("read_file", ["path": "a.ts", "limit": 5]), "a.ts")
        XCTAssertEqual(summary("web_fetch", ["url": "https://x.y"]), "https://x.y")
        XCTAssertEqual(summary("python", ["code": "\nimport os\nprint(1)"]), "import os")
        XCTAssertEqual(summary("ask_user", ["question": "Why?"]), "Why?")
        XCTAssertEqual(summary("spawn_subagent", ["task": "Do A\nthen B"]), "Do A")
        XCTAssertEqual(summary("schedule_create", ["title": "Daily"]), "Daily")
        XCTAssertEqual(summary("todo_write", ["todos": []]), "")
        XCTAssertEqual(summary("n", ["count": 3]), "count: 3")
    }

    func testTodosOf() {
        XCTAssertEqual(todosOf(["todos": [
            ["content": "a", "status": "completed"],
            ["content": "b", "status": "in_progress"],
            ["content": "c", "status": "weird"],
            ["status": "pending"],
        ]]), [
            UiTodo(content: "a", status: .completed),
            UiTodo(content: "b", status: .inProgress),
            UiTodo(content: "c", status: .pending),
        ])
        XCTAssertEqual(todosOf(nil), [])
        XCTAssertEqual(todosOf(["todos": "x"]), [])
    }

    func testQuestionOfAndJoinAnswer() {
        XCTAssertEqual(
            questionOf(["question": "Pick", "options": ["a", 1, "b"], "multi_select": true]),
            UiQuestion(question: "Pick", options: ["a", "b"], multiSelect: true)
        )
        XCTAssertEqual(questionOf(["question": "Why?"]), UiQuestion(question: "Why?", options: [], multiSelect: false))
        XCTAssertNil(questionOf([:]))
        XCTAssertEqual(joinAnswer(["a", "b"], "  c "), "a, b, c")
        XCTAssertEqual(joinAnswer([], "  "), "")
    }
}
