import Foundation

// The chat view-model: the server's message tree flattened into a transcript,
// and a live `KernelEvent` stream folded into the same shape. A port of
// `packages/core/src/chat-view.ts`, which the web and desktop clients share;
// `ChatViewTests` holds the same cases as its `chat-view.test.ts`.

public struct UiTool: Hashable, Sendable, Identifiable {
    public var callId: String
    public var name: String
    public var args: JSONValue
    /// Last approval state seen; nil when the call is not approval-gated.
    public var approval: ApprovalStatus?
    public var result: String?
    public var isError: Bool
    public var running: Bool
    /// Images in the result (e.g. a plot from `python`), shown outside the card.
    public var images: [UiImage]
    /// Stored artifacts in the result, shown as tappable cards.
    public var files: [UiFile]
    /// Set optimistically once an `ask_user` question has been answered here.
    public var answered: Bool

    public var id: String { callId }

    public init(
        callId: String, name: String, args: JSONValue = .null, approval: ApprovalStatus? = nil,
        result: String? = nil, isError: Bool = false, running: Bool = true,
        images: [UiImage] = [], files: [UiFile] = [], answered: Bool = false
    ) {
        self.callId = callId
        self.name = name
        self.args = args
        self.approval = approval
        self.result = result
        self.isError = isError
        self.running = running
        self.images = images
        self.files = files
        self.answered = answered
    }
}

/// A stored file: an artifact the assistant produced, or a document the user attached.
public struct UiFile: Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var mime: String
    public var size: Int

    public init(id: String, name: String, mime: String, size: Int) {
        self.id = id
        self.name = name
        self.mime = mime
        self.size = size
    }
}

public struct UiBranch: Hashable, Sendable {
    public var index: Int
    public var count: Int
    public var ids: [String]
}

public struct UiImage: Hashable, Sendable {
    /// A data URL, a remote URL, or a `file:` URL for a local preview; empty
    /// for attachment-backed images, which are fetched with the bearer token.
    public var src: String
    public var attachmentId: String?

    public init(src: String, attachmentId: String? = nil) {
        self.src = src
        self.attachmentId = attachmentId
    }
}

public enum UiRole: String, Hashable, Sendable {
    case user, assistant
}

public struct UiMessage: Hashable, Sendable, Identifiable {
    public var id: String
    public var role: UiRole
    public var text: String
    public var reasoning: String
    public var tools: [UiTool]
    public var branch: UiBranch?
    public var images: [UiImage]
    /// Documents attached to a user message.
    public var files: [UiFile]
    public var usage: Usage?
    /// Why the model stopped; `length` means the reply was cut off.
    public var finishReason: String?
    /// True while this is an in-flight assistant message rather than stored state.
    public var streaming: Bool

    public init(
        id: String, role: UiRole, text: String = "", reasoning: String = "", tools: [UiTool] = [],
        branch: UiBranch? = nil, images: [UiImage] = [], files: [UiFile] = [], usage: Usage? = nil,
        finishReason: String? = nil, streaming: Bool = false
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.reasoning = reasoning
        self.tools = tools
        self.branch = branch
        self.images = images
        self.files = files
        self.usage = usage
        self.finishReason = finishReason
        self.streaming = streaming
    }

    public static func emptyAssistant(_ id: String) -> UiMessage {
        UiMessage(id: id, role: .assistant, streaming: true)
    }
}

// MARK: - Parts

func textOf(_ parts: [Part]) -> String {
    parts.compactMap { if case let .text(t) = $0 { return t } else { return nil } }.joined()
}

func reasoningOf(_ parts: [Part]) -> String {
    parts.compactMap { if case let .reasoning(t) = $0 { return t } else { return nil } }.joined()
}

func toolsOf(_ parts: [Part]) -> [UiTool] {
    parts.compactMap {
        // A call with a result later in the path starts out running;
        // `buildMessages` clears it when it reaches the tool message.
        if case let .toolCall(id, name, args) = $0 { return UiTool(callId: id, name: name, args: args) }
        return nil
    }
}

func imagesOf(_ parts: [Part]) -> [UiImage] {
    parts.compactMap {
        guard case let .image(source) = $0 else { return nil }
        switch source {
        case let .attachment(id, _): return UiImage(src: "", attachmentId: id)
        case let .url(url, _): return UiImage(src: url)
        case let .data(data, mime): return UiImage(src: "data:\(mime);base64,\(data)")
        }
    }
}

func filesOf(_ parts: [Part]) -> [UiFile] {
    parts.compactMap {
        if case let .file(id, name, mime, size) = $0 { return UiFile(id: id, name: name, mime: mime, size: size) }
        return nil
    }
}

/// What a tool result's content contributes to its card.
public func toolResultOf(_ parts: [Part]) -> (result: String, images: [UiImage], files: [UiFile]) {
    (textOf(parts), imagesOf(parts), filesOf(parts))
}

// MARK: - buildMessages

/// Rebuild the visible conversation from the server's active branch path.
///
/// `path` is already the root-to-leaf chain, so this is a walk. The subtlety is
/// `role: "tool"`: a result arrives as its own message, but it belongs on the
/// card of the assistant message that made the call, so the walk looks back
/// for that card.
public func buildMessages(_ path: [PathNode]) -> [UiMessage] {
    var out: [UiMessage] = []
    for node in path {
        let message = node.message
        let branch = UiBranch(index: node.siblingIndex, count: node.siblingCount, ids: node.siblingIds)

        switch message.role {
        case "user":
            // The "Continue" nudge is the app talking, not the user.
            if message.meta?.synthetic != nil { continue }
            out.append(UiMessage(
                id: message.id, role: .user, text: textOf(message.parts), branch: branch,
                images: imagesOf(message.parts), files: filesOf(message.parts)
            ))
        case "assistant":
            out.append(UiMessage(
                id: message.id, role: .assistant, text: textOf(message.parts),
                reasoning: reasoningOf(message.parts), tools: toolsOf(message.parts), branch: branch,
                images: imagesOf(message.parts), usage: message.meta?.usage,
                finishReason: message.meta?.finishReason
            ))
        case "tool":
            for part in message.parts {
                guard case let .toolResult(callId, _, content, isError) = part else { continue }
                search: for i in out.indices.reversed() {
                    guard let t = out[i].tools.firstIndex(where: { $0.callId == callId }) else { continue }
                    let result = toolResultOf(content)
                    out[i].tools[t].result = result.result
                    out[i].tools[t].images = result.images
                    out[i].tools[t].files = result.files
                    out[i].tools[t].isError = isError
                    out[i].tools[t].running = false
                    break search
                }
            }
        default:
            continue
        }
    }
    return out
}

// MARK: - Events

/// What a single `KernelEvent` does to the live view-model.
public enum ChatEffect: Hashable, Sendable {
    case none
    case resetUsage
    case startMessage(id: String)
    case appendText(messageId: String?, text: String)
    case appendReasoning(messageId: String?, text: String)
    case toolCall(messageId: String?, callId: String, name: String, args: JSONValue)
    case toolApproval(callId: String, status: ApprovalStatus)
    case toolResult(callId: String, result: String, images: [UiImage], files: [UiFile], isError: Bool)
    case finishMessage(messageId: String, finishReason: String)
    case usage(Usage)
    case sessionTitle(sessionId: String, title: String)
    case error(String)
    case warning(String)
}

/// Read one event. There is one `message.start` per model iteration, not per
/// turn, which is why the in-flight state is a list.
public func readEvent(_ event: KernelEvent) -> ChatEffect {
    switch event {
    case .turnStart: return .resetUsage
    case let .messageStart(id): return .startMessage(id: id)
    case let .textDelta(id, text): return .appendText(messageId: id, text: text)
    case let .reasoningDelta(id, text): return .appendReasoning(messageId: id, text: text)
    case let .toolCall(id, callId, name, args): return .toolCall(messageId: id, callId: callId, name: name, args: args)
    case let .toolApproval(callId, status): return .toolApproval(callId: callId, status: status)
    case let .toolResult(callId, _, parts, isError):
        let result = toolResultOf(parts)
        return .toolResult(callId: callId, result: result.result, images: result.images, files: result.files, isError: isError)
    case let .messageDone(id, reason): return .finishMessage(messageId: id, finishReason: reason)
    case let .usage(usage): return .usage(usage)
    case let .sessionTitle(sessionId, title): return .sessionTitle(sessionId: sessionId, title: title)
    case let .error(error): return .error(error.message)
    case let .warning(message): return .warning(message)
    // `turn.done` changes nothing itself: a finished turn becomes durable
    // through the post-turn refresh.
    case .turnDone, .unknown: return .none
    }
}

/// Replace the message with `messageId`, or the newest one when the id is
/// unknown: `tool.approval` and `tool.result` carry no message id, and a delta
/// for a message no longer in the list should still land somewhere sensible.
private func patchMessage(_ list: inout [UiMessage], _ messageId: String?, _ fn: (inout UiMessage) -> Void) {
    let known = messageId.flatMap { id in list.firstIndex { $0.id == id } }
    guard let index = known ?? (list.isEmpty ? nil : list.count - 1) else { return }
    fn(&list[index])
}

/// Patch a tool by call id, newest message first.
private func patchTool(_ list: inout [UiMessage], _ callId: String, _ fn: (inout UiTool) -> Void) {
    for i in list.indices.reversed() {
        guard let t = list[i].tools.firstIndex(where: { $0.callId == callId }) else { continue }
        fn(&list[i].tools[t])
        return
    }
}

/// Apply one effect to the in-flight messages.
public func applyEffect(_ list: [UiMessage], _ effect: ChatEffect) -> [UiMessage] {
    var next = list
    switch effect {
    case let .startMessage(id):
        next.append(.emptyAssistant(id))
    case let .appendText(id, text):
        patchMessage(&next, id) { $0.text += text }
    case let .appendReasoning(id, text):
        patchMessage(&next, id) { $0.reasoning += text }
    case let .toolCall(id, callId, name, args):
        patchMessage(&next, id) { $0.tools.append(UiTool(callId: callId, name: name, args: args)) }
    case let .toolApproval(callId, status):
        patchTool(&next, callId) { $0.approval = status }
    case let .toolResult(callId, result, images, files, isError):
        patchTool(&next, callId) {
            $0.running = false
            $0.isError = isError
            $0.result = result
            $0.images = images
            $0.files = files
        }
    case let .finishMessage(id, reason):
        // Only a known id: a stale `message.done` must not stamp whatever is newest.
        guard next.contains(where: { $0.id == id }) else { return list }
        patchMessage(&next, id) { $0.finishReason = reason }
    case let .usage(usage):
        // Usage arrives once per model call, before its message.done, so the
        // newest message is the one it belongs to.
        patchMessage(&next, nil) { $0.usage = addUsage($0.usage, usage) }
    default:
        return list
    }
    return next
}

/// Apply a live effect to the stored messages shown above the in-flight ones.
/// Only tool approvals and results can concern them: a client that attached
/// to a turn already under way (a relaunch, switching back, another device)
/// got the message that made the call with the stored history, since it was
/// saved before the call ran, so the replayed approval request and the result
/// belong to that copy. Applied only in flight, they were dropped, which left
/// an approval with no buttons and the turn waiting on it. The list comes back
/// unchanged when the call is not in it.
public func applyStoredEffect(_ stored: [UiMessage], _ effect: ChatEffect) -> [UiMessage] {
    switch effect {
    case .toolApproval, .toolResult: return applyEffect(stored, effect)
    default: return stored
    }
}

/// How full the context window is, judged by the latest model call: its prompt
/// plus its reply is what the next call starts from.
public func contextFill(_ messages: [UiMessage], contextWindow: Int?) -> (tokens: Int, fraction: Double)? {
    guard let window = contextWindow, window > 0 else { return nil }
    for message in messages.reversed() {
        guard message.role == .assistant, let usage = message.usage else { continue }
        let tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        if tokens <= 0 { continue }
        return (tokens, min(1, Double(tokens) / Double(window)))
    }
    return nil
}

/// Whether the conversation ends on a reply cut off at the output limit.
public func endsTruncated(_ messages: [UiMessage]) -> Bool {
    guard let last = messages.last else { return false }
    return last.role == .assistant && last.finishReason == "length"
}

/// The local decision recorded optimistically on a tool card, before the POST.
public func approvalForDecision(_ decision: ApprovalDecision) -> ApprovalStatus {
    decision == .deny ? .denied : .approved
}

// MARK: - Tool cards

/// Which argument makes the one-line brief for a known tool; `firstLine` marks
/// arguments that are typically multi-line.
private let briefKeys: [String: (key: String, firstLine: Bool)] = [
    "read_file": ("path", false),
    "write_file": ("path", false),
    "edit_file": ("path", false),
    "web_fetch": ("url", false),
    "python": ("code", true),
    "process_start": ("command", false),
    "create_artifact": ("name", false),
    "memory_save": ("text", false),
    "ask_user": ("question", false),
    "spawn_subagent": ("task", true),
    "schedule_create": ("title", false),
]

private func firstLine(_ value: String) -> String {
    value.split(separator: "\n", omittingEmptySubsequences: false)
        .first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
}

/// One-line preview of a tool call, for the collapsed card.
public func toolSummary(_ tool: UiTool) -> String {
    switch tool.args {
    case .null: return ""
    case let .string(value): return value
    case let .object(record):
        if let brief = briefKeys[tool.name], let value = record[brief.key]?.stringValue {
            return brief.firstLine ? firstLine(value) : value
        }
        // The checklist itself is the preview; a JSON dump of it is noise.
        if tool.name == "todo_write" { return "" }
        if let command = (record["command"] ?? record["cmd"])?.stringValue { return command }
        guard let key = record.keys.sorted().first else { return "" }
        return "\(key): \(record[key]!.jsonString)"
    default:
        return tool.args.displayString
    }
}

public enum TodoStatus: String, Hashable, Sendable {
    case pending, inProgress = "in_progress", completed
}

public struct UiTodo: Hashable, Sendable {
    public var content: String
    public var status: TodoStatus
}

/// The checklist from `todo_write` args; malformed entries are dropped.
public func todosOf(_ args: JSONValue) -> [UiTodo] {
    guard let todos = args["todos"]?.arrayValue else { return [] }
    return todos.compactMap { item in
        guard let content = item["content"]?.stringValue else { return nil }
        let status = item["status"]?.stringValue.flatMap(TodoStatus.init(rawValue:)) ?? .pending
        return UiTodo(content: content, status: status)
    }
}

public struct UiQuestion: Hashable, Sendable {
    public var question: String
    public var options: [String]
    public var multiSelect: Bool
}

/// The prompt from `ask_user` args, or nil when there is no question.
public func questionOf(_ args: JSONValue) -> UiQuestion? {
    guard let question = args["question"]?.stringValue else { return nil }
    let options = (args["options"]?.arrayValue ?? []).compactMap(\.stringValue).filter { !$0.isEmpty }
    return UiQuestion(question: question, options: options, multiSelect: args["multi_select"]?.boolValue == true)
}

/// The answer the server expects: multi-select choices joined by ", ".
public func joinAnswer(_ selected: [String], _ freeText: String) -> String {
    (selected + [freeText.trimmingCharacters(in: .whitespacesAndNewlines)]).filter { !$0.isEmpty }.joined(separator: ", ")
}
