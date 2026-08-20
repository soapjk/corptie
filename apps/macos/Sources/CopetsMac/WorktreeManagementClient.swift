import Foundation
import OSLog

@MainActor
final class WorktreeManagementClient: ObservableObject {
    @Published private(set) var repositories: [ManagedRepository] = []
    @Published private(set) var detail: ManagedRepositoryDetail?
    @Published private(set) var projectStatus: ProjectDevelopmentServiceStatus?
    @Published private(set) var job: WorktreeIntegrationJob?
    @Published var selection = WorktreeManagementSelection()
    @Published private(set) var isLoading = false
    @Published private(set) var isMutating = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var listLoadState: WorktreeListLoadState = .idle
    @Published private(set) var lastLoadMetrics: WorktreeLoadMetrics?
    @Published var cleanupResult: WorktreeCleanupResult?
    @Published private(set) var cleanupProgress: WorktreeCleanupProgress?
    @Published private(set) var operationNotice: String?

    private let baseURL: URL
    private let session: URLSession
    private let cacheLifetime: TimeInterval
    private let now: () -> Date
    private var detailGeneration = 0
    private var detailCache: [String: CachedRepositoryDetail] = [:]
    private var repositoryListMilliseconds = 0
    private let logger = Logger(subsystem: "com.corptie.mac", category: "WorktreeLoad")
    private let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    init(
        baseURL: URL = CorptieAppEnvironment.backendBaseURL,
        session: URLSession = .shared,
        cacheLifetime: TimeInterval = 15,
        now: @escaping () -> Date = Date.init
    ) {
        self.baseURL = baseURL
        self.session = session
        self.cacheLifetime = cacheLifetime
        self.now = now
    }

    var selectedWorktree: ManagedWorktree? {
        detail?.project.worktrees.first { $0.worktreeId == selection.worktreeId }
    }

    func loadRepositories(forceSelectedReload: Bool = false) async {
        let startedAt = now()
        isLoading = true
        defer { isLoading = false }
        do {
            let envelope: ManagedRepositoryListEnvelope = try await get("worktree-management/repositories")
            repositoryListMilliseconds = milliseconds(since: startedAt)
            repositories = envelope.repositories
            selection.reconcile(repositories: repositories)
            errorMessage = nil
            if let repositoryId = selection.repositoryId {
                await loadRepository(repositoryId, force: forceSelectedReload)
            } else {
                detail = nil
                projectStatus = nil
                job = nil
                listLoadState = .idle
            }
        } catch {
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
            if detail == nil { listLoadState = .failed(error.localizedDescription) }
        }
    }

    func selectRepository(_ id: String?) async {
        guard selection.repositoryId != id else { return }
        selection.repositoryId = id
        selection.worktreeId = nil
        detail = nil
        projectStatus = nil
        job = nil
        listLoadState = id == nil ? .idle : .loading
        guard let id else { return }
        await loadRepository(id)
    }

    func refreshSelected() async {
        guard let repositoryId = selection.repositoryId else {
            await loadRepositories()
            return
        }
        await loadRepository(repositoryId, force: true)
    }

    @discardableResult
    func navigate(to target: WorktreeNavigationTarget) async -> Bool {
        // Refresh the selected detail so a Session Worktree created after this
        // persistent tab was preloaded is available for ID/path matching.
        await loadRepositories(forceSelectedReload: true)
        if let repositoryId = target.repositoryId {
            guard repositories.contains(where: { $0.id == repositoryId }) else { return false }
            if selection.repositoryId != repositoryId {
                await selectRepository(repositoryId)
            } else if detail == nil {
                await loadRepository(repositoryId)
            }
        }
        guard let worktrees = detail?.project.worktrees else { return false }
        return selection.select(target: target, worktrees: worktrees)
    }

    func synchronizeSelectedWorktree() async {
        guard let repositoryId = selection.repositoryId,
              let worktreeId = selection.worktreeId else { return }
        await mutate {
            let _: WorktreeActionAcknowledgement = try await self.post(
                "projects/\(repositoryId)/workspaces/\(worktreeId)/actions/synchronize",
                body: [:]
            )
            await self.loadRepository(repositoryId, force: true)
        }
    }

    @discardableResult
    func deleteWorktree(_ worktree: ManagedWorktree) async -> Bool {
        guard let repositoryId = selection.repositoryId else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let envelope: WorktreeDeletionResultEnvelope = try await post(
                "worktree-management/repositories/\(repositoryId)/worktrees/\(worktree.worktreeId)/delete",
                body: [:]
            )
            operationNotice = "Removed \(envelope.result.branchName ?? envelope.result.path) and its local branch."
            errorMessage = nil
            await loadRepository(repositoryId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func cleanupMergedWorktrees(_ worktrees: [ManagedWorktree]) async {
        guard let repositoryId = selection.repositoryId,
              let project = detail?.project,
              !worktrees.isEmpty else { return }
        isMutating = true
        defer {
            cleanupProgress = nil
            isMutating = false
        }

        let confirmedIds = Set(worktrees.map(\.worktreeId))
        var removed: [WorktreeDeletionResult] = []
        var skipped = project.worktrees.compactMap { worktree -> WorktreeDeletionResult? in
            guard !worktree.isMain,
                  !confirmedIds.contains(worktree.worktreeId),
                  let blocker = ManagedWorktreeDeletionPolicy.blocker(for: worktree) else { return nil }
            return WorktreeDeletionResult(
                worktreeId: worktree.worktreeId,
                branchName: worktree.branchName,
                path: worktree.path,
                status: "skipped",
                code: blocker.code,
                reason: blocker.reason
            )
        }
        var failed: [WorktreeDeletionResult] = []

        for (offset, worktree) in worktrees.enumerated() {
            cleanupProgress = .deleting(
                worktree,
                mainPath: project.mainPath,
                currentIndex: offset + 1,
                total: worktrees.count
            )
            do {
                let envelope: WorktreeDeletionResultEnvelope = try await post(
                    "worktree-management/repositories/\(repositoryId)/worktrees/\(worktree.worktreeId)/delete",
                    body: [:]
                )
                removed.append(envelope.result)
            } catch {
                let clientError = error as? WorktreeManagementClientError
                let code = clientError?.code ?? "WORKTREE_DELETE_FAILED"
                let result = WorktreeDeletionResult(
                    worktreeId: worktree.worktreeId,
                    branchName: worktree.branchName,
                    path: worktree.path,
                    status: Self.deletionBlockerCodes.contains(code) ? "skipped" : "failed",
                    code: code,
                    reason: clientError?.message ?? error.localizedDescription
                )
                if Self.deletionBlockerCodes.contains(code) {
                    skipped.append(result)
                } else {
                    failed.append(result)
                }
            }
        }

        cleanupResult = WorktreeCleanupResult(
            removed: removed,
            skipped: skipped,
            failed: failed,
            counts: WorktreeCleanupCounts(
                removed: removed.count,
                skipped: skipped.count,
                failed: failed.count
            )
        )
        errorMessage = nil
        await loadRepository(repositoryId)
    }

    func prepareIndividualOperation(
        for worktree: ManagedWorktree
    ) async -> IndividualWorktreeOperationPreparation? {
        guard let repositoryId = selection.repositoryId else { return nil }
        guard worktree.dirty == true else {
            return IndividualWorktreeOperationPreparation(commitMessage: nil, protection: nil)
        }
        isMutating = true
        defer { isMutating = false }
        do {
            let protection: ProjectWorkspaceActionEnvelope<GitCommitProtectionStatus> = try await post(
                "projects/\(repositoryId)/workspaces/\(worktree.worktreeId)/actions/commit-prepare",
                body: [:]
            )
            let message: ProjectWorkspaceActionEnvelope<WorktreeCommitMessageResult> = try await post(
                "projects/\(repositoryId)/workspaces/\(worktree.worktreeId)/actions/commit-message",
                body: [:]
            )
            errorMessage = nil
            return IndividualWorktreeOperationPreparation(
                commitMessage: message.result.commitMessage,
                protection: protection.result
            )
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func executeIndividualOperation(
        worktree: ManagedWorktree,
        mergeIntoMain: Bool,
        synchronizeWithMain: Bool,
        restartService: Bool,
        commitMessage: String?,
        privateFilesDecision: String?,
        neverRemindPrivateFiles: Bool
    ) async -> Bool {
        guard let repositoryId = selection.repositoryId else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            if mergeIntoMain {
                var body: [String: Any] = ["synchronizeSource": synchronizeWithMain]
                if let commitMessage { body["commitMessage"] = commitMessage }
                if let privateFilesDecision { body["privateFilesDecision"] = privateFilesDecision }
                body["neverRemindPrivateFiles"] = neverRemindPrivateFiles
                let _: WorktreeActionAcknowledgement = try await post(
                    "projects/\(repositoryId)/workspaces/\(worktree.worktreeId)/actions/merge",
                    body: body
                )
            } else if synchronizeWithMain {
                let _: WorktreeActionAcknowledgement = try await post(
                    "projects/\(repositoryId)/workspaces/\(worktree.worktreeId)/actions/synchronize",
                    body: [:]
                )
            }
            if restartService {
                let _: WorktreeActionAcknowledgement = try await post(
                    "projects/\(repositoryId)/workspaces/\(worktree.worktreeId)/actions/restart",
                    body: [:]
                )
            }
            await loadRepository(repositoryId, force: true)
            errorMessage = nil
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func runDevelopmentServiceAction(_ action: String, profileId: String? = nil) async {
        guard let repositoryId = selection.repositoryId else { return }
        await mutate {
            var body: [String: Any] = [:]
            if let profileId { body["profileId"] = profileId }
            let _: WorktreeActionAcknowledgement = try await self.post(
                "projects/\(repositoryId)/development-service/actions/\(action)",
                body: body
            )
            await self.loadRepository(repositoryId, force: true)
        }
    }

    func createPreflight() async {
        guard let repositoryId = selection.repositoryId else { return }
        await mutate {
            let envelope: WorktreeIntegrationJobEnvelope = try await self.post(
                "worktree-management/repositories/\(repositoryId)/integration-plans",
                body: [:]
            )
            self.job = envelope.job
        }
    }

    func confirmPlan() async {
        guard let job, job.status == "awaiting_confirmation" else { return }
        await mutate {
            let envelope: WorktreeIntegrationJobEnvelope = try await self.post(
                "worktree-management/jobs/\(job.id)/confirm",
                body: ["confirmed": true, "planFingerprint": job.planFingerprint]
            )
            self.job = envelope.job
        }
    }

    func retryJob() async {
        guard let job, job.status == "paused" else { return }
        await mutate {
            let envelope: WorktreeIntegrationJobEnvelope = try await self.post(
                "worktree-management/jobs/\(job.id)/retry",
                body: [:]
            )
            self.job = envelope.job
        }
    }

    @discardableResult
    func resolveConflictWithAgent() async -> String? {
        guard let job, job.hasMergeConflict else { return nil }
        isMutating = true
        defer { isMutating = false }
        do {
            let envelope: WorktreeIntegrationJobEnvelope = try await post(
                "worktree-management/jobs/\(job.id)/resolve-conflict",
                body: [:]
            )
            self.job = envelope.job
            errorMessage = nil
            await AppStateSyncController.shared.refreshSnapshot()
            return envelope.job.currentConflictResolution?.sessionId
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    @discardableResult
    func regeneratePlan() async -> Bool {
        guard let staleJob = job,
              staleJob.requiresPlanRegeneration,
              selection.repositoryId != nil else { return false }
        isMutating = true
        defer { isMutating = false }
        do {
            let fresh: WorktreeIntegrationJobEnvelope = try await post(
                "worktree-management/jobs/\(staleJob.id)/cancel",
                body: ["replan": true]
            )
            job = fresh.job
            errorMessage = nil
            return fresh.job.status == "awaiting_confirmation"
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func stopAndRepreflight() async {
        guard let job, job.canStopAndRepreflight else { return }
        await mutate {
            let envelope: WorktreeIntegrationJobEnvelope = try await self.post(
                "worktree-management/jobs/\(job.id)/cancel",
                body: ["replan": true]
            )
            self.job = envelope.job
        }
    }

    func pollJob() async {
        guard let current = job, current.shouldPoll else { return }
        do {
            let envelope: WorktreeIntegrationJobEnvelope = try await get(
                "worktree-management/jobs/\(current.id)"
            )
            job = envelope.job
            if !envelope.job.isActive { await refreshSelected() }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func dismissError() { errorMessage = nil }
    func dismissOperationNotice() { operationNotice = nil }

    private func loadRepository(_ id: String, force: Bool = false) async {
        if !force, let cached = detailCache[id], now().timeIntervalSince(cached.loadedAt) < cacheLifetime {
            apply(cached, repositoryId: id)
            let metrics = WorktreeLoadMetrics(
                repositoryId: id,
                repositoryListMilliseconds: repositoryListMilliseconds,
                detailMilliseconds: 0,
                serviceMilliseconds: 0,
                listAvailableMilliseconds: repositoryListMilliseconds,
                cacheHit: true
            )
            lastLoadMetrics = metrics
            log(metrics)
            return
        }
        detailGeneration &+= 1
        let generation = detailGeneration
        let startedAt = now()
        listLoadState = .loading
        isLoading = true
        defer { if generation == detailGeneration { isLoading = false } }
        do {
            async let detailRequest: ManagedRepositoryDetail = get("worktree-management/repositories/\(id)")
            async let serviceRequest: ProjectDevelopmentServiceStatus? = try? get("projects/\(id)/development-service")
            let response = try await detailRequest
            let detailMilliseconds = milliseconds(since: startedAt)
            guard generation == detailGeneration, selection.repositoryId == id else { return }
            detail = response
            job = response.latestJob
            selection.reconcile(repositories: repositories, worktrees: response.project.worktrees)
            listLoadState = .loaded
            errorMessage = nil
            detailCache[id] = CachedRepositoryDetail(
                detail: response,
                projectStatus: projectStatus,
                loadedAt: now()
            )
            let refreshedProjectStatus = await serviceRequest
            let serviceMilliseconds = milliseconds(since: startedAt)
            guard generation == detailGeneration, selection.repositoryId == id else { return }
            projectStatus = refreshedProjectStatus
            let cached = CachedRepositoryDetail(
                detail: response,
                projectStatus: refreshedProjectStatus,
                loadedAt: now()
            )
            detailCache[id] = cached
            let metrics = WorktreeLoadMetrics(
                repositoryId: id,
                repositoryListMilliseconds: repositoryListMilliseconds,
                detailMilliseconds: detailMilliseconds,
                serviceMilliseconds: serviceMilliseconds,
                listAvailableMilliseconds: repositoryListMilliseconds + detailMilliseconds,
                cacheHit: false
            )
            lastLoadMetrics = metrics
            log(metrics)
        } catch {
            guard !Self.isCancellation(error) else { return }
            guard generation == detailGeneration else { return }
            if detail?.repository.id != id {
                detail = nil
                projectStatus = nil
                job = nil
                selection.worktreeId = nil
            }
            errorMessage = error.localizedDescription
            listLoadState = .failed(error.localizedDescription)
        }
    }

    private func apply(_ cached: CachedRepositoryDetail, repositoryId: String) {
        guard selection.repositoryId == repositoryId else { return }
        detail = cached.detail
        projectStatus = cached.projectStatus
        job = cached.detail.latestJob
        selection.reconcile(repositories: repositories, worktrees: cached.detail.project.worktrees)
        listLoadState = .loaded
        errorMessage = nil
    }

    private func milliseconds(since start: Date) -> Int {
        max(0, Int(now().timeIntervalSince(start) * 1_000))
    }

    private func log(_ metrics: WorktreeLoadMetrics) {
        logger.info(
            "repository=\(metrics.repositoryId, privacy: .public) cacheHit=\(metrics.cacheHit) repositoriesMs=\(metrics.repositoryListMilliseconds) detailMs=\(metrics.detailMilliseconds) serviceMs=\(metrics.serviceMilliseconds) listAvailableMs=\(metrics.listAvailableMilliseconds)"
        )
    }

    private func mutate(_ operation: () async throws -> Void) async {
        isMutating = true
        defer { isMutating = false }
        do {
            try await operation()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func get<Response: Decodable>(_ path: String) async throws -> Response {
        try await request(path, method: "GET", body: nil)
    }

    private func post<Response: Decodable>(_ path: String, body: [String: Any]) async throws -> Response {
        try await request(path, method: "POST", body: body)
    }

    private func request<Response: Decodable>(
        _ path: String,
        method: String,
        body: [String: Any]?
    ) async throws -> Response {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { request.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await session.data(for: request)
        if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
            let envelope = try? decoder.decode(WorktreeManagementErrorEnvelope.self, from: data)
            throw WorktreeManagementClientError(
                message: envelope?.error ?? "HTTP \(http.statusCode)",
                code: envelope?.code
            )
        }
        return try decoder.decode(Response.self, from: data)
    }

    private static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        return (error as? URLError)?.code == .cancelled
    }

    private static let deletionBlockerCodes: Set<String> = [
        "MAIN_WORKTREE", "WORKTREE_UNAVAILABLE", "WORKTREE_LOCKED", "WORKTREE_PRUNABLE",
        "GIT_OPERATION_IN_PROGRESS", "UNRESOLVED_CONFLICTS", "UNCOMMITTED_CHANGES",
        "NOT_MERGED_INTO_MAIN", "WORKTREE_BRANCH_AMBIGUOUS", "WORK_ITEM_ASSOCIATED",
        "WORKTREE_IN_USE"
    ]
}

private struct CachedRepositoryDetail {
    let detail: ManagedRepositoryDetail
    let projectStatus: ProjectDevelopmentServiceStatus?
    let loadedAt: Date
}

private struct WorktreeActionAcknowledgement: Decodable {}

private struct ProjectWorkspaceActionEnvelope<Result: Decodable>: Decodable {
    let result: Result
}

private struct WorktreeCommitMessageResult: Decodable {
    let commitMessage: String
}

private struct WorktreeManagementErrorEnvelope: Decodable {
    let error: String
    let code: String?
}

private struct WorktreeManagementClientError: LocalizedError {
    let message: String
    let code: String?
    var errorDescription: String? { code.map { "\(message) (\($0))" } ?? message }
}
