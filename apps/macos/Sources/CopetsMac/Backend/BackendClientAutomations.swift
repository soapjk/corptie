import Foundation

extension BackendClient {
    func loadScheduledTasks(
        for session: TaskSession,
        expectedSelectionGeneration: UInt64? = nil
    ) async {
        await scheduledTaskController.loadScheduledTasks(
            for: session, expectedSelectionGeneration: expectedSelectionGeneration
        )
    }

    nonisolated static func scheduledTaskListURL(baseURL: URL, logicalSessionId: String? = nil) -> URL? {
        ScheduledTaskAPI.listURL(baseURL: baseURL, logicalSessionId: logicalSessionId)
    }

    func loadAutomations() async {
        await scheduledTaskController.loadAutomations()
    }

    @discardableResult
    func performAutomationAction(_ action: ScheduledSessionTaskAction, task: ScheduledSessionTask) async -> Bool {
        await scheduledTaskController.performAutomationAction(action, task: task)
    }

    @discardableResult
    func createScheduledTask(_ draft: ScheduledSessionTaskDraft, for session: TaskSession) async -> Bool {
        await scheduledTaskController.createScheduledTask(draft, for: session)
    }

    @discardableResult
    func updateScheduledTask(
        _ task: ScheduledSessionTask, draft: ScheduledSessionTaskDraft, for session: TaskSession
    ) async -> Bool {
        await scheduledTaskController.updateScheduledTask(task, draft: draft, for: session)
    }

    @discardableResult
    func performScheduledTaskAction(
        _ action: ScheduledSessionTaskAction, task: ScheduledSessionTask, for session: TaskSession
    ) async -> Bool {
        await scheduledTaskController.performScheduledTaskAction(action, task: task, for: session)
    }

    nonisolated static func reconciledScheduledTasks(
        _ tasks: [ScheduledSessionTask], for session: TaskSession
    ) -> [ScheduledSessionTask] {
        ScheduledTaskController.reconciledScheduledTasks(tasks, for: session)
    }


    /// 补拉更早的历史消息，prepend 到当前选中会话的 detail.items 头部。
    /// 只在用户滚动到顶时触发（低频），因此直接请求后端切片端点即可。
}
