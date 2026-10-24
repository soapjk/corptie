import Foundation

public struct ClientTaskStartup: Codable, Sendable, Equatable {
    public struct Failure: Codable, Sendable, Equatable {
        public let code: String
        public let retryable: Bool
    }
    public let taskId: String
    public let workId: String
    public let parentTaskId: String?
    public let status: String
    public let phase: String?
    public let startupOperationId: String?
    public let sessionId: String?
    public let canRetry: Bool
    public let error: Failure?

    public var reasonKey: String {
        Self.failureReasonKey(error?.code)
    }
    public static func failureReasonKey(_ code: String?) -> String {
        switch code {
        case "PARENT_WORKTREE_DIRTY": "父任务工作区存在未提交改动，请先提交或处理，再重试启动。"
        case "TASK_HIERARCHY_BUSY": "父分支正在执行任务或 Git 操作，请处理完成后重试。"
        case "PARENT_WORKTREE_REQUIRED", "TASK_DELIVERY_BINDING_CHANGED": "父任务工作区不可用或绑定已改变，需要先恢复父任务。"
        case "TASK_PARENT_INVALID", "TASK_PARENT_UNAVAILABLE": "父任务不可用，不能重试启动。"
        case "TASK_PARENT_VERSION_CONFLICT", "TASK_HIERARCHY_CHANGED": "父任务已变化，请刷新并重新选择父任务。"
        case "START_WORKTREE_PREPARATION_FAILED": "准备工作区失败，请检查本机 Git 与工作区路径后重试。"
        default: "会话启动失败，请核对错误代码和启动记录。"
        }
    }
}

/// Exact-operation retry; no automatic mutation retry or polling.
public struct ClientTaskStartupAPI: Sendable {
    public enum Route: Sendable { case desktop, paired }
    private let transport: BackendTransport
    private let route: Route
    private let sourceSessionId: String
    public init(transport: BackendTransport, route: Route, sourceSessionId: String) {
        self.transport = transport; self.route = route; self.sourceSessionId = sourceSessionId
    }
    public func status(taskId: String) async throws -> ClientTaskStartup {
        try await request(taskId: taskId, operation: nil)
    }
    public func retry(taskId: String, startupOperationId: String) async throws -> ClientTaskStartup {
        try await request(taskId: taskId, operation: startupOperationId)
    }
    private func request(taskId: String, operation: String?) async throws -> ClientTaskStartup {
        let path: [String] = route == .desktop ? ["tasks", taskId, "startup-recovery"]
            : ["client", "v1", "sessions", sourceSessionId, "task-startup"]
        var query: [URLQueryItem] = []
        if route == .paired && operation == nil { query = [.init(name: "taskId", value: taskId)] }
        var request = try transport.endpoint.request(path: path, query: query)
        if route == .desktop { request.setValue(sourceSessionId, forHTTPHeaderField: "X-Corptie-Logical-Session-Id") }
        if let operation {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            var body = ["startupOperationId": operation]
            if route == .paired { body["taskId"] = taskId }
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(ClientTaskStartup.self, from: data)
    }
}
