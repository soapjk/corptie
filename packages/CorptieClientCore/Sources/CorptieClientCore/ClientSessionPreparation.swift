import Foundation

public struct ClientSessionPreparation: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let state: String
    public let reasonCode: String?
    public let remoteDisposition: String
    public let retryable: Bool
    public let createdAt: String
    public let deadlineAt: String

    public var isActive: Bool { state == "queued" || state == "verifying" }
    public var isReady: Bool { state == "ready" }
    public var statusText: String {
        switch state {
        case "queued": "正在等待核验，草稿已保留"
        case "verifying": "正在核验会话，草稿已保留"
        case "ready": "会话已就绪，未自动发送草稿"
        case "cancelled": "已停止等待，草稿已保留"
        default: remoteDisposition == "unknown"
            ? "恢复结果仍需核对，未重发消息" : "会话尚未就绪，草稿已保留"
        }
    }
}

/// One product DTO for desktop and authenticated paired clients. No mutation retry.
public struct ClientSessionPreparationAPI: Sendable {
    public enum Route: Sendable { case desktop, paired }
    private struct Envelope: Decodable { let schemaVersion: Int; let preparation: ClientSessionPreparation? }
    private let transport: BackendTransport
    private let route: Route

    public init(transport: BackendTransport, route: Route) {
        self.transport = transport; self.route = route
    }

    public func start(sessionID: String) async throws -> ClientSessionPreparation? {
        try await request(sessionID: sessionID, method: "POST")
    }
    public func current(sessionID: String) async throws -> ClientSessionPreparation? {
        try await request(sessionID: sessionID, method: "GET")
    }
    public func cancel(sessionID: String, attemptID: String) async throws -> ClientSessionPreparation? {
        try await request(sessionID: sessionID, method: "POST", suffix: [attemptID, "cancel"])
    }

    private func request(sessionID: String, method: String, suffix: [String] = []) async throws -> ClientSessionPreparation? {
        let prefix = route == .desktop ? ["sessions"] : ["client", "v1", "sessions"]
        var request = try transport.endpoint.request(path: prefix + [sessionID, "preparation"] + suffix)
        request.httpMethod = method
        request.timeoutInterval = 15
        if method == "POST" {
            request.httpBody = Data("{}".utf8)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, _) = try await transport.data(for: request)
        let envelope = try JSONDecoder().decode(Envelope.self, from: data)
        guard envelope.schemaVersion == 1 else { throw ClientConnectionError.invalidResponse }
        return envelope.preparation
    }
}
