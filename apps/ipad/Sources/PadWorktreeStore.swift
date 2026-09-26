import Foundation
import Observation
import CorptieClientCore

@MainActor @Observable
final class PadWorktreeStore {
    var detail: ClientManagedRepositoryDetail?
    var service: ClientDevelopmentServiceStatus?
    var job: ClientWorktreeJob?
    var pushStatuses: [String: ClientGitHubPushStatus] = [:]
    var selectedWorktreeID: String?
    var loading = false
    var busyWorktreeIDs: Set<String> = []
    var serviceBusy = false
    var planning = false
    var errorMessage: String?
    var notice: String?
    private var generation = 0
    private var polling: Task<Void, Never>?

    var selectedWorktree: ClientManagedWorktree? {
        detail?.project.worktrees.first { $0.worktreeId == selectedWorktreeID }
    }

    func reset() {
        generation += 1
        polling?.cancel(); polling = nil
        detail = nil; service = nil; job = nil; pushStatuses = [:]; selectedWorktreeID = nil
        loading = false; busyWorktreeIDs = []; serviceBusy = false; planning = false
        errorMessage = nil; notice = nil
    }

    func load(_ repositoryID: String, connection: PadConnection, force: Bool = false) async {
        generation += 1
        let token = generation
        loading = true
        errorMessage = nil
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            async let loadedDetail = api.repository(repositoryID, forceFresh: force)
            async let loadedService = api.developmentService(repositoryID)
            let next = try await loadedDetail
            let status = try await loadedService
            guard token == generation, !Task.isCancelled else { return }
            if selectedWorktreeID == nil || !next.project.worktrees.contains(where: { $0.worktreeId == selectedWorktreeID }) {
                selectedWorktreeID = next.project.worktrees.first(where: \.isMain)?.worktreeId
                    ?? next.project.worktrees.first?.worktreeId
            }
            if let selectedWorktreeID {
                pushStatuses[selectedWorktreeID] = try? await api.pushStatus(
                    repositoryId: repositoryID, worktreeId: selectedWorktreeID)
            }
            detail = next
            service = status
            job = next.latestJob
            startPollingIfNeeded(repositoryID, connection: connection)
        } catch {
            guard token == generation, !Task.isCancelled else { return }
            errorMessage = PadControlStore.explain(error)
        }
        if token == generation { loading = false }
    }

    func select(_ id: String, connection: PadConnection) async {
        selectedWorktreeID = id
        guard let repositoryID = detail?.repository.id else { return }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            let status = try await api.pushStatus(repositoryId: repositoryID, worktreeId: id)
            guard selectedWorktreeID == id else { return }
            pushStatuses[id] = status
        } catch { /* Push availability is supplementary. */ }
    }

    func synchronize(_ worktree: ClientManagedWorktree, connection: PadConnection) async {
        await action(worktree, connection: connection) { api, repositoryID in
            try await api.workspaceAction(repositoryId: repositoryID, worktreeId: worktree.worktreeId,
                                          action: "synchronize")
            return "已与主分支同步"
        }
    }

    func push(_ worktree: ClientManagedWorktree, connection: PadConnection) async {
        await action(worktree, connection: connection) { api, repositoryID in
            let result = try await api.push(repositoryId: repositoryID, worktreeId: worktree.worktreeId)
            return "已将 \(result.branch) 推送到 \(result.destinationUrl)"
        }
    }

    func delete(_ worktree: ClientManagedWorktree, connection: PadConnection) async {
        await action(worktree, connection: connection) { api, repositoryID in
            try await api.delete(repositoryId: repositoryID, worktreeId: worktree.worktreeId)
            return "已删除 Worktree 与本地分支"
        }
    }

    func execute(_ draft: PadWorktreeOperationDraft, connection: PadConnection) async {
        await action(draft.worktree, connection: connection) { api, repositoryID in
            if draft.worktree.isMain {
                try await api.workspaceAction(repositoryId: repositoryID, worktreeId: draft.worktree.worktreeId,
                                              action: "commit", commitMessage: draft.commitMessage,
                                              privateFilesDecision: draft.privateFilesDecision,
                                              neverRemindPrivateFiles: draft.neverRemindPrivateFiles)
                return "主 Worktree 修改已提交"
            }
            if draft.mergeIntoMain {
                try await api.workspaceAction(repositoryId: repositoryID, worktreeId: draft.worktree.worktreeId,
                                              action: "merge", commitMessage: draft.commitMessage,
                                              privateFilesDecision: draft.privateFilesDecision,
                                              neverRemindPrivateFiles: draft.neverRemindPrivateFiles,
                                              synchronizeSource: draft.synchronizeWithMain)
            } else if draft.synchronizeWithMain {
                try await api.workspaceAction(repositoryId: repositoryID, worktreeId: draft.worktree.worktreeId,
                                              action: "synchronize")
            }
            if draft.restartService {
                try await api.workspaceAction(repositoryId: repositoryID, worktreeId: draft.worktree.worktreeId,
                                              action: "restart")
            }
            return "Worktree 操作已完成"
        }
    }

    func prepareOperation(_ worktree: ClientManagedWorktree, connection: PadConnection) async -> PadWorktreeOperationDraft? {
        guard let repositoryID = detail?.repository.id else { return nil }
        busyWorktreeIDs.insert(worktree.worktreeId)
        defer { busyWorktreeIDs.remove(worktree.worktreeId) }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            let protection = worktree.dirty == true
                ? try await api.commitPreparation(repositoryId: repositoryID, worktreeId: worktree.worktreeId) : nil
            let message = worktree.dirty == true
                ? try await api.commitMessage(repositoryId: repositoryID, worktreeId: worktree.worktreeId) : nil
            return PadWorktreeOperationDraft(worktree: worktree, commitMessage: message ?? "", protection: protection)
        } catch {
            errorMessage = PadControlStore.explain(error)
            return nil
        }
    }

    func cleanup(_ worktrees: [ClientManagedWorktree], connection: PadConnection) async {
        for worktree in worktrees where !Task.isCancelled {
            await delete(worktree, connection: connection)
        }
    }

    func serviceAction(_ actionName: String, profileID: String? = nil, connection: PadConnection) async {
        guard let repositoryID = detail?.repository.id, !serviceBusy else { return }
        serviceBusy = true; errorMessage = nil
        defer { serviceBusy = false }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            try await api.developmentServiceAction(repositoryId: repositoryID, action: actionName, profileId: profileID)
            service = try await api.developmentService(repositoryID)
            notice = "开发服务操作已提交"
        } catch { errorMessage = PadControlStore.explain(error) }
    }

    func preparePlan(operation: String? = nil, sources: [String]? = nil, target: String? = nil,
                     connection: PadConnection) async {
        guard let repositoryID = detail?.repository.id, !planning else { return }
        planning = true; errorMessage = nil
        defer { planning = false }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            job = try await api.preparePlan(repositoryId: repositoryID, operationType: operation,
                                            sources: sources, target: target)
            startPollingIfNeeded(repositoryID, connection: connection)
        } catch { errorMessage = PadControlStore.explain(error) }
    }

    func jobAction(_ action: String, decisions: [ClientWorktreeCommitDecision] = [], connection: PadConnection) async {
        guard let job else { return }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            let updated: ClientWorktreeJob
            switch action {
            case "confirm": updated = try await api.confirm(job: job, decisions: decisions)
            case "cancel": updated = try await api.cancel(jobId: job.id)
            case "retry": updated = try await api.retry(jobId: job.id)
            case "resolve-conflict": updated = try await api.resolveConflict(jobId: job.id)
            default: return
            }
            replaceJob(updated)
            startPollingIfNeeded(job.repositoryId, connection: connection)
        } catch { errorMessage = PadControlStore.explain(error) }
    }

    private func action(_ worktree: ClientManagedWorktree, connection: PadConnection,
                        operation: (ClientWorktreeAPI, String) async throws -> String) async {
        guard let repositoryID = detail?.repository.id, !busyWorktreeIDs.contains(worktree.worktreeId) else { return }
        busyWorktreeIDs.insert(worktree.worktreeId); errorMessage = nil
        defer { busyWorktreeIDs.remove(worktree.worktreeId) }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            notice = try await operation(api, repositoryID)
            await load(repositoryID, connection: connection, force: true)
        } catch { errorMessage = PadControlStore.explain(error) }
    }

    private func replaceJob(_ job: ClientWorktreeJob) {
        self.job = job
    }

    private func startPollingIfNeeded(_ repositoryID: String, connection: PadConnection) {
        polling?.cancel(); polling = nil
        guard job?.shouldPoll == true else { return }
        polling = Task { @MainActor [weak self] in
            var unchanged = 0
            while !Task.isCancelled, let self, let current = self.job, current.shouldPoll {
                do { try await Task.sleep(for: .seconds(min(5, 1 + Double(unchanged) * 0.25))) } catch { return }
                do {
                    let api = ClientWorktreeAPI(transport: try await connection.transport())
                    let updated = try await api.job(current.id)
                    unchanged = updated == current ? unchanged + 1 : 0
                    self.replaceJob(updated)
                    if !updated.shouldPoll { await self.load(repositoryID, connection: connection, force: true); return }
                } catch { self.errorMessage = PadControlStore.explain(error); return }
            }
        }
    }
}

struct PadWorktreeOperationDraft: Identifiable {
    let id = UUID()
    let worktree: ClientManagedWorktree
    var mergeIntoMain = true
    var synchronizeWithMain = true
    var restartService = true
    var commitMessage: String
    let protection: ClientGitCommitProtectionStatus?
    var privateFilesDecision: String?
    var neverRemindPrivateFiles = false
}
