import SwiftUI
import CorptieClientCore

/// The semantic Task summary displayed in Detail on either platform.
public struct ConversationTaskSummary: Equatable, Sendable {
    public let state: String
    public let errorCode: String?
    public let focus: String
    public let progress: String
    public let messageSummary: String?
    public let intervention: String
    public let reason: String
    public let nextAction: String
    public let retainedReason: String?
    public let generatedAt: String
    public let sourceRefs: [String]
    public let contentSchemaVersion: Int?
    public let basisTaskRevision: Int?
    public let taskRevision: Int?

    public init(state: String, errorCode: String?, focus: String, progress: String,
                messageSummary: String?, intervention: String, reason: String, nextAction: String,
                retainedReason: String?, generatedAt: String, sourceRefs: [String], contentSchemaVersion: Int?,
                basisTaskRevision: Int?, taskRevision: Int?) {
        self.state = state
        self.errorCode = errorCode
        self.focus = focus
        self.progress = progress
        self.messageSummary = messageSummary
        self.intervention = intervention
        self.reason = reason
        self.nextAction = nextAction
        self.retainedReason = retainedReason
        self.generatedAt = generatedAt
        self.sourceRefs = sourceRefs
        self.contentSchemaVersion = contentSchemaVersion
        self.basisTaskRevision = basisTaskRevision
        self.taskRevision = taskRevision
    }

    public init?(inspectorValue: ClientInspectorValue, taskRevision: Int?) {
        guard let state = inspectorValue["state"].text else { return nil }
        let content = inspectorValue["content"]
        self.init(state: state, errorCode: inspectorValue["errorCode"].text,
            focus: content["focus"].text ?? "", progress: content["progress"].text ?? "",
            messageSummary: content["messageSummary"].text,
            intervention: content["intervention"].text ?? "", reason: content["reason"].text ?? "",
            nextAction: content["nextAction"].text ?? "",
            retainedReason: content["retainedAttention"]["reason"].text,
            generatedAt: content["generatedAt"].text ?? "",
            sourceRefs: content["sourceRefs"].items.compactMap(\.text),
            contentSchemaVersion: content["schemaVersion"].number.map(Int.init),
            basisTaskRevision: content["basis"]["taskRevision"].number.map(Int.init),
            taskRevision: taskRevision)
    }

    public var isCurrent: Bool {
        state == "ready" && contentSchemaVersion == 1 && taskRevision != nil && basisTaskRevision == taskRevision
    }

    public var needsIntervention: Bool { isCurrent && intervention == "required" }

    public var stateLabel: String {
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
        case "ready" where isCurrent: return ""
        default: return focus.isEmpty && progress.isEmpty ? "摘要待生成" : "旧摘要 · 待更新"
        }
    }

    public var hasContent: Bool {
        contentSchemaVersion == 1 && (!focus.isEmpty || !progress.isEmpty || !(messageSummary ?? "").isEmpty)
    }
}

public struct ConversationTaskSummaryView: View {
    public let summary: ConversationTaskSummary?
    public var compact = false
    public var expandsWidth = true
    public var title = "当前摘要"

    public init(summary: ConversationTaskSummary?, compact: Bool = false,
                expandsWidth: Bool = true, title: String = "当前摘要") {
        self.summary = summary
        self.compact = compact
        self.expandsWidth = expandsWidth
        self.title = title
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 7) {
            if !compact { Label(title, systemImage: "text.alignleft").font(.caption.weight(.semibold)).foregroundStyle(.secondary) }
            if let summary, summary.hasContent {
                if compact {
                    Text(summary.needsIntervention ? summary.nextAction : summary.focus)
                        .font(.system(size: 11)).lineLimit(2)
                        .foregroundStyle(summary.needsIntervention ? Color.orange : Color.secondary)
                } else {
                    Text(summary.focus).font(.system(size: 12, weight: .medium))
                    Text(summary.messageSummary?.isEmpty == false ? summary.messageSummary! : summary.progress)
                        .font(.system(size: 11)).foregroundStyle(.secondary)
                    if summary.needsIntervention {
                        Text("需要你：\(summary.nextAction)").font(.system(size: 11, weight: .medium)).foregroundStyle(.orange)
                        Text(summary.reason).font(.system(size: 10)).foregroundStyle(.secondary)
                    } else if summary.isCurrent {
                        Text(summary.intervention == "attention" ? "只需关注，无需操作" : summary.intervention == "not_required" ? "无需操作" : "是否需要介入尚未明确")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    if let retainedReason = summary.retainedReason, summary.basisTaskRevision == summary.taskRevision {
                        Text("上次关注尚未确认解决：\(retainedReason)")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    Text("更新：\(summary.generatedAt)").font(.system(size: 9)).foregroundStyle(.tertiary).lineLimit(1)
                        .help("来源：\(summary.sourceRefs.joined(separator: "\n"))")
                }
                if !summary.stateLabel.isEmpty {
                    Text(summary.stateLabel).font(.system(size: 9)).foregroundStyle(.secondary)
                }
            } else if !compact {
                Text(summary?.stateLabel ?? "尚未生成摘要").font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: expandsWidth ? .infinity : nil, alignment: .leading)
    }
}

public struct ConversationTaskInformationCard<Actions: View>: View {
    public let summary: ConversationTaskSummary?
    public let description: String
    public let acceptance: String
    public let verification: String
    public let title: String
    public let summaryTitle: String
    public let descriptionTitle: String
    public let acceptanceTitle: String
    public let verificationTitle: String
    public let expandLabel: String
    public let collapseLabel: String
    public let showsWhenEmpty: Bool
    private let actions: Actions

    public init(summary: ConversationTaskSummary?, description: String?, acceptance: String?,
                verification: String?, title: String = "Task 信息", summaryTitle: String = "当前摘要",
                descriptionTitle: String = "描述", acceptanceTitle: String = "验收标准",
                verificationTitle: String = "验证标准", expandLabel: String = "展开",
                collapseLabel: String = "收起", showsWhenEmpty: Bool = false,
                @ViewBuilder actions: () -> Actions) {
        self.summary = summary
        self.description = description ?? ""
        self.acceptance = acceptance ?? ""
        self.verification = verification ?? ""
        self.title = title
        self.summaryTitle = summaryTitle
        self.descriptionTitle = descriptionTitle
        self.acceptanceTitle = acceptanceTitle
        self.verificationTitle = verificationTitle
        self.expandLabel = expandLabel
        self.collapseLabel = collapseLabel
        self.showsWhenEmpty = showsWhenEmpty
        self.actions = actions()
    }

    public var body: some View {
        if showsWhenEmpty || summary != nil || ConversationTaskDefinition.hasContent(
            description: description, acceptance: acceptance, verification: verification) {
            ConversationDetailModuleCard(title: title, systemImage: "checklist", headerActions: { actions }) {
                VStack(alignment: .leading, spacing: 14) {
                    ConversationTaskSummaryView(summary: summary, title: summaryTitle)
                    ConversationTaskDefinition(description: description, acceptance: acceptance, verification: verification,
                        descriptionTitle: descriptionTitle, acceptanceTitle: acceptanceTitle,
                        verificationTitle: verificationTitle, expandLabel: expandLabel, collapseLabel: collapseLabel)
                }
            }
        }
    }
}
