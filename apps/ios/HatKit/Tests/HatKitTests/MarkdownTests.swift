import XCTest
@testable import HatKit

final class MarkdownTests: XCTestCase {
    func testParagraphsHeadingsAndRules() {
        XCTAssertEqual(parseMarkdown("# Title\n\nOne\ntwo\n\n---\n\nThree"), [
            .heading(level: 1, text: "Title"),
            .paragraph("One\ntwo"),
            .rule,
            .paragraph("Three"),
        ])
        XCTAssertEqual(parseMarkdown("#hashtag"), [.paragraph("#hashtag")])
    }

    func testFencedCode() {
        XCTAssertEqual(parseMarkdown("Look:\n```swift\nlet x = 1\n\nprint(x)\n```\nDone"), [
            .paragraph("Look:"),
            .code(language: "swift", text: "let x = 1\n\nprint(x)"),
            .paragraph("Done"),
        ])
    }

    /// A reply is parsed at every streamed prefix; an open fence runs to the end.
    func testAnUnclosedFenceIsStillCode() {
        XCTAssertEqual(parseMarkdown("```\nstill typing"), [.code(language: "", text: "still typing")])
    }

    func testListsWithNestingAndTasks() {
        XCTAssertEqual(parseMarkdown("- a\n  - b\n- [x] c\n\n1. one\n2) two"), [
            .list([
                MarkdownListItem(marker: nil, text: "a", depth: 0, checked: nil),
                MarkdownListItem(marker: nil, text: "b", depth: 1, checked: nil),
                MarkdownListItem(marker: nil, text: "c", depth: 0, checked: true),
                MarkdownListItem(marker: "1.", text: "one", depth: 0, checked: nil),
                MarkdownListItem(marker: "2.", text: "two", depth: 0, checked: nil),
            ]),
        ])
    }

    func testQuotesAndTables() {
        XCTAssertEqual(parseMarkdown("> quoted\n> # inside"), [
            .quote([.paragraph("quoted"), .heading(level: 1, text: "inside")]),
        ])
        XCTAssertEqual(parseMarkdown("| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 |"), [
            .table(header: ["a", "b"], rows: [["1", "2"], ["3", ""]]),
        ])
    }

    func testImagesOnTheirOwnLine() {
        XCTAssertEqual(parseMarkdown("Here:\n![a plot](https://x.example/p.png \"title\")\n![](data:image/png;base64,AAA=) ![b](<https://y.example/q.png>)\nafter"), [
            .paragraph("Here:"),
            .image(alt: "a plot", source: "https://x.example/p.png"),
            .image(alt: "", source: "data:image/png;base64,AAA="),
            .image(alt: "b", source: "https://y.example/q.png"),
            .paragraph("after"),
        ])
        // Inside a sentence an image stays inline, where it shows as its alt text.
        XCTAssertEqual(parseMarkdown("see ![x](https://x.example/p.png)"), [.paragraph("see ![x](https://x.example/p.png)")])
        XCTAssertEqual(parseMarkdown("![x](https://x.example/p.png) and text"), [.paragraph("![x](https://x.example/p.png) and text")])
    }

    /// A web image waits for a tap: rendering it would fetch it, and a steered
    /// reply could put what the model saw in its URL.
    func testImageSources() {
        XCTAssertEqual(markdownImageSource("data:image/png;base64,AAEC"), .inline(Data([0, 1, 2])))
        XCTAssertEqual(markdownImageSource("DATA:image/JPEG;base64,AAEC"), .inline(Data([0, 1, 2])))
        XCTAssertEqual(
            markdownImageSource("https://attacker.example:8443/p.png?d=secret"),
            .remote(URL(string: "https://attacker.example:8443/p.png?d=secret")!, host: "attacker.example:8443")
        )
        XCTAssertEqual(markdownImageSource("http://x.example/a.gif"), .remote(URL(string: "http://x.example/a.gif")!, host: "x.example"))
        for blocked in ["https://", "file:///etc/passwd", "p.png", "data:image/svg+xml;base64,AAEC", "data:image/png;base64,", "javascript:alert(1)"] {
            XCTAssertEqual(markdownImageSource(blocked), .blocked, blocked)
        }
    }

    func testOnlyWebMailAndPhoneLinksOpen() {
        for open in ["https://x.example", "HTTP://x.example", "mailto:a@b.c", "tel:+48123"] {
            XCTAssertTrue(isOpenableLink(URL(string: open)!), open)
        }
        for inert in ["shortcuts://run-shortcut?name=x", "file:///etc/passwd", "javascript:alert(1)", "sms:123", "relative/path"] {
            XCTAssertFalse(isOpenableLink(URL(string: inert)!), inert)
        }
    }
}
