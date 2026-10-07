import Foundation
import CorptieClientCore
import OSLog

/// Deliberately excludes localized descriptions, URLs, bodies and credentials.
public enum ConnectionDiagnostic {
    /// WebSocket close reasons are remotely supplied. Only fixed protocol
    /// reasons may be logged; never emit arbitrary close text.
    public static func closeReason(_ data: Data?) -> String {
        guard let data, data.count <= 120, let reason = String(data: data, encoding: .utf8) else { return "absent" }
        let known = ["unknown relay connection", "relay peer is offline", "relay backpressure limit reached",
            "invalid encrypted frame header", "sender is not part of relay connection",
            "account relay connection limit reached", "peer disconnected", "device revoked", "account revoked"]
        return known.contains(reason) ? reason : "unclassified"
    }
    public static func failure(_ error: any Error) -> String {
        if error is CancellationError { return "cancelled" }
        if let error = error as? URLError { return "url:\(error.code.rawValue)" }
        if let error = error as? CloudRelayTransportError { return "relay:\(error)" }
        if let error = error as? CloudRelayCryptoError { return "crypto:\(error)" }
        if error is DecodingError { return "protocol-decode" }
        if error as? CloudOAuthRefreshError == .invalidGrant { return "oauth:invalid-grant" }
        if let error = error as? CredentialVaultError {
            if case .keychain(let status) = error { return "keychain:\(status)" }
            return "keychain:invalid-identity"
        }
        if let error = error as? ClientServiceFailure {
            let known = ["LOCAL_BACKEND_UNAVAILABLE", "DEVICE_REVOKED", "INVALID_CREDENTIAL", "ROUTE_NOT_AVAILABLE", "RATE_LIMITED", "DEVICE_AUTH_REQUIRED",
                "IMAGE_SIZE_LIMIT", "IMAGE_UPLOAD_REQUIRES_HOST_UPDATE", "IMAGE_CAPABILITY_UNSUPPORTED",
                "INVALID_IMAGE_UPLOAD", "INVALID_IMAGE_CHUNK", "IMAGE_UPLOAD_OFFSET_CONFLICT",
                "IMAGE_UPLOAD_HASH_MISMATCH", "IMAGE_UPLOAD_INCOMPLETE", "IMAGE_UPLOAD_STORAGE_FULL",
                "CHAT_IMAGE_FORMAT_UNSUPPORTED", "CHAT_IMAGE_SIZE_INVALID", "BODY_TOO_LARGE"]
            return "http:\(error.statusCode):\(known.contains(error.code) ? error.code : "other")"
        }
        if let error = error as? ClientConnectionError {
            if case .httpStatus(let status) = error { return "http:\(status)" }
            return error == .invalidCredential ? "invalidCredential" : "clientConnection"
        }
        return "unclassified"
    }
}

public enum CloudRelayTransportError: Error, Equatable, Sendable {
    case invalidControlMessage
    case invalidApplicationMessage
    case disconnected
    case responseTooLarge
    case unsupportedRequest
}

public protocol CloudRelaySecureChannel: Sendable {
    func send(_ plaintext: Data) async throws
    func receive() async throws -> Data
    func close() async
}

struct CloudRelaySSEBuffer {
    private(set) var remainder = Data()
    private var suffix: UInt32 = 0
    mutating func append(_ byte: UInt8) -> Data? {
        remainder.append(byte)
        suffix = (suffix << 8) | UInt32(byte)
        guard remainder.count >= 16 * 1024 || suffix & 0xffff == 0x0a0a || suffix == 0x0d0a0d0a else { return nil }
        let event = remainder
        remainder = Data()
        return event
    }
}

/// Only exact connection IDs previously owned by this agent can be ignored.
struct CloudRelayClosedConnectionWindow {
    private(set) var entries: [UUID: Date] = [:]
    mutating func record(_ id: UUID, at now: Date = Date()) {
        entries = entries.filter { $0.value > now }
        entries[id] = now.addingTimeInterval(60)
        if entries.count > 256, let oldest = entries.min(by: { $0.value < $1.value })?.key {
            entries.removeValue(forKey: oldest)
        }
    }
    func contains(_ id: UUID, at now: Date = Date()) -> Bool {
        entries[id].map { $0 > now && $0.timeIntervalSince(now) <= 60 } ?? false
    }
}

public struct CloudRelayApplicationMessage: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable { case request, response, chunk, cancel }
    public let kind: Kind
    public let id: UUID
    public let method: String?
    public let path: String?
    public let headers: [String: String]?
    public let status: Int?
    public let body: Data?
    public let final: Bool?

    public static func request(id: UUID, method: String, path: String, headers: [String: String], body: Data? = nil, final: Bool = true) -> Self {
        .init(kind: .request, id: id, method: method, path: path, headers: headers, status: nil, body: body, final: final)
    }

    public static func response(id: UUID, status: Int, headers: [String: String]) -> Self {
        .init(kind: .response, id: id, method: nil, path: nil, headers: headers, status: status, body: nil, final: nil)
    }

    public static func chunk(id: UUID, body: Data, final: Bool) -> Self {
        .init(kind: .chunk, id: id, method: nil, path: nil, headers: nil, status: nil, body: body, final: final)
    }

    public static func cancel(id: UUID) -> Self {
        .init(kind: .cancel, id: id, method: nil, path: nil, headers: nil, status: nil, body: nil, final: nil)
    }
}

public actor CloudRelayHTTPClient {
    public static let maximumRequestBytes = 8 * 1_024 * 1_024
    public static let maximumResponseBytes = 16 * 1_024 * 1_024
    public static let maximumChunkBytes = 16 * 1_024

    private struct PendingData {
        let url: URL
        var response: HTTPURLResponse?
        var body = Data()
        let continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>
    }

    private struct PendingStream {
        let url: URL
        var response: HTTPURLResponse?
        let head: CheckedContinuation<(BackendByteStream, HTTPURLResponse), Error>
        let bytes: BackendByteStream
        let stream: AsyncThrowingStream<Data, Error>.Continuation
        let idleTimeout: TimeInterval
        var lastActivity = ContinuousClock.now
        var receivedBytes = 0
    }

    private enum Pending { case data(PendingData), stream(PendingStream) }

    private let endpoint: BackendEndpoint
    private let channel: any CloudRelaySecureChannel
    private let diagnosticID = UUID()
    private static let log = Logger(subsystem: "com.corptie.connection", category: "MobileRelayHTTP")
    private var pending: [UUID: Pending] = [:]
    private var receiver: Task<Void, Never>?
    private var terminalError: Error?
    private var deadlines: [UUID: Task<Void, Never>] = [:]

    public init(endpoint: BackendEndpoint, channel: any CloudRelaySecureChannel) {
        self.endpoint = endpoint
        self.channel = channel
    }

    deinit { receiver?.cancel(); for task in deadlines.values { task.cancel() } }

    public func isUsable() -> Bool { terminalError == nil }

    public nonisolated func transport() -> BackendTransport {
        BackendTransport(endpoint: endpoint, data: { [weak self] request in
            guard let self else { throw CloudRelayTransportError.disconnected }
            return try await self.data(for: request)
        }, bytes: { [weak self] request in
            guard let self else { throw CloudRelayTransportError.disconnected }
            return try await self.bytes(for: request)
        })
    }

    public func close() async {
        receiver?.cancel()
        receiver = nil
        await channel.close()
        failAll(CloudRelayTransportError.disconnected)
    }

    private func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try startReceiver()
        let messages = try makeRequest(request)
        let message = messages[0]
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[message.id] = .data(PendingData(url: request.url!, continuation: continuation))
                Self.log.debug("Request start: channel=\(self.diagnosticID, privacy: .public) request=\(message.id, privacy: .public) kind=data")
                armDeadline(message.id, seconds: min(30, request.timeoutInterval))
                Task { await self.send(messages) }
            }
        } onCancel: { Task { await self.cancel(message.id) } }
    }

    private func bytes(for request: URLRequest) async throws -> (BackendByteStream, HTTPURLResponse) {
        try startReceiver()
        let messages = try makeRequest(request)
        let message = messages[0]
        // A state snapshot can arrive as many Relay frames before the UI starts
        // consuming. Buffer chunks, not individual bytes, to keep memory bounded.
        let pair = AsyncThrowingStream<Data, Error>.makeStream(bufferingPolicy: .bufferingOldest(512))
        pair.continuation.onTermination = { [weak self] _ in
            Task { await self?.cancel(message.id) }
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[message.id] = .stream(PendingStream(
                    url: request.url!, head: continuation,
                    bytes: BackendByteStream(chunks: pair.stream), stream: pair.continuation,
                    idleTimeout: min(35, request.timeoutInterval)
                ))
                armDeadline(message.id, seconds: min(10, request.timeoutInterval))
                Self.log.info("Stream start: channel=\(self.diagnosticID, privacy: .public) request=\(message.id, privacy: .public)")
                Task { await self.send(messages) }
            }
        } onCancel: { Task { await self.cancel(message.id) } }
    }

    private func startReceiver() throws {
        if let terminalError { throw terminalError }
        guard receiver == nil else { return }
        receiver = Task { [weak self] in
            guard let self else { return }
            do {
                while !Task.isCancelled { try await self.consume(self.channel.receive()) }
            } catch is CancellationError { await self.failAll(CancellationError()) }
            catch { await self.failAll(error) }
        }
    }

    private func send(_ messages: [CloudRelayApplicationMessage]) async {
        guard let id = messages.first?.id else { return }
        do {
            for message in messages {
                guard pending[id] != nil else { return }
                try Task.checkCancellation()
                try await channel.send(try JSONEncoder().encode(message))
                await Task.yield()
            }
        }
        catch { fail(id, error) }
    }

    private func cancel(_ id: UUID) async {
        guard pending[id] != nil else { return }
        fail(id, CancellationError())
        try? await channel.send(JSONEncoder().encode(CloudRelayApplicationMessage.cancel(id: id)))
    }

    private func consume(_ payload: Data) throws {
        let message = try JSONDecoder().decode(CloudRelayApplicationMessage.self, from: payload)
        guard var current = pending[message.id] else { return }
        switch (message.kind, current) {
        case (.response, .data(var value)):
            Self.log.debug("Response head: request=\(message.id, privacy: .public) status=\(message.status ?? 0)")
            value.response = try response(message, url: value.url)
            current = .data(value)
        case (.response, .stream(var value)):
            Self.log.info("Stream head: request=\(message.id, privacy: .public) status=\(message.status ?? 0)")
            value.lastActivity = .now
            let response = try response(message, url: value.url)
            value.response = response
            value.head.resume(returning: (value.bytes, response))
            current = .stream(value)
            armDeadline(message.id, seconds: value.idleTimeout)
        case (.chunk, .data(var value)):
            guard value.response != nil, let body = message.body, let final = message.final else { throw CloudRelayTransportError.invalidApplicationMessage }
            guard value.body.count + body.count <= Self.maximumResponseBytes else {
                fail(message.id, CloudRelayTransportError.responseTooLarge); return
            }
            value.body.append(body)
            if final {
                pending.removeValue(forKey: message.id)
                deadlines.removeValue(forKey: message.id)?.cancel()
                value.continuation.resume(returning: (value.body, value.response!))
                return
            }
            current = .data(value)
        case (.chunk, .stream(var value)):
            guard value.response != nil, let body = message.body, let final = message.final else { throw CloudRelayTransportError.invalidApplicationMessage }
            armDeadline(message.id, seconds: value.idleTimeout)
            value.lastActivity = .now
            value.receivedBytes += body.count
            current = .stream(value)
            for start in stride(from: 0, to: body.count, by: 16 * 1_024) {
                let end = min(body.count, start + 16 * 1_024)
                if case .dropped = value.stream.yield(body.subdata(in: start..<end)) {
                    fail(message.id, CloudRelayTransportError.responseTooLarge); return
                }
            }
            if final {
                pending.removeValue(forKey: message.id)
                deadlines.removeValue(forKey: message.id)?.cancel()
                value.stream.finish()
                return
            }
        default: throw CloudRelayTransportError.invalidApplicationMessage
        }
        pending[message.id] = current
    }

    private func response(_ message: CloudRelayApplicationMessage, url: URL) throws -> HTTPURLResponse {
        guard let status = message.status, (100...599).contains(status),
              let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: message.headers ?? [:]) else {
            throw CloudRelayTransportError.invalidApplicationMessage
        }
        return response
    }

    private func makeRequest(_ request: URLRequest) throws -> [CloudRelayApplicationMessage] {
        guard let url = request.url, endpoint.contains(url), let method = request.httpMethod,
              ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method),
              request.httpBodyStream == nil else { throw CloudRelayTransportError.unsupportedRequest }
        let body = request.httpBody
        guard (body?.count ?? 0) <= Self.maximumRequestBytes else { throw CloudRelayTransportError.unsupportedRequest }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        components.scheme = nil; components.host = nil; components.port = nil; components.user = nil; components.password = nil; components.fragment = nil
        guard let path = components.string, path.hasPrefix("/"), path.utf8.count <= 8_192 else { throw CloudRelayTransportError.unsupportedRequest }
        let allowed = Set(["accept", "content-type", "if-none-match", "if-match", "last-event-id", "x-corptie-request-id"])
        let headers = (request.allHTTPHeaderFields ?? [:]).reduce(into: [String: String]()) { result, entry in
            let name = entry.key.lowercased()
            if allowed.contains(name) { result[name] = entry.value }
        }
        let id = UUID()
        guard let body, !body.isEmpty else {
            return [.request(id: id, method: method, path: path, headers: headers)]
        }
        var messages = [CloudRelayApplicationMessage.request(
            id: id, method: method, path: path, headers: headers, final: false
        )]
        var offset = 0
        while offset < body.count {
            let end = min(body.count, offset + Self.maximumChunkBytes)
            messages.append(.chunk(id: id, body: body.subdata(in: offset..<end), final: end == body.count))
            offset = end
        }
        return messages
    }

    private func fail(_ id: UUID, _ error: Error) {
        deadlines.removeValue(forKey: id)?.cancel()
        guard let value = pending.removeValue(forKey: id) else { return }
        Self.log.info("Request ended: channel=\(self.diagnosticID, privacy: .public) request=\(id, privacy: .public) reason=\(ConnectionDiagnostic.failure(error), privacy: .public)")
        switch value {
        case .data(let pending): pending.continuation.resume(throwing: error)
        case .stream(let pending):
            if pending.response == nil { pending.head.resume(throwing: error) }
            pending.stream.finish(throwing: error)
        }
    }

    private func armDeadline(_ id: UUID, seconds: TimeInterval) {
        deadlines.removeValue(forKey: id)?.cancel()
        deadlines[id] = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0.01, seconds))) }
            catch { return }
            guard let self else { return }
            await self.expire(id)
        }
    }

    private func expire(_ id: UUID) async {
        guard let value = pending[id] else { return }
        switch value {
        case .data:
            Self.log.error("Deadline: request=\(id, privacy: .public) phase=data")
        case .stream(let stream):
            Self.log.error("Deadline: request=\(id, privacy: .public) phase=\(stream.response == nil ? "stream-head" : "stream-idle", privacy: .public) receivedBytes=\(stream.receivedBytes) lastActivityAgo=\(String(describing: stream.lastActivity.duration(to: .now)), privacy: .public)")
        }
        fail(id, URLError(.timedOut))
        try? await channel.send(JSONEncoder().encode(CloudRelayApplicationMessage.cancel(id: id)))
    }

    private func failAll(_ error: Error) {
        Self.log.info("Channel ended: channel=\(self.diagnosticID, privacy: .public) pending=\(self.pending.count) reason=\(ConnectionDiagnostic.failure(error), privacy: .public)")
        terminalError = error
        let ids = Array(pending.keys)
        for id in ids { fail(id, error) }
    }
}

public actor CloudRelayMobileChannel: CloudRelaySecureChannel {
    private static let log = Logger(subsystem: "com.corptie.connection", category: "MobileRelaySocket")
    private struct Control: Decodable {
        struct Peer: Decodable {
            let id: UUID
            let displayName: String
            let publicKey: String
        }
        let type: String
        let connectionId: UUID?
        let deviceId: UUID?
        let peer: Peer?
        let reason: String?
    }

    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let cipher: CloudRelayCipherSession

    private init(session: URLSession, socket: URLSessionWebSocketTask, cipher: CloudRelayCipherSession) {
        self.session = session
        self.socket = socket
        self.cipher = cipher
    }

    public static func connect(
        cloudEndpoint: BackendEndpoint,
        accessToken: String,
        deviceID: UUID,
        targetMacID: UUID,
        deviceKey: CloudRelayDeviceKey
    ) async throws -> CloudRelayMobileChannel {
        let started = ContinuousClock.now
        Self.log.info("Connect started")
        var components = URLComponents(url: cloudEndpoint.baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/relay"
        components.queryItems = [URLQueryItem(name: "deviceId", value: deviceID.uuidString.lowercased())]
        guard let url = components.url else { throw CloudRelayTransportError.invalidControlMessage }
        var request = URLRequest(url: url)
        request.timeoutInterval = 10
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral, delegate: CloudRelayWebSocketDelegate(), delegateQueue: nil)
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 512 * 1_024
        socket.resume()
        // Bound all relay control/crypto handshake stages, not just URL loading.
        let deadline = Task {
            do { try await Task.sleep(for: .seconds(10)) } catch { return }
            socket.cancel(with: .goingAway, reason: nil)
            session.invalidateAndCancel()
        }
        defer { deadline.cancel() }
        do {
            return try await withTaskCancellationHandler {
            let ready = try await receiveControl(socket)
            guard ready.type == "ready" else { throw CloudRelayTransportError.invalidControlMessage }
            Self.log.info("Cloud socket ready: elapsed=\(String(describing: started.duration(to: .now)), privacy: .public)")
            let connect = try JSONSerialization.data(withJSONObject: [
                "type": "connect", "targetDeviceId": targetMacID.uuidString.lowercased(), "requestId": UUID().uuidString
            ])
            try await socket.send(.string(String(decoding: connect, as: UTF8.self)))
            let connected = try await receiveControl(socket)
            guard connected.type == "connected", let connectionID = connected.connectionId,
                  let encodedKey = connected.peer?.publicKey, let peerKey = Data(base64Encoded: encodedKey) else {
                throw CloudRelayTransportError.invalidControlMessage
            }
            let handshake = try CloudRelayHandshake(
                connectionID: connectionID, role: .mobile,
                staticPrivateKey: deviceKey.privateKey, peerStaticPublicKeyData: peerKey
            )
            try await socket.send(.data(routingHeader(connectionID) + handshake.makeHello()))
            let peerFrame = try await receiveBinary(socket)
            guard peerFrame.count == 17 + 67, peerFrame.prefix(17) == routingHeader(connectionID) else {
                throw CloudRelayCryptoError.invalidHello
            }
            let cipher = try handshake.complete(peerHello: Data(peerFrame.dropFirst(17)))
            Self.log.info("E2E handshake ready: connection=\(connectionID, privacy: .public) elapsed=\(String(describing: started.duration(to: .now)), privacy: .public)")
            try Task.checkCancellation()
            return CloudRelayMobileChannel(session: session, socket: socket, cipher: cipher)
            } onCancel: {
                socket.cancel(with: .goingAway, reason: nil)
                session.invalidateAndCancel()
            }
        } catch {
            let status = (socket.response as? HTTPURLResponse)?.statusCode
            Self.log.error("Connect failed: http=\(status ?? 0) closeCode=\(socket.closeCode.rawValue) elapsed=\(String(describing: started.duration(to: .now)), privacy: .public) reason=\(ConnectionDiagnostic.failure(error), privacy: .public)")
            socket.cancel(with: .protocolError, reason: nil)
            session.invalidateAndCancel()
            if status == 401 || status == 403 { throw ClientConnectionError.httpStatus(status!) }
            throw error
        }
    }

    public func send(_ plaintext: Data) async throws {
        try await socket.send(.data(try await cipher.seal(plaintext)))
    }

    public func receive() async throws -> Data {
        do {
            while true {
                switch try await socket.receive() {
                case .data(let data): return try await cipher.open(data)
                case .string(let value):
                    if let control = try? JSONDecoder().decode(Control.self, from: Data(value.utf8)), control.type == "disconnected" {
                        Self.log.info("Peer disconnected: reason=\(ConnectionDiagnostic.closeReason(control.reason.map { Data($0.utf8) }), privacy: .public)")
                        throw CloudRelayTransportError.disconnected
                    }
                @unknown default: throw CloudRelayTransportError.disconnected
                }
            }
        } catch {
            Self.log.info("Mobile cloud receive ended: closeCode=\(self.socket.closeCode.rawValue) peerReason=\(ConnectionDiagnostic.closeReason(self.socket.closeReason), privacy: .public) reason=\(ConnectionDiagnostic.failure(error), privacy: .public)")
            if socket.closeCode.rawValue == 4003 { throw ClientConnectionError.invalidCredential }
            throw error
        }
    }

    public func close() async {
        Self.log.info("Mobile socket closing: initiator=local")
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    private static func receiveControl(_ socket: URLSessionWebSocketTask) async throws -> Control {
        while true {
            switch try await socket.receive() {
            case .string(let text): return try JSONDecoder().decode(Control.self, from: Data(text.utf8))
            case .data: continue
            @unknown default: throw CloudRelayTransportError.invalidControlMessage
            }
        }
    }

    private static func receiveBinary(_ socket: URLSessionWebSocketTask) async throws -> Data {
        while true {
            switch try await socket.receive() {
            case .data(let data): return data
            case .string: continue
            @unknown default: throw CloudRelayTransportError.invalidControlMessage
            }
        }
    }
}

private func routingHeader(_ connectionID: UUID) -> Data {
    Data([CloudRelayHandshake.protocolVersion]) + CloudRelayHandshake.connectionData(connectionID)
}

private final class CloudRelayWebSocketDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession, task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest
    ) async -> URLRequest? { nil }
}

public actor CloudRelayMacAgent {
    private static let log = Logger(subsystem: "com.corptie.connection", category: "MacRelay")
    private struct Control: Decodable {
        struct Peer: Decodable {
            let id: UUID
            let displayName: String
            let publicKey: String
        }
        let type: String
        let connectionId: UUID?
        let deviceId: UUID?
        let peer: Peer?
        let reason: String?
    }

    private struct Connection {
        struct Upload { let request: CloudRelayApplicationMessage; var body = Data() }
        let handshake: CloudRelayHandshake
        let peer: Control.Peer
        var cipher: CloudRelayCipherSession?
        var requests: [UUID: Task<Void, Never>] = [:]
        var uploads: [UUID: Upload] = [:]
        var registration: Task<Void, Error>?
    }

    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let localTransport: BackendTransport
    private let deviceKey: CloudRelayDeviceKey
    private var connections: [UUID: Connection] = [:]
    private var closedConnections = CloudRelayClosedConnectionWindow()
    private let sendScheduler = CloudRelaySendScheduler()

    private init(
        session: URLSession,
        socket: URLSessionWebSocketTask,
        localTransport: BackendTransport,
        deviceKey: CloudRelayDeviceKey
    ) {
        self.session = session
        self.socket = socket
        self.localTransport = localTransport
        self.deviceKey = deviceKey
    }

    public static func connect(
        cloudEndpoint: BackendEndpoint,
        accessToken: String,
        deviceID: UUID,
        localBackend: BackendEndpoint,
        localAccessToken: String,
        deviceKey: CloudRelayDeviceKey
    ) async throws -> CloudRelayMacAgent {
        guard localBackend.isLoopback else { throw CloudRelayTransportError.unsupportedRequest }
        var components = URLComponents(url: cloudEndpoint.baseURL, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/v1/relay"
        components.queryItems = [URLQueryItem(name: "deviceId", value: deviceID.uuidString.lowercased())]
        guard let url = components.url else { throw CloudRelayTransportError.invalidControlMessage }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let session = URLSession(configuration: .ephemeral, delegate: CloudRelayWebSocketDelegate(), delegateQueue: nil)
        let socket = session.webSocketTask(with: request)
        socket.maximumMessageSize = 512 * 1_024
        socket.resume()
        let ready: Control
        switch try await socket.receive() {
        case .string(let text): ready = try JSONDecoder().decode(Control.self, from: Data(text.utf8))
        default: throw CloudRelayTransportError.invalidControlMessage
        }
        guard ready.type == "ready" else {
            socket.cancel(with: .protocolError, reason: nil)
            session.invalidateAndCancel()
            throw CloudRelayTransportError.invalidControlMessage
        }
        return try CloudRelayMacAgent(
            session: session,
            socket: socket,
            localTransport: BackendTransport(endpoint: localBackend, bearerToken: localAccessToken),
            deviceKey: deviceKey
        )
    }

    /// Runs until the authenticated socket closes. Callers own retry/backoff
    /// and token refresh so account policy remains outside the relay protocol.
    public func run() async throws {
        defer { terminate() }
        Self.log.info("Mac cloud socket ready")
        do {
            while !Task.isCancelled {
                switch try await socket.receive() {
                case .string(let text): try handleControl(Data(text.utf8))
                case .data(let frame): try await handleFrame(frame)
                @unknown default: throw CloudRelayTransportError.disconnected
                }
            }
        } catch {
            Self.log.error("Mac cloud socket ended: closeCode=\(self.socket.closeCode.rawValue) peerReason=\(ConnectionDiagnostic.closeReason(self.socket.closeReason), privacy: .public) connections=\(self.connections.count) reason=\(ConnectionDiagnostic.failure(error), privacy: .public)")
            if socket.closeCode.rawValue == 4003 { throw ClientConnectionError.invalidCredential }
            throw error
        }
    }

    public func close() {
        terminate()
    }

    private func handleControl(_ data: Data) throws {
        let control = try JSONDecoder().decode(Control.self, from: data)
        if control.type == "incoming", let id = control.connectionId, let peer = control.peer,
           let peerKey = Data(base64Encoded: peer.publicKey) {
            let handshake = try CloudRelayHandshake(
                connectionID: id, role: .mac,
                staticPrivateKey: deviceKey.privateKey, peerStaticPublicKeyData: peerKey
            )
            connections[id] = Connection(handshake: handshake, peer: peer)
            Self.log.info("Peer incoming: connection=\(id, privacy: .public)")
            Task { [weak self] in try? await self?.sendRaw(routingHeader(id) + handshake.makeHello()) }
            return
        }
        if control.type == "disconnected", let id = control.connectionId {
            Self.log.info("Peer disconnected: connection=\(id, privacy: .public) reason=\(ConnectionDiagnostic.closeReason(control.reason.map { Data($0.utf8) }), privacy: .public)")
            removeConnection(id)
            return
        }
        if control.type == "device_revoked", let deviceID = control.deviceId {
            for id in connections.keys.filter({ connections[$0]?.peer.id == deviceID }) { removeConnection(id) }
            Task { [weak self] in await self?.revokeCloudGrant(deviceID: deviceID) }
            return
        }
        if control.type == "account_revoked" {
            for id in Array(connections.keys) { removeConnection(id) }
            Task { [weak self] in await self?.revokeCloudGrant(deviceID: nil) }
            return
        }
        if control.type != "ready" { throw CloudRelayTransportError.invalidControlMessage }
    }

    private func handleFrame(_ frame: Data) async throws {
        guard frame.count >= 17, frame[0] == CloudRelayHandshake.protocolVersion else {
            throw CloudRelayCryptoError.invalidFrame
        }
        let connectionID = try uuid(frame.subdata(in: 1..<17))
        guard var connection = connections[connectionID] else {
            if closedConnections.contains(connectionID) { return }
            throw CloudRelayTransportError.invalidControlMessage
        }
        if connection.cipher == nil {
            connection.cipher = try connection.handshake.complete(peerHello: Data(frame.dropFirst(17)))
            connections[connectionID] = connection
            Self.log.info("E2E handshake ready: connection=\(connectionID, privacy: .public)")
            return
        }
        let plaintext = try await connection.cipher!.open(frame)
        let message = try JSONDecoder().decode(CloudRelayApplicationMessage.self, from: plaintext)
        switch message.kind {
        case .request:
            guard connection.requests[message.id] == nil, connection.uploads[message.id] == nil,
                  let final = message.final else { throw CloudRelayTransportError.invalidApplicationMessage }
            if final {
                connection.requests[message.id] = Task { [weak self] in await self?.serve(message, connectionID: connectionID) }
            } else {
                connection.uploads[message.id] = Connection.Upload(request: message)
            }
            connections[connectionID] = connection
        case .chunk:
            guard var upload = connection.uploads[message.id], let body = message.body, let final = message.final,
                  upload.body.count + body.count <= CloudRelayHTTPClient.maximumRequestBytes else {
                throw CloudRelayTransportError.invalidApplicationMessage
            }
            upload.body.append(body)
            if final {
                connection.uploads.removeValue(forKey: message.id)
                let request = CloudRelayApplicationMessage.request(
                    id: upload.request.id,
                    method: upload.request.method ?? "",
                    path: upload.request.path ?? "",
                    headers: upload.request.headers ?? [:],
                    body: upload.body
                )
                connection.requests[message.id] = Task { [weak self] in await self?.serve(request, connectionID: connectionID) }
            } else {
                connection.uploads[message.id] = upload
            }
            connections[connectionID] = connection
        case .cancel:
            connection.requests.removeValue(forKey: message.id)?.cancel()
            connection.uploads.removeValue(forKey: message.id)
            connections[connectionID] = connection
        case .response: throw CloudRelayTransportError.invalidApplicationMessage
        }
    }

    private func serve(_ message: CloudRelayApplicationMessage, connectionID: UUID) async {
        let started = ContinuousClock.now
        Self.log.debug("Local request start: connection=\(connectionID, privacy: .public) request=\(message.id, privacy: .public)")
        do {
            guard let connection = connections[connectionID] else { throw CloudRelayTransportError.disconnected }
            if message.path != "/client/v1/cloud/offline-lan-grant" {
                try await registerPeer(connectionID: connectionID)
            }
            let request = try message.path == "/client/v1/cloud/offline-lan-grant"
                ? cloudGrantRequest(message, peer: connection.peer)
                : Self.localRequest(message, peerID: connection.peer.id, endpoint: localTransport.endpoint)
            let responsePriority = CloudRelaySendPriority.response(to: request)
            if request.value(forHTTPHeaderField: "Accept")?.hasPrefix("text/event-stream") == true {
                let (bytes, response) = try await localTransport.bytes(for: request)
                Self.log.info("Local stream head: connection=\(connectionID, privacy: .public) request=\(message.id, privacy: .public) status=\(response.statusCode) elapsed=\(String(describing: started.duration(to: .now)), privacy: .public)")
                try await send(.response(id: message.id, status: response.statusCode, headers: responseHeaders(response)), on: connectionID)
                var buffer = CloudRelaySSEBuffer()
                var lastFlushLog = ContinuousClock.now
                var flushedBytes = 0
                var streamPriority = CloudRelaySendPriority.interactive
                for try await byte in bytes {
                    try Task.checkCancellation()
                    if let chunk = buffer.append(byte) {
                        let prefix = String(decoding: chunk.prefix(256), as: UTF8.self)
                        if prefix.hasPrefix("id:") || prefix.hasPrefix("event:") {
                            streamPriority = prefix.contains("event: timeline-snapshot") || prefix.contains("event: control-snapshot")
                                ? .background : (prefix.contains("event: command-receipt") || prefix.contains("event: heartbeat") ? .control : .interactive)
                        }
                        try await send(.chunk(id: message.id, body: chunk, final: false), on: connectionID, priority: streamPriority)
                        flushedBytes += chunk.count
                        if lastFlushLog.duration(to: .now) >= .seconds(10) {
                            Self.log.info("Stream relay progress: request=\(message.id, privacy: .public) sentBytes=\(flushedBytes)")
                            lastFlushLog = .now
                        }
                        await Task.yield()
                    }
                }
                try await send(.chunk(id: message.id, body: buffer.remainder, final: true), on: connectionID, priority: streamPriority)
            } else if request.httpMethod == "GET" {
                // Pull at most one chunk ahead. Awaiting the shared writer
                // propagates history pacing back to the local HTTP producer.
                let (bytes, response) = try await localTransport.bytes(for: request)
                try await send(.response(id: message.id, status: response.statusCode, headers: responseHeaders(response)), on: connectionID)
                var chunk = Data()
                var total = 0
                for try await byte in bytes {
                    try Task.checkCancellation()
                    chunk.append(byte); total += 1
                    guard total <= CloudRelayHTTPClient.maximumResponseBytes else { throw CloudRelayTransportError.responseTooLarge }
                    if chunk.count == CloudRelayHTTPClient.maximumChunkBytes {
                        try await send(.chunk(id: message.id, body: chunk, final: false), on: connectionID, priority: responsePriority)
                        chunk.removeAll(keepingCapacity: true)
                    }
                }
                try await send(.chunk(id: message.id, body: chunk, final: true), on: connectionID, priority: responsePriority)
                Self.log.info("History response: request=\(message.id, privacy: .public) status=\(response.statusCode) bytes=\(total) elapsed=\(String(describing: started.duration(to: .now)), privacy: .public)")
            } else {
                let (body, response) = try await localTransport.data(for: request)
                Self.log.debug("Local response: request=\(message.id, privacy: .public) status=\(response.statusCode) bytes=\(body.count) elapsed=\(String(describing: started.duration(to: .now)), privacy: .public)")
                guard body.count <= CloudRelayHTTPClient.maximumResponseBytes else { throw CloudRelayTransportError.responseTooLarge }
                try await send(.response(id: message.id, status: response.statusCode, headers: responseHeaders(response)), on: connectionID)
                if body.isEmpty {
                    try await send(.chunk(id: message.id, body: Data(), final: true), on: connectionID)
                } else {
                    for offset in stride(from: 0, to: body.count, by: CloudRelayHTTPClient.maximumChunkBytes) {
                        try Task.checkCancellation()
                        let end = min(body.count, offset + CloudRelayHTTPClient.maximumChunkBytes)
                        try await send(.chunk(id: message.id, body: body.subdata(in: offset..<end), final: end == body.count), on: connectionID, priority: responsePriority)
                        await Task.yield()
                    }
                }
            }
        } catch is CancellationError { }
        catch let failure as ClientServiceFailure {
            Self.log.error("Local request failed: request=\(message.id, privacy: .public) reason=\(ConnectionDiagnostic.failure(failure), privacy: .public)")
            await sendFailure(id: message.id, status: failure.statusCode, code: failure.code, connectionID: connectionID)
        } catch let failure as ClientConnectionError {
            Self.log.error("Local request failed: request=\(message.id, privacy: .public) reason=\(ConnectionDiagnostic.failure(failure), privacy: .public)")
            let status: Int
            if case .httpStatus(let value) = failure { status = value } else { status = 502 }
            await sendFailure(id: message.id, status: status, code: "LOCAL_BACKEND_UNAVAILABLE", connectionID: connectionID)
        } catch {
            Self.log.error("Local request failed: request=\(message.id, privacy: .public) reason=\(ConnectionDiagnostic.failure(error), privacy: .public)")
            await sendFailure(id: message.id, status: 502, code: "LOCAL_BACKEND_UNAVAILABLE", connectionID: connectionID)
        }
        connections[connectionID]?.requests.removeValue(forKey: message.id)
        Self.log.debug("Local request finished: request=\(message.id, privacy: .public) elapsed=\(String(describing: started.duration(to: .now)), privacy: .public)")
    }

    private func cloudGrantRequest(_ message: CloudRelayApplicationMessage, peer: Control.Peer) throws -> URLRequest {
        guard message.method == "POST", message.body?.isEmpty != false else {
            throw CloudRelayTransportError.unsupportedRequest
        }
        var request = try localTransport.endpoint.request(path: ["internal", "client-devices", "cloud-grant"])
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode([
            "cloudDeviceId": peer.id.uuidString.lowercased(), "name": peer.displayName
        ])
        return request
    }

    private func revokeCloudGrant(deviceID: UUID?) async {
        do {
            var request = try localTransport.endpoint.request(path: ["internal", "client-devices", "cloud-revoke"])
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let revokedDevice: Any = deviceID?.uuidString.lowercased() ?? NSNull()
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "cloudDeviceId": revokedDevice
            ])
            _ = try await localTransport.data(for: request)
        } catch {
            // The Mac controller performs a full device reconciliation on reconnect.
        }
    }

    private func registerPeer(connectionID: UUID) async throws {
        guard var connection = connections[connectionID] else { throw CloudRelayTransportError.disconnected }
        if let registration = connection.registration { return try await registration.value }
        let peer = connection.peer, transport = localTransport
        let registration = Task {
            var request = try transport.endpoint.request(path: ["internal", "client-devices", "cloud-register"])
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode([
                "cloudDeviceId": peer.id.uuidString.lowercased(), "name": peer.displayName
            ])
            _ = try await transport.data(for: request)
        }
        connection.registration = registration; connections[connectionID] = connection
        do { try await registration.value }
        catch { connections[connectionID]?.registration = nil; throw error }
        guard connections[connectionID] != nil else { throw CloudRelayTransportError.disconnected }
    }

    static func localRequest(_ message: CloudRelayApplicationMessage, peerID: UUID, endpoint: BackendEndpoint) throws -> URLRequest {
        guard let method = message.method, ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method),
              let path = message.path, path.hasPrefix("/client/"), !path.contains("\\"),
              let relative = URL(string: path, relativeTo: endpoint.baseURL),
              endpoint.contains(relative.absoluteURL),
              (message.body?.count ?? 0) <= CloudRelayHTTPClient.maximumRequestBytes else {
            throw CloudRelayTransportError.unsupportedRequest
        }
        var request = URLRequest(url: relative.absoluteURL)
        request.httpMethod = method
        request.httpBody = message.body
        let allowed = Set(["accept", "content-type", "if-none-match", "if-match", "last-event-id", "x-corptie-request-id"])
        for (name, value) in message.headers ?? [:] where allowed.contains(name.lowercased()) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        // The peer comes from the authenticated cloud control plane AND the
        // completed E2E handshake, never from mobile HTTP headers or a body.
        request.setValue(peerID.uuidString.lowercased(), forHTTPHeaderField: "X-Corptie-Relay-Cloud-Device-Id")
        return request
    }

    private func sendFailure(id: UUID, status: Int, code: String, connectionID: UUID) async {
        let data = (try? JSONEncoder().encode(["code": code])) ?? Data()
        try? await send(.response(id: id, status: status, headers: ["Content-Type": "application/json"]), on: connectionID)
        try? await send(.chunk(id: id, body: data, final: true), on: connectionID)
    }

    private func responseHeaders(_ response: HTTPURLResponse) -> [String: String] {
        let allowed = Set(["content-type", "etag", "cache-control", "x-corptie-revision"])
        return response.allHeaderFields.reduce(into: [:]) { result, entry in
            guard let name = entry.key as? String, let value = entry.value as? String, allowed.contains(name.lowercased()) else { return }
            result[name] = value
        }
    }

    private func send(_ message: CloudRelayApplicationMessage, on connectionID: UUID,
                      priority: CloudRelaySendPriority = .control) async throws {
        let plaintext = try JSONEncoder().encode(message)
        try await sendScheduler.send(bytes: plaintext.count + 41, priority: priority) { [weak self] in
            guard let self else { throw CloudRelayTransportError.disconnected }
            try await self.sealAndSend(plaintext, on: connectionID)
        }
    }

    private func sealAndSend(_ plaintext: Data, on connectionID: UUID) async throws {
        guard let cipher = connections[connectionID]?.cipher else { throw CloudRelayTransportError.disconnected }
        try await sendRaw(try await cipher.seal(plaintext))
    }

    private func sendRaw(_ data: Data) async throws { try await socket.send(.data(data)) }

    private func removeConnection(_ id: UUID) {
        guard let removed = connections.removeValue(forKey: id) else { return }
        closedConnections.record(id)
        Self.log.info("Peer removed: connection=\(id, privacy: .public) requests=\(removed.requests.count) uploads=\(removed.uploads.count)")
        removed.registration?.cancel()
        for task in removed.requests.values { task.cancel() }
    }

    private func terminate() {
        Task { await sendScheduler.close() }
        for id in Array(connections.keys) { removeConnection(id) }
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }

    private func uuid(_ data: Data) throws -> UUID {
        guard data.count == 16 else { throw CloudRelayTransportError.invalidApplicationMessage }
        let bytes = [UInt8](data)
        let tuple: uuid_t = (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])
        return UUID(uuid: tuple)
    }
}
