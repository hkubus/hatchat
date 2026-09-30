import Foundation

/// Incremental parser for the `text/event-stream` frames the kernel endpoints
/// emit — the Swift twin of `packages/core/src/sse.ts`, and it has to agree
/// with it on the awkward parts:
///
///   - a frame split across network chunks, or several frames in one chunk
///   - multi-byte UTF-8 split mid-character between chunks. This parser works
///     on bytes and only decodes a frame once it is complete, so a split
///     character is reassembled before it is ever decoded.
///   - `: keepalive` comment frames, which carry no data
///   - a stream that ends mid-frame
public struct SSEFrameParser: Sendable {
    private var buffer: [UInt8] = []
    /// Where the next terminator search starts. Bytes before it are known not
    /// to begin a terminator, so each chunk is scanned once rather than the
    /// whole buffer again (a long frame arriving in many small chunks would
    /// otherwise be quadratic).
    private var scanFrom = 0

    /// Longest terminator (`\r\n\r\n`) minus one: how far to back off from the
    /// end of the buffer so a terminator split across chunks is still found.
    private static let terminatorOverlap = 3

    public init() {}

    /// Feed the next chunk; returns the payloads it completed.
    public mutating func push(_ chunk: Data) -> [String] {
        buffer.append(contentsOf: chunk)
        var out: [String] = []
        var start = 0
        while let end = SSEFrameParser.frameEnd(buffer, from: max(start, scanFrom)) {
            let frame = String(decoding: buffer[start..<end], as: UTF8.self)
            if let data = frameData(frame) { out.append(data) }
            start = end
            scanFrom = end
        }
        // Drop consumed frames in one go, then resume the next search just
        // short of the end, where a terminator may have been cut off.
        if start > 0 { buffer.removeSubrange(..<start) }
        scanFrom = max(0, buffer.count - SSEFrameParser.terminatorOverlap)
        return out
    }

    public mutating func push(_ chunk: String) -> [String] {
        push(Data(chunk.utf8))
    }

    /// Consume what is left when the stream ends. A frame still missing its
    /// terminator is kept (the last event of a turn is often flushed without
    /// one), but an empty or comment-only tail yields nothing.
    public mutating func flush() -> [String] {
        let rest = String(decoding: buffer, as: UTF8.self)
        buffer.removeAll()
        scanFrom = 0
        guard !rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        return frameData(rest).map { [$0] } ?? []
    }

    /// Index just past the first frame terminator (`\n\n`, `\r\n\r\n` or
    /// `\r\r`) that starts at or after `from`, if any.
    static func frameEnd(_ bytes: [UInt8], from: Int = 0) -> Int? {
        let lf = UInt8(ascii: "\n"), cr = UInt8(ascii: "\r")
        var i = max(0, from)
        while i + 1 < bytes.count {
            let a = bytes[i], b = bytes[i + 1]
            if a == lf, b == lf { return i + 2 }
            if a == cr, b == cr { return i + 2 }
            if a == cr, b == lf, i + 3 < bytes.count, bytes[i + 2] == cr, bytes[i + 3] == lf {
                return i + 4
            }
            i += 1
        }
        return nil
    }
}

/// The payload of a single frame: its `data:` lines joined with newlines, or
/// nil when it carries none (a comment, or only `event:`/`id:`/`retry:`).
public func frameData(_ frame: String) -> String? {
    var lines: [String] = []
    // Split on CRLF, LF or CR. `\r\n` is a single grapheme in Swift, so it is
    // matched as its own separator rather than as two.
    for line in frame.split(omittingEmptySubsequences: false, whereSeparator: { $0 == "\n" || $0 == "\r" || $0 == "\r\n" }) {
        if line.isEmpty || line.hasPrefix(":") { continue }
        guard let colon = line.firstIndex(of: ":") else {
            if line == "data" { lines.append("") }
            continue
        }
        guard line[..<colon] == "data" else { continue }
        var value = line[line.index(after: colon)...]
        // A single leading space after the colon is framing, not value.
        if value.hasPrefix(" ") { value = value.dropFirst() }
        lines.append(String(value))
    }
    return lines.isEmpty ? nil : lines.joined(separator: "\n")
}

/// Decode a frame payload, or nil when it is not a usable event. A truncated or
/// non-JSON frame must not take the turn down with it.
public func decodeFrame(_ data: String) -> KernelEvent? {
    try? JSONDecoder().decode(KernelEvent.self, from: Data(data.utf8))
}
