import HatKit
import SwiftUI
import UIKit

/// A reply rendered as Markdown. Block structure comes from HatKit's
/// `parseMarkdown`; inline emphasis, code spans and links are SwiftUI's own
/// `AttributedString(markdown:)`.
struct MarkdownView: View {
    var text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(parseMarkdown(text).enumerated()), id: \.offset) { _, block in
                BlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Inline Markdown, falling back to the raw text when it does not parse (a
/// half-streamed `**` is the common case).
func inlineMarkdown(_ source: String) -> AttributedString {
    let options = AttributedString.MarkdownParsingOptions(
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible
    )
    return (try? AttributedString(markdown: source, options: options)) ?? AttributedString(source)
}

private struct BlockView: View {
    var block: MarkdownBlock

    var body: some View {
        switch block {
        case let .paragraph(text):
            Text(inlineMarkdown(text))
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
        case let .heading(level, text):
            Text(inlineMarkdown(text))
                .font(level == 1 ? .title2.bold() : level == 2 ? .title3.bold() : .headline)
                .padding(.top, 4)
        case let .code(language, text):
            CodeBlock(language: language, code: text)
        case let .list(items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        marker(item)
                            .frame(minWidth: 16, alignment: .trailing)
                        Text(inlineMarkdown(item.text))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.leading, CGFloat(item.depth) * 18)
                }
            }
        case let .quote(blocks):
            HStack(spacing: 10) {
                RoundedRectangle(cornerRadius: 1.5).fill(.quaternary).frame(width: 3)
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        BlockView(block: block)
                    }
                }
                .foregroundStyle(.secondary)
            }
            .fixedSize(horizontal: false, vertical: true)
        case let .table(header, rows):
            ScrollView(.horizontal, showsIndicators: false) {
                Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 6) {
                    GridRow {
                        ForEach(Array(header.enumerated()), id: \.offset) { _, cell in
                            Text(inlineMarkdown(cell)).font(.subheadline.weight(.semibold))
                        }
                    }
                    Divider()
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        GridRow {
                            ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                Text(inlineMarkdown(cell)).font(.subheadline)
                            }
                        }
                    }
                }
                .padding(12)
            }
            .background(Theme.surfaceAlt, in: .rect(cornerRadius: 12, style: .continuous))
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func marker(_ item: MarkdownListItem) -> some View {
        if let checked = item.checked {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .foregroundStyle(checked ? Theme.accent : .secondary)
        } else if let marker = item.marker {
            Text(marker).monospacedDigit().foregroundStyle(.secondary)
        } else {
            Text(item.depth == 0 ? "•" : "◦").foregroundStyle(.secondary)
        }
    }
}

/// A fenced block: scrolls sideways instead of wrapping, with a Copy button.
/// No syntax highlighting — a monospace surface keeps the app small.
private struct CodeBlock: View {
    var language: String
    var code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    Haptics.success()
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(1.5))
                        copied = false
                    }
                } label: {
                    Label(copied ? "Copied" : "Copy", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.caption.weight(.medium))
                }
                .buttonStyle(.borderless)
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 12)
            }
        }
        .background(Theme.surfaceAlt, in: .rect(cornerRadius: 12, style: .continuous))
    }
}
