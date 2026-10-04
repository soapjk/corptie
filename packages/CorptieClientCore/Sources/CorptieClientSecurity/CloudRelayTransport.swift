import Foundation
import CorptieClientCore

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
    public static let maximumChunkBytes = 128 * 1_024

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
    }

    private enum Pending { case data(PendingData), stream(PendingStream) }

    private let endpoint: BackendEndpoint
    private let channel: any CloudRelaySecureChannel
    private var pending: [UUID: Pending] = [:]
    private var receiver: Task<Void, Never>?
    private var terminalError: Error?

    public init(endpoint: BackendEndpoint, channel: any CloudRelaySecureChannel) {
        self.endpoint = endpoint
        self.channel = channel
    }

    deinit { receiver?.cancel() }

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
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                pending[message.id] = .stream(PendingStream(
                    url: request.url!, head: continuation, bytes: BackendByteStream(chunks: pair.stream), stream: pair.continuation
                ))
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
            for message in messages { try await channel.send(try JSONEncoder().encode(message)) }
        }
        catch { fail(id, error) }
    }

    private func cancel(_ id: UUID) async {
        fail(id, CancellationError())
        try? await channel.send(JSONEncoder().encode(CloudRelayApplicationMessage.cancel(id: id)))
    }

    private func consume(_ payload: Data) throws {
        let message = try JSONDecoder().decode(CloudRelayApplicationMessage.self, from: payload)
        guard var current = pending[message.id] else { return }
        switch (message.kind, current) {
        case (.response, .data(var value)):
            value.response = try response(message, url: value.url)
            current = .data(value)
        case (.response, .stream(var value)):
            let response = try response(message, url: value.url)
            value.response = response
            value.head.resume(returning: (value.bytes, response))
            current = .stream(value)
        case (.chunk, .data(var value)):
            guard value.response != nil, let body = message.body, let final = message.final else { throw CloudRelayTransportError.invalidApplicationMessage }
            guard value.body.count + body.count <= Self.maximumResponseBytes else {
                fail(message.id, CloudRelayTransportError.responseTooLarge); return
            }
            value.body.append(body)
            if final {
                pending.removeValue(forKey: message.id)
                value.continuation.resume(returning: (value.body, value.response!))
                return
            }
            current = .data(value)
        case (.chunk, .stream(let value)):
            guard value.response != nil, let body = message.body, let final = message.final else { throw CloudRelayTransportError.invalidApplicationMessage }
            for start in stride(from: 0, to: body.count, by: 16 * 1_024) {
                let end = min(body.count, start + 16 * 1_024)
                if case .dropped = value.stream.yield(body.subdata(in: start..<end)) {
                    fail(message.id, CloudRelayTransportError.responseTooLarge); return
                }
            }
            if final {
                pending.removeValue(forKey: message.id)
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
        guard let value = pending.removeValue(forKey: id) else { return }
        switch value {
        case .data(let pending): pending.continuation.resume(throwing: error)
        case .stream(let pending):
            if pending.response == nil { pending.head.resume(throwing: error) }
            pending.stream.finish(throwing: error)
        }
    }

    private func failAll(_ error: Error) {
        terminalError = error
        let ids = Array(pending.keys)
        for id in ids { fail(id, error) }
    }
}

public actor CloudRelayMobileChannel: CloudRelaySecureChannel {
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
        do {
            let ready = try await receiveControl(socket)
            guard ready.type == "ready" else { throw CloudRelayTransportError.invalidControlMessage }
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
            return CloudRelayMobileChannel(session: session, socket: socket, cipher: cipher)
        } catch {
            socket.cancel(with: .protocolError, reason: nil)
            session.invalidateAndCancel()
            throw error
        }
    }

    public func send(_ plaintext: Data) async throws {
        try await socket.send(.data(try await cipher.seal(plaintext)))
    }

    public func receive() async throws -> Data {
        while true {
            switch try await socket.receive() {
            case .data(let data): return try await cipher.open(data)
            case .string(let value):
                if (try? JSONDecoder().decode(Control.self, from: Data(value.utf8)).type) == "disconnected" {
                    throw CloudRelayTransportError.disconnected
                }
            @unknown default: throw CloudRelayTransportError.disconnected
            }
        }
    }

    public func close() async {
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
    }

    private struct Connection {
        struct Upload { let request: CloudRelayApplicationMessage; var body = Data() }
        let handshake: CloudRelayHandshake
        let peer: Control.Peer
        var cipher: CloudRelayCipherSession?
        var requests: [UUID: Task<Void, Never>] = [:]
        var uploads: [UUID: Upload] = [:]
    }

    private let session: URLSession
    private let socket: URLSessionWebSocketTask
    private let localTransport: BackendTransport
    private let deviceKey: CloudRelayDeviceKey
    private var connections: [UUID: Connection] = [:]

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
        while !Task.isCancelled {
            switch try await socket.receive() {
            case .string(let text): try handleControl(Data(text.utf8))
            case .data(let frame): try await handleFrame(frame)
            @unknown default: throw CloudRelayTransportError.disconnected
            }
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
            Task { [weak self] in try? await self?.sendRaw(routingHeader(id) + handshake.makeHello()) }
            return
        }
        if control.type == "disconnected", let id = control.connectionId {
            removeConnection(id)
            return
        }
        if control.type == "device_revoked", let deviceID = control.deviceId {
            Task { [weak self] in await self?.revokeCloudGrant(deviceID: deviceID) }
            return
        }
        if control.type == "account_revoked" {
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
        guard var connection = connections[connectionID] else { throw CloudRelayTransportError.invalidControlMessage }
        if connection.cipher == nil {
            connection.cipher = try connection.handshake.complete(peerHello: Data(frame.dropFirst(17)))
            connections[connectionID] = connection
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
        do {
            guard let connection = connections[connectionID] else { throw CloudRelayTransportError.disconnected }
            let request = try message.path == "/client/v1/cloud/offline-lan-grant"
                ? cloudGrantRequest(message, peer: connection.peer)
                : localRequest(message)
            if request.value(forHTTPHeaderField: "Accept")?.hasPrefix("text/event-stream") == true {
                let (bytes, response) = try await localTransport.bytes(for: request)
                try await send(.response(id: message.id, status: response.statusCode, headers: responseHeaders(response)), on: connectionID)
                var buffer = Data(); buffer.reserveCapacity(16 * 1_024)
                for try await byte in bytes {
                    try Task.checkCancellation()
                    buffer.append(byte)
                    if buffer.count >= 16 * 1_024 {
                        try await send(.chunk(id: message.id, body: buffer, final: false), on: connectionID)
                        buffer.removeAll(keepingCapacity: true)
                    }
                }
                try await send(.chunk(id: message.id, body: buffer, final: true), on: connectionID)
            } else {
                let (body, response) = try await localTransport.data(for: request)
                guard body.count <= CloudRelayHTTPClient.maximumResponseBytes else { throw CloudRelayTransportError.responseTooLarge }
                try await send(.response(id: message.id, status: response.statusCode, headers: responseHeaders(response)), on: connectionID)
                try await send(.chunk(id: message.id, body: body, final: true), on: connectionID)
            }
        } catch is CancellationError { }
        catch let failure as ClientServiceFailure {
            await sendFailure(id: message.id, status: failure.statusCode, code: failure.code, connectionID: connectionID)
        } catch let failure as ClientConnectionError {
            let status: Int
            if case .httpStatus(let value) = failure { status = value } else { status = 502 }
            await sendFailure(id: message.id, status: status, code: "LOCAL_BACKEND_UNAVAILABLE", connectionID: connectionID)
        } catch {
            await sendFailure(id: message.id, status: 502, code: "LOCAL_BACKEND_UNAVAILABLE", connectionID: connectionID)
        }
        connections[connectionID]?.requests.removeValue(forKey: message.id)
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

    private func localRequest(_ message: CloudRelayApplicationMessage) throws -> URLRequest {
        guard let method = message.method, ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method),
              let path = message.path, path.hasPrefix("/client/"), !path.contains("\\"),
              let relative = URL(string: path, relativeTo: localTransport.endpoint.baseURL),
              localTransport.endpoint.contains(relative.absoluteURL),
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

    private func send(_ message: CloudRelayApplicationMessage, on connectionID: UUID) async throws {
        guard let cipher = connections[connectionID]?.cipher else { throw CloudRelayTransportError.disconnected }
        try await sendRaw(try await cipher.seal(try JSONEncoder().encode(message)))
    }

    private func sendRaw(_ data: Data) async throws { try await socket.send(.data(data)) }

    private func removeConnection(_ id: UUID) {
        guard let removed = connections.removeValue(forKey: id) else { return }
        for task in removed.requests.values { task.cancel() }
    }

    private func terminate() {
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
