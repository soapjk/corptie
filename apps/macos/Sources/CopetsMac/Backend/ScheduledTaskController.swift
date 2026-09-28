import Combine
import Foundation

/// Scheduling orchestration owns request coalescing and the all-Session list.
/// Selected panel data and command state retain their existing single owners.
@MainActor
final class ScheduledTaskController: ObservableObject {
    @Published private(set) var automations: [ScheduledSessionTask] = []
    @Published private(set) var isLoadingAutomations = false
    @Published private(set) var automationsError: String?

    private let api: any ScheduledTaskServing
    private let selection: SessionSelectionController
    private let supplementary: SessionSupplementaryDataController
    private let commands: SessionCommandController
    private let selectedSession: () -> TaskSession?
    private var automationRefreshCoalescer = AutomationRefreshCoalescer()
    private var scheduledTaskLoadTasks: [String: Task<ScheduledTaskListLoadOutcome, Never>] = [:]
    private var eventRefreshTask: Task<Void, Never>?

    init(
        api: any ScheduledTaskServing,
        selection: SessionSelectionController,
        supplementary: SessionSupplementaryDataController,
        commands: SessionCommandController,
        selectedSession: @escaping () -> TaskSession?
    ) {
        self.api = api
        self.selection = selection
        self.supplementary = supplementary
        self.commands = commands
        self.selectedSession = selectedSession
    }

    func cancelEventRefresh() {
        eventRefreshTask?.cancel()
        eventRefreshTask = nil
    }

    func scheduleEventRefresh(eventSessionId: String?) {
        guard eventRefreshTask == nil else { return }
        eventRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard let self, !Task.isCancelled else { return }
            defer { self.eventRefreshTask = nil }
            async let automationLoad: Void = self.loadAutomations()
            if let selectedSession = self.selectedSession() {
                let logicalID = selectedSession.external?.logicalSessionId ?? selectedSession.id
                if eventSessionId == nil || eventSessionId == logicalID || eventSessionId == selectedSession.id {
                    async let selectedLoad: Void = self.loadScheduledTasks(for: selectedSession)
                    _ = await (automationLoad, selectedLoad)
                    return
                }
            }
            await automationLoad
        }
    }

    func loadScheduledTasks(
        for session: TaskSession,
        expectedSelectionGeneration: UInt64? = nil
    ) async {
        if selectedSession()?.id == session.id { supplementary.isLoadingScheduledTasks = true }
        defer {
            if selectedSession()?.id == session.id { supplementary.isLoadingScheduledTasks = false }
        }
        let logicalSessionId = session.external?.logicalSessionId ?? session.id
        let outcome: ScheduledTaskListLoadOutcome
        if let inFlight = scheduledTaskLoadTasks[logicalSessionId] {
            PerfStopwatch.event("计划任务.合并重复请求", value: 1)
            outcome = await inFlight.value
        } else {
            let api = api
            let loadTask = Task {
                await Self.fetchScheduledTaskList(api: api, logicalSessionId: logicalSessionId)
            }
            scheduledTaskLoadTasks[logicalSessionId] = loadTask
            outcome = await loadTask.value
            scheduledTaskLoadTasks[logicalSessionId] = nil
        }
        switch outcome {
        case .success(let tasks):
            guard selectedSession()?.id == session.id,
                  expectedSelectionGeneration == nil
                    || expectedSelectionGeneration == selection.generation else { return }
            PerfStopwatch.measure("计划任务.前端发布渲染状态") {
                supplementary.selectedScheduledTasks = Self.reconciledScheduledTasks(tasks, for: session)
                commands.scheduledTaskError = nil
            }
            PerfStopwatch.event("计划任务.展示条数", value: supplementary.selectedScheduledTasks.count)
        case .failure(let message):
            guard selectedSession()?.id == session.id else { return }
            commands.scheduledTaskError = message
        }
    }

    private static func fetchScheduledTaskList(
        api: any ScheduledTaskServing,
        logicalSessionId: String
    ) async -> ScheduledTaskListLoadOutcome {
        do {
            let tasks = try await api.list(logicalSessionId: logicalSessionId)
            return .success(tasks)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    func loadAutomations() async {
        guard automationRefreshCoalescer.request() else { return }
        isLoadingAutomations = true
        defer {
            automationRefreshCoalescer.finish()
            isLoadingAutomations = false
        }
        repeat {
            automationRefreshCoalescer.beginPass()
            await loadAutomationsPass()
        } while automationRefreshCoalescer.completePass()
    }

    private func loadAutomationsPass() async {
        do {
            let details = try await api.list(logicalSessionId: nil)
            automations = AutomationListOrdering.sorted(details)
            automationsError = nil
        } catch {
            automationsError = error.localizedDescription
        }
    }

    @discardableResult
    func performAutomationAction(_ action: ScheduledSessionTaskAction, task: ScheduledSessionTask) async -> Bool {
        guard commands.scheduledTaskMutationIds.insert(task.id).inserted else { return false }
        defer { commands.scheduledTaskMutationIds.remove(task.id) }
        do {
            try await api.mutate(method: "POST",
                path: "automations/\(task.id)/\(action == .retry ? ScheduledSessionTaskAction.resume.rawValue : action.rawValue)", body: nil
            )
            await loadAutomations()
            return true
        } catch {
            automationsError = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func createScheduledTask(_ draft: ScheduledSessionTaskDraft, for session: TaskSession) async -> Bool {
        if let validationError = draft.validationError() {
            commands.scheduledTaskError = validationError.localizedDescription
            return false
        }
        return await performScheduledTaskMutation(
            session: session,
            mutationId: "create",
            method: "POST",
            path: ScheduledSessionAPIContract.collectionPath,
            body: draft.requestBody().merging([
                "logicalSessionId": session.external?.logicalSessionId ?? session.id
            ]) { current, _ in current }
        )
    }

    @discardableResult
    func updateScheduledTask(
        _ task: ScheduledSessionTask,
        draft: ScheduledSessionTaskDraft,
        for session: TaskSession
    ) async -> Bool {
        if let validationError = draft.validationError() {
            commands.scheduledTaskError = validationError.localizedDescription
            return false
        }
        var body = draft.requestBody()
        body.removeValue(forKey: "scheduleType")
        body["resourceVersion"] = task.resourceVersion
        return await performScheduledTaskMutation(
            session: session,
            mutationId: task.id,
            method: "PATCH",
            path: ScheduledSessionAPIContract.itemPath(taskId: task.id),
            body: body
        )
    }

    @discardableResult
    func performScheduledTaskAction(
        _ action: ScheduledSessionTaskAction,
        task: ScheduledSessionTask,
        for session: TaskSession
    ) async -> Bool {
        await performScheduledTaskMutation(
            session: session,
            mutationId: task.id,
            method: "POST",
            path: ScheduledSessionAPIContract.actionPath(taskId: task.id, action: action),
            body: nil
        )
    }

    private func performScheduledTaskMutation(
        session: TaskSession,
        mutationId: String,
        method: String,
        path: String,
        body: [String: Any]?
    ) async -> Bool {
        guard commands.scheduledTaskMutationIds.insert(mutationId).inserted else { return false }
        commands.scheduledTaskError = nil
        defer { commands.scheduledTaskMutationIds.remove(mutationId) }
        do {
            try await api.mutate(method: method, path: path, body: body)
            await loadScheduledTasks(for: session)
            return true
        } catch {
            commands.scheduledTaskError = error.localizedDescription
            return false
        }
    }

    nonisolated static func reconciledScheduledTasks(
        _ tasks: [ScheduledSessionTask],
        for session: TaskSession
    ) -> [ScheduledSessionTask] {
        let logicalSessionId = session.external?.logicalSessionId ?? session.id
        var byID: [String: ScheduledSessionTask] = [:]
        for task in tasks where task.logicalSessionId == logicalSessionId || task.logicalSessionId == session.id {
            if let existing = byID[task.id], existing.resourceVersion > task.resourceVersion { continue }
            byID[task.id] = task
        }
        return byID.values.sorted { left, right in
            let leftDate = ScheduledSessionDateFormatting.date(from: left.nextRunAt) ?? .distantFuture
            let rightDate = ScheduledSessionDateFormatting.date(from: right.nextRunAt) ?? .distantFuture
            if leftDate != rightDate { return leftDate < rightDate }
            return left.id < right.id
        }
    }
}

struct AutomationRefreshCoalescer: Equatable {
    private(set) var isRunning = false
    private(set) var isPending = false

    mutating func request() -> Bool {
        isPending = true
        guard !isRunning else { return false }
        isRunning = true
        return true
    }

    mutating func beginPass() {
        isPending = false
    }

    mutating func completePass() -> Bool {
        guard isPending else {
            isRunning = false
            return false
        }
        return true
    }

    mutating func finish() {
        isRunning = false
        isPending = false
    }
}

enum ScheduledTaskListLoadOutcome: Sendable {
    case success([ScheduledSessionTask])
    case failure(String)
}
