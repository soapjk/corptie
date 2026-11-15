import Foundation

public struct ClientVerificationPerformance: Decodable, Equatable, Sendable {
    public let sessionId: String
    public let taskId: String?
    public let available: Bool
    public let policyEditable: Bool
    public let revision: String
    public let policy: Policy
    public let budgets: [Budget]
    public let limitation: String
    public struct Policy: Decodable, Equatable, Sendable {
        public let enabled: Bool
        public let limit: Int
        public let revision: Int
    }
    public struct Run: Decodable, Equatable, Identifiable, Sendable {
        public var id: String { executionId }
        public let executionId: String
        public let status: String
        public let createdAt: String
        public let executorSessionId: String?
        public let executorTaskId: String?
    }
    public struct Budget: Decodable, Equatable, Identifiable, Sendable {
        public var id: String { instructionId }
        public let instructionId: String
        public let taskId: String
        public let sessionId: String
        public let instruction: String
        public let enabled: Bool
        public let limit: Int
        public let used: Int
        public let remaining: Int?
        public let status: String
        public let paused: Bool
        public let pauseReason: String?
        public let running: Bool
        public let executionRunning: Bool
        public let revision: Int
        public let resumeRequested: Bool
        public let resumeOperationIds: [String]
        public let runs: [Run]
        public let runsHasMore: Bool
        public let nextRunCursor: String?
        public var statusTitle: String {
            switch status {
            case "disabled": "不限次数"
            case "running": "正在验证"
            case "exhausted": "额度已用完"
            case "paused_budget": executionRunning ? "后续验证已暂停，当前执行尚未结束" : "因验证预算耗尽暂停"
            case "stopped_user": "用户已停止"
            case "recovery_unknown": "原执行结果待核对"
            default: "可继续验证"
            }
        }
    }
}

/// A program-owned notice. No model reply or collaboration wake is involved.
public struct ClientVerificationNotice: Decodable, Equatable, Sendable {
    public let id: String
    public let sessionId: String
    public let instructionId: String
    public let title: String
    public let body: String
    public let occurredAt: String
    public var notification: OperationNotificationEvent? {
        guard let date = ClientAutomationNotificationBatch.date(occurredAt) else { return nil }
        return OperationNotificationEvent(id: id, category: .verification, outcome: .attention,
            name: title, summary: body, sessionID: sessionId, occurredAt: date)
    }
}

public struct ClientVerificationPause: Codable, Equatable, Sendable {
    public let instructionId: String
    public let reason: String
}

public struct ClientVerificationRunPage: Decodable, Equatable, Sendable {
    public let runs: [ClientVerificationPerformance.Run]
    public let hasMore: Bool
    public let nextCursor: String?
}
