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
        let completedWorkItem = makeRecoveryWorkItem(id: "work-item:completed", status: "done")
        let current = makeRecoverySession(id: "session:current", workItemID: completedWorkItem.id, archived: true)
        let inaccessibleRecent = makeRecoverySession(id: "session:completed", workItemID: completedWorkItem.id, archived: true)
        let accessibleOlder = makeRecoverySession(id: "session:accessible", workItemID: nil, kind: .assistantChat)

        #expect(SessionSelectionRecoveryPolicy.recoverySessionID(
            recentSessionIDs: [current.id, inaccessibleRecent.id, accessibleOlder.id],
            sessions: [current, inaccessibleRecent, accessibleOlder],
            excluding: current.id
        ) == accessibleOlder.id)
    }

    @Test func backendResolvedCompletedWorkerSessionCannotBecomeARecoveryTarget() {
        let session = makeRecoverySession(
            id: "session:one",
            workItemID: "work-item:one",
            archived: true
        )

        #expect(!SessionSelectionRecoveryPolicy.isAccessible(
            session,
            sessions: [session]
        ))
    }

    @Test func explicitlyArchivedWorkerSessionCannotBecomeARecoveryTarget() {
        let session = makeRecoverySession(id: "session:archived", workItemID: "work-item:one", archived: true)
        #expect(!SessionSelectionRecoveryPolicy.isAccessible(session, sessions: [session]))
    }

    @Test func fallsBackToTheFirstAccessibleSessionWhenHistoryIsStale() {
        let first = makeRecoverySession(id: "session:first", workItemID: nil, kind: .objectiveChat)
        let second = makeRecoverySession(id: "session:second", workItemID: nil, kind: .assistantChat)

        #expect(SessionSelectionRecoveryPolicy.recoverySessionID(
            recentSessionIDs: ["session:deleted"],
            sessions: [first, second],
            excluding: "session:reclaimed"
        ) == first.id)
    }
}

private func makeRecoveryWorkItem(id: String, status: String) -> WorkItem {
    WorkItem(
        id: id,
        objectiveId: "objective:one",
        title: id,
        description: "Description",
        acceptanceCriteria: "Criteria",
        priority: "medium",
        status: status,
        mainWorkspaceId: nil,
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
    workItemID: String?,
    kind: SessionKind = .worker,
    archived: Bool = false
) -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Agent",
        agentId: "agent:one",
        sessionKind: kind,
        objectiveId: "objective:one",
        workItemId: workItemID,
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
