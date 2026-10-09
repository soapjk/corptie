import Testing
@testable import CorptieMac

struct SessionSupplementaryProjectionTests {
    @Test func localConfirmationTransitionChangesRefreshSignatureAndPreservesIdentity() {
        let pending = CodexThreadItem(id: "confirmation", turnId: "product", turnStatus: "waiting_approval",
                                     type: "collaborationConfirmation", title: "", text: "", options: nil, status: "pending", createdAt: nil)
        let submitting = CollaborationConfirmationController.replacingStatus(pending, with: "submitting")
        let accepted = CollaborationConfirmationController.replacingStatus(submitting, with: "confirmed")
        #expect(submitting.id == pending.id)
        #expect(submitting.collaborationConfirmationStatus == "submitting")
        #expect(detailItemSignature(pending) != detailItemSignature(submitting))
        #expect(accepted.turnStatus == pending.turnStatus)
        #expect(accepted.collaborationConfirmationStatus == "confirmed")
    }
    @Test
    func pendingCollaborationConfirmationComesFromTimelineInsteadOfSessionIndex() {
        var item = CodexThreadItem(
            id: "collaboration-confirmation:one",
            turnId: "turn:one",
            turnStatus: "waiting_approval",
            type: "collaborationConfirmation",
            title: "Confirm Agent Collaboration",
            text: "",
            options: nil,
            status: "pending",
            createdAt: "2026-08-26T10:00:00Z"
        )
        item.presentationText = "Review the migration"
        item.collaborationConfirmationId = "confirmation:one"
        item.collaborationConfirmationStatus = "pending"
        item.collaborationSenderAgentId = "agent:sender"
        item.collaborationSenderName = "Sender"
        item.collaborationRecipientAgentId = "agent:recipient"
        item.collaborationRecipientName = "Recipient"
        item.collaborationTaskTitle = "Migration review"
        item.collaborationAcceptanceCriteria = ["No duplicate messages"]

        let detail = CodexThreadDetail(
            id: "session:one",
            title: "Session",
            status: .blocked,
            source: "provider:test",
            connectionStatus: "connected",
            currentModel: nil,
            currentReasoningLevel: nil,
            activityStatus: "Waiting for approval",
            cwd: nil,
            createdAt: "2026-08-26T10:00:00Z",
            updatedAt: "2026-08-26T10:00:00Z",
            canSend: true,
            sendUnavailableReason: nil,
            capabilities: nil,
            turnCount: 1,
            items: [item]
        )

        let confirmation = BackendClient.pendingCollaborationConfirmation(in: detail)
        #expect(confirmation?.confirmationId == "confirmation:one")
        #expect(confirmation?.recipientName == "Recipient")
        #expect(confirmation?.summary == "Review the migration")
        #expect(confirmation?.acceptanceCriteria == ["No duplicate messages"])

        item.collaborationConfirmationStatus = "confirmed"
        let resolved = CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: .complete,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: nil,
            currentReasoningLevel: nil,
            activityStatus: nil,
            cwd: nil,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            canSend: true,
            sendUnavailableReason: nil,
            capabilities: nil,
            turnCount: 1,
            items: [item]
        )
        #expect(BackendClient.pendingCollaborationConfirmation(in: resolved) == nil)
    }
}
