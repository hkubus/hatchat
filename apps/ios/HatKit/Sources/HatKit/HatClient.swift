import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Where the server is and how to authenticate to it.
///
/// There is no login: the server accepts `HAT_AUTH_TOKEN` as a bearer
/// credential and exempts bearer requests from CSRF, so a native client needs
/// neither cookies nor the browser's double-submit token.
public struct HatConfig: Hashable, Sendable, Codable {
    /// Base URL of the hat server, e.g. `https://hat.tail1234.ts.net`.
    public var serverUrl: String
    /// `HAT_AUTH_TOKEN`, sent as a bearer token.
    public var token: String

    public init(serverUrl: String, token: String) {
        self.serverUrl = normalizeServerUrl(serverUrl)
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    public static let empty = HatConfig(serverUrl: "", token: "")
}

/// Trim, default the scheme, and drop trailing slashes.
///
/// A bare address gets `http://` only when it is on the local network (see
/// `isLocalNetworkHost`) and `https://` otherwise: iOS App Transport Security
/// refuses plain HTTP to public hosts, so guessing http for `hat.example.com`
/// would only produce an opaque failure. An explicit scheme is kept as typed.
public func normalizeServerUrl(_ raw: String) -> String {
    var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if value.isEmpty { return "" }
    let lower = value.lowercased()
    if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
        let host = URLComponents(string: "http://" + value)?.host ?? ""
        value = (isLocalNetworkHost(host) ? "http://" : "https://") + value
    }
    while value.hasSuffix("/") { value.removeLast() }
    return value
}

/// Whether a host is on the local network: loopback, an unqualified name
/// (`hat`, a Tailscale MagicDNS short name), `.local`, or a private,
/// link-local or carrier-grade-NAT (Tailscale) IP literal. These are where a
/// plain-HTTP server is plausible; `NSAllowsLocalNetworking` covers some of
/// them, and for the rest the ATS error below explains what to do.
public func isLocalNetworkHost(_ rawHost: String) -> Bool {
    var host = rawHost.lowercased()
    if host.hasPrefix("[") && host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
    if host.isEmpty { return false }
    if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return true }
    if host.contains(":") {
        // IPv6 literal: loopback, link-local (fe80::/10) or unique-local (fc00::/7).
        return host == "::1" || host.hasPrefix("fe8") || host.hasPrefix("fe9") || host.hasPrefix("fea")
            || host.hasPrefix("feb") || host.hasPrefix("fc") || host.hasPrefix("fd")
    }
    let octets = host.split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
    if octets.count == 4, octets.allSatisfy({ $0 != nil && (0...255).contains($0!) }) {
        let a = octets[0]!, b = octets[1]!
        return a == 127 || a == 10 || (a == 192 && b == 168) || (a == 172 && (16...31).contains(b))
            || (a == 169 && b == 254) || (a == 100 && (64...127).contains(b))
    }
    return !host.contains(".")
}

/// `NSURLErrorAppTransportSecurityRequiresSecureConnection`.
let atsBlockedCode = -1022

/// Replace the opaque ATS failure ("The resource could not be loaded because
/// the App Transport Security policy requires the use of a secure connection")
/// with one that says what to do. Other errors pass through unchanged.
public func explainTransportError(_ error: Error, url: URL?) -> Error {
    let ns = error as NSError
    guard ns.domain == NSURLErrorDomain, ns.code == atsBlockedCode else { return error }
    let host = url?.host ?? "the server"
    var https = "an https:// address"
    if let url, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
        components.scheme = "https"
        components.path = ""
        components.query = nil
        if let string = components.string { https = string }
    }
    return HatError(
        "iOS blocks plain HTTP to \(host) (App Transport Security). Connect over HTTPS instead, e.g. \(https) — "
            + "put the server behind TLS (Caddy, Traefik, or a Tailscale HTTPS certificate). "
            + "Plain HTTP only works for local-network addresses such as .local names."
    )
}

/// Carries the HTTP status so callers can tell "gone" from "unreachable".
public struct HttpError: Error, LocalizedError, Sendable {
    public var status: Int
    public var path: String
    /// The server's own `{ "error": "…" }` sentence, when it sent one.
    public var reason: String?

    public var errorDescription: String? {
        if let reason, !reason.isEmpty { return reason }
        return "\(path): \(status)"
    }
}

/// A client-side problem worth showing as it is (a rejected file, a bad URL).
public struct HatError: Error, LocalizedError, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// A file to upload: an image or a document picked on-device.
public struct UploadFile: Sendable {
    public var data: Data
    public var name: String
    public var mime: String

    public init(data: Data, name: String, mime: String) {
        self.data = data
        self.name = name
        self.mime = mime
    }
}

/// The image types the server accepts. It reads dimensions from the file header
/// with no native image dependency, so anything else comes back as a 415 —
/// which matters on iOS, where most camera-roll photos are HEIC.
public let acceptedImageTypes: Set<String> = ["image/png", "image/jpeg", "image/gif", "image/webp"]

public func isAcceptedImageType(_ type: String?) -> Bool {
    acceptedImageTypes.contains(type ?? "")
}

/// The server's upload cap, checked up front so a huge file fails before the upload.
public let maxUploadBytes = 25 * 1024 * 1024

/// Typed client for the hat server: `apps/web/src/api.ts` reduced to what a
/// native client needs.
///
/// Turn streams are read through a `URLSessionDataDelegate`, which hands over
/// each chunk as it arrives, rather than `bytes(for:)`, which Linux Foundation
/// lacks. That keeps the whole client testable against a real server from
/// `swift test`.
///
/// Cancelling the task that reads a stream closes the socket, but it does
/// **not** stop the turn: a turn outlives its connection so that it survives
/// the app being suspended. Stopping is `cancelTurn`.
public final class HatClient: @unchecked Sendable {
    public let config: HatConfig
    private let session: URLSession
    private let onUnauthorized: (@Sendable () -> Void)?

    public init(config: HatConfig, onUnauthorized: (@Sendable () -> Void)? = nil) {
        self.config = config
        self.onUnauthorized = onUnauthorized
        let configuration = URLSessionConfiguration.default
        // Nothing here is cacheable except attachments, which are cached by id.
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        self.session = URLSession(configuration: configuration)
    }

    // MARK: Plumbing

    func url(_ path: String) throws -> URL {
        guard let url = URL(string: config.serverUrl + path) else {
            throw HatError("“\(config.serverUrl)” is not a valid server address.")
        }
        return url
    }

    func request(_ path: String, method: String = "GET", json body: (any Encodable)? = nil) throws -> URLRequest {
        var request = URLRequest(url: try url(path))
        request.httpMethod = method
        if !config.token.isEmpty {
            request.setValue("Bearer \(config.token)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(AnyEncodable(body))
        }
        return request
    }

    /// Send, and turn a non-2xx answer into an `HttpError`. A 401 anywhere means
    /// the token was rotated server-side, which the app handles once, globally.
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await data(for: request)
        let http = response as! HTTPURLResponse
        if http.statusCode == 401 { onUnauthorized?() }
        guard (200..<300).contains(http.statusCode) else {
            throw HttpError(status: http.statusCode, path: request.url?.path ?? "", reason: HatClient.reason(in: data))
        }
        return (data, http)
    }

    func get<T: Decodable>(_ path: String, as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await send(try request(path))
        return try JSONDecoder().decode(T.self, from: data)
    }

    func call<T: Decodable>(_ path: String, _ method: String, json body: (any Encodable)? = nil, as type: T.Type = T.self) async throws -> T {
        let (data, _) = try await send(try request(path, method: method, json: body))
        return try JSONDecoder().decode(T.self, from: data)
    }

    func call(_ path: String, _ method: String, json body: (any Encodable)? = nil) async throws {
        _ = try await send(try request(path, method: method, json: body))
    }

    /// `session.data(for:)` with ATS failures made readable.
    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        do {
            return try await session.data(for: request)
        } catch {
            throw explainTransportError(error, url: request.url)
        }
    }

    static func reason(in data: Data) -> String? {
        struct Body: Decodable { var error: String? }
        return (try? JSONDecoder().decode(Body.self, from: data))?.error
    }

    static func escape(_ component: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return component.addingPercentEncoding(withAllowedCharacters: allowed) ?? component
    }

    // MARK: Connection

    /// Probe a candidate server before saving it, so the connect screen can
    /// tell "wrong URL" from "wrong token" instead of failing on the first send.
    public static func probe(_ config: HatConfig) async throws {
        let client = HatClient(config: config)
        var request = try client.request("/api/health")
        request.timeoutInterval = 15
        let (_, response) = try await client.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw HatError("That server wants a different token.") }
        guard (200..<300).contains(status) else { throw HatError("Server replied \(status).") }
    }

    // MARK: Meta

    public func tools() async throws -> [String] {
        struct R: Decodable { var tools: [String] }
        return try await get("/api/tools", as: R.self).tools
    }

    public func models() async throws -> [ModelInfo] {
        struct R: Decodable { var models: [ModelInfo] }
        return try await get("/api/models", as: R.self).models
    }

    public func runners() async throws -> [RunnerSummary] {
        struct R: Decodable { var runners: [RunnerSummary] }
        return try await get("/api/runners", as: R.self).runners
    }

    // MARK: Providers, secrets and plugins

    public func providers() async throws -> [ProviderStatus] {
        struct R: Decodable { var providers: [ProviderStatus] }
        return try await get("/api/providers", as: R.self).providers
    }

    public func setSecret(name: String, value: String) async throws {
        struct Body: Encodable { var name: String; var value: String }
        try await call("/api/secrets", "POST", json: Body(name: name, value: value))
    }

    public func deleteSecret(name: String) async throws {
        try await call("/api/secrets/\(HatClient.escape(name))", "DELETE")
    }

    public func plugins() async throws -> [PluginDescriptor] {
        struct R: Decodable { var plugins: [PluginDescriptor] }
        return try await get("/api/plugins", as: R.self).plugins
    }

    @discardableResult
    public func setPluginEnabled(id: String, enabled: Bool) async throws -> PluginDescriptor {
        struct Body: Encodable { var enabled: Bool }
        struct R: Decodable { var plugin: PluginDescriptor }
        return try await call("/api/plugins/\(HatClient.escape(id))/enable", "POST", json: Body(enabled: enabled), as: R.self).plugin
    }

    @discardableResult
    public func setPluginConfig(id: String, config: [String: JSONValue]) async throws -> PluginDescriptor {
        struct Body: Encodable { var config: [String: JSONValue] }
        struct R: Decodable { var plugin: PluginDescriptor }
        return try await call("/api/plugins/\(HatClient.escape(id))/config", "PUT", json: Body(config: config), as: R.self).plugin
    }

    // MARK: Sessions

    public func createSession(model: String) async throws -> SessionPayload {
        struct Body: Encodable { var model: String }
        return try await call("/api/sessions", "POST", json: Body(model: model))
    }

    public func session(id: String) async throws -> SessionPayload {
        try await get("/api/sessions/\(HatClient.escape(id))")
    }

    public func sessions() async throws -> [SessionSummary] {
        struct R: Decodable { var sessions: [SessionSummary] }
        return try await get("/api/sessions", as: R.self).sessions
    }

    public func updateSession(id: String, _ patch: SessionPatch) async throws -> SessionRecord {
        struct R: Decodable { var session: SessionRecord }
        return try await call("/api/sessions/\(HatClient.escape(id))", "PATCH", json: patch, as: R.self).session
    }

    public func deleteSession(id: String) async throws {
        try await call("/api/sessions/\(HatClient.escape(id))", "DELETE")
    }

    /// A new conversation holding this one's path up to and including `messageId`.
    public func forkSession(id: String, messageId: String) async throws -> SessionPayload {
        struct Body: Encodable { var messageId: String }
        return try await call("/api/sessions/\(HatClient.escape(id))/fork", "POST", json: Body(messageId: messageId))
    }

    /// The active branch as a readable Markdown transcript.
    public func exportMarkdown(id: String) async throws -> String {
        let (data, _) = try await send(try request("/api/sessions/\(HatClient.escape(id))/export?format=markdown"))
        return String(decoding: data, as: UTF8.self)
    }

    /// Full-text search over every conversation's messages.
    public func search(_ query: String) async throws -> [SearchHit] {
        struct R: Decodable { var hits: [SearchHit] }
        return try await get("/api/search?q=\(HatClient.escape(query))", as: R.self).hits
    }

    /// Make the branch through `messageId` the active one. The server follows it
    /// down to its newest leaf, so any message on a branch will do.
    public func selectBranch(sessionId: String, messageId: String) async throws -> SessionPayload {
        struct Body: Encodable { var messageId: String }
        return try await call("/api/sessions/\(HatClient.escape(sessionId))/select", "POST", json: Body(messageId: messageId))
    }

    // MARK: Approvals and questions

    /// Resolve a pending tool call. The server binds an approval to the session
    /// that asked for it, so a stale card cannot approve another conversation's call.
    public func resolveApproval(callId: String, decision: ApprovalDecision, sessionId: String) async throws {
        struct Body: Encodable { var decision: ApprovalDecision; var sessionId: String }
        try await call("/api/approvals/\(HatClient.escape(callId))", "POST", json: Body(decision: decision, sessionId: sessionId))
    }

    /// Answer an `ask_user` call. A 404 means it is no longer pending.
    public func answerQuestion(callId: String, answer: String, sessionId: String) async throws {
        struct Body: Encodable { var sessionId: String; var answer: String }
        try await call("/api/questions/\(HatClient.escape(callId))", "POST", json: Body(sessionId: sessionId, answer: answer))
    }

    // MARK: Attachments

    /// Upload an image or document. The server dedupes by sha256 and answers
    /// with an id the turn refers to. Its 413/415/422 answers carry a sentence
    /// worth showing ("this PDF has no extractable text"), which becomes the error.
    public func upload(_ file: UploadFile) async throws -> AttachmentRecord {
        if file.mime.hasPrefix("image/") && !isAcceptedImageType(file.mime) {
            throw HatError("\(file.name) is \(file.mime). The server accepts PNG, JPEG, GIF, and WebP — re-share the photo as JPEG.")
        }
        let boundary = "hat-\(UUID().uuidString)"
        var body = Data()
        let name = file.name.replacingOccurrences(of: "\"", with: "'").replacingOccurrences(of: "\r", with: " ").replacingOccurrences(of: "\n", with: " ")
        body.append(Data("--\(boundary)\r\n".utf8))
        body.append(Data("Content-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\n".utf8))
        body.append(Data("Content-Type: \(file.mime)\r\n\r\n".utf8))
        body.append(file.data)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))

        var request = try request("/api/attachments", method: "POST")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        do {
            struct R: Decodable { var attachment: AttachmentRecord }
            let (data, _) = try await send(request)
            return try JSONDecoder().decode(R.self, from: data).attachment
        } catch let error as HttpError where error.reason != nil {
            throw HatError("\(file.name): \(error.reason!)")
        }
    }

    /// Download a stored attachment. Views cannot fetch it themselves because
    /// the request has to carry the bearer token.
    public func attachment(id: String) async throws -> (data: Data, mime: String) {
        let (data, response) = try await send(try request("/api/attachments/\(HatClient.escape(id))"))
        return (data, response.value(forHTTPHeaderField: "Content-Type") ?? "application/octet-stream")
    }

    // MARK: Turns

    /// Actually stop a turn — the Stop button. Closing the stream alone would
    /// only detach this viewer while the model kept generating (and billing).
    public func cancelTurn(sessionId: String) async throws {
        try await call("/api/sessions/\(HatClient.escape(sessionId))/turn/cancel", "POST")
    }

    /// Send a user message and stream the turn. `attachmentNames` carries each
    /// document's name by id: content is stored by hash, so a deduplicated
    /// upload would otherwise show the name it was first uploaded as.
    public func sendTurn(
        sessionId: String, text: String, model: String, attachmentIds: [String],
        attachmentNames: [String: String], onEvent: @escaping @Sendable (KernelEvent) async -> Void
    ) async throws {
        struct Body: Encodable {
            var text: String
            var model: String
            var attachmentIds: [String]
            var attachmentNames: [String: String]
        }
        let body = Body(text: text, model: model, attachmentIds: attachmentIds, attachmentNames: attachmentNames)
        _ = try await stream(try request("/api/sessions/\(HatClient.escape(sessionId))/turn", method: "POST", json: body), onEvent: onEvent)
    }

    /// Continue a reply cut off at the output limit. The server sends a hidden
    /// "continue" message and streams the rest as a normal turn.
    public func continueTurn(sessionId: String, onEvent: @escaping @Sendable (KernelEvent) async -> Void) async throws {
        struct Body: Encodable {}
        _ = try await stream(try request("/api/sessions/\(HatClient.escape(sessionId))/continue", method: "POST", json: Body()), onEvent: onEvent)
    }

    public func regenerate(sessionId: String, messageId: String, onEvent: @escaping @Sendable (KernelEvent) async -> Void) async throws {
        struct Body: Encodable { var messageId: String }
        _ = try await stream(try request("/api/sessions/\(HatClient.escape(sessionId))/regenerate", method: "POST", json: Body(messageId: messageId)), onEvent: onEvent)
    }

    public func editMessage(sessionId: String, messageId: String, text: String, onEvent: @escaping @Sendable (KernelEvent) async -> Void) async throws {
        struct Body: Encodable { var messageId: String; var text: String }
        _ = try await stream(try request("/api/sessions/\(HatClient.escape(sessionId))/edit", method: "POST", json: Body(messageId: messageId, text: text)), onEvent: onEvent)
    }

    /// Follow a turn already running for a session — what makes the app survive
    /// being suspended mid-answer. Returns false when the session is idle (204).
    @discardableResult
    public func followTurn(sessionId: String, onEvent: @escaping @Sendable (KernelEvent) async -> Void) async throws -> Bool {
        var request = try request("/api/sessions/\(HatClient.escape(sessionId))/stream")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        return try await stream(request, onEvent: onEvent) != 204
    }

    /// Run a streaming request to the end, handing each decoded event to
    /// `onEvent` in order. Returns the HTTP status (204 means nothing to follow).
    /// Cancelling the calling task closes the connection.
    func stream(_ request: URLRequest, onEvent: @escaping @Sendable (KernelEvent) async -> Void) async throws -> Int {
        var request = request
        // A turn paused on an approval can sit silent for a long time; the
        // server's keepalive comments are what keep it from timing out.
        request.timeoutInterval = 24 * 60 * 60
        let connection = SSEConnection(request: request)
        return try await withTaskCancellationHandler {
            let status: Int
            do {
                status = try await connection.start()
            } catch let error as HttpError {
                if error.status == 401 { onUnauthorized?() }
                throw error
            }
            for try await event in connection.events {
                await onEvent(event)
            }
            return status
        } onCancel: {
            connection.cancel()
        }
    }
}

/// One streaming request, bridged from delegate callbacks to async/await.
final class SSEConnection: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    let events: AsyncThrowingStream<KernelEvent, Error>
    private let continuation: AsyncThrowingStream<KernelEvent, Error>.Continuation
    private let request: URLRequest
    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionDataTask?
    private var responseWaiter: CheckedContinuation<Int, Error>?
    private var parser = SSEFrameParser()
    private var status = 0
    private var errorBody = Data()
    private var cancelled = false

    init(request: URLRequest) {
        self.request = request
        (events, continuation) = AsyncThrowingStream.makeStream()
        super.init()
    }

    /// Open the connection and wait for the response head. Resolves with the
    /// status for 2xx answers; anything else throws once its body is in.
    func start() async throws -> Int {
        try await withCheckedThrowingContinuation { waiter in
            lock.lock()
            if cancelled {
                lock.unlock()
                waiter.resume(throwing: CancellationError())
                return
            }
            responseWaiter = waiter
            let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
            let task = session.dataTask(with: request)
            self.session = session
            self.task = task
            lock.unlock()
            task.resume()
        }
    }

    func cancel() {
        lock.lock()
        cancelled = true
        let task = self.task
        let waiter = responseWaiter
        responseWaiter = nil
        lock.unlock()
        task?.cancel()
        waiter?.resume(throwing: CancellationError())
        continuation.finish(throwing: CancellationError())
    }

    private var ok: Bool { (200..<300).contains(status) }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void) {
        lock.lock()
        status = (response as? HTTPURLResponse)?.statusCode ?? 0
        // A failure is only reported once its body (the server's reason) is in.
        let waiter = ok ? responseWaiter : nil
        if ok { responseWaiter = nil }
        let code = status
        lock.unlock()
        waiter?.resume(returning: code)
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        guard ok else {
            errorBody.append(data)
            lock.unlock()
            return
        }
        let payloads = parser.push(data)
        lock.unlock()
        for payload in payloads {
            if let event = decodeFrame(payload) { continuation.yield(event) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let waiter = responseWaiter
        responseWaiter = nil
        let wasCancelled = cancelled
        let tail = ok ? parser.flush() : []
        let failure: Error? = if wasCancelled {
            CancellationError()
        } else if let error {
            explainTransportError(error, url: request.url)
        } else if !ok {
            HttpError(status: status, path: request.url?.path ?? "", reason: HatClient.reason(in: errorBody))
        } else {
            nil
        }
        lock.unlock()
        session.finishTasksAndInvalidate()

        // Flush whatever is left, so a final frame is not lost when the stream
        // ends without its terminator.
        for payload in tail {
            if let event = decodeFrame(payload) { continuation.yield(event) }
        }
        if let failure {
            waiter?.resume(throwing: failure)
            continuation.finish(throwing: failure)
        } else {
            waiter?.resume(returning: status)
            continuation.finish()
        }
    }
}

/// Lets a heterogeneous `any Encodable` go through `JSONEncoder`.
private struct AnyEncodable: Encodable {
    let value: any Encodable
    init(_ value: any Encodable) { self.value = value }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}

/// The image type from a file's leading bytes, when it is one the server
/// accepts. Photo pickers report types loosely (and HEIC often hides behind a
/// generic image type), so the bytes are the reliable answer.
public func sniffImageMime(_ data: Data) -> String? {
    let bytes = [UInt8](data.prefix(12))
    if bytes.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return "image/png" }
    if bytes.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
    if bytes.starts(with: Array("GIF8".utf8)) { return "image/gif" }
    if bytes.count >= 12, bytes.starts(with: Array("RIFF".utf8)), Array(bytes[8..<12]) == Array("WEBP".utf8) {
        return "image/webp"
    }
    return nil
}
