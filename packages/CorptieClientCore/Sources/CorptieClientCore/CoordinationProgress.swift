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
    public var phase: String? = nil
    public var previousExecutionStatus: String? = nil
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
        if state == "blocked" {
            switch phase {
            case "preparation": return "准备受阻"
            case "dispatch": return "派发受阻"
            case "shadow": return "后续派发受阻"
            case "delivery": return "交付受阻"
            case "reclamation": return "回收受阻"
            default: break
            }
        }
        if phase == "shadow", state == "queued" { return "影子处理中" }
        if state == "needs_review", phase == "delivery" { return "交付中" }
        if state == "needs_review", phase == "reclamation" { return "回收中" }
        return switch state {
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
    public var previousExecutionTitle: String? {
        guard phase == "shadow" else { return nil }
        switch previousExecutionStatus {
        case "completed": return "上一轮执行已结束，后续指令尚未送达。"
        case "failed": return "上一轮执行失败，正在处理后续指令。"
        case "cancelled": return "上一轮执行已取消，正在处理后续指令。"
        default: return nil
        }
    }
    public var previewSummary: String {
        let summary = summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        return ["blocked", "waiting_input"].contains(state) && !reason.isEmpty ? reason : summary
    }
}

/// Presentation metadata, never inferred from model-authored prose.
public struct ConversationCoordinationEvent: Codable, Equatable, Sendable {
    public let kind: String
    public let batchId: String?
    public var requestId: String? = nil
    public var sessionId: String? = nil
    public var phase: String? = nil
    public var errorCode: String? = nil
    public var retryable: Bool? = nil
    public init?(rawMetadataJSON: String?) {
        guard let data = rawMetadataJSON?.data(using: .utf8),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let event = raw["coordinationEvent"] as? [String: Any],
           let value = event["kind"] as? String, ["summary", "delivery", "receipt", "failure", "decision"].contains(value) {
            kind = value; batchId = event["batchId"] as? String
            requestId = event["requestId"] as? String; sessionId = event["sessionId"] as? String
            phase = event["phase"] as? String; errorCode = event["errorCode"] as? String
            retryable = event["retryable"] as? Bool; return
        }
        if raw["executionMode"] as? String == "shadow_report" { kind = "summary" }
        else if raw["progressBatchId"] is String { kind = "delivery" }
        else { return nil }
        batchId = raw["progressBatchId"] as? String
    }
}
