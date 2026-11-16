import Foundation

/// Execution facts supplied by the host, independent of the model's checklist
/// completion claim. Optional on older progress-only checklists.
public struct ClientChecklistContinuation: Codable, Hashable, Sendable {
    public let enabled: Bool
    public let state: String
    public let generation: Int
    public let pauseReason: String?
    public let reason: String?
    public let nextStepIds: [String]
    public let canPause: Bool
    public let canResume: Bool

    public var statusTitle: String {
        switch state {
        case "queued": "继续执行已排队"
        case "running": "持续推进中"
        case "waiting_dependency": "等待关联事项"
        case "waiting_user": "等待你的答复"
        case "paused_user": "已暂停"
        case "paused_budget": "验证预算已用尽"
        case "needs_attention": "执行需要处理"
        case "completed": "清单已完成"
        case "cancelled": "已取消"
        default: enabled ? "准备继续执行" : "仅记录进度"
        }
    }
}

public struct ClientCoordinationDecision: Codable, Hashable, Sendable, Identifiable {
    public struct Option: Codable, Hashable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let description: String?
    }
    public let id: String
    public let planId: String?
    public let revision: Int
    public let status: String
    public let question: String
    public let recommendation: String?
    public let impact: String?
    public let options: [Option]
    public let allowsText: Bool
    public let answer: String?
    public var isPending: Bool { status == "pending" && !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
}
