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
    public var failureDetail: String? {
        guard !isActive, !isReady, state != "cancelled", let reasonCode else { return nil }
        return "\(Self.reasonDescription(reasonCode))（\(reasonCode)）"
    }

    public static func requestFailureDetail(_ error: Error) -> String {
        if let failure = error as? ClientServiceFailure {
            let message = failure.message?.trimmingCharacters(in: .whitespacesAndNewlines)
            let detail = message.flatMap { $0.isEmpty || $0 == failure.code ? nil : $0 }
                ?? reasonDescription(failure.code)
            return "\(detail)（\(failure.code)，HTTP \(failure.statusCode)）"
        }
        if let failure = error as? URLError {
            let message: String
            switch failure.code {
            case .timedOut: message = "核验请求超过 15 秒未收到响应"
            case .cannotConnectToHost: message = "无法连接后端服务"
            case .networkConnectionLost: message = "核验期间与后端的连接中断"
            default: message = failure.localizedDescription
            }
            return "\(message)（NSURLErrorDomain \(failure.code.rawValue)）"
        }
        if error is DecodingError || (error as? ClientConnectionError) == .invalidResponse {
            return "后端返回的核验数据格式无效（INVALID_RESPONSE）"
        }
        if case .httpStatus(let status) = error as? ClientConnectionError {
            return "后端核验请求失败（HTTP \(status)）"
        }
        let failure = error as NSError
        return "\(failure.localizedDescription)（\(failure.domain) \(failure.code)）"
    }

    private static func reasonDescription(_ code: String) -> String {
        switch code {
        case "PROVIDER_RPC_TIMEOUT": "Provider 会话核验超时"
        case "PROVIDER_RESUME_OUTCOME_UNKNOWN": "无法确认 Provider 会话恢复结果"
        case "SESSION_BINDING_CHANGED", "BINDING_VERIFICATION_SUPERSEDED": "核验期间会话绑定已改变"
        case "SESSION_PREPARATION_DEADLINE": "后台会话核验超过 120 秒期限"
        case "SESSION_PREPARATION_STORAGE_UNAVAILABLE": "无法保存会话核验状态"
        case "SESSION_PREPARATION_BUSY": "会话核验队列或容量已满"
        case "PROVIDER_SESSION_UNAVAILABLE": "Provider 会话不可用"
        case "SESSION_PREPARATION_FAILED": "后台会话核验失败"
        default: "会话核验失败"
        }
    }
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
