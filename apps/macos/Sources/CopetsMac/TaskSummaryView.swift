import SwiftUI
import CorptieConversation

struct TaskUserSummary: Codable, Hashable {
    let state: String
    let content: Content?
    var errorCode: String? = nil

    struct Content: Codable, Hashable {
        let schemaVersion: Int
        let focus: String
        let progress: String
        let intervention: String
        let reason: String
        let nextAction: String
        let sourceRefs: [String]
        let generatedAt: String
        let providerID: String?
        let model: String?
        let basis: Basis
        var messageSummary: String? = nil
        var targetMessageId: String? = nil
        var retainedAttention: RetainedAttention? = nil
    }

    struct RetainedAttention: Codable, Hashable {
        let intervention: String
        let reason: String
        let nextAction: String
    }

    struct Basis: Codable, Hashable {
        let taskRevision: Int
        let sessionID: String
        let timelineRevision: Int
    }

    func isCurrent(for task: CorptieTask) -> Bool {
        state == "ready" && content?.schemaVersion == 1 && content?.basis.taskRevision == task.revision
    }

    func stateLabel(for task: CorptieTask) -> String {
        switch state {
        case "generating": return "摘要更新中"
        case "blocked", "failed":
            switch errorCode {
            case "BACKGROUND_AGENT_UNAVAILABLE": return "默认 Provider 暂不支持安全的后台摘要"
            case "BACKGROUND_NO_TOOLS_RUNTIME_UNVERIFIED": return "当前 Provider 版本尚未通过摘要隔离验证"
            case "TASK_SUMMARY_PROVIDER_UNAVAILABLE": return "默认 Provider 尚未就绪"
            case "BACKGROUND_TIMEOUT": return "摘要生成超时"
            case "TASK_SUMMARY_INVALID_OUTPUT": return "摘要结果格式不符合要求"
            case "BACKGROUND_CANCELLED": return "摘要更新已取消"
            default: return "摘要生成失败"
            }
        case "ready" where isCurrent(for: task): return ""
        default: return content == nil ? "摘要待生成" : "旧摘要 · 待更新"
        }
    }
}

extension CorptieTask {
    var summaryNeedsIntervention: Bool {
        userSummary?.isCurrent(for: self) == true && userSummary?.content?.intervention == "required"
    }

    var conversationDetailSummary: ConversationTaskSummary? {
        guard let summary = userSummary else { return nil }
        let content = summary.content
        return ConversationTaskSummary(state: summary.state, errorCode: summary.errorCode,
            focus: content?.focus ?? "", progress: content?.progress ?? "",
            messageSummary: content?.messageSummary, intervention: content?.intervention ?? "",
            reason: content?.reason ?? "", nextAction: content?.nextAction ?? "",
            retainedReason: content?.retainedAttention?.reason,
            generatedAt: content?.generatedAt ?? "", sourceRefs: content?.sourceRefs ?? [],
            contentSchemaVersion: content?.schemaVersion,
            basisTaskRevision: content?.basis.taskRevision, taskRevision: revision)
    }
}

/// Same persisted projection for the compact card and the information rail.
/// No network request, transcript access, polling, or per-card observation.
struct TaskSummaryView: View {
    let task: CorptieTask
    var compact = false
    var expandsWidth = true

    var body: some View {
        ConversationTaskSummaryView(summary: task.conversationDetailSummary,
            compact: compact, expandsWidth: expandsWidth)
    }
}
