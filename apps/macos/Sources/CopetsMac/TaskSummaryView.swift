import SwiftUI

struct TaskUserSummary: Codable, Hashable {
    let state: String
    let content: Content?

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
        case "failed": return "摘要生成失败"
        case "ready" where isCurrent(for: task): return ""
        default: return content == nil ? "摘要待生成" : "旧摘要 · 待更新"
        }
    }
}

extension CorptieTask {
    var summaryNeedsIntervention: Bool {
        userSummary?.isCurrent(for: self) == true && userSummary?.content?.intervention == "required"
    }
}

/// Same persisted projection for the compact card and the information rail.
/// No network request, transcript access, polling, or per-card observation.
struct TaskSummaryView: View {
    let task: CorptieTask
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 7) {
            if !compact {
                Label("当前摘要", systemImage: "text.alignleft").detailRailSectionLabelStyle()
            }
            if let summary = task.userSummary, let content = summary.content, content.schemaVersion == 1 {
                if compact {
                    Text(task.summaryNeedsIntervention ? content.nextAction : content.focus)
                        .font(.system(size: 11)).lineLimit(2)
                        .foregroundStyle(task.summaryNeedsIntervention ? Color.orange : Color.secondary)
                } else {
                    Text(content.focus).font(.system(size: 12, weight: .medium))
                    Text(content.progress).font(.system(size: 11)).foregroundStyle(.secondary)
                    if task.summaryNeedsIntervention {
                        Text("需要你：\(content.nextAction)").font(.system(size: 11, weight: .medium)).foregroundStyle(.orange)
                        Text(content.reason).font(.system(size: 10)).foregroundStyle(.secondary)
                    } else if summary.isCurrent(for: task) {
                        Text(content.intervention == "not_required" ? "暂不需要介入" : "是否需要介入尚未明确")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    Text("更新：\(content.generatedAt)")
                        .font(.system(size: 9)).foregroundStyle(.tertiary).lineLimit(1)
                        .help("来源：\(content.sourceRefs.joined(separator: "\n"))")
                }
                if !summary.stateLabel(for: task).isEmpty {
                    Text(summary.stateLabel(for: task)).font(.system(size: 9)).foregroundStyle(.secondary)
                }
            } else if !compact {
                Text(task.userSummary?.stateLabel(for: task) ?? "尚未生成摘要")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
