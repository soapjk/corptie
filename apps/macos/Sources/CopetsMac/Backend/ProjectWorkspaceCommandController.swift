import Foundation

struct ProjectWorktreeIntegrationLaunchGate: Equatable {
    private(set) var isRunning = false

    mutating func begin() -> Bool {
        guard !isRunning else { return false }
        isRunning = true
        return true
    }

    mutating func finish() { isRunning = false }
}

/// Worktree and project-service commands share one in-flight and confirmation lifecycle.
@MainActor
final class ProjectWorkspaceCommandController: ObservableObject {
    @Published private(set) var worktreeCommitReviewPrompt: WorktreeCommitReviewPrompt?
    private var pendingProtectedWorktreeAction: (
        worktree: ProjectWorktreeStatus, action: String, body: [String: Any]
    )?
    private var completedWorktreeIntegrationGate = ProjectWorktreeIntegrationLaunchGate()

    private let baseURL: URL
    private let workspaceActionAPI: ProjectWorkspaceActionAPI
    private let workspaceStatusController: ProjectWorkspaceStatusController
    private let supplementary: SessionSupplementaryDataController
    private let commands: SessionCommandController
    private let currentSession: () -> TaskSession?
    private let projectID: (TaskSession) -> String?
    private let onCreatedSession: (TaskSession) -> Void
    private let closeDetail: () -> Void
    private let currentError: () -> String?
    private let reportError: (String?) -> Void
    private let errorMessage: (Data) -> String?

    private var selectedSession: TaskSession? { currentSession() }
    private var selectedProjectIntegrationStatus: ProjectIntegrationStatusResponse? {
        get { supplementary.selectedProjectIntegrationStatus }
        set { supplementary.selectedProjectIntegrationStatus = newValue }
    }
    private var workspaceRecoveryStatus: WorkspaceRecoveryStatus? {
        get { supplementary.workspaceRecoveryStatus }
        set { supplementary.workspaceRecoveryStatus = newValue }
    }
    private var isLoadingProjectWorktrees: Bool {
        get { supplementary.isLoadingProjectWorktrees }
        set { supplementary.isLoadingProjectWorktrees = newValue }
    }
    private var projectWorktreeActionError: String? {
        get { commands.projectWorktreeActionError }
        set { commands.projectWorktreeActionError = newValue }
    }
    private var projectWorktreeActionIds: Set<String> {
        get { commands.projectWorktreeActionIds }
        set { commands.projectWorktreeActionIds = newValue }
    }
    private var isCleaningMergedProjectWorktrees: Bool {
        get { commands.isCleaningMergedProjectWorktrees }
        set { commands.isCleaningMergedProjectWorktrees = newValue }
    }
    private var isIntegratingCompletedWorktrees: Bool {
        get { commands.isIntegratingCompletedWorktrees }
        set { commands.isIntegratingCompletedWorktrees = newValue }
    }
    private var isCreatingIntegrationConflictCorptieTask: Bool {
        get { commands.isCreatingIntegrationConflictCorptieTask }
        set { commands.isCreatingIntegrationConflictCorptieTask = newValue }
    }
    private var isRecoveringWorkspace: Bool {
        get { commands.isRecoveringWorkspace }
        set { commands.isRecoveringWorkspace = newValue }
    }
    private var isGeneratingWorktreeCommitMessage: Bool {
        get { commands.isGeneratingWorktreeCommitMessage }
        set { commands.isGeneratingWorktreeCommitMessage = newValue }
    }
    private var sendStatusMessage: String? {
        get { commands.sendStatusMessage }
        set { commands.sendStatusMessage = newValue }
    }
    private var lastError: String? {
        get { currentError() }
        set { reportError(newValue) }
    }

    init(baseURL: URL, workspaceActionAPI: ProjectWorkspaceActionAPI,
         workspaceStatusController: ProjectWorkspaceStatusController,
         supplementary: SessionSupplementaryDataController, commands: SessionCommandController,
         currentSession: @escaping () -> TaskSession?, projectID: @escaping (TaskSession) -> String?,
         onCreatedSession: @escaping (TaskSession) -> Void, closeDetail: @escaping () -> Void,
         currentError: @escaping () -> String?, reportError: @escaping (String?) -> Void,
         errorMessage: @escaping (Data) -> String?) {
        self.baseURL = baseURL
        self.workspaceActionAPI = workspaceActionAPI
        self.workspaceStatusController = workspaceStatusController
        self.supplementary = supplementary
        self.commands = commands
        self.currentSession = currentSession
        self.projectID = projectID
        self.onCreatedSession = onCreatedSession
        self.closeDetail = closeDetail
        self.currentError = currentError
        self.reportError = reportError
        self.errorMessage = errorMessage
    }

    private func projectId(for session: TaskSession) -> String? { projectID(session) }
    private func loadProjectWorktreeStatus(for session: TaskSession) async {
        await workspaceStatusController.loadProjectWorktreeStatus(for: session)
    }
    private func loadWorkspaceStatus(for session: TaskSession) async {
        await workspaceStatusController.loadWorkspaceStatus(for: session)
    }
    func refreshWorkspaceRecoveryStatus(for session: TaskSession) async {
        await loadWorkspaceRecoveryStatus(for: session)
    }
    func clearWorktreeCommitReview() {
        worktreeCommitReviewPrompt = nil
        pendingProtectedWorktreeAction = nil
    }
    func dismissProjectWorktreeActionError() { projectWorktreeActionError = nil }
    func recordProjectWorktreeActionError(_ message: String) {
        projectWorktreeActionError = message
        lastError = message
    }
    private func beginProjectWorktreeAction() {
        projectWorktreeActionError = nil
        lastError = nil
    }

    func integrateCompletedWorktrees() {
        guard completedWorktreeIntegrationGate.begin() else {
            recordProjectWorktreeActionError(L10n("Worktree integration is already running."))
            return
        }
        guard let session = selectedSession else {
            completedWorktreeIntegrationGate.finish()
            recordProjectWorktreeActionError(L10n("Select a Session before starting Worktree integration."))
            return
        }
        guard let projectId = projectId(for: session) else {
            completedWorktreeIntegrationGate.finish()
            recordProjectWorktreeActionError(L10n("The selected Session is not attached to a repository workspace."))
            return
        }
        guard let workId = session.workId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !workId.isEmpty else {
            completedWorktreeIntegrationGate.finish()
            recordProjectWorktreeActionError(L10n("The selected Session is not attached to an Work."))
            return
        }
        beginProjectWorktreeAction()
        isIntegratingCompletedWorktrees = true
        Task {
            defer {
                completedWorktreeIntegrationGate.finish()
                isIntegratingCompletedWorktrees = false
            }
            do {
                var request = URLRequest(url: baseURL.appending(
                    path: "projects/\(projectId)/works/\(workId)/integrations"
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        errorMessage(data) ?? L10n("Could not integrate completed Worktrees.")
                    )
                }
                selectedProjectIntegrationStatus = try JSONDecoder().decode(
                    ProjectIntegrationStatusResponse.self,
                    from: data
                )
                let counts = selectedProjectIntegrationStatus?.latestRun?.counts
                sendStatusMessage = L10nFormat(
                    "Integrated %d Worktrees; %d have conflicts; %d failed",
                    counts?.integrated ?? 0,
                    counts?.conflicts ?? 0,
                    counts?.failed ?? 0
                )
                if let failed = counts?.failed, failed > 0 {
                    recordProjectWorktreeActionError(L10nFormat(
                        "Integration finished with %d failed Worktrees. Review the failure details below.",
                        failed
                    ))
                }
                await loadProjectWorktreeStatus(for: session)
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func createIntegrationConflictCorptieTask(runId: String, agentId: String, title: String? = nil) {
        guard let session = selectedSession,
              let projectId = projectId(for: session),
              let workId = session.workId,
              !isCreatingIntegrationConflictCorptieTask else { return }
        Task {
            beginProjectWorktreeAction()
            isCreatingIntegrationConflictCorptieTask = true
            defer { isCreatingIntegrationConflictCorptieTask = false }
            do {
                var request = URLRequest(url: baseURL.appending(
                    path: "projects/\(projectId)/works/\(workId)/integrations/\(runId)/conflict-task"
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = ["agentId": agentId]
                if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    body["title"] = title
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        errorMessage(data) ?? L10n("Could not create the conflict-resolution CorptieTask.")
                    )
                }
                let result = try JSONDecoder().decode(
                    ProjectIntegrationConflictCorptieTaskResponse.self,
                    from: data
                )
                if var current = selectedProjectIntegrationStatus {
                    current = ProjectIntegrationStatusResponse(
                        projectId: current.projectId,
                        work: current.work,
                        mainHeadOid: current.mainHeadOid,
                        eligibleWorktrees: current.eligibleWorktrees,
                        excludedWorktrees: current.excludedWorktrees,
                        eligibleAgents: current.eligibleAgents,
                        latestRun: result.run
                    )
                    selectedProjectIntegrationStatus = current
                }
                if let createdSession = result.session {
                    onCreatedSession(createdSession)
                }
                sendStatusMessage = result.reused
                    ? L10n("Opened the existing conflict-resolution CorptieTask")
                    : L10n("Created and started the conflict-resolution CorptieTask")
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    private func loadWorkspaceRecoveryStatus(for session: TaskSession) async {
        await workspaceStatusController.loadWorkspaceRecoveryStatus(for: session)
    }

    func recoverSelectedWorkspace(action: String, targetWorktreeId: String? = nil) {
        guard let session = selectedSession, !isRecoveringWorkspace else { return }
        Task {
            isRecoveringWorkspace = true
            lastError = nil
            defer { isRecoveringWorkspace = false }
            do {
                try await workspaceActionAPI.recover(
                    sessionID: session.id, action: action, targetWorktreeID: targetWorktreeId
                )
                workspaceRecoveryStatus = nil
                sendStatusMessage = action == "rebuild"
                    ? L10n("Workspace rebuilt")
                    : L10n("Session switched to an available Worktree")
                await loadWorkspaceStatus(for: session)
            } catch {
                lastError = error.localizedDescription
                await loadWorkspaceRecoveryStatus(for: session)
            }
        }
    }

    func initializeProjectToolset(update: Bool = false) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let action = update ? "update" : "initialize"
        Task {
            beginProjectWorktreeAction()
            isLoadingProjectWorktrees = true
            defer { isLoadingProjectWorktrees = false }
            do {
                try await workspaceActionAPI.serviceAction(
                    projectID: projectId, action: action,
                    fallback: L10n("Could not initialize project tools.")
                )
                sendStatusMessage = update
                    ? L10n("Project tools update started")
                    : L10n("Project tools initialization started")
                try? await Task.sleep(for: .seconds(1))
                await loadProjectWorktreeStatus(for: session)
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func runProjectServiceAction(_ action: String) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let actionId = "service:\(action)"
        Task {
            beginProjectWorktreeAction()
            projectWorktreeActionIds.insert(actionId)
            defer { projectWorktreeActionIds.remove(actionId) }
            do {
                try await workspaceActionAPI.serviceAction(
                    projectID: projectId, action: action,
                    fallback: L10n("Project service action failed.")
                )
                await loadProjectWorktreeStatus(for: session)
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func selectProjectServiceProfile(_ profileId: String) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let actionId = "service:profile"
        Task {
            beginProjectWorktreeAction()
            projectWorktreeActionIds.insert(actionId)
            defer { projectWorktreeActionIds.remove(actionId) }
            do {
                try await workspaceActionAPI.serviceAction(
                    projectID: projectId, action: "profile", body: ["profileId": profileId],
                    fallback: L10n("Could not update the service profile.")
                )
                await loadProjectWorktreeStatus(for: session)
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func mergeProjectWorktree(_ worktree: ProjectWorktreeStatus, restartService: Bool) {
        performProtectedProjectWorktreeAction(
            worktree,
            action: "merge",
            body: ["restartService": restartService]
        )
    }

    func restartProjectService(from worktree: ProjectWorktreeStatus) {
        performProjectWorktreeAction(
            worktree,
            action: "restart",
            body: [:]
        )
    }

    func commitProjectWorktreeChanges(_ worktree: ProjectWorktreeStatus) {
        performProtectedProjectWorktreeAction(worktree, action: "commit", body: [:])
    }

    private func performProtectedProjectWorktreeAction(
        _ worktree: ProjectWorktreeStatus,
        action: String,
        body: [String: Any]
    ) {
        let actionMayCommit = action == "commit"
            || action == "merge"
            || action == "complete"
            || (action == "operate" && body["mergeIntoMain"] as? Bool == true)
        guard worktree.dirty == true, actionMayCommit else {
            performProjectWorktreeAction(worktree, action: action, body: body)
            return
        }
        guard let session = selectedSession else { return }
        Task {
            beginProjectWorktreeAction()
            projectWorktreeActionIds.insert(worktree.worktreeId)
            defer { projectWorktreeActionIds.remove(worktree.worktreeId) }
            do {
                var request = URLRequest(url: baseURL.appending(
                    path: "sessions/\(session.id)/project-worktrees/\(worktree.worktreeId)/commit-prepare"
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(errorMessage(data) ?? L10n("Could not inspect commit contents."))
                }
                let protection = try JSONDecoder().decode(GitCommitProtectionStatus.self, from: data)
                pendingProtectedWorktreeAction = (worktree, action, body)
                worktreeCommitReviewPrompt = WorktreeCommitReviewPrompt(
                    worktree: worktree,
                    protection: protection,
                    operation: Self.commitReviewOperation(for: action)
                )
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func confirmProtectedWorktreeCommit(
        commitMessage: String,
        decision: String,
        neverRemindPrivateFiles: Bool
    ) {
        guard worktreeCommitReviewPrompt != nil,
              let pending = pendingProtectedWorktreeAction else { return }
        worktreeCommitReviewPrompt = nil
        pendingProtectedWorktreeAction = nil
        var body = pending.body
        body["commitMessage"] = commitMessage
        body["privateFilesDecision"] = decision
        body["neverRemindPrivateFiles"] = neverRemindPrivateFiles
        performProjectWorktreeAction(
            pending.worktree,
            action: pending.action,
            body: body
        )
    }

    func cancelProtectedWorktreeCommit() {
        worktreeCommitReviewPrompt = nil
        pendingProtectedWorktreeAction = nil
    }

    func generateWorktreeCommitMessage() async -> String? {
        guard let session = selectedSession,
              let prompt = worktreeCommitReviewPrompt,
              !isGeneratingWorktreeCommitMessage else { return nil }
        isGeneratingWorktreeCommitMessage = true
        beginProjectWorktreeAction()
        defer { isGeneratingWorktreeCommitMessage = false }
        do {
            var request = URLRequest(url: baseURL.appending(
                path: "sessions/\(session.id)/project-worktrees/\(prompt.worktree.worktreeId)/commit-message"
            ))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = Data("{}".utf8)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(
                    errorMessage(data) ?? L10n("Could not generate commit message.")
                )
            }
            let result = try JSONDecoder().decode(GitHubCommitMessageSuggestion.self, from: data)
            guard worktreeCommitReviewPrompt?.id == prompt.id else { return nil }
            return result.commitMessage
        } catch {
            recordProjectWorktreeActionError(error.localizedDescription)
            return nil
        }
    }

    private static func commitReviewOperation(for action: String) -> WorktreeCommitReviewOperation {
        switch action {
        case "commit": .commit
        case "merge": .merge
        case "complete": .complete
        default: .operate
        }
    }

    func operateProjectWorktree(
        _ worktree: ProjectWorktreeStatus,
        mergeIntoMain: Bool,
        synchronizeWithMain: Bool,
        deleteWorktree: Bool,
        deleteSessions: Bool,
        restartService: Bool,
        forceDeleteUnmerged: Bool = false,
        confirmedBranchName: String? = nil
    ) {
        var body: [String: Any] = [
            "mergeIntoMain": mergeIntoMain,
            "synchronizeWithMain": synchronizeWithMain,
            "deleteWorktree": deleteWorktree,
            "deleteSessions": deleteSessions,
            "restartService": restartService
        ]
        if forceDeleteUnmerged, let confirmedBranchName {
            body["forceDeleteUnmerged"] = true
            body["acknowledgeIrrecoverable"] = true
            body["confirmedBranchName"] = confirmedBranchName
        }
        performProtectedProjectWorktreeAction(
            worktree,
            action: "operate",
            body: body
        )
    }

    func synchronizeProjectWorktree(_ worktree: ProjectWorktreeStatus) {
        let needsMerge = worktree.dirty == true || worktree.mergedIntoMain != true
        operateProjectWorktree(
            worktree,
            mergeIntoMain: needsMerge,
            synchronizeWithMain: true,
            deleteWorktree: false,
            deleteSessions: false,
            restartService: false
        )
    }

    func completeProjectWorktree(_ worktree: ProjectWorktreeStatus, restartService: Bool = true) {
        performProtectedProjectWorktreeAction(
            worktree,
            action: "complete",
            body: [
                "restartService": restartService,
                "deleteSessions": true,
                "deleteBranch": true
            ]
        )
    }

    func cleanupMergedProjectWorktrees(_ worktrees: [ProjectWorktreeStatus]) {
        guard !worktrees.isEmpty,
              let session = selectedSession,
              let projectId = projectId(for: session),
              !isCleaningMergedProjectWorktrees else { return }
        let worktreeIds = Set(worktrees.map(\.worktreeId))
        Task {
            beginProjectWorktreeAction()
            isCleaningMergedProjectWorktrees = true
            projectWorktreeActionIds.formUnion(worktreeIds)
            defer {
                projectWorktreeActionIds.subtract(worktreeIds)
                isCleaningMergedProjectWorktrees = false
            }

            var removedCount = 0
            var failures: [String] = []
            for worktree in worktrees {
                do {
                    try await workspaceActionAPI.deleteMergedWorktree(
                        projectID: projectId, worktreeID: worktree.worktreeId
                    )
                    removedCount += 1
                } catch {
                    let name = worktree.branchName ?? worktree.path
                    failures.append("\(name): \(error.localizedDescription)")
                }
            }

            if failures.isEmpty {
                sendStatusMessage = L10nFormat("Removed %d merged Worktrees", removedCount)
            } else {
                recordProjectWorktreeActionError(L10nFormat(
                    "Removed %d Worktrees; %d could not be removed:\n%@",
                    removedCount,
                    failures.count,
                    failures.joined(separator: "\n")
                ))
            }
            if selectedSession?.id == session.id {
                await loadProjectWorktreeStatus(for: session)
            }
        }
    }

    private func performProjectWorktreeAction(
        _ worktree: ProjectWorktreeStatus,
        action: String,
        body: [String: Any]
    ) {
        guard let session = selectedSession else { return }
        Task {
            beginProjectWorktreeAction()
            projectWorktreeActionIds.insert(worktree.worktreeId)
            defer { projectWorktreeActionIds.remove(worktree.worktreeId) }
            do {
                let result = try await workspaceActionAPI.worktreeAction(
                    sessionID: session.id, projectID: projectId(for: session),
                    worktreeID: worktree.worktreeId, action: action, body: body
                )
                if action == "commit" {
                    sendStatusMessage = L10n("Worktree changes committed")
                }
                if result?.deletedSessionIds?.contains(session.id) == true {
                    closeDetail()
                }
                if selectedSession?.id == session.id {
                    await loadProjectWorktreeStatus(for: session)
                }
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }
}
