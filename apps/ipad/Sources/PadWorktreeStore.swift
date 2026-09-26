import Foundation
import Observation
import CorptieClientCore

enum PadWorktreeFailure {
    static func describe(_ error: Error, stage: String, mutation: Bool = false) -> String {
        if let failure = error as? ClientServiceFailure {
            let reasons = ["BRANCH_OPERATION_INVALID": "操作类型不受支持，请更新客户端。",
                "INTEGRATION_JOB_ACTIVE": "已有集成任务，请先查看并处理原任务。",
                "EXPLICIT_CONFIRMATION_REQUIRED": "计划已变更或确认信息不匹配，请重新审查计划。",
                "SOURCE_WORKTREE_REQUIRED": "至少选择一个不同于目标的来源 Worktree。",
                "SOURCE_EQUALS_TARGET": "来源不能包含目标 Worktree。",
                "TARGET_WORKTREE_REQUIRED": "请选择目标 Worktree。",
                "TARGET_BRANCH_AMBIGUOUS": "目标 Worktree 没有可用的本地分支。",
                "WORKTREE_NOT_FOUND": "所选 Worktree 已不存在，请重新读取仓库。",
                "ROUTE_NOT_AVAILABLE": "Mac 服务端不支持此接口。",
                "INVALID_CREDENTIAL": "设备连接授权已失效，请重新连接。"]
            let reason = reasons[failure.code] ?? "服务端返回错误。"
            let uncertain = mutation && failure.statusCode >= 500 ? "\n执行结果可能未确认，请先核对状态，不要重复提交。" : ""
            return "\(stage)：\(reason)\n\(failure.code) · HTTP \(failure.statusCode)\(uncertain)"
        }
        let detail: String
        if error is DecodingError { detail = "服务端响应无法解析（响应格式不匹配）。" }
        else if let url = error as? URLError { detail = "连接异常（URLError \(url.code.rawValue)）。" }
        else if let connection = error as? ClientConnectionError { detail = "连接错误：\(connection)" }
        else { detail = error.localizedDescription }
        return "\(stage)：\(detail)" + (mutation ? "\n执行结果未确认，请先核对状态，不要重复提交。" : "")
    }
}

private struct PadWorktreeStepFailure: Error {
    let stage: String
    let completed: [String]
    let underlying: Error
}

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
    var jobBusy = false
    var errorMessage: String?
    var notice: String?
    private var generation = 0
    private var polling: Task<Void, Never>?
    private var jobRecoveryKey: String?
    private var activeRepositoryID: String?
    private var operationScope = UUID()

    var selectedWorktree: ClientManagedWorktree? {
        detail?.project.worktrees.first { $0.worktreeId == selectedWorktreeID }
    }

    func reset() {
        generation += 1
        operationScope = UUID()
        polling?.cancel(); polling = nil
        detail = nil; service = nil; job = nil; pushStatuses = [:]; selectedWorktreeID = nil
        loading = false; busyWorktreeIDs = []; serviceBusy = false; planning = false; jobBusy = false
        activeRepositoryID = nil; jobRecoveryKey = nil
        errorMessage = nil; notice = nil
    }

    func load(_ repositoryID: String, connection: PadConnection, force: Bool = false, afterOperation: String? = nil) async {
        let nextKey = "corptie.worktree.job:\(connection.serverID):\(connection.address):\(repositoryID)"
        if jobRecoveryKey != nextKey {
            reset()
        }
        generation += 1
        let token = generation
        activeRepositoryID = repositoryID
        let recoveryKey = "corptie.worktree.job:\(connection.serverID):\(connection.address):\(repositoryID)"
        jobRecoveryKey = recoveryKey
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
                let push = try? await api.pushStatus(
                    repositoryId: repositoryID, worktreeId: selectedWorktreeID)
                guard token == generation, !Task.isCancelled else { return }
                pushStatuses[selectedWorktreeID] = push
            }
            var nextJob = next.latestJob
            if let savedID = UserDefaults.standard.string(forKey: recoveryKey), savedID != nextJob?.id,
               let saved = try? await api.job(savedID), saved.repositoryId == repositoryID {
                guard token == generation, !Task.isCancelled else { return }
                if nextJob == nil || saved.updatedAt > nextJob!.updatedAt { nextJob = saved }
            }
            guard token == generation, !Task.isCancelled else { return }
            detail = next
            service = status
            job = nextJob
            if let job { UserDefaults.standard.set(job.id, forKey: recoveryKey) }
            startPollingIfNeeded(repositoryID, connection: connection)
        } catch {
            guard token == generation, !Task.isCancelled else { return }
            if let afterOperation {
                notice = afterOperation + "。但列表更新失败；不要重复执行，可使用刷新按钮重新读取。\n"
                    + PadWorktreeFailure.describe(error, stage: "读取仓库状态")
            } else { errorMessage = PadWorktreeFailure.describe(error, stage: "读取仓库状态") }
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
        guard draft.privateFilesDecision != "cancel" else { return }
        await action(draft.worktree, connection: connection) { api, repositoryID in
            var completed: [String] = []
            var stage = "提交主 Worktree"
            do {
            if draft.worktree.isMain {
                try await api.workspaceAction(repositoryId: repositoryID, worktreeId: draft.worktree.worktreeId,
                                              action: "commit", commitMessage: draft.commitMessage,
                                              privateFilesDecision: draft.privateFilesDecision,
                                              neverRemindPrivateFiles: draft.neverRemindPrivateFiles)
                return "主 Worktree 修改已提交"
            }
            if draft.mergeIntoMain {
                stage = "合并到主分支"
                try await api.workspaceAction(repositoryId: repositoryID, worktreeId: draft.worktree.worktreeId,
                                              action: "merge", commitMessage: draft.commitMessage,
                                              privateFilesDecision: draft.privateFilesDecision,
                                              neverRemindPrivateFiles: draft.neverRemindPrivateFiles,
                                              synchronizeSource: draft.synchronizeWithMain)
                completed.append("合并到主分支")
            } else if draft.synchronizeWithMain {
                stage = "与主分支同步"
                try await api.workspaceAction(repositoryId: repositoryID, worktreeId: draft.worktree.worktreeId,
                                              action: "synchronize")
                completed.append("与主分支同步")
            }
            if draft.restartService {
                stage = "重启开发服务"
                try await api.workspaceAction(repositoryId: repositoryID, worktreeId: draft.worktree.worktreeId,
                                              action: "restart")
            }
            return "Worktree 操作已完成"
            } catch { throw PadWorktreeStepFailure(stage: stage, completed: completed, underlying: error) }
        }
    }

    func prepareOperation(_ worktree: ClientManagedWorktree, connection: PadConnection) async -> PadWorktreeOperationDraft? {
        guard let repositoryID = detail?.repository.id, !busyWorktreeIDs.contains(worktree.worktreeId) else { return nil }
        let scope = operationScope
        busyWorktreeIDs.insert(worktree.worktreeId)
        defer { if scope == operationScope { busyWorktreeIDs.remove(worktree.worktreeId) } }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            let protection = worktree.dirty == true
                ? try await api.commitPreparation(repositoryId: repositoryID, worktreeId: worktree.worktreeId) : nil
            let message = worktree.dirty == true
                ? try await api.commitMessage(repositoryId: repositoryID, worktreeId: worktree.worktreeId) : nil
            guard scope == operationScope else { return nil }
            return PadWorktreeOperationDraft(worktree: worktree, commitMessage: message ?? "", protection: protection)
        } catch {
            guard scope == operationScope else { return nil }
            errorMessage = PadWorktreeFailure.describe(error, stage: "准备提交与合并")
            return nil
        }
    }

    func cleanup(_ worktrees: [ClientManagedWorktree], connection: PadConnection) async {
        let scope = operationScope
        for worktree in worktrees where !Task.isCancelled {
            guard scope == operationScope else { return }
            await delete(worktree, connection: connection)
            if errorMessage != nil { return }
        }
    }

    func serviceAction(_ actionName: String, profileID: String? = nil, connection: PadConnection) async {
        guard let repositoryID = detail?.repository.id, !serviceBusy else { return }
        serviceBusy = true; errorMessage = nil
        let scope = operationScope
        defer { if scope == operationScope { serviceBusy = false } }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            try await api.developmentServiceAction(repositoryId: repositoryID, action: actionName, profileId: profileID)
            guard scope == operationScope else { return }
            notice = "开发服务操作已提交"
            do {
                let status = try await api.developmentService(repositoryID)
                guard scope == operationScope else { return }
                service = status
            } catch {
                guard scope == operationScope else { return }
                notice = "开发服务操作已提交，但状态读取失败。\n" + PadWorktreeFailure.describe(error, stage: "读取开发服务")
            }
        } catch {
            guard scope == operationScope else { return }
            errorMessage = PadWorktreeFailure.describe(error, stage: "开发服务操作", mutation: true)
        }
    }

    func preparePlan(operation: ClientWorktreePlanOperation? = nil, sources: [String]? = nil, target: String? = nil,
                     connection: PadConnection) async {
        guard let repositoryID = detail?.repository.id, !planning, !jobBusy else { return }
        let token = operationScope
        planning = true; errorMessage = nil
        defer { if token == operationScope { planning = false } }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            let next = try await api.preparePlan(repositoryId: repositoryID, operationType: operation,
                                            sources: sources, target: target)
            let key = "corptie.worktree.job:\(connection.serverID):\(connection.address):\(repositoryID)"
            UserDefaults.standard.set(next.id, forKey: key)
            guard token == operationScope else { return }
            replaceJob(next)
            startPollingIfNeeded(repositoryID, connection: connection)
        } catch {
            guard token == operationScope else { return }
            errorMessage = PadWorktreeFailure.describe(error, stage: "生成集成计划", mutation: true)
        }
    }

    func jobAction(_ action: String, decisions: [ClientWorktreeCommitDecision] = [], reviewedJob: ClientWorktreeJob? = nil,
                   connection: PadConnection) async {
        guard let job, !jobBusy, !planning else { return }
        if action == "confirm" {
            guard let reviewedJob, reviewedJob.id == job.id,
                  reviewedJob.planFingerprint == job.planFingerprint,
                  job.status == "awaiting_confirmation", job.plan.blockingRisks.isEmpty else {
                errorMessage = "集成计划或状态已变化，请重新查看并确认计划。"
                return
            }
        }
        let token = operationScope
        jobBusy = true; errorMessage = nil
        defer { if token == operationScope { jobBusy = false } }
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
            guard token == operationScope else { return }
            replaceJob(updated)
            startPollingIfNeeded(job.repositoryId, connection: connection)
        } catch {
            guard token == operationScope else { return }
            errorMessage = PadWorktreeFailure.describe(error, stage: "集成任务 \(action)", mutation: true)
        }
    }

    private func action(_ worktree: ClientManagedWorktree, connection: PadConnection,
                        operation: (ClientWorktreeAPI, String) async throws -> String) async {
        guard let repositoryID = detail?.repository.id, !busyWorktreeIDs.contains(worktree.worktreeId) else { return }
        guard detail?.project.worktrees.contains(where: { $0.worktreeId == worktree.worktreeId }) == true else { return }
        busyWorktreeIDs.insert(worktree.worktreeId); errorMessage = nil
        let token = operationScope
        defer { if token == operationScope { busyWorktreeIDs.remove(worktree.worktreeId) } }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            let completed = try await operation(api, repositoryID)
            guard token == operationScope else { return }
            notice = completed
            await load(repositoryID, connection: connection, force: true, afterOperation: completed)
        } catch {
            guard token == operationScope else { return }
            if let failure = error as? PadWorktreeStepFailure {
                let completed = failure.completed.isEmpty ? "" : "已完成：\(failure.completed.joined(separator: "、"))。\n"
                errorMessage = completed + PadWorktreeFailure.describe(failure.underlying, stage: failure.stage, mutation: true)
            } else { errorMessage = PadWorktreeFailure.describe(error, stage: "执行 Worktree 操作", mutation: true) }
        }
    }

    private func replaceJob(_ job: ClientWorktreeJob) {
        // A command response supersedes any inventory read started before it.
        generation += 1
        loading = false
        self.job = job
        if let jobRecoveryKey { UserDefaults.standard.set(job.id, forKey: jobRecoveryKey) }
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
                    guard self.activeRepositoryID == repositoryID, self.job?.id == current.id, !Task.isCancelled else { return }
                    self.replaceJob(updated)
                    if !updated.shouldPoll { await self.load(repositoryID, connection: connection, force: true); return }
                } catch {
                    guard self.activeRepositoryID == repositoryID, !Task.isCancelled else { return }
                    self.errorMessage = PadWorktreeFailure.describe(error, stage: "读取集成任务状态（任务未被重发）"); return
                }
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
