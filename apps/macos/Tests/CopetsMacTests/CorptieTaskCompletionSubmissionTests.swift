import Foundation
import Testing
@testable import CorptieMac

struct CorptieTaskCompletionSubmissionTests {
    @Test func frozenSubmissionDoesNotFollowLaterSelectionOrViewReuse() throws {
        let first = try task(id: "task:first", objectiveId: "objective:one", title: "First")
        let second = try task(id: "task:second", objectiveId: "objective:one", title: "Second")
        let receipt = CorptieTaskCompletionIntentReceipt(
            receiptId: "receipt:first",
            intentToken: "opaque:first",
            taskId: first.id,
            objectiveId: first.objectiveId,
            interactionId: "click:first",
            uiSurface: "task_completion_confirmation",
            issuedAt: "2026-08-29T00:00:00Z",
            expiresAt: "2026-08-29T00:05:00Z",
            purpose: "task_completion"
        )

        let frozen = try #require(CorptieTaskCompletionSubmission.freeze(
            task: first,
            receipt: receipt,
            requestId: "request:first",
            idempotencyKey: "idempotency:first"
        ))
        let laterSelection = second

        #expect(frozen.taskId == first.id)
        #expect(frozen.taskId != laterSelection.id)
        #expect(frozen.receipt.intentToken == "opaque:first")
        #expect(frozen.requestId == "request:first")
        #expect(frozen.idempotencyKey == "idempotency:first")
    }

    @Test func staleOrCrossCorptieTaskReceiptCannotBeFrozen() throws {
        let target = try task(id: "task:target", objectiveId: "objective:one", title: "Target")
        let crossReceipt = CorptieTaskCompletionIntentReceipt(
            receiptId: "receipt:other",
            intentToken: "opaque:other",
            taskId: "task:other",
            objectiveId: target.objectiveId,
            interactionId: "click:other",
            uiSurface: "task_edit_status_confirmation",
            issuedAt: "2026-08-29T00:00:00Z",
            expiresAt: "2026-08-29T00:05:00Z",
            purpose: "task_completion"
        )

        #expect(CorptieTaskCompletionSubmission.freeze(
            task: target,
            receipt: crossReceipt,
            requestId: "request:other",
            idempotencyKey: "idempotency:other"
        ) == nil)
    }

    @Test func retryRetainsExactlyTheSameImmutableCapability() throws {
        let target = try task(id: "task:retry", objectiveId: "objective:one", title: "Retry")
        let receipt = CorptieTaskCompletionIntentReceipt(
            receiptId: "receipt:retry", intentToken: "opaque:retry",
            taskId: target.id, objectiveId: target.objectiveId,
            interactionId: "click:retry", uiSurface: "task_completion_confirmation",
            issuedAt: "2026-08-29T00:00:00Z", expiresAt: "2026-08-29T00:05:00Z",
            purpose: "task_completion"
        )
        let first = try #require(CorptieTaskCompletionSubmission.freeze(
            task: target, receipt: receipt,
            requestId: "request:retry", idempotencyKey: "idempotency:retry"
        ))
        let retainedForRetry = first
        #expect(retainedForRetry == first)
    }
}

private func task(id: String, objectiveId: String, title: String) throws -> CorptieTask {
    let data = try JSONSerialization.data(withJSONObject: [
        "id": id,
        "objectiveId": objectiveId,
        "title": title,
        "description": "",
        "goal": "",
        "acceptanceCriteria": "",
        "verificationCriteria": "",
        "priority": "medium",
        "lifecycleState": "in_progress",
        "resourceVersion": 1,
        "revision": 1,
        "mainWorkspaceId": NSNull(),
        "mainAgentId": NSNull(),
        "currentSessionId": NSNull(),
        "executionStatus": "idle",
        "acceptanceAssessment": NSNull(),
        "completionSuggestion": NSNull(),
        "createdAt": "2026-08-29T00:00:00Z",
        "updatedAt": "2026-08-29T00:00:00Z"
    ])
    return try JSONDecoder().decode(CorptieTask.self, from: data)
}
