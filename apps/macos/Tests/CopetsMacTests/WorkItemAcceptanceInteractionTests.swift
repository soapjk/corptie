import Testing
@testable import CorptieMac

struct WorkItemAcceptanceInteractionTests {
    @Test func passedAssessmentPresentsItsConclusionDetails() {
        let result = acceptanceResult(verdict: "passed")
        let presentation = WorkItemAutomaticAcceptancePresentation.resolve(
            assessment: acceptanceAssessment(status: "passed", results: [result]),
            suggestion: nil
        )

        #expect(presentation.state == .passed)
        #expect(presentation.results == [result])
    }

    @Test func failedAssessmentPresentsItsConclusionDetails() {
        let result = acceptanceResult(verdict: "failed")
        let presentation = WorkItemAutomaticAcceptancePresentation.resolve(
            assessment: acceptanceAssessment(status: "not_proven", results: [result]),
            suggestion: nil
        )

        #expect(presentation.state == .notPassed)
        #expect(presentation.results == [result])
    }

    @Test func missingAssessmentPresentsExplicitEmptyStateData() {
        let presentation = WorkItemAutomaticAcceptancePresentation.resolve(
            assessment: nil,
            suggestion: nil
        )

        #expect(presentation.state == .notAssessed)
        #expect(presentation.results.isEmpty)
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

private func acceptanceAssessment(
    status: String,
    results: [WorkItemAcceptanceResult]
) -> WorkItemAcceptanceAssessment {
    WorkItemAcceptanceAssessment(
        status: status,
        criteriaSnapshot: "Criterion",
        sourceSessionId: "session:acceptance",
        assessedAt: "2026-08-20T00:00:00Z",
        results: results
    )
}

private func acceptanceResult(verdict: String) -> WorkItemAcceptanceResult {
    WorkItemAcceptanceResult(
        criterion: "Criterion",
        verdict: verdict,
        evidence: [
            WorkItemAcceptanceEvidence(summary: "Verified", reference: "swift test")
        ]
    )
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
