import Foundation
import XCTest
@testable import HatKit

/// Ports of `apps/mobile/src/tokens.test.ts` and `search.test.ts`, plus the
/// models' lenient decoding.
final class FormatTests: XCTestCase {
    func testFormatTokens() {
        XCTAssertEqual(formatTokens(812), "812")
        XCTAssertEqual(formatTokens(1500), "1.5k")
        XCTAssertEqual(formatTokens(4200), "4.2k")
        XCTAssertEqual(formatTokens(200_000), "200k")
        XCTAssertEqual(formatTokens(1_048_576), "1M")
        XCTAssertEqual(formatTokens(12_000_000), "12M")
        XCTAssertEqual(formatTokens(0), "")
        XCTAssertEqual(formatTokens(-5), "")
        XCTAssertEqual(formatTokens(Double.nan), "")
        XCTAssertEqual(formatTokens(Double.infinity), "")
    }

    /// An advertised window stays round ("8k") where a measured count keeps a decimal.
    func testFormatContext() {
        XCTAssertEqual(formatContext(8192), "8k")
        XCTAssertEqual(formatContext(16_384), "16k")
        XCTAssertEqual(formatContext(32_768), "33k")
        XCTAssertEqual(formatContext(65_536), "66k")
        XCTAssertEqual(formatContext(128_000), "128k")
        XCTAssertEqual(formatContext(1_048_576), "1M")
        XCTAssertEqual(formatContext(2_000_000), "2M")
        XCTAssertEqual(formatContext(0), "")
    }

    func testUsage() {
        XCTAssertEqual(usageTotal(Usage(inputTokens: 10, outputTokens: 5)), 15)
        XCTAssertEqual(usageTotal(Usage(totalTokens: 99)), 99)
        XCTAssertEqual(usageTotal(nil), 0)
        XCTAssertEqual(usageDetail(Usage(inputTokens: 1234, outputTokens: 567, totalTokens: 1801)), "1,234 in · 567 out · 1,801 total")
        XCTAssertEqual(usageDetail(Usage(inputTokens: 0, outputTokens: 12)), "12 out · 12 total")
        XCTAssertEqual(usageDetail(nil), "")
        XCTAssertEqual(sumUsage([nil, Usage(inputTokens: 1), Usage(inputTokens: 2, cachedTokens: 1)]), Usage(inputTokens: 3, outputTokens: 0, totalTokens: 0, cachedTokens: 1))
    }

    func testFormatBytes() {
        XCTAssertEqual(formatBytes(512), "512 B")
        XCTAssertEqual(formatBytes(1536), "1.5 KB")
        XCTAssertEqual(formatBytes(20 * 1024 * 1024), "20 MB")
    }

    func testCapTags() {
        let caps = ProviderCapabilities(toolCalls: true, vision: true, reasoningEffort: true)
        XCTAssertEqual(capTags(caps, contextWindow: 128_000).map(\.label), ["tools", "vision", "effort", "128k ctx"])
        XCTAssertEqual(capSummary(ModelInfo(id: "a/b", label: "B", provider: "a")), "no capabilities reported")
    }

    func testSnippetParts() {
        XCTAssertEqual(snippetParts("…the «quick» brown «fox» jumps"), [
            SnippetPart(text: "…the ", hit: false),
            SnippetPart(text: "quick", hit: true),
            SnippetPart(text: " brown ", hit: false),
            SnippetPart(text: "fox", hit: true),
            SnippetPart(text: " jumps", hit: false),
        ])
        XCTAssertEqual(snippetParts("«alpha»\n\n  beta «gamma»"), [
            SnippetPart(text: "alpha", hit: true),
            SnippetPart(text: " beta ", hit: false),
            SnippetPart(text: "gamma", hit: true),
        ])
        XCTAssertEqual(snippetParts("a « b"), [SnippetPart(text: "a « b", hit: false)])
        XCTAssertEqual(snippetParts(""), [])
    }

    func testNormalizeServerUrl() {
        XCTAssertEqual(normalizeServerUrl("  hat.local:8787/ "), "http://hat.local:8787")
        XCTAssertEqual(normalizeServerUrl("HTTPS://x.ts.net//"), "HTTPS://x.ts.net")
        XCTAssertEqual(normalizeServerUrl(""), "")
        XCTAssertEqual(normalizeServerUrl("http://hat.example.com"), "http://hat.example.com", "an explicit scheme is kept")
    }

    /// Bare addresses: http on the local network, https everywhere else, where
    /// App Transport Security would refuse plain HTTP anyway.
    func testNormalizeServerUrlPicksTheScheme() {
        XCTAssertEqual(normalizeServerUrl("hat.example.com"), "https://hat.example.com")
        XCTAssertEqual(normalizeServerUrl("x.tail1234.ts.net"), "https://x.tail1234.ts.net")
        XCTAssertEqual(normalizeServerUrl("8.8.8.8:8787"), "https://8.8.8.8:8787")
        XCTAssertEqual(normalizeServerUrl("localhost:8787"), "http://localhost:8787")
        XCTAssertEqual(normalizeServerUrl("hat:8787"), "http://hat:8787")
        XCTAssertEqual(normalizeServerUrl("127.0.0.1:8787"), "http://127.0.0.1:8787")
        XCTAssertEqual(normalizeServerUrl("192.168.1.10:8787"), "http://192.168.1.10:8787")
        XCTAssertEqual(normalizeServerUrl("10.0.0.5"), "http://10.0.0.5")
        XCTAssertEqual(normalizeServerUrl("172.20.0.1"), "http://172.20.0.1")
        XCTAssertEqual(normalizeServerUrl("172.32.0.1"), "https://172.32.0.1")
        XCTAssertEqual(normalizeServerUrl("100.101.102.103"), "http://100.101.102.103")
        XCTAssertEqual(normalizeServerUrl("[::1]:8787"), "http://[::1]:8787")
    }

    func testExplainsATSBlockedRequests() {
        let url = URL(string: "http://hat.example.com:8787/api/health")!
        let blocked = NSError(domain: NSURLErrorDomain, code: -1022)
        let explained = explainTransportError(blocked, url: url)
        XCTAssertTrue(explained is HatError)
        let message = explained.localizedDescription
        XCTAssertTrue(message.contains("hat.example.com"), message)
        XCTAssertTrue(message.contains("https://hat.example.com:8787"), message)
        XCTAssertFalse(message.contains("/api/health"), message)

        let other = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        XCTAssertEqual(explainTransportError(other, url: url) as NSError, other, "other errors pass through")
    }

    func testDateBuckets() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let now = Date(timeIntervalSince1970: 1_750_000_000) // mid-day UTC
        let ms = { (secondsAgo: Double) in (now.timeIntervalSince1970 - secondsAgo) * 1000 }
        XCTAssertEqual(dateBucket(ms(60), now: now, calendar: calendar), "Today")
        XCTAssertEqual(dateBucket(ms(86_400), now: now, calendar: calendar), "Yesterday")
        XCTAssertEqual(dateBucket(ms(4 * 86_400), now: now, calendar: calendar), "Previous 7 Days")
        XCTAssertEqual(dateBucket(ms(20 * 86_400), now: now, calendar: calendar), "Previous 30 Days")
    }

    func testLenientDecoding() throws {
        let json = """
        {"id":"s","title":"T","model":"m","activeLeafId":null,"approvalMode":"sometimes",
         "allowedTools":[],"reasoningEffort":"extreme","createdAt":1,"updatedAt":2}
        """
        let record = try JSONDecoder().decode(SessionRecord.self, from: Data(json.utf8))
        XCTAssertEqual(record.approvalMode, .ask)
        XCTAssertEqual(record.reasoningEffort, .off)
        XCTAssertNil(record.instructions)
        // The menus list these through `allCases`.
        XCTAssertEqual(ReasoningEffort.allCases, [.off, .low, .medium, .high])
        XCTAssertEqual(ApprovalMode.allCases.map(\.label), ["Ask", "Auto", "Allowlist", "Deny"])

        let model = try JSONDecoder().decode(ModelInfo.self, from: Data(#"{"id":"a/b","label":"B","provider":"a","capabilities":{"vision":true}}"#.utf8))
        XCTAssertTrue(model.capabilities.vision)
        XCTAssertFalse(model.capabilities.toolCalls)

        let parts = try JSONDecoder().decode([Part].self, from: Data(#"[{"type":"hologram"},{"type":"text","text":"x"}]"#.utf8))
        XCTAssertEqual(parts, [.unknown, .text("x")])
    }

    func testSessionPatchEncodesNullToReset() throws {
        let patch = SessionPatch(instructions: "", temperature: .some(nil), maxTokens: .some(512))
        let json = String(decoding: try JSONEncoder().encode(patch), as: UTF8.self)
        XCTAssertTrue(json.contains("\"temperature\":null"), json)
        XCTAssertTrue(json.contains("\"maxTokens\":512"), json)
        XCTAssertFalse(json.contains("model"), json)
    }

    func testSniffImageMime() {
        XCTAssertEqual(sniffImageMime(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A])), "image/png")
        XCTAssertEqual(sniffImageMime(Data([0xFF, 0xD8, 0xFF, 0xE0])), "image/jpeg")
        XCTAssertEqual(sniffImageMime(Data("GIF89a".utf8)), "image/gif")
        XCTAssertEqual(sniffImageMime(Data("RIFF\0\0\0\0WEBPVP8 ".utf8)), "image/webp")
        // HEIC: an ISO box with an `ftypheic` brand.
        XCTAssertNil(sniffImageMime(Data([0, 0, 0, 0x18] + Array("ftypheic".utf8))))
        XCTAssertNil(sniffImageMime(Data()))
    }
}
