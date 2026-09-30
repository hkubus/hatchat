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
}
