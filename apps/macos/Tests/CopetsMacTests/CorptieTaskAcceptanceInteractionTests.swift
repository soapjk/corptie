import Testing
@testable import CorptieMac

struct CorptieTaskAcceptanceInteractionTests {
    @Test func completionRetrySkipsAnAlreadyCompletedCorptieTask() {
        for status in ["done", "complete", "completed"] {
            #expect(CorptieTaskCompletionBackgroundDecision.resolve(status: status) == .alreadyCompleted)
        }
        #expect(CorptieTaskCompletionBackgroundDecision.resolve(status: "in_progress") == .submit)
        for status in ["in_progress", "doing", "running"] {
            #expect(CorptieTaskCompletionBackgroundDecision.requiresExplicitUserConfirmation(status: status))
        }
        #expect(!CorptieTaskCompletionBackgroundDecision.requiresExplicitUserConfirmation(status: "review"))
    }

    @Test func statusOverrideUsesBackgroundSubmissionOnlyAfterTheRequiredConfirmation() {
        #expect(CorptieTaskEditSubmissionPolicy.submitsInBackground(statusChanged: true))
        #expect(!CorptieTaskEditSubmissionPolicy.submitsInBackground(statusChanged: false))
    }

    @Test func passedAssessmentPresentsItsConclusionDetails() {
        let result = acceptanceResult(verdict: "passed")
        let presentation = CorptieTaskAutomaticAcceptancePresentation.resolve(
            assessment: acceptanceAssessment(status: "passed", results: [result]),
            suggestion: nil
        )

        #expect(presentation.state == .passed)
        #expect(presentation.results == [result])
    }

    @Test func failedAssessmentPresentsItsConclusionDetails() {
        let result = acceptanceResult(verdict: "failed")
        let presentation = CorptieTaskAutomaticAcceptancePresentation.resolve(
            assessment: acceptanceAssessment(status: "not_proven", results: [result]),
            suggestion: nil
        )

        #expect(presentation.state == .notPassed)
        #expect(presentation.results == [result])
    }

    @Test func missingAssessmentPresentsExplicitEmptyStateData() {
        let presentation = CorptieTaskAutomaticAcceptancePresentation.resolve(
            assessment: nil,
            suggestion: nil
        )

        #expect(presentation.state == .notAssessed)
        #expect(presentation.results.isEmpty)
    }

    @Test func acceptanceReviewIsAvailableOnlyForAPassingSuggestion() {
        let result = acceptanceResult(verdict: "passed")
        let item = makeAcceptanceCorptieTask(
            assessment: acceptanceAssessment(status: "passed", results: [result]),
            suggestion: CorptieTaskCompletionSuggestion(
                recommended: true,
                sourceSessionId: "session:acceptance",
                assessedAt: "2026-08-20T00:00:00Z",
                criteriaSnapshot: "Criterion",
                results: [result]
            )
        )
        #expect(CorptieTaskAcceptanceReviewState.resolve(item) == .passed)
        #expect(CorptieTaskAcceptanceReviewState.resolve(
            makeAcceptanceCorptieTask(assessment: nil, suggestion: nil)
        ) == .unavailable)
    }

    @Test func rejectedAssessmentPresentsTheManualRejectionState() {
        let item = makeAcceptanceCorptieTask(
            assessment: acceptanceAssessment(
                status: "rejected",
                results: [acceptanceResult(verdict: "passed")]
            ),
            suggestion: nil
        )
        #expect(CorptieTaskAcceptanceReviewState.resolve(item) == .manuallyRejected)
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

private func makeAcceptanceCorptieTask(
    assessment: CorptieTaskAcceptanceAssessment?,
    suggestion: CorptieTaskCompletionSuggestion?
) -> CorptieTask {
    CorptieTask(
        id: "task:acceptance",
        objectiveId: "objective:one",
        title: "Acceptance",
        description: "",
        acceptanceCriteria: "Criterion",
        priority: "medium",
        lifecycleState: "in_progress",
        mainWorkspaceId: nil,
        mainAgentId: nil,
        currentSessionId: nil,
        executionStatus: "idle",
        acceptanceAssessment: assessment,
        completionSuggestion: suggestion,
        createdAt: "2026-08-20T00:00:00Z",
        updatedAt: "2026-08-20T00:00:00Z"
    )
}

private func acceptanceAssessment(
    status: String,
    results: [CorptieTaskAcceptanceResult]
) -> CorptieTaskAcceptanceAssessment {
    CorptieTaskAcceptanceAssessment(
        status: status,
        criteriaSnapshot: "Criterion",
        sourceSessionId: "session:acceptance",
        assessedAt: "2026-08-20T00:00:00Z",
        results: results
    )
}

private func acceptanceResult(verdict: String) -> CorptieTaskAcceptanceResult {
    CorptieTaskAcceptanceResult(
        criterion: "Criterion",
        verdict: verdict,
        evidence: [
            CorptieTaskAcceptanceEvidence(summary: "Verified", reference: "swift test")
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
        taskId: nil,
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
    )
}
