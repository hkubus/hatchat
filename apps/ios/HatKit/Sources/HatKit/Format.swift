import Foundation

// Display formatting: token counts, context windows, byte sizes, capability
// chips and search snippets. Pure, so all of it is pinned by tests.

/// JavaScript's `Math.round`: halves round up, towards +infinity.
private func jsRound(_ value: Double) -> Double {
    (value + 0.5).rounded(.down)
}

/// A number with at most one decimal, without a trailing ".0".
private func oneDecimal(_ value: Double) -> String {
    let rounded = jsRound(value * 10) / 10
    return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
}

/// Compact token label: 1048576 -> "1M", 4200 -> "4.2k", 812 -> "812". Empty for
/// zero or non-finite input, so callers can hide the readout entirely.
public func formatTokens(_ tokens: Double) -> String {
    guard tokens.isFinite, tokens > 0 else { return "" }
    if tokens >= 1_000_000 {
        let millions = tokens / 1_000_000
        return (millions >= 10 || millions == millions.rounded() ? String(Int(jsRound(millions))) : oneDecimal(millions)) + "M"
    }
    if tokens >= 1000 {
        let thousands = tokens / 1000
        return (thousands >= 100 || thousands == thousands.rounded() ? String(Int(jsRound(thousands))) : oneDecimal(thousands)) + "k"
    }
    return String(Int(jsRound(tokens)))
}

public func formatTokens(_ tokens: Int) -> String {
    formatTokens(Double(tokens))
}

/// Compact context-window label, rounded to whole thousands: an advertised
/// window is a round number, so "8k" reads truer than "8.2k".
public func formatContext(_ tokens: Int) -> String {
    guard tokens > 0 else { return "" }
    let value = Double(tokens)
    if tokens >= 1_000_000 {
        let millions = value / 1_000_000
        return (millions >= 10 || millions == millions.rounded() ? String(Int(jsRound(millions))) : oneDecimal(millions)) + "M"
    }
    if tokens >= 1000 { return "\(Int(jsRound(value / 1000)))k" }
    return String(tokens)
}

/// "1,234" in the en-US style the web client's `toLocaleString` shows.
public func groupedNumber(_ value: Int) -> String {
    let digits = String(abs(value))
    var out = ""
    for (i, ch) in digits.enumerated() {
        if i > 0, (digits.count - i) % 3 == 0 { out.append(",") }
        out.append(ch)
    }
    return value < 0 ? "-" + out : out
}

/// "1,234 in · 567 out · 1,801 total".
public func usageDetail(_ usage: Usage?) -> String {
    guard let usage else { return "" }
    var parts: [String] = []
    if let input = usage.inputTokens, input != 0 { parts.append("\(groupedNumber(input)) in") }
    if let output = usage.outputTokens, output != 0 { parts.append("\(groupedNumber(output)) out") }
    let total = usageTotal(usage)
    if total != 0 { parts.append("\(groupedNumber(total)) total") }
    return parts.joined(separator: " · ")
}

/// Human-readable byte count: 512 B, 1.5 KB, 12 MB.
public func formatBytes(_ size: Int) -> String {
    guard size >= 0 else { return "" }
    if size < 1024 { return "\(size) B" }
    let units = ["KB", "MB", "GB"]
    var value = Double(size) / 1024
    var unit = 0
    while value >= 1024, unit < units.count - 1 {
        value /= 1024
        unit += 1
    }
    let number = value < 10 ? String(format: "%.1f", value) : String(Int(jsRound(value)))
    return "\(number) \(units[unit])"
}

// MARK: - Capabilities

public struct CapTag: Hashable, Sendable, Identifiable {
    public var key: String
    public var label: String
    public var title: String
    public var id: String { key }
}

/// The capability chips shown against a model, in a stable order.
public func capTags(_ caps: ProviderCapabilities, contextWindow: Int?) -> [CapTag] {
    var tags: [CapTag] = []
    if caps.toolCalls { tags.append(CapTag(key: "tools", label: "tools", title: "Can call tools")) }
    if caps.vision { tags.append(CapTag(key: "vision", label: "vision", title: "Accepts image input")) }
    if caps.reasoning { tags.append(CapTag(key: "reasoning", label: "reasoning", title: "Exposes reasoning output")) }
    if caps.reasoningEffort { tags.append(CapTag(key: "effort", label: "effort", title: "Supports a tunable reasoning effort")) }
    if caps.jsonMode { tags.append(CapTag(key: "json", label: "json", title: "Supports JSON mode")) }
    if let window = contextWindow, window > 0 {
        tags.append(CapTag(key: "ctx", label: "\(formatContext(window)) ctx", title: "\(groupedNumber(window)) token context window"))
    }
    return tags
}

/// One-line capability summary, where there is no room for chips.
public func capSummary(_ model: ModelInfo) -> String {
    let tags = capTags(model.capabilities, contextWindow: model.contextWindow)
    return tags.isEmpty ? "no capabilities reported" : tags.map(\.label).joined(separator: " · ")
}

// MARK: - Search

public struct SnippetPart: Hashable, Sendable {
    public var text: String
    /// True for a matched term, which the server wraps in « and ».
    public var hit: Bool

    public init(text: String, hit: Bool) {
        self.text = text
        self.hit = hit
    }
}

/// Split a search snippet into plain and matched runs. Whitespace collapses to
/// single spaces (a snippet is a two-line preview); an unmatched « or » stays
/// as text.
public func snippetParts(_ snippet: String) -> [SnippetPart] {
    let text = snippet.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    var out: [SnippetPart] = []
    var plain = ""
    var i = text.startIndex
    while i < text.endIndex {
        if text[i] == "«", let close = text[text.index(after: i)...].firstIndex(where: { $0 == "»" || $0 == "«" }), text[close] == "»" {
            let inner = String(text[text.index(after: i)..<close])
            if !plain.isEmpty { out.append(SnippetPart(text: plain, hit: false)); plain = "" }
            if !inner.isEmpty { out.append(SnippetPart(text: inner, hit: true)) }
            i = text.index(after: close)
        } else {
            plain.append(text[i])
            i = text.index(after: i)
        }
    }
    if !plain.isEmpty { out.append(SnippetPart(text: plain, hit: false)) }
    return out
}

// MARK: - Dates

/// Section title for a conversation's last activity, as Messages groups them.
public func dateBucket(_ epochMs: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
    let date = Date(timeIntervalSince1970: epochMs / 1000)
    let today = calendar.startOfDay(for: now)
    let day: TimeInterval = 24 * 60 * 60
    let t = date.timeIntervalSince(today)
    if t >= 0 { return "Today" }
    if t >= -day { return "Yesterday" }
    if t >= -7 * day { return "Previous 7 Days" }
    if t >= -30 * day { return "Previous 30 Days" }
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.setLocalizedDateFormatFromTemplate("MMMM yyyy")
    return formatter.string(from: date)
}

/// The short timestamp Messages and Mail use in their lists.
public func listTime(_ epochMs: Double, now: Date = Date(), calendar: Calendar = .current) -> String {
    let date = Date(timeIntervalSince1970: epochMs / 1000)
    let today = calendar.startOfDay(for: now)
    let day: TimeInterval = 24 * 60 * 60
    let t = date.timeIntervalSince(today)
    let formatter = DateFormatter()
    formatter.calendar = calendar
    if t >= 0 {
        formatter.timeStyle = .short
        formatter.dateStyle = .none
        return formatter.string(from: date)
    }
    if t >= -day { return "Yesterday" }
    if t >= -6 * day {
        formatter.setLocalizedDateFormatFromTemplate("EEEE")
        return formatter.string(from: date)
    }
    formatter.setLocalizedDateFormatFromTemplate("M/d/yy")
    return formatter.string(from: date)
}
