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
    var pendingNotificationJobID: String?
    var pendingNotificationWorktreeID: String?
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
        PadOperationNotifications.shared.setScope("\(connection.serverID)|\(connection.address)")
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
            async let loadedService = try? api.developmentService(repositoryID)
            let next = try await loadedDetail
            guard token == generation, !Task.isCancelled else { return }
            if selectedWorktreeID == nil || !next.project.worktrees.contains(where: { $0.worktreeId == selectedWorktreeID }) {
                selectedWorktreeID = next.project.worktrees.first(where: \.isMain)?.worktreeId
                    ?? next.project.worktrees.first?.worktreeId
            }
            detail = next
            job = next.latestJob
            loading = false
            startPollingIfNeeded(repositoryID, connection: connection)
            if let selectedWorktreeID {
                let push = try? await api.pushStatus(
                    repositoryId: repositoryID, worktreeId: selectedWorktreeID)
                guard token == generation, !Task.isCancelled else { return }
                pushStatuses[selectedWorktreeID] = push
            }
            var nextJob = next.latestJob
            let navigatingToJob = pendingNotificationJobID != nil
            if let id = pendingNotificationJobID, let requested = try? await api.job(id), requested.repositoryId == repositoryID {
                nextJob = requested
                pendingNotificationJobID = nil
            }
            if let id = pendingNotificationWorktreeID {
                if next.project.worktrees.contains(where: { $0.worktreeId == id }) { selectedWorktreeID = id }
                pendingNotificationWorktreeID = nil
            }
            if !navigatingToJob, let savedID = UserDefaults.standard.string(forKey: recoveryKey), savedID != nextJob?.id,
               let saved = try? await api.job(savedID), saved.repositoryId == repositoryID {
                guard token == generation, !Task.isCancelled else { return }
                if nextJob == nil || saved.updatedAt > nextJob!.updatedAt { nextJob = saved }
            }
            guard token == generation, !Task.isCancelled else { return }
            service = await loadedService
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
        await action(worktree, connection: connection, category: .gitPush) { api, repositoryID in
            let result = try await api.push(repositoryId: repositoryID, worktreeId: worktree.worktreeId)
            guard result.pushed else { throw ClientConnectionError.invalidResponse }
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
        guard draft.canExecute else {
            errorMessage = "请选择有效的操作、提交信息和私密文件处理方式。"
            return
        }
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
        guard let repositoryID = detail?.repository.id, !worktrees.isEmpty else { return }
        let scope = operationScope
        var removed: [String] = []
        var failed: [String] = []
        var finished = false
        let notificationScope = "\(connection.serverID)|\(connection.address)"
        defer {
            PadOperationNotifications.shared.complete(.init(category: .worktree,
                outcome: !finished || Task.isCancelled ? (removed.isEmpty ? .cancelled : .partial)
                    : (failed.isEmpty ? .succeeded : (removed.isEmpty ? .failed : .partial)),
                name: "Worktree cleanup", summary: "已删除 \(removed.count) 个，未完成 \(failed.count) 个", repositoryID: repositoryID),
                expectedScope: notificationScope)
        }
        errorMessage = nil
        let api: ClientWorktreeAPI
        do { api = ClientWorktreeAPI(transport: try await connection.transport()) }
        catch {
            errorMessage = PadWorktreeFailure.describe(error, stage: "连接 Worktree 服务")
            return
        }
        for worktree in worktrees where !Task.isCancelled {
            guard scope == operationScope else { return }
            guard let current = detail?.project.worktrees.first(where: { $0.worktreeId == worktree.worktreeId }),
                  !current.isMain, current.availability == "available", !current.isLocked,
                  current.operationState == nil, current.conflictFiles.isEmpty, current.dirty == false,
                  current.mergedIntoMain == true, current.associations.isEmpty else {
                failed.append("\(worktree.branchName ?? worktree.worktreeId)：状态已变化，未删除")
                continue
            }
            do {
                try await api.delete(repositoryId: repositoryID, worktreeId: worktree.worktreeId)
                removed.append(worktree.branchName ?? worktree.worktreeId)
            } catch {
                failed.append("\(worktree.branchName ?? worktree.worktreeId)：\(PadWorktreeFailure.describe(error, stage: "删除失败", mutation: true))")
            }
        }
        guard scope == operationScope else { return }
        finished = true
        await load(repositoryID, connection: connection, force: true,
                   afterOperation: removed.isEmpty ? nil : "已清理 \(removed.count) 个 Worktree")
        if !failed.isEmpty {
            let summary = "已清理：\(removed.isEmpty ? "无" : removed.joined(separator: "、"))。\n未完成：\n"
                + failed.joined(separator: "\n")
            errorMessage = [summary, errorMessage].compactMap { $0 }.joined(separator: "\n")
            notice = nil
        } else if !removed.isEmpty, errorMessage == nil,
                  notice?.contains("列表更新失败") != true {
            notice = "已清理：\(removed.joined(separator: "、"))"
        }
    }

    func serviceAction(_ actionName: String, profileID: String? = nil, connection: PadConnection) async {
        guard let repositoryID = detail?.repository.id, !serviceBusy else { return }
        serviceBusy = true; errorMessage = nil
        let scope = operationScope
        let notificationScope = "\(connection.serverID)|\(connection.address)"
        defer { if scope == operationScope { serviceBusy = false } }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            try await api.developmentServiceAction(repositoryId: repositoryID, action: actionName, profileId: profileID)
            if ["start", "restart", "stop"].contains(actionName) {
                PadOperationNotifications.shared.complete(.init(category: .developmentService, outcome: .succeeded,
                    name: "Development service operation", repositoryID: repositoryID), expectedScope: notificationScope)
            }
            guard scope == operationScope else { return }
            notice = "开发服务操作已完成"
            do {
                let status = try await api.developmentService(repositoryID)
                guard scope == operationScope else { return }
                service = status
            } catch {
                guard scope == operationScope else { return }
                notice = "开发服务操作已提交，但状态读取失败。\n" + PadWorktreeFailure.describe(error, stage: "读取开发服务")
            }
        } catch {
            PadOperationNotifications.shared.complete(.init(category: .developmentService, outcome: OperationNotificationOutcome.errorOutcome(error),
                name: "Development service operation", repositoryID: repositoryID), expectedScope: notificationScope)
            guard scope == operationScope else { return }
            errorMessage = PadWorktreeFailure.describe(error, stage: "开发服务操作", mutation: true)
        }
    }

    func preparePlan(operation: ClientWorktreePlanOperation? = nil, sources: [String]? = nil, target: String? = nil,
                     replacingDraft: Bool = false, connection: PadConnection) async {
        guard let repositoryID = detail?.repository.id, !planning, !jobBusy else { return }
        let token = operationScope
        planning = true; errorMessage = nil
        defer { if token == operationScope { planning = false } }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            if replacingDraft, let existing = job, existing.status == "awaiting_confirmation" {
                let canceled = try await api.cancel(jobId: existing.id)
                guard token == operationScope else { return }
                replaceJob(canceled)
            }
            guard token == operationScope, !Task.isCancelled else { return }
            let next = try await api.preparePlan(repositoryId: repositoryID, operationType: operation,
                                            sources: sources, target: target)
            guard token == operationScope, !Task.isCancelled else { return }
            let key = "corptie.worktree.job:\(connection.serverID):\(connection.address):\(repositoryID)"
            UserDefaults.standard.set(next.id, forKey: key)
            replaceJob(next)
            startPollingIfNeeded(repositoryID, connection: connection)
        } catch {
            guard token == operationScope else { return }
            errorMessage = PadWorktreeFailure.describe(error, stage: "生成集成计划", mutation: true)
        }
    }

    @discardableResult func jobAction(_ action: String, decisions: [ClientWorktreeCommitDecision] = [], reviewedJob: ClientWorktreeJob? = nil,
                   connection: PadConnection) async -> Bool {
        guard let job, !jobBusy, !planning else { return false }
        if action == "confirm" {
            guard let reviewedJob, reviewedJob.id == job.id,
                  reviewedJob.planFingerprint == job.planFingerprint,
                  job.status == "awaiting_confirmation", job.plan.blockingRisks.isEmpty else {
                errorMessage = "集成计划或状态已变化，请重新查看并确认计划。"
                return false
            }
        }
        if action == "cancel", let reviewedJob,
           (reviewedJob.id != job.id || reviewedJob.planFingerprint != job.planFingerprint
            || job.status != "awaiting_confirmation") {
            errorMessage = "集成计划或状态已变化，请重新查看任务。"
            return false
        }
        let token = operationScope
        jobBusy = true; errorMessage = nil
        defer { if token == operationScope { jobBusy = false } }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            let updated: ClientWorktreeJob
            if ["confirm", "retry", "resolve-conflict"].contains(action) { PadOperationNotifications.shared.track(job.id, resourceName: detail?.repository.name) }
            switch action {
            case "confirm": updated = try await api.confirm(job: job, decisions: decisions)
            case "cancel": updated = try await api.cancel(jobId: job.id)
            case "retry": updated = try await api.retry(jobId: job.id)
            case "resolve-conflict": updated = try await api.resolveConflict(jobId: job.id)
            default: return false
            }
            guard token == operationScope else { return false }
            if ["confirm", "retry", "resolve-conflict"].contains(action) {
                PadOperationNotifications.shared.track(updated.id, resourceName: detail?.repository.name)
            }
            if let snapshot = updated.notification { PadOperationNotifications.shared.observe(snapshot) }
            replaceJob(updated)
            startPollingIfNeeded(job.repositoryId, connection: connection)
            return true
        } catch {
            guard token == operationScope else { return false }
            errorMessage = PadWorktreeFailure.describe(error, stage: "集成任务 \(action)", mutation: true)
            return false
        }
    }

    private func action(_ worktree: ClientManagedWorktree, connection: PadConnection,
                        category: OperationNotificationCategory = .worktree,
                        operation: (ClientWorktreeAPI, String) async throws -> String) async {
        guard let repositoryID = detail?.repository.id, !busyWorktreeIDs.contains(worktree.worktreeId) else { return }
        guard detail?.project.worktrees.contains(where: { $0.worktreeId == worktree.worktreeId }) == true else { return }
        busyWorktreeIDs.insert(worktree.worktreeId); errorMessage = nil
        let token = operationScope
        let notificationScope = "\(connection.serverID)|\(connection.address)"
        defer { if token == operationScope { busyWorktreeIDs.remove(worktree.worktreeId) } }
        do {
            let api = ClientWorktreeAPI(transport: try await connection.transport())
            let completed = try await operation(api, repositoryID)
            PadOperationNotifications.shared.complete(.init(category: category, outcome: .succeeded,
                name: category == .gitPush ? "Git push" : "Worktree operation", summary: worktree.branchName ?? "", repositoryID: repositoryID,
                worktreeID: worktree.worktreeId), expectedScope: notificationScope)
            guard token == operationScope else { return }
            notice = completed
            await load(repositoryID, connection: connection, force: true, afterOperation: completed)
        } catch {
            if !Task.isCancelled {
                let step = error as? PadWorktreeStepFailure
                PadOperationNotifications.shared.complete(.init(category: category,
                    outcome: step?.completed.isEmpty == false ? .partial : OperationNotificationOutcome.errorOutcome(error),
                    name: category == .gitPush ? "Git push" : "Worktree operation", summary: worktree.branchName ?? "", repositoryID: repositoryID,
                    worktreeID: worktree.worktreeId), expectedScope: notificationScope)
            }
            guard token == operationScope else { return }
            if let failure = error as? PadWorktreeStepFailure {
                let completed = failure.completed.isEmpty ? "" : "已完成：\(failure.completed.joined(separator: "、"))。\n"
                errorMessage = completed + PadWorktreeFailure.describe(failure.underlying, stage: failure.stage, mutation: true)
            } else { errorMessage = PadWorktreeFailure.describe(error, stage: "执行 Worktree 操作", mutation: true) }
        }
    }

    private func replaceJob(_ job: ClientWorktreeJob) {
        if let snapshot = job.notification { PadOperationNotifications.shared.observe(snapshot) }
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
    var mergeIntoMain: Bool
    var synchronizeWithMain: Bool
    var restartService = false
    var commitMessage: String
    let protection: ClientGitCommitProtectionStatus?
    var privateFilesDecision: String?
    var neverRemindPrivateFiles = false

    init(worktree: ClientManagedWorktree, commitMessage: String, protection: ClientGitCommitProtectionStatus?) {
        self.worktree = worktree
        self.commitMessage = commitMessage
        self.protection = protection
        self.mergeIntoMain = worktree.isMain ? false : (worktree.dirty == true || worktree.mergedIntoMain != true)
        self.synchronizeWithMain = !worktree.isMain && worktree.synchronizedWithMain != true
    }

    var canExecute: Bool {
        let committing = worktree.isMain || mergeIntoMain
        guard committing || synchronizeWithMain || restartService else { return false }
        if committing && worktree.dirty == true {
            guard !commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
            if protection?.requiresDecision == true && !["ignore", "include"].contains(privateFilesDecision ?? "") { return false }
        }
        return true
    }
}
