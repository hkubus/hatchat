import Foundation

// The wire format. These mirror `packages/core/src/messages.ts`, `events.ts`
// and `provider.ts`, and the response shapes the Hono handlers in
// `packages/server/src/app.ts` serialize. Keep them in step with those files.
//
// Decoding is deliberately lenient: an optional field an older server does not
// send, or an enum value a newer one adds, must not make a whole response
// unreadable. Unknown part and event types decode to `.unknown` and are
// skipped, the way the TypeScript clients fall through their `switch`.

/// A string enum that decodes an unknown value to a fallback instead of failing.
public protocol LenientEnum: RawRepresentable, Codable, CaseIterable where RawValue == String {
    static var fallback: Self { get }
}

extension LenientEnum {
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = Self(rawValue: raw) ?? Self.fallback
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
}

// MARK: - Messages

public enum ImageSource: Hashable, Sendable, Decodable {
    case url(String, mime: String)
    case data(String, mime: String)
    case attachment(String, mime: String)

    private enum CodingKeys: String, CodingKey { case kind, url, data, id, mime }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let mime = try c.decodeIfPresent(String.self, forKey: .mime) ?? ""
        switch try c.decode(String.self, forKey: .kind) {
        case "url": self = .url(try c.decode(String.self, forKey: .url), mime: mime)
        case "data": self = .data(try c.decode(String.self, forKey: .data), mime: mime)
        default: self = .attachment(try c.decode(String.self, forKey: .id), mime: mime)
        }
    }
}

public enum Part: Hashable, Sendable, Decodable {
    case text(String)
    case image(ImageSource)
    case reasoning(String)
    /// A stored file: an artifact the assistant produced, or a document the user attached.
    case file(id: String, name: String, mime: String, size: Int)
    case toolCall(id: String, name: String, args: JSONValue)
    case toolResult(id: String, name: String, content: [Part], isError: Bool)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type, text, source, id, name, mime, size, args, content, isError
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .type) {
        case "text":
            self = .text(try c.decode(String.self, forKey: .text))
        case "reasoning":
            self = .reasoning(try c.decode(String.self, forKey: .text))
        case "image":
            self = .image(try c.decode(ImageSource.self, forKey: .source))
        case "file":
            self = .file(
                id: try c.decode(String.self, forKey: .id),
                name: try c.decodeIfPresent(String.self, forKey: .name) ?? "file",
                mime: try c.decodeIfPresent(String.self, forKey: .mime) ?? "application/octet-stream",
                size: Int(try c.decodeIfPresent(Double.self, forKey: .size) ?? 0)
            )
        case "tool_call":
            self = .toolCall(
                id: try c.decode(String.self, forKey: .id),
                name: try c.decode(String.self, forKey: .name),
                args: try c.decodeIfPresent(JSONValue.self, forKey: .args) ?? .null
            )
        case "tool_result":
            self = .toolResult(
                id: try c.decode(String.self, forKey: .id),
                name: try c.decodeIfPresent(String.self, forKey: .name) ?? "",
                content: try c.decodeIfPresent([Part].self, forKey: .content) ?? [],
                isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            )
        default:
            self = .unknown
        }
    }
}

public struct Usage: Hashable, Sendable, Codable {
    public var inputTokens: Int?
    public var outputTokens: Int?
    public var totalTokens: Int?
    /// Input tokens served from the provider's prompt cache; absent when not reported.
    public var cachedTokens: Int?

    public init(inputTokens: Int? = nil, outputTokens: Int? = nil, totalTokens: Int? = nil, cachedTokens: Int? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.totalTokens = totalTokens
        self.cachedTokens = cachedTokens
    }
}

/// `addUsage` from `@hat/core`: absent fields count as zero, and only totals a
/// provider reported are summed. `cachedTokens` stays absent unless one side
/// reported it, so "no cache statistics" stays distinguishable from a 0% hit.
public func addUsage(_ base: Usage?, _ next: Usage) -> Usage {
    let hasCached = base?.cachedTokens != nil || next.cachedTokens != nil
    return Usage(
        inputTokens: (base?.inputTokens ?? 0) + (next.inputTokens ?? 0),
        outputTokens: (base?.outputTokens ?? 0) + (next.outputTokens ?? 0),
        totalTokens: (base?.totalTokens ?? 0) + (next.totalTokens ?? 0),
        cachedTokens: hasCached ? (base?.cachedTokens ?? 0) + (next.cachedTokens ?? 0) : nil
    )
}

/// The most trustworthy total: the reported one when positive, else input + output.
public func usageTotal(_ usage: Usage?) -> Int {
    guard let usage else { return 0 }
    if let total = usage.totalTokens, total > 0 { return total }
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
}

/// Sum a list of usage figures, skipping the absent ones.
public func sumUsage(_ list: [Usage?]) -> Usage {
    list.reduce(nil as Usage?) { acc, usage in usage.map { addUsage(acc, $0) } ?? acc }
        ?? Usage(inputTokens: 0, outputTokens: 0, totalTokens: 0)
}

public struct MessageMeta: Hashable, Sendable, Decodable {
    public var usage: Usage?
    public var finishReason: String?
    /// Set on the "Continue" nudge, which the app writes on the user's behalf.
    public var synthetic: String?

    public init(usage: Usage? = nil, finishReason: String? = nil, synthetic: String? = nil) {
        self.usage = usage
        self.finishReason = finishReason
        self.synthetic = synthetic
    }
}

public struct ChatMessage: Hashable, Sendable, Decodable {
    public var id: String
    public var role: String
    public var parts: [Part]
    public var createdAt: Double
    public var meta: MessageMeta?

    public init(id: String, role: String, parts: [Part], createdAt: Double = 0, meta: MessageMeta? = nil) {
        self.id = id
        self.role = role
        self.parts = parts
        self.createdAt = createdAt
        self.meta = meta
    }
}

/// One node of the active root-to-leaf path, as the session API returns it.
public struct PathNode: Hashable, Sendable, Decodable {
    public var message: ChatMessage
    public var parentId: String?
    public var siblingIndex: Int
    public var siblingCount: Int
    public var siblingIds: [String]

    public init(message: ChatMessage, parentId: String? = nil, siblingIndex: Int = 0, siblingCount: Int = 1, siblingIds: [String]? = nil) {
        self.message = message
        self.parentId = parentId
        self.siblingIndex = siblingIndex
        self.siblingCount = siblingCount
        self.siblingIds = siblingIds ?? [message.id]
    }
}

// MARK: - Kernel events

public struct NormalizedError: Hashable, Sendable, Decodable {
    public var code: String?
    public var message: String
}

/// Canonical stream events the kernel emits towards clients.
public enum KernelEvent: Hashable, Sendable, Decodable {
    case turnStart(turnId: String)
    case messageStart(messageId: String)
    case textDelta(messageId: String?, text: String)
    case reasoningDelta(messageId: String?, text: String)
    case toolCall(messageId: String?, callId: String, name: String, args: JSONValue)
    case toolApproval(callId: String, status: ApprovalStatus)
    case toolResult(callId: String, name: String, parts: [Part], isError: Bool)
    case messageDone(messageId: String, finishReason: String)
    case sessionTitle(sessionId: String, title: String)
    case usage(Usage)
    case warning(String)
    case error(NormalizedError)
    case turnDone(turnId: String)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type, turnId, messageId, text, callId, name, args, status, parts, isError
        case finishReason, sessionId, title, usage, message, error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func string(_ key: CodingKeys) throws -> String { try c.decode(String.self, forKey: key) }
        func optional(_ key: CodingKeys) throws -> String? { try c.decodeIfPresent(String.self, forKey: key) }

        switch try string(.type) {
        case "turn.start": self = .turnStart(turnId: try optional(.turnId) ?? "")
        case "message.start": self = .messageStart(messageId: try string(.messageId))
        case "text.delta": self = .textDelta(messageId: try optional(.messageId), text: try string(.text))
        case "reasoning.delta": self = .reasoningDelta(messageId: try optional(.messageId), text: try string(.text))
        case "tool.call":
            self = .toolCall(
                messageId: try optional(.messageId),
                callId: try string(.callId),
                name: try string(.name),
                args: try c.decodeIfPresent(JSONValue.self, forKey: .args) ?? .null
            )
        case "tool.approval":
            self = .toolApproval(callId: try string(.callId), status: try c.decode(ApprovalStatus.self, forKey: .status))
        case "tool.result":
            self = .toolResult(
                callId: try string(.callId),
                name: try optional(.name) ?? "",
                parts: try c.decodeIfPresent([Part].self, forKey: .parts) ?? [],
                isError: try c.decodeIfPresent(Bool.self, forKey: .isError) ?? false
            )
        case "message.done":
            self = .messageDone(messageId: try string(.messageId), finishReason: try optional(.finishReason) ?? "stop")
        case "session.title": self = .sessionTitle(sessionId: try string(.sessionId), title: try string(.title))
        case "usage": self = .usage(try c.decode(Usage.self, forKey: .usage))
        case "warning": self = .warning(try string(.message))
        case "error": self = .error(try c.decode(NormalizedError.self, forKey: .error))
        case "turn.done": self = .turnDone(turnId: try optional(.turnId) ?? "")
        default: self = .unknown
        }
    }
}

public enum ApprovalStatus: String, Hashable, Sendable, LenientEnum {
    case requested, approved, denied
    public static var fallback: ApprovalStatus { .requested }
}

// MARK: - Server resources

public enum ReasoningEffort: String, Hashable, Sendable, LenientEnum {
    case off, low, medium, high
    public static var fallback: ReasoningEffort { .off }

    public var label: String { rawValue.capitalized }
}

public enum ApprovalMode: String, Hashable, Sendable, LenientEnum {
    case ask, auto, allowlist, deny
    public static var fallback: ApprovalMode { .ask }

    public var label: String { rawValue.capitalized }
}

public enum SessionStatus: String, Hashable, Sendable, LenientEnum {
    case idle, running, waiting
    public static var fallback: SessionStatus { .idle }
}

public struct ProviderCapabilities: Hashable, Sendable, Decodable {
    public var toolCalls: Bool
    public var vision: Bool
    public var reasoning: Bool
    /// Whether `reasoningEffort` is accepted as a tunable knob.
    public var reasoningEffort: Bool
    public var jsonMode: Bool

    public init(toolCalls: Bool = false, vision: Bool = false, reasoning: Bool = false, reasoningEffort: Bool = false, jsonMode: Bool = false) {
        self.toolCalls = toolCalls
        self.vision = vision
        self.reasoning = reasoning
        self.reasoningEffort = reasoningEffort
        self.jsonMode = jsonMode
    }

    private enum CodingKeys: String, CodingKey { case toolCalls, vision, reasoning, reasoningEffort, jsonMode }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        func flag(_ key: CodingKeys) -> Bool { (try? c.decodeIfPresent(Bool.self, forKey: key)).flatMap { $0 } ?? false }
        self.init(
            toolCalls: flag(.toolCalls),
            vision: flag(.vision),
            reasoning: flag(.reasoning),
            reasoningEffort: flag(.reasoningEffort),
            jsonMode: flag(.jsonMode)
        )
    }
}

public struct ModelInfo: Hashable, Sendable, Decodable, Identifiable {
    /// Fully qualified, `provider/model`.
    public var id: String
    public var label: String
    public var provider: String
    public var contextWindow: Int?
    public var capabilities: ProviderCapabilities

    public init(id: String, label: String, provider: String, contextWindow: Int? = nil, capabilities: ProviderCapabilities = .init()) {
        self.id = id
        self.label = label
        self.provider = provider
        self.contextWindow = contextWindow
        self.capabilities = capabilities
    }
}

public struct SessionRecord: Hashable, Sendable, Decodable {
    public var id: String
    public var title: String
    public var model: String
    public var activeLeafId: String?
    public var approvalMode: ApprovalMode
    public var allowedTools: [String]
    public var reasoningEffort: ReasoningEffort
    /// Per-conversation instructions; "" for none. Optional so an older server still parses.
    public var instructions: String?
    /// 0–2; nil leaves the provider default.
    public var temperature: Double?
    /// Reply-token cap per model call; nil leaves the provider default.
    public var maxTokens: Int?
    public var createdAt: Double
    public var updatedAt: Double
}

public struct SessionPayload: Hashable, Sendable, Decodable {
    public var session: SessionRecord
    public var path: [PathNode]
}

public struct SessionSummary: Hashable, Sendable, Decodable, Identifiable {
    public var id: String
    public var title: String
    public var model: String
    public var messageCount: Int
    /// Tokens spent on the active branch; nil when nothing has been recorded.
    public var usage: Usage?
    /// A turn `running`, or `waiting` on the user. Absent from older servers.
    public var status: SessionStatus?
    public var updatedAt: Double

    public init(id: String, title: String, model: String = "", messageCount: Int = 0, usage: Usage? = nil, status: SessionStatus? = nil, updatedAt: Double = 0) {
        self.id = id
        self.title = title
        self.model = model
        self.messageCount = messageCount
        self.usage = usage
        self.status = status
        self.updatedAt = updatedAt
    }
}

/// One message matched by `GET /api/search`.
public struct SearchHit: Hashable, Sendable, Decodable, Identifiable {
    public var messageId: String
    public var sessionId: String
    public var sessionTitle: String
    public var role: String
    /// Matched text, with each hit wrapped in « and ».
    public var snippet: String
    public var createdAt: Double

    public var id: String { messageId }
}

public struct RunnerSummary: Hashable, Sendable, Decodable, Identifiable {
    public struct Capabilities: Hashable, Sendable, Decodable {
        public var os: String
        public var arch: String
        public var tags: [String]
    }

    public var id: String
    public var capabilities: Capabilities
    /// In-flight jobs plus processes.
    public var load: Int
}

public struct ProviderStatus: Hashable, Sendable, Decodable, Identifiable {
    public var id: String
    public var label: String
    public var secretName: String
    public var configured: Bool
    public var registered: Bool
    public var status: String?
}

public struct AttachmentRecord: Hashable, Sendable, Decodable {
    public var id: String
    public var mime: String
    public var size: Int
    /// `image` goes to the model as pixels; a `document` is read as text on upload.
    public var kind: String?
    public var name: String?
}

public struct JsonSchemaProperty: Hashable, Sendable, Decodable {
    public var type: String?
    public var description: String?
    public var `enum`: [JSONValue]?
    public var `default`: JSONValue?
}

public struct JsonSchema: Hashable, Sendable, Decodable {
    public var type: String?
    public var properties: [String: JsonSchemaProperty]?
    public var required: [String]?
}

public struct PluginDescriptor: Hashable, Sendable, Decodable, Identifiable {
    public var id: String
    public var name: String
    public var version: String
    public var description: String?
    public var source: String
    public var enabled: Bool
    public var status: String
    public var error: String?
    public var config: [String: JSONValue]
    public var configSchema: JsonSchema?
}

/// Fields `PATCH /api/sessions/:id` accepts. `nil` leaves a field alone;
/// `.some(nil)` on the two nullable ones clears it back to the provider default.
public struct SessionPatch: Sendable, Encodable {
    public var model: String?
    public var title: String?
    public var approvalMode: ApprovalMode?
    public var allowedTools: [String]?
    public var reasoningEffort: ReasoningEffort?
    public var instructions: String?
    public var temperature: Double??
    public var maxTokens: Int??

    public init(
        model: String? = nil, title: String? = nil, approvalMode: ApprovalMode? = nil,
        allowedTools: [String]? = nil, reasoningEffort: ReasoningEffort? = nil,
        instructions: String? = nil, temperature: Double?? = nil, maxTokens: Int?? = nil
    ) {
        self.model = model
        self.title = title
        self.approvalMode = approvalMode
        self.allowedTools = allowedTools
        self.reasoningEffort = reasoningEffort
        self.instructions = instructions
        self.temperature = temperature
        self.maxTokens = maxTokens
    }

    private enum CodingKeys: String, CodingKey {
        case model, title, approvalMode, allowedTools, reasoningEffort, instructions, temperature, maxTokens
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(model, forKey: .model)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(approvalMode, forKey: .approvalMode)
        try c.encodeIfPresent(allowedTools, forKey: .allowedTools)
        try c.encodeIfPresent(reasoningEffort, forKey: .reasoningEffort)
        try c.encodeIfPresent(instructions, forKey: .instructions)
        // A double optional: absent leaves the field alone, an explicit null resets it.
        if let temperature { try c.encode(temperature, forKey: .temperature) }
        if let maxTokens { try c.encode(maxTokens, forKey: .maxTokens) }
    }
}

public enum ApprovalDecision: String, Sendable, Encodable {
    case approve
    case approveAlways = "approve_always"
    case deny
}
