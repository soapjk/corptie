import Testing
@testable import CorptieMac

struct WorkItemAcceptanceInteractionTests {
    @Test func automaticRefreshNeverPresentsAcceptanceConfirmation() {
        #expect(!WorkItemAcceptancePresentationDecision.shouldPresent(
            trigger: .automaticRefresh,
            hasPassingAcceptance: true
        ))
    }

    @Test func passingStatusButtonPresentsAcceptanceConfirmation() {
        #expect(WorkItemAcceptancePresentationDecision.shouldPresent(
            trigger: .automaticAcceptanceButton,
            hasPassingAcceptance: true
        ))
        #expect(!WorkItemAcceptancePresentationDecision.shouldPresent(
            trigger: .automaticAcceptanceButton,
            hasPassingAcceptance: false
        ))
    }

    @Test func objectiveDiscussionOpensItsExistingBoundSession() {
        let existing = makeObjectiveSession(id: "session:discussion", objectiveId: "objective:one")
        #expect(ObjectiveDiscussionRouteDecision.resolve(
            objectiveId: "objective:one",
            sessions: [existing]
        ) == .open(sessionId: existing.id))
    }

    @Test func objectiveDiscussionUsesCreationFlowWhenNoBoundSessionExists() {
        let other = makeObjectiveSession(id: "session:other", objectiveId: "objective:other")
        #expect(ObjectiveDiscussionRouteDecision.resolve(
            objectiveId: "objective:one",
            sessions: [other]
        ) == .create)
    }
}

private func makeObjectiveSession(id: String, objectiveId: String) -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Agent",
        agentId: "agent:one",
        sessionKind: .objectiveChat,
        objectiveId: objectiveId,
        workItemId: nil,
        status: .complete,
        progress: 1,
        summary: "",
        suggestedOptions: nil,
        suggestedPrompt: nil,
        activityStatus: nil,
        updatedAt: "2026-08-19T00:00:00Z",
        accent: .cyan,
        archived: false,
        pinned: false,
        sortOrder: nil,
        capabilities: nil,
        external: nil,
        actions: nil,
        pendingCollaborationConfirmation: nil
    )
}
