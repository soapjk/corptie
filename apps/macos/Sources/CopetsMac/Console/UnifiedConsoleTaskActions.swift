import AppKit
import SwiftUI

extension UnifiedConsoleView {
    func setTaskArchived(_ archived: Bool, task: CorptieTask) async {
        guard await entityClient.setTaskArchived(archived, taskId: task.id) != nil else {
            taskArchiveError = entityClient.errorMessage ?? L10n("归档失败")
            return
        }
        if selectedTaskId == task.id {
            selectedTaskId = nil
            backendClient.closeDetail()
        }
        await backendClient.refreshArchivedSessions(sessionKind: .worker)
    }

    func restartTask(_ task: CorptieTask) {
        guard !pendingTaskRestartIds.contains(task.id) else { return }
        pendingTaskRestartIds.insert(task.id)
        Task {
            defer { pendingTaskRestartIds.remove(task.id) }
            guard await entityClient.restartCorptieTask(taskId: task.id) else {
                taskRestartError = entityClient.errorMessage ?? L10n("Could not restart Task.")
                return
            }
        }
    }

    func prepareTaskChat(_ task: CorptieTask) {
        guard !pendingTaskChatIds.contains(task.id) else { return }
        guard let agentId = task.mainAgentId,
              let providerId = modelCatalog.defaultSessionProviderId else {
            taskRestartError = L10n("无法准备聊天：请检查 Task 的 Agent 和默认 Provider 配置。")
            return
        }
        pendingTaskChatIds.insert(task.id)
        Task {
            defer { pendingTaskChatIds.remove(task.id) }
            let result = await entityClient.createSession(
                taskId: task.id, agentId: agentId, providerId: providerId,
                title: task.title, dispatchInitialTurn: false
            )
            guard let session = result.session else {
                taskRestartError = result.error?.message ?? L10n("无法准备聊天，请重试。")
                return
            }
            backendClient.acceptCreatedSession(session, selectImmediately: false)
            // A slow recovery must not steal selection after the user moves on.
            guard selectedTaskId == task.id, selectedCategory == .worker else { return }
            selectSessionAfterHighlight(session, focusComposer: true)
        }
    }

    func openTask(_ task: CorptieTask, session: TaskSession?) {
        cardSelectionExplicitlyCleared = false
        selectedWorkId = task.workId
        selectedCategory = .worker
        selectedTaskId = task.id
        switch ConsoleTaskOpenDecision.resolve(task: task, session: session) {
        case .selectSession:
            guard let session else { return }
            selectedCategory = .worker
            selectSessionAfterHighlight(session, focusComposer: true)
        case .showWithoutSession:
            backendClient.closeDetail()
        }
    }

    func deleteWork(_ work: Work) async {
        guard await entityClient.deleteWork(workId: work.id) else {
            workDeletionError = entityClient.errorMessage ?? L10n("Unable to delete Work.")
            return
        }
        outlineExpansionPreferences.removeWork(work.id)
        if selectedWorkId == work.id {
            selectedWorkId = entityClient.works.first?.id
            selectedTaskId = nil
            selectDefaultContentForCurrentSpace()
        }
    }

    func prepareTaskDeletion(_ task: CorptieTask) async {
        guard !pendingTaskDeletionIds.contains(task.id) else { return }
        pendingTaskDeletionIds.insert(task.id)
        defer { pendingTaskDeletionIds.remove(task.id) }
        guard let plan = await entityClient.inspectCorptieTaskDeletion(taskId: task.id) else {
            taskDeletionError = entityClient.errorMessage ?? L10n("无法检查 CorptieTask 的关联资源。")
            return
        }
        taskDeletionPresentation = CorptieTaskDeletionPresentation(task: task, plan: plan)
    }

    func deleteTask(
        _ task: CorptieTask,
        force: Bool,
        confirmedBranchName: String?,
        deleteWorktree: Bool,
        artifactDisposition: CorptieTaskArtifactDisposition
    ) {
        guard !pendingTaskDeletionIds.contains(task.id) else { return }
        taskDeletionPresentation = nil
        BackgroundTaskCenter.shared.start(
            id: "task.deletion.\(task.id)",
            title: L10nFormat("删除 CorptieTask：%@", task.title)
        ) {
            pendingTaskDeletionIds.insert(task.id)
            let deleted = await entityClient.deleteCorptieTask(
                taskId: task.id,
                force: force,
                confirmedBranchName: confirmedBranchName,
                deleteWorktree: deleteWorktree,
                artifactDisposition: artifactDisposition
            )
            pendingTaskDeletionIds.remove(task.id)
            if deleted {
                if selectedTaskId == task.id {
                    selectedTaskId = nil
                    selectDefaultContentForCurrentSpace()
                }
                return .success(L10nFormat("CorptieTask“%@”已删除。", task.title))
            }
            return .failure(entityClient.errorMessage ?? L10n("删除失败；资源状态已保留，可修复后安全重试。"))
        }
    }

    func workerSession(for task: CorptieTask) -> TaskSession? {
        ConsoleTaskSelectionPolicy.session(for: task, in: backendClient.sessions)
    }
}
