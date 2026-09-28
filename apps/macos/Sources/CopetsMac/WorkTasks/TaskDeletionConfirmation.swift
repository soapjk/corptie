import SwiftUI
import CorptieClientCore
import CorptieConversation

struct CorptieTaskDeletionConfirmationView: View {
    let task: CorptieTask
    let plan: CorptieTaskDeletionPlan
    let onCancel: () -> Void
    let onMergeFirst: () -> Void
    let onDelete: (
        _ force: Bool,
        _ branch: String?,
        _ deleteWorktree: Bool,
        _ artifactDisposition: CorptieTaskArtifactDisposition
    ) -> Void

    @State private var showForceConfirmation = false
    @State private var acknowledgesDataLoss = false
    @State private var deleteWorktree = true
    @State private var artifactDisposition: CorptieTaskArtifactDisposition = .delete

    private var artifacts: [CorptieTaskDeletionArtifact] { plan.artifacts ?? [] }
    private var effectiveBlockers: [CorptieTaskDeletionRisk] {
        deleteWorktree ? plan.blockers : plan.blockers.filter { $0.code == "START_IN_PROGRESS" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(
                showForceConfirmation ? L10n("二次确认强制删除") : L10n("删除 CorptieTask"),
                systemImage: "exclamationmark.triangle.fill"
            )
            .font(.title3.weight(.semibold))
            .foregroundStyle(showForceConfirmation ? Color.red : Color.primary)

            Text(task.title).font(.headline)

            Text(L10nFormat(
                "删除此 CorptieTask 将永久删除 %d 个关联会话及完整会话历史。Worktree 和 Artifact 将按下方选项处理。此操作无法撤销。",
                plan.associatedSessionCount
            ))
            .font(.callout.weight(.semibold))
            .foregroundStyle(.red)

            if let worktree = plan.worktree {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("关联的专属 Worktree")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(worktree.path).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Text(worktree.branchName ?? L10n("未知分支")).font(.system(.caption, design: .monospaced))
                }
                .padding(10)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
                Toggle(L10n("删除关联的 Worktree 和分支"), isOn: $deleteWorktree)
            } else {
                Text(L10n("此 CorptieTask 没有关联专属 Worktree；不会执行 Worktree 或分支清理。"))
                    .font(.callout).foregroundStyle(.secondary)
            }

            if !artifacts.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L10nFormat("Artifact 处理（%d 个）", artifacts.count))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Picker(L10n("Artifact 处理"), selection: $artifactDisposition) {
                        Text(L10n("删除")).tag(CorptieTaskArtifactDisposition.delete)
                        Text(L10n("移入 Work 层级")).tag(CorptieTaskArtifactDisposition.work)
                        Text(L10n("留在原地")).tag(CorptieTaskArtifactDisposition.retain)
                    }
                    .pickerStyle(.radioGroup)
                    ForEach(artifacts.prefix(5)) { artifact in
                        Text(artifact.title).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
            }

            if !effectiveBlockers.isEmpty {
                riskList(title: L10n("当前无法安全删除"), risks: effectiveBlockers, color: .red)
            }
            if deleteWorktree, !plan.risks.isEmpty {
                riskList(title: L10n("可能丢失的内容"), risks: plan.risks, color: .orange)
            }

            if showForceConfirmation {
                Text(L10n("强制删除将永久丢弃上述未提交修改、未跟踪文件和未合并提交，且无法从 Corptie 恢复。"))
                    .font(.callout.weight(.semibold)).foregroundStyle(.red)
                Toggle(L10n("我理解这些内容可能永久丢失"), isOn: $acknowledgesDataLoss)
            }

            HStack {
                Spacer()
                Button(L10n("取消"), role: .cancel, action: onCancel)
                if !showForceConfirmation, deleteWorktree, !plan.risks.isEmpty, effectiveBlockers.isEmpty {
                    Button(L10n("先合并"), action: onMergeFirst)
                    Button(L10n("强制删除"), role: .destructive) { showForceConfirmation = true }
                } else if showForceConfirmation {
                    Button(L10n("确认强制删除"), role: .destructive) {
                        onDelete(true, plan.worktree?.branchName, deleteWorktree, artifactDisposition)
                    }
                    .disabled(!acknowledgesDataLoss)
                } else if effectiveBlockers.isEmpty {
                    Button(L10n("确认删除"), role: .destructive) {
                        onDelete(false, nil, deleteWorktree, artifactDisposition)
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 520)
        .onChange(of: deleteWorktree) { _, enabled in
            if !enabled {
                showForceConfirmation = false
                acknowledgesDataLoss = false
            }
        }
    }

    private func riskList(title: String, risks: [CorptieTaskDeletionRisk], color: Color) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(color)
            ForEach(risks) { risk in
                VStack(alignment: .leading, spacing: 3) {
                    Label(risk.message, systemImage: "exclamationmark.circle")
                    ForEach((risk.files ?? []).prefix(8), id: \.self) { file in
                        Text(file).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
                .font(.callout)
            }
        }
    }
}
