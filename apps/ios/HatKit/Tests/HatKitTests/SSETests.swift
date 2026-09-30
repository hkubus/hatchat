import Foundation
import XCTest
@testable import HatKit

/// The same cases as `packages/core/src/sse.test.ts`: every client has to
/// decode the stream identically.
final class SSETests: XCTestCase {
    private func frame(_ payload: String) -> String {
        "event: kernel\ndata: \(payload)\n\n"
    }

    private func parseAll(_ body: String) -> [String] {
        var parser = SSEFrameParser()
        return parser.push(body) + parser.flush()
    }

    func testDecodesCompleteFramesAndIgnoresKeepalives() {
        var parser = SSEFrameParser()
        XCTAssertEqual(
            parser.push(": keepalive\n\ndata: {\"a\":1}\n\n: keepalive\n\ndata: {\"b\":2}\n\n"),
            ["{\"a\":1}", "{\"b\":2}"]
        )
        XCTAssertEqual(parser.flush(), [])
    }

    func testBuffersAFrameThatArrivesInPieces() {
        var parser = SSEFrameParser()
        XCTAssertEqual(parser.push("data: {\"a\""), [])
        XCTAssertEqual(parser.push(":1}\n"), [])
        XCTAssertEqual(parser.push("\n"), ["{\"a\":1}"])
    }

    func testSplitsSeveralFramesInOneChunk() {
        let body = frame("{\"n\":1}") + frame("{\"n\":2}") + frame("{\"n\":3}")
        XCTAssertEqual(parseAll(body), ["{\"n\":1}", "{\"n\":2}", "{\"n\":3}"])
    }

    /// Byte offsets, so every split inside the multi-byte characters is covered.
    func testReassemblesAFrameSplitAtEveryByteOffset() {
        let payload = "{\"text\":\"héllo 🌍\"}"
        let bytes = Array(": keepalive\n\nevent: kernel\ndata: \(payload)\n\n".utf8)
        for size in 1...bytes.count {
            var parser = SSEFrameParser()
            var out: [String] = []
            var start = 0
            while start < bytes.count {
                let end = min(start + size, bytes.count)
                out += parser.push(Data(bytes[start..<end]))
                start = end
            }
            out += parser.flush()
            XCTAssertEqual(out, [payload], "chunk size \(size)")
        }
    }

    func testFlushYieldsAFrameThatNeverGotItsTerminator() {
        var parser = SSEFrameParser()
        XCTAssertEqual(parser.push("data: {\"done\":true}"), [])
        XCTAssertEqual(parser.flush(), ["{\"done\":true}"])
        XCTAssertEqual(parser.flush(), [], "flush is not repeatable")
    }

    func testFlushDropsACommentOnlyOrWhitespaceTail() {
        var parser = SSEFrameParser()
        _ = parser.push(": keepalive\n\n")
        XCTAssertEqual(parser.flush(), [])
        XCTAssertEqual(parseAll("   \n\n"), [])
    }

    func testJoinsMultiLineDataAndDropsOneLeadingSpace() {
        XCTAssertEqual(frameData("data: {\ndata:   \"a\": 1\ndata: }"), "{\n  \"a\": 1\n}")
        XCTAssertEqual(frameData("data:no-space"), "no-space")
        XCTAssertEqual(frameData("event: kernel\nid: 7\nretry: 10\ndata: x"), "x")
        XCTAssertEqual(frameData("data"), "", "a bare field name carries an empty value")
    }

    func testHandlesCRLFTerminators() {
        var parser = SSEFrameParser()
        XCTAssertEqual(parser.push("data: {\"a\":1}\r\n\r\ndata: {\"b\":2}\r\n\r\n"), ["{\"a\":1}", "{\"b\":2}"])
    }

    func testHandlesCRTerminators() {
        var parser = SSEFrameParser()
        XCTAssertEqual(parser.push("data: {\"a\":1}\r\rdata: {\"b\":2}\r\r"), ["{\"a\":1}", "{\"b\":2}"])
    }

    /// Every terminator style, split at every byte offset, including through
    /// the middle of the terminator itself.
    func testFindsATerminatorSplitAcrossChunks() {
        for terminator in ["\n\n", "\r\n\r\n", "\r\r"] {
            let bytes = Array("data: one\(terminator)data: two\(terminator)".utf8)
            for cut in 0...bytes.count {
                var parser = SSEFrameParser()
                var out = parser.push(Data(bytes[..<cut]))
                out += parser.push(Data(bytes[cut...]))
                XCTAssertEqual(out, ["one", "two"], "terminator \(terminator.debugDescription) cut at \(cut)")
                XCTAssertEqual(parser.flush(), [])
            }
        }
    }

    func testFrameEndStartsTheSearchAtTheGivenOffset() {
        let bytes = Array("a\n\nb\n\n".utf8)
        XCTAssertEqual(SSEFrameParser.frameEnd(bytes), 3)
        XCTAssertEqual(SSEFrameParser.frameEnd(bytes, from: 2), 6)
        XCTAssertNil(SSEFrameParser.frameEnd(bytes, from: 6))
    }

    /// A large frame trickling in as small chunks. Rescanning the whole buffer
    /// on each chunk made this quadratic; with the scan offset it is linear.
    func testALargeFrameInSmallChunksStaysLinear() {
        let payload = String(repeating: "x", count: 400_000)
        let bytes = Array("data: \(payload)\n\n".utf8)
        var parser = SSEFrameParser()
        var out: [String] = []
        var start = 0
        let started = Date()
        while start < bytes.count {
            let end = min(start + 16, bytes.count)
            out += parser.push(Data(bytes[start..<end]))
            start = end
        }
        XCTAssertEqual(out, [payload])
        XCTAssertLessThan(Date().timeIntervalSince(started), 10, "parsing should not rescan the buffer per chunk")
    }

    func testDecodeFrameSwallowsMalformedFrames() {
        XCTAssertEqual(decodeFrame("{\"type\":\"turn.done\",\"turnId\":\"t\"}"), .turnDone(turnId: "t"))
        XCTAssertNil(decodeFrame("{\"type\":"))
        XCTAssertNil(decodeFrame("not json at all"))
        XCTAssertEqual(decodeFrame("{\"type\":\"from.the.future\"}"), .unknown)
    }

    func testDecodesEveryKernelEvent() throws {
        let events: [(String, KernelEvent)] = [
            (#"{"type":"turn.start","turnId":"t1"}"#, .turnStart(turnId: "t1")),
            (#"{"type":"message.start","messageId":"m1","role":"assistant"}"#, .messageStart(messageId: "m1")),
            (#"{"type":"text.delta","messageId":"m1","text":"hi"}"#, .textDelta(messageId: "m1", text: "hi")),
            (#"{"type":"reasoning.delta","messageId":"m1","text":"hm"}"#, .reasoningDelta(messageId: "m1", text: "hm")),
            (
                #"{"type":"tool.call","messageId":"m1","callId":"c1","name":"shell_exec","args":{"command":"ls","n":2}}"#,
                .toolCall(messageId: "m1", callId: "c1", name: "shell_exec", args: ["command": "ls", "n": 2])
            ),
            (#"{"type":"tool.approval","callId":"c1","status":"requested"}"#, .toolApproval(callId: "c1", status: .requested)),
            (
                #"{"type":"tool.result","callId":"c1","name":"shell_exec","parts":[{"type":"text","text":"ok"}],"isError":false}"#,
                .toolResult(callId: "c1", name: "shell_exec", parts: [.text("ok")], isError: false)
            ),
            (#"{"type":"message.done","messageId":"m1","finishReason":"length"}"#, .messageDone(messageId: "m1", finishReason: "length")),
            (#"{"type":"session.title","sessionId":"s","title":"T"}"#, .sessionTitle(sessionId: "s", title: "T")),
            (#"{"type":"usage","usage":{"inputTokens":3,"outputTokens":4}}"#, .usage(Usage(inputTokens: 3, outputTokens: 4))),
            (#"{"type":"warning","message":"careful"}"#, .warning("careful")),
            (#"{"type":"error","error":{"code":"x","message":"broke"}}"#, .error(NormalizedError(code: "x", message: "broke"))),
        ]
        for (json, expected) in events {
            XCTAssertEqual(decodeFrame(json), expected, json)
        }
    }
}
