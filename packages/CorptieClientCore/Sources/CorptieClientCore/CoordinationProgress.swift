import Foundation

/// Provider-neutral presentation facts. A completed model turn is never acceptance.
public struct ClientCoordinationProgress: Codable, Equatable, Sendable {
    public let version: Int
    public let batchId: String
    public let parentSessionId: String
    public let revision: Int
    public let updatedAt: String
    public let counts: [String: Int]
    public let total: Int
    public let items: [ClientCoordinationProgressItem]
    public let hasMore: Bool
    public let focus: String
    public let decision: String
}

public struct ClientCoordinationProgressItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String { assignmentId }
    public let assignmentId: String
    public let taskId: String?
    public let sessionId: String?
    public let title: String
    public let state: String
    public let summary: String
    public let reason: String
    public let reportMessageId: String?
    public let updatedAt: String
}

public struct ClientCoordinationProgressPage: Decodable, Sendable {
    public let items: [ClientCoordinationProgressItem]
    public let nextOffset: Int?
}

public struct ClientCoordinationProgressReport: Decodable, Sendable {
    public let text: String
    public let nextOffset: Int?
}

extension ClientCoordinationProgressItem {
    public var statusTitle: String {
        switch state {
        case "preparing": "准备中"
        case "queued": "排队中"
        case "running": "执行中"
        case "waiting_input": "等待补充"
        case "blocked": "受阻"
        case "needs_review": "待审查"
        case "delivered": "已交付"
        case "accepted": "已验收"
        case "cancelled": "已取消"
        default: "状态待确认"
        }
    }
    public var statusSymbol: String {
        switch state {
        case "running": "play.circle"
        case "blocked", "waiting_input": "exclamationmark.circle"
        case "needs_review": "doc.text.magnifyingglass"
        case "delivered", "accepted": "checkmark.circle"
        case "cancelled": "xmark.circle"
        default: "clock"
        }
    }
    public var previewSummary: String {
        let summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return ["blocked", "waiting_input"].contains(state) && !reason.isEmpty ? reason : summary
    }
}
