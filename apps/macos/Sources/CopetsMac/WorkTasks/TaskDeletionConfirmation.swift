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
        _ deleteWorktree: Bool,
        _ artifactDisposition: CorptieTaskArtifactDisposition,
        _ options: ClientTaskDeletionOptions
    ) -> Void

    @State private var options = ClientTaskDeletionOptions()
    @State private var deleteWorktree = true
    @State private var artifactDisposition: CorptieTaskArtifactDisposition = .delete

    private var artifacts: [CorptieTaskDeletionArtifact] { plan.artifacts ?? [] }
    private var effectiveBlockers: [CorptieTaskDeletionRisk] {
        plan.blockers.filter { (deleteWorktree || TaskDeletionConfirmationPolicy.isTaskLevelBlocker($0.code)) && !options.resolves($0.code) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(
                L10n("删除 CorptieTask"),
                systemImage: "exclamationmark.triangle.fill"
            )
            .font(.title3.weight(.semibold))
            .foregroundStyle(Color.primary)

            Text(task.title).font(.headline)
            if plan.parentTaskId != nil {
                Text(L10n("删除此任务及其子任务；已合入父分支的代码不受影响。"))
                    .font(.callout).foregroundStyle(.secondary)
            }

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

            if plan.blockers.contains(where: { ["SESSION_BUSY", "TASK_BACKGROUND_WORK_RUNNING"].contains($0.code) }) {
                Toggle(L10n("停止关联会话和后台工作后删除"), isOn: $options.stopRunning)
            }
            if plan.blockers.contains(where: { $0.code == "START_IN_PROGRESS" }) {
                Toggle(L10n("中断启动后删除"), isOn: $options.cancelStartup)
            }
            if plan.blockers.contains(where: { $0.code == "SHARED_WITH_ACTIVE_TASK" }) {
                Toggle(L10n("一并删除共用 Worktree 的关联任务"), isOn: $options.deleteAssociatedTasks)
                Text((plan.associatedTaskIds ?? []).joined(separator: "\n")).font(.caption).foregroundStyle(.secondary)
            }
            if plan.blockers.contains(where: { $0.code == "ACTIVE_WORKTREE_INTEGRATION_JOB" }) {
                Toggle("取消占用的集成作业后删除", isOn: $options.cancelIntegration)
            }
            if !(plan.childTaskIds ?? []).isEmpty {
                Text(L10nFormat("将级联删除 %d 个子任务。", plan.childTaskIds?.count ?? 0)).font(.callout).foregroundStyle(.secondary)
            }
            HStack {
                Spacer()
                Button(L10n("取消"), role: .cancel, action: onCancel)
                Button(L10n(plan.recoveryAvailable == true ? "继续清理" : "删除"), role: .destructive) {
                    onDelete(true, deleteWorktree, artifactDisposition, options)
                }.disabled(!effectiveBlockers.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
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
