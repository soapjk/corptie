import Testing
@testable import CorptieMac

@MainActor
struct ConsoleTaskSelectionPolicyTests {
    @Test
    func preservesAnActiveTaskWithoutASessionAsAValidSelection() {
        let task = makeTask(id: "task:target", workID: "work:current")

        #expect(ConsoleTaskSelectionPolicy.isValidSelection(
            task: task,
            selectedWorkID: "work:current"
        ))
        #expect(ConsoleTaskSelectionPolicy.session(for: task, in: []) == nil)
    }

    @Test
    func rejectsAStaleCurrentSessionThatBelongsToAnotherTask() {
        let task = makeTask(
            id: "task:target",
            workID: "work:current",
            currentSessionID: "session:stale"
        )
        let stale = makeSession(
            id: "session:stale",
            taskID: "task:other",
            workID: "work:current"
        )
        let matching = makeSession(
            id: "session:matching",
            taskID: task.id,
            workID: task.workId
        )

        #expect(ConsoleTaskSelectionPolicy.session(
            for: task,
            in: [stale, matching]
        )?.id == matching.id)
    }

    @Test
    func openingAnAssignedTaskWithoutASessionAttemptsCreation() {
        var task = makeTask(id: "task:target", workID: "work:current")
        task.mainAgentId = " agent:owner "

        #expect(ConsoleTaskOpenDecision.resolve(
            task: task,
            session: nil
        ) == .createSession(agentID: "agent:owner"))
    }

    @Test
    func openingATaskWithASessionSelectsItWithoutCreatingAnother() {
        let task = makeTask(id: "task:target", workID: "work:current")
        let session = makeSession(
            id: "session:current",
            taskID: task.id,
            workID: task.workId
        )

        #expect(ConsoleTaskOpenDecision.resolve(
            task: task,
            session: session
        ) == .selectSession(id: session.id))
    }

    private func makeTask(
        id: String,
        workID: String,
        currentSessionID: String? = nil
    ) -> CorptieTask {
        CorptieTask(
            id: id,
            workId: workID,
            title: "Task",
            description: "",
            acceptanceCriteria: "",
            priority: "medium",
            lifecycleState: "todo",
            mainAgentId: nil,
            currentSessionId: currentSessionID,
            executionStatus: "idle",
            createdAt: "2026-09-04T00:00:00Z",
            updatedAt: "2026-09-04T00:00:00Z"
        )
    }

    private func makeSession(
        id: String,
        taskID: String,
        workID: String
    ) -> TaskSession {
        TaskSession(
            id: id,
            title: id,
            agent: "Agent",
            agentId: "agent:one",
            sessionKind: .worker,
            workId: workID,
            taskId: taskID,
            status: .complete,
            progress: 1,
            summary: "",
            suggestedOptions: nil,
            suggestedPrompt: nil,
            activityStatus: nil,
            updatedAt: "2026-09-04T00:00:00Z",
            accent: .cyan,
            archived: false,
            pinned: false,
            sortOrder: nil,
            capabilities: nil,
            external: nil,
            actions: nil
        )
    }
}
