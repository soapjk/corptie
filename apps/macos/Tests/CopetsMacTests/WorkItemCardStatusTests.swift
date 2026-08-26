import Testing
@testable import CorptieMac

struct WorkItemCardStatusTests {
    @Test func reportsNoSessionWithoutACurrentBinding() {
        #expect(WorkItemBoundSessionActivity.resolve(
            workItem: makeWorkItem(currentSessionId: nil, executionStatus: "idle"),
            sessions: []
        ) == .noSession)
    }

    @Test func mapsTheBoundSessionsAuthoritativeRuntimeStatus() {
        let mappings: [(TaskStatus, WorkItemBoundSessionActivity)] = [
            (.running, .processing),
            (.blocked, .waitingForInput),
            (.complete, .idle),
            (.cancelled, .interrupted),
            (.failed, .failed)
        ]

        for (status, expected) in mappings {
            let workItem = makeWorkItem(currentSessionId: "session:current", executionStatus: "idle")
            let session = makeWorkItemSession(id: "session:current", status: status)
            #expect(WorkItemBoundSessionActivity.resolve(
                workItem: workItem,
                sessions: [session]
            ) == expected)
        }
    }

    @Test func ignoresOtherSessionsWhenTheCurrentBindingIsPresent() {
        let current = makeWorkItemSession(id: "session:current", status: .running)
        let newerOther = makeWorkItemSession(
            id: "session:other",
            status: .failed,
            updatedAt: "2026-08-20T00:00:00Z"
        )
        #expect(WorkItemBoundSessionActivity.resolve(
            workItem: makeWorkItem(currentSessionId: current.id, executionStatus: "failed"),
            sessions: [newerOther, current]
        ) == .processing)
    }

    @Test func fallsBackToPersistedExecutionStatusDuringSnapshotRaces() {
        let workItem = makeWorkItem(currentSessionId: "session:not-loaded", executionStatus: "paused")
        #expect(WorkItemBoundSessionActivity.resolve(
            workItem: workItem,
            sessions: []
        ) == .paused)
    }
}

private func makeWorkItem(currentSessionId: String?, executionStatus: String?) -> WorkItem {
    WorkItem(
        id: "work-item:one",
        objectiveId: "objective:one",
        title: "WorkItem",
        description: "",
        acceptanceCriteria: "",
        priority: "medium",
        status: "in_progress",
        mainWorkspaceId: nil,
        mainAgentId: "agent:one",
        currentSessionId: currentSessionId,
        executionStatus: executionStatus,
        acceptanceAssessment: nil,
        completionSuggestion: nil,
        createdAt: "2026-08-19T00:00:00Z",
        updatedAt: "2026-08-19T00:00:00Z"
    )
}

private func makeWorkItemSession(
    id: String,
    status: TaskStatus,
    updatedAt: String = "2026-08-19T00:00:00Z"
) -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Agent",
        agentId: "agent:one",
        sessionKind: .worker,
        objectiveId: "objective:one",
        workItemId: "work-item:one",
        status: status,
        progress: status == .running ? 0.5 : 1,
        summary: "",
        suggestedOptions: nil,
        suggestedPrompt: nil,
        activityStatus: nil,
        updatedAt: updatedAt,
        accent: .cyan,
        archived: false,
        pinned: false,
        sortOrder: nil,
        capabilities: nil,
        external: nil,
        actions: nil,
    )
}
