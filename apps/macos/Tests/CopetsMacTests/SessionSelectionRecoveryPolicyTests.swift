import Testing
@testable import CorptieMac

struct SessionSelectionRecoveryPolicyTests {
    @Test func recordsMostRecentlyOpenedSessionWithoutDuplicates() {
        #expect(SessionSelectionRecoveryPolicy.recording(
            "session:two",
            in: ["session:one", "session:two", "session:three"]
        ) == ["session:two", "session:one", "session:three"])
    }

    @Test func recoversTheMostRecentStillAccessibleSession() {
        let completedCorptieTask = makeRecoveryCorptieTask(id: "task:completed", lifecycleState: "done")
        let current = makeRecoverySession(id: "session:current", taskID: completedCorptieTask.id, archived: true)
        let inaccessibleRecent = makeRecoverySession(id: "session:completed", taskID: completedCorptieTask.id, archived: true)
        let accessibleOlder = makeRecoverySession(id: "session:accessible", taskID: nil, kind: .assistantChat)

        #expect(SessionSelectionRecoveryPolicy.recoverySessionID(
            recentSessionIDs: [current.id, inaccessibleRecent.id, accessibleOlder.id],
            sessions: [current, inaccessibleRecent, accessibleOlder],
            excluding: current.id
        ) == accessibleOlder.id)
    }

    @Test func backendResolvedCompletedWorkerSessionCannotBecomeARecoveryTarget() {
        let session = makeRecoverySession(
            id: "session:one",
            taskID: "task:one",
            archived: true
        )

        #expect(!SessionSelectionRecoveryPolicy.isAccessible(
            session,
            sessions: [session]
        ))
    }

    @Test func explicitlyArchivedWorkerSessionCannotBecomeARecoveryTarget() {
        let session = makeRecoverySession(id: "session:archived", taskID: "task:one", archived: true)
        #expect(!SessionSelectionRecoveryPolicy.isAccessible(session, sessions: [session]))
    }

    @Test func fallsBackToTheFirstAccessibleSessionWhenHistoryIsStale() {
        let first = makeRecoverySession(id: "session:first", taskID: nil, kind: .workChat)
        let second = makeRecoverySession(id: "session:second", taskID: nil, kind: .assistantChat)

        #expect(SessionSelectionRecoveryPolicy.recoverySessionID(
            recentSessionIDs: ["session:deleted"],
            sessions: [first, second],
            excluding: "session:reclaimed"
        ) == first.id)
    }
}

private func makeRecoveryCorptieTask(id: String, lifecycleState: String) -> CorptieTask {
    CorptieTask(
        id: id,
        workId: "work:one",
        title: id,
        description: "Description",
        acceptanceCriteria: "Criteria",
        priority: "medium",
        lifecycleState: lifecycleState,
        mainAgentId: "agent:one",
        currentSessionId: nil,
        executionStatus: "idle",
        acceptanceAssessment: nil,
        completionSuggestion: nil,
        createdAt: "2026-08-22T00:00:00Z",
        updatedAt: "2026-08-22T00:00:00Z"
    )
}

private func makeRecoverySession(
    id: String,
    taskID: String?,
    kind: SessionKind = .worker,
    archived: Bool = false
) -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Agent",
        agentId: "agent:one",
        sessionKind: kind,
        workId: "work:one",
        taskId: taskID,
        status: .complete,
        progress: 1,
        summary: "",
        suggestedOptions: nil,
        suggestedPrompt: nil,
        activityStatus: nil,
        updatedAt: "2026-08-22T00:00:00Z",
        accent: .cyan,
        archived: archived,
        pinned: false,
        sortOrder: nil,
        capabilities: nil,
        external: nil,
        actions: nil,
    )
}
