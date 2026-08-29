import Foundation
import Testing
@testable import CorptieMac

struct WorkItemCompletionSubmissionTests {
    @Test func frozenSubmissionDoesNotFollowLaterSelectionOrViewReuse() throws {
        let first = try workItem(id: "work_item:first", objectiveId: "objective:one", title: "First")
        let second = try workItem(id: "work_item:second", objectiveId: "objective:one", title: "Second")
        let receipt = WorkItemCompletionIntentReceipt(
            receiptId: "receipt:first",
            intentToken: "opaque:first",
            workItemId: first.id,
            objectiveId: first.objectiveId,
            interactionId: "click:first",
            uiSurface: "work_item_completion_confirmation",
            issuedAt: "2026-08-29T00:00:00Z",
            expiresAt: "2026-08-29T00:05:00Z",
            purpose: "work_item_completion"
        )

        let frozen = try #require(WorkItemCompletionSubmission.freeze(
            workItem: first,
            receipt: receipt,
            requestId: "request:first",
            idempotencyKey: "idempotency:first"
        ))
        let laterSelection = second

        #expect(frozen.workItemId == first.id)
        #expect(frozen.workItemId != laterSelection.id)
        #expect(frozen.receipt.intentToken == "opaque:first")
        #expect(frozen.requestId == "request:first")
        #expect(frozen.idempotencyKey == "idempotency:first")
    }

    @Test func staleOrCrossWorkItemReceiptCannotBeFrozen() throws {
        let target = try workItem(id: "work_item:target", objectiveId: "objective:one", title: "Target")
        let crossReceipt = WorkItemCompletionIntentReceipt(
            receiptId: "receipt:other",
            intentToken: "opaque:other",
            workItemId: "work_item:other",
            objectiveId: target.objectiveId,
            interactionId: "click:other",
            uiSurface: "work_item_edit_status_confirmation",
            issuedAt: "2026-08-29T00:00:00Z",
            expiresAt: "2026-08-29T00:05:00Z",
            purpose: "work_item_completion"
        )

        #expect(WorkItemCompletionSubmission.freeze(
            workItem: target,
            receipt: crossReceipt,
            requestId: "request:other",
            idempotencyKey: "idempotency:other"
        ) == nil)
    }

    @Test func retryRetainsExactlyTheSameImmutableCapability() throws {
        let target = try workItem(id: "work_item:retry", objectiveId: "objective:one", title: "Retry")
        let receipt = WorkItemCompletionIntentReceipt(
            receiptId: "receipt:retry", intentToken: "opaque:retry",
            workItemId: target.id, objectiveId: target.objectiveId,
            interactionId: "click:retry", uiSurface: "work_item_completion_confirmation",
            issuedAt: "2026-08-29T00:00:00Z", expiresAt: "2026-08-29T00:05:00Z",
            purpose: "work_item_completion"
        )
        let first = try #require(WorkItemCompletionSubmission.freeze(
            workItem: target, receipt: receipt,
            requestId: "request:retry", idempotencyKey: "idempotency:retry"
        ))
        let retainedForRetry = first
        #expect(retainedForRetry == first)
    }
}

private func workItem(id: String, objectiveId: String, title: String) throws -> WorkItem {
    let data = try JSONSerialization.data(withJSONObject: [
        "id": id,
        "objectiveId": objectiveId,
        "title": title,
        "description": "",
        "acceptanceCriteria": "",
        "priority": "medium",
        "status": "in_progress",
        "mainWorkspaceId": NSNull(),
        "mainAgentId": NSNull(),
        "currentSessionId": NSNull(),
        "executionStatus": "idle",
        "acceptanceAssessment": NSNull(),
        "completionSuggestion": NSNull(),
        "createdAt": "2026-08-29T00:00:00Z",
        "updatedAt": "2026-08-29T00:00:00Z"
    ])
    return try JSONDecoder().decode(WorkItem.self, from: data)
}
