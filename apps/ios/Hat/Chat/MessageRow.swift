import HatKit
import SwiftUI
import UIKit

/// What a row can ask the chat screen to do.
struct MessageActions {
    var regenerate: (String) -> Void
    var edit: (String) -> Void
    /// Start a new conversation from the path up to this reply.
    var fork: (String) -> Void
    /// Switch to the sibling with this id.
    var switchBranch: (String) -> Void
    var decide: (String, ApprovalDecision) -> Void
    var answer: (String, String) -> Void
    var selectText: (String) -> Void
    var openImage: (UIImage) -> Void
}

/// One row of the transcript: a user bubble, or an assistant message with its
/// reasoning, tool cards and branch controls.
///
/// Long-pressing a message opens the system context menu (Copy, Select Text,
/// Share, Edit / Regenerate, Fork from Here), as in Messages. Reasoning and
/// tool output are collapsed by default: they can run to hundreds of lines and
/// bury the answer. What a tool exists to *show* stays out of the fold: a
/// `todo_write` checklist, a pending `ask_user` question, and the images and
/// files a tool produced.
struct MessageRow: View {
    var message: UiMessage
    var busy: Bool
    var actions: MessageActions

    private var isUser: Bool { message.role == .user }
    private var idle: Bool { !message.streaming && !busy }

    var body: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
            // Attached documents sit above the bubble as their own cards.
            if !message.files.isEmpty {
                VStack(spacing: 6) {
                    ForEach(message.files) { FileCard(file: $0) }
                }
                .frame(maxWidth: isUser ? 360 : .infinity)
            }

            // A message of documents alone has nothing to put in a bubble.
            if !(isUser && message.text.isEmpty && message.images.isEmpty) {
                bubble
                    .contextMenu { menu }
            }

            rowActions
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    @ViewBuilder
    private var bubble: some View {
        if isUser {
            VStack(alignment: .trailing, spacing: 8) {
                images
                if !message.text.isEmpty {
                    Text(message.text)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .background(Theme.userBubble, in: .rect(cornerRadius: 20, style: .continuous))
            // Room on the leading side keeps a long message from filling the row.
            .padding(.leading, 56)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                images
                if !message.reasoning.isEmpty {
                    ReasoningView(text: message.reasoning, thinking: message.streaming && message.text.isEmpty)
                }
                if !message.text.isEmpty {
                    MarkdownView(text: message.text)
                }
                // A turn that has only just started shows a pulse and nothing
                // else; it reads as "thinking", which is accurate.
                if message.streaming && message.text.isEmpty && message.reasoning.isEmpty && message.tools.isEmpty {
                    StreamingPulse()
                }
                ForEach(message.tools) { tool in
                    ToolCard(tool: tool, disabled: busy && !tool.running, actions: actions)
                    ToolArtifacts(tool: tool, openImage: actions.openImage)
                }
            }
            .padding(2)
            .contentShape(.rect)
        }
    }

    @ViewBuilder
    private var images: some View {
        if !message.images.isEmpty {
            HStack(spacing: 8) {
                ForEach(Array(message.images.enumerated()), id: \.offset) { _, image in
                    MessageImage(image: image, style: .thumbnail, onOpen: actions.openImage)
                }
            }
        }
    }

    @ViewBuilder
    private var menu: some View {
        if !message.text.isEmpty {
            Button("Copy", systemImage: "doc.on.doc") { copy() }
            Button("Select Text", systemImage: "character.cursor.ibeam") { actions.selectText(message.text) }
            ShareLink(item: message.text) { Label("Share…", systemImage: "square.and.arrow.up") }
        }
        if idle {
            if isUser {
                Button("Edit", systemImage: "pencil") { actions.edit(message.id) }
            } else {
                Button("Regenerate", systemImage: "arrow.clockwise") { actions.regenerate(message.id) }
                // Replies only: a fork ending on a user message would have no
                // reply to regenerate or continue from.
                Button {
                    actions.fork(message.id)
                } label: {
                    Label("Fork from Here", systemImage: "arrow.triangle.branch")
                    Text("New conversation up to this reply")
                }
            }
        }
    }

    @ViewBuilder
    private var rowActions: some View {
        let branch = message.branch.flatMap { $0.count > 1 ? $0 : nil }
        if branch != nil || idle {
            HStack(spacing: 8) {
                if let branch {
                    HStack(spacing: 4) {
                        iconButton("chevron.left", label: "Previous version", disabled: branch.index <= 0) {
                            actions.switchBranch(branch.ids[branch.index - 1])
                        }
                        Text("\(branch.index + 1)/\(branch.count)")
                            .font(.footnote)
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                        iconButton("chevron.right", label: "Next version", disabled: branch.index >= branch.count - 1) {
                            actions.switchBranch(branch.ids[branch.index + 1])
                        }
                    }
                }
                if idle {
                    if isUser {
                        iconButton("pencil", label: "Edit message") { actions.edit(message.id) }
                    } else {
                        if !message.text.isEmpty {
                            iconButton("doc.on.doc", label: "Copy response") { copy() }
                        }
                        iconButton("arrow.clockwise", label: "Regenerate response") { actions.regenerate(message.id) }
                    }
                }
            }
            .padding(.horizontal, 2)
        }
    }

    private func iconButton(_ icon: String, label: String, disabled: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(width: 28, height: 28)
                .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .opacity(disabled ? 0.3 : 1)
        .accessibilityLabel(label)
    }

    private func copy() {
        UIPasteboard.general.string = message.text
        Haptics.success()
    }
}

/// A header that toggles the section under it, with a chevron.
private struct Disclosure<Label: View>: View {
    @Binding var open: Bool
    @ViewBuilder var label: Label

    var body: some View {
        Button {
            Haptics.selection()
            withAnimation(.snappy) { open.toggle() }
        } label: {
            HStack(spacing: 6) {
                label
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .frame(minHeight: 28)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isButton)
        .accessibilityValue(open ? "Expanded" : "Collapsed")
    }
}

private struct ReasoningView: View {
    var text: String
    var thinking: Bool
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Disclosure(open: $open) {
                if thinking { ProgressView().controlSize(.small) }
                Text(thinking ? "Thinking…" : "Thought process")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            if open { Mono(text: text) }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Theme.surfaceAlt, in: .rect(cornerRadius: 12, style: .continuous))
    }
}

private struct ToolCard: View {
    var tool: UiTool
    var disabled: Bool
    var actions: MessageActions
    @State private var open = false

    private var awaiting: Bool { tool.running && tool.approval == .requested }

    private var status: (label: String, tone: Badge.Tone) {
        if tool.running { return awaiting ? ("awaiting approval", .warn) : ("running", .neutral) }
        if tool.isError { return ("failed", .bad) }
        if tool.approval == .denied { return ("denied", .bad) }
        if tool.approval == .approved { return ("approved", .good) }
        return ("done", .good)
    }

    var body: some View {
        let summary = toolSummary(tool)
        let todos = tool.name == "todo_write" ? todosOf(tool.args) : []
        let question = tool.name == "ask_user" && tool.running && !tool.answered && !awaiting ? questionOf(tool.args) : nil

        VStack(alignment: .leading, spacing: 6) {
            Disclosure(open: $open) {
                Image(systemName: !todos.isEmpty ? "checklist" : question != nil ? "questionmark.bubble" : "terminal")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(tool.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                if tool.running && !awaiting { ProgressView().controlSize(.small) }
                Badge(label: status.label, tone: status.tone)
            }
            .accessibilityLabel("\(tool.name), \(status.label)")

            if !summary.isEmpty {
                Mono(text: summary, lineLimit: open ? nil : 1)
            }
            if !todos.isEmpty { TodosView(todos: todos) }
            if let question {
                QuestionView(question: question) { actions.answer(tool.callId, $0) }
                    .id(tool.callId)
            }
            if awaiting {
                HStack(spacing: 8) {
                    Button("Deny", role: .destructive) { actions.decide(tool.callId, .deny) }
                        .buttonStyle(.bordered)
                        .frame(maxWidth: .infinity)
                    Button("Approve") { actions.decide(tool.callId, .approve) }
                        .buttonStyle(.borderedProminent)
                        .frame(maxWidth: .infinity)
                }
                .controlSize(.regular)
                .disabled(disabled)
                .padding(.bottom, 4)
            }
            if open, let result = tool.result {
                Mono(text: result, color: tool.isError ? Theme.danger : .secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.surfaceAlt, in: .rect(cornerRadius: 12, style: .continuous))
        .overlay {
            if awaiting {
                RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.warn, lineWidth: 1)
            }
        }
    }
}

/// `todo_write` as a checklist: done items struck through, the current one bold.
private struct TodosView: View {
    var todos: [UiTodo]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(todos.enumerated()), id: \.offset) { _, todo in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: todo.status == .completed ? "checkmark.circle.fill" : todo.status == .inProgress ? "arrow.right.circle.fill" : "circle")
                        .foregroundStyle(todo.status == .completed ? Theme.success : todo.status == .inProgress ? Color.primary : Color(uiColor: .tertiaryLabel))
                    Text(todo.content)
                        .font(.subheadline)
                        .fontWeight(todo.status == .inProgress ? .semibold : .regular)
                        .strikethrough(todo.status == .completed)
                        .foregroundStyle(todo.status == .completed ? .tertiary : .primary)
                }
            }
        }
    }
}

/// An `ask_user` prompt. A single-select option answers on tap; multi-select
/// collects choices and sends them with any typed text.
private struct QuestionView: View {
    var question: UiQuestion
    var onAnswer: (String) -> Void
    @State private var selected: [String] = []
    @State private var text = ""

    private var answer: String {
        question.multiSelect ? joinAnswer(selected, text) : text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(question.question).font(.body.weight(.semibold))
            if !question.options.isEmpty {
                FlowLayout(spacing: 8) {
                    ForEach(question.options, id: \.self) { option in
                        let on = selected.contains(option)
                        Button {
                            Haptics.selection()
                            if !question.multiSelect { return onAnswer(option) }
                            if on { selected.removeAll { $0 == option } } else { selected.append(option) }
                        } label: {
                            HStack(spacing: 4) {
                                if on { Image(systemName: "checkmark") }
                                Text(option)
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(on ? Theme.accent : .secondary)
                    }
                }
            }
            HStack(spacing: 8) {
                TextField(question.options.isEmpty ? "Type an answer" : "Or type an answer", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .submitLabel(.send)
                    .onSubmit { if !answer.isEmpty { onAnswer(answer) } }
                Button("Send") { onAnswer(answer) }
                    .buttonStyle(.borderedProminent)
                    .disabled(answer.isEmpty)
            }
        }
        .padding(.leading, 10)
        .overlay(alignment: .leading) {
            Rectangle().fill(Theme.accent).frame(width: 3)
        }
        .padding(.bottom, 4)
    }
}

/// Images and files a tool produced, outside the card, so a plot or an artifact
/// is visible without expanding the tool output.
private struct ToolArtifacts: View {
    var tool: UiTool
    var openImage: (UIImage) -> Void

    var body: some View {
        let fileImages = tool.files.filter { $0.mime.hasPrefix("image/") }.map { UiImage(src: "", attachmentId: $0.id) }
        if !tool.images.isEmpty || !tool.files.isEmpty {
            VStack(spacing: 8) {
                ForEach(Array((tool.images + fileImages).enumerated()), id: \.offset) { _, image in
                    MessageImage(image: image, style: .fullWidth, onOpen: openImage)
                }
                ForEach(tool.files) { FileCard(file: $0) }
            }
        }
    }
}

private struct StreamingPulse: View {
    @State private var on = false

    var body: some View {
        Circle()
            .fill(.tertiary)
            .frame(width: 10, height: 10)
            .opacity(on ? 1 : 0.3)
            .frame(height: 22)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) { on = true }
            }
            .accessibilityLabel("Waiting for a response")
    }
}

/// Lays children out in rows, wrapping to the next when one is full.
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map { $0.width }.max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.indices {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var indices: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = [Row()]
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            if !rows[rows.count - 1].indices.isEmpty, rows[rows.count - 1].width + spacing + size.width > width {
                rows.append(Row())
            }
            var row = rows[rows.count - 1]
            row.width += (row.indices.isEmpty ? 0 : spacing) + size.width
            row.height = max(row.height, size.height)
            row.indices.append(index)
            rows[rows.count - 1] = row
        }
        return rows.filter { !$0.indices.isEmpty }
    }
}
