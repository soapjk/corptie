import Foundation

extension BackendClient {
    func refreshSelectedProjectWorktrees() async {
        guard let selectedSession else { return }
        await loadProjectWorktreeStatus(for: selectedSession)
    }

    func applicationDidBecomeActive() {
        guard let selectedSession else { return }
        startProjectStatusFallbackRefresh(for: selectedSession, refreshImmediately: true)
    }

    func applicationDidResignActive() {
        workspaceStatusController.stopRefreshing()
    }

    func startProjectStatusFallbackRefresh(for session: TaskSession, refreshImmediately: Bool) {
        workspaceStatusController.startProjectStatusFallbackRefresh(for: session, refreshImmediately: refreshImmediately)
    }

    func loadWorkspaceStatus(for session: TaskSession) async {
        await workspaceStatusController.loadWorkspaceStatus(for: session)
    }

    func scheduleSelectedProjectStatusEventRefresh(data: String) {
        workspaceStatusController.scheduleSelectedProjectStatusEventRefresh(data: data)
    }

    func prepareGitHubPush() {
        gitHubPushController.prepare()
    }

    func cancelGitHubPush() {
        gitHubPushController.cancel()
    }

    func generateGitHubCommitMessage() async -> String? {
        await gitHubPushController.generateCommitMessage()
    }

    func confirmGitHubPush(
        commitMessage: String? = nil,
        privateFilesDecision: String? = nil,
        neverRemindPrivateFiles: Bool = false
    ) {
        gitHubPushController.confirm(
            commitMessage: commitMessage,
            privateFilesDecision: privateFilesDecision,
            neverRemindPrivateFiles: neverRemindPrivateFiles
        )
    }

    func loadProjectWorktreeStatus(for session: TaskSession) async {
        await workspaceStatusController.loadProjectWorktreeStatus(for: session)
    }

    func integrateCompletedWorktrees() { projectWorkspaceCommandController.integrateCompletedWorktrees() }

    func createIntegrationConflictCorptieTask(runId: String, agentId: String, title: String? = nil) {
        projectWorkspaceCommandController.createIntegrationConflictCorptieTask(
            runId: runId, agentId: agentId, title: title
        )
    }

    func loadWorkspaceRecoveryStatus(for session: TaskSession) async {
        await projectWorkspaceCommandController.refreshWorkspaceRecoveryStatus(for: session)
    }

    func recoverSelectedWorkspace(action: String, targetWorktreeId: String? = nil) {
        projectWorkspaceCommandController.recoverSelectedWorkspace(
            action: action, targetWorktreeId: targetWorktreeId
        )
    }

    func initializeProjectToolset(update: Bool = false) {
        projectWorkspaceCommandController.initializeProjectToolset(update: update)
    }

    func runProjectServiceAction(_ action: String) {
        projectWorkspaceCommandController.runProjectServiceAction(action)
    }

    func selectProjectServiceProfile(_ profileId: String) {
        projectWorkspaceCommandController.selectProjectServiceProfile(profileId)
    }

    func mergeProjectWorktree(_ worktree: ProjectWorktreeStatus, restartService: Bool) {
        projectWorkspaceCommandController.mergeProjectWorktree(worktree, restartService: restartService)
    }

    func restartProjectService(from worktree: ProjectWorktreeStatus) {
        projectWorkspaceCommandController.restartProjectService(from: worktree)
    }

    func commitProjectWorktreeChanges(_ worktree: ProjectWorktreeStatus) {
        projectWorkspaceCommandController.commitProjectWorktreeChanges(worktree)
    }

    func confirmProtectedWorktreeCommit(
        commitMessage: String, decision: String, neverRemindPrivateFiles: Bool
    ) {
        projectWorkspaceCommandController.confirmProtectedWorktreeCommit(
            commitMessage: commitMessage, decision: decision,
            neverRemindPrivateFiles: neverRemindPrivateFiles
        )
    }

    func cancelProtectedWorktreeCommit() {
        projectWorkspaceCommandController.cancelProtectedWorktreeCommit()
    }

    func generateWorktreeCommitMessage() async -> String? {
        await projectWorkspaceCommandController.generateWorktreeCommitMessage()
    }

    func operateProjectWorktree(
        _ worktree: ProjectWorktreeStatus, mergeIntoMain: Bool, synchronizeWithMain: Bool,
        deleteWorktree: Bool, deleteSessions: Bool, restartService: Bool,
        forceDeleteUnmerged: Bool = false, confirmedBranchName: String? = nil
    ) {
        projectWorkspaceCommandController.operateProjectWorktree(
            worktree, mergeIntoMain: mergeIntoMain, synchronizeWithMain: synchronizeWithMain,
            deleteWorktree: deleteWorktree, deleteSessions: deleteSessions,
            restartService: restartService, forceDeleteUnmerged: forceDeleteUnmerged,
            confirmedBranchName: confirmedBranchName
        )
    }

    func synchronizeProjectWorktree(_ worktree: ProjectWorktreeStatus) {
        projectWorkspaceCommandController.synchronizeProjectWorktree(worktree)
    }

    func completeProjectWorktree(_ worktree: ProjectWorktreeStatus, restartService: Bool = true) {
        projectWorkspaceCommandController.completeProjectWorktree(worktree, restartService: restartService)
    }

    func cleanupMergedProjectWorktrees(_ worktrees: [ProjectWorktreeStatus]) {
        projectWorkspaceCommandController.cleanupMergedProjectWorktrees(worktrees)
    }
}
