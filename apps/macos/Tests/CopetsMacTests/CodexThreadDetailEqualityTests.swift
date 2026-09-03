import Testing
@testable import CorptieMac

struct CodexThreadDetailEqualityTests {
    @Test
    func streamingMetadataChangeMakesDetailsUnequal() {
        let original = fixtureDetail()
        let streamed = ChatPerformanceFixture.appendingStreamStep(1, to: original)
        #expect(original != streamed)
    }

    @Test
    func middleHistoryChangeWithSameMetadataStillUsesStrictEquality() {
        let original = fixtureDetail()
        var items = original.items
        let item = items[1]
        items[1] = replacingText(in: item, with: item.text + " changed")
        #expect(original != copy(original, items: items))
    }

    private func fixtureDetail() -> CodexThreadDetail {
        ChatPerformanceFixture.make(
            configuration: .init(turnCount: 2, rawItemCount: 8, longMessageCharacters: 100)
        ).detail
    }

    private func copy(_ detail: CodexThreadDetail, items: [CodexThreadItem]) -> CodexThreadDetail {
        CodexThreadDetail(
            id: detail.id, title: detail.title, status: detail.status, source: detail.source,
            connectionStatus: detail.connectionStatus, currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel, activityStatus: detail.activityStatus,
            cwd: detail.cwd, createdAt: detail.createdAt, updatedAt: detail.updatedAt,
            canSend: detail.canSend, sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities, turnCount: detail.turnCount, items: items, actions: detail.actions
        )
    }

    private func replacingText(in item: CodexThreadItem, with text: String) -> CodexThreadItem {
        CodexThreadItem(
            id: item.id, turnId: item.turnId, turnStatus: item.turnStatus, type: item.type,
            title: item.title, text: text, options: item.options, status: item.status,
            createdAt: item.createdAt, rawMetadataJSON: item.rawMetadataJSON,
            processStartedAt: item.processStartedAt, processEndedAt: item.processEndedAt,
            sourceType: item.sourceType, localVisibility: item.localVisibility,
            taskId: item.taskId, collaborationTaskId: item.collaborationTaskId,
            presentationRole: item.presentationRole, presentationText: item.presentationText,
            collaborationDirection: item.collaborationDirection,
            collaborationSenderAgentId: item.collaborationSenderAgentId,
            collaborationSenderName: item.collaborationSenderName,
            collaborationRecipientAgentId: item.collaborationRecipientAgentId,
            collaborationRecipientName: item.collaborationRecipientName,
            collaborationInitiatorSessionId: item.collaborationInitiatorSessionId,
            collaborationInitiatorSessionTitle: item.collaborationInitiatorSessionTitle,
            collaborationInitiatorSessionKind: item.collaborationInitiatorSessionKind,
            collaborationRecipientSessionId: item.collaborationRecipientSessionId,
            collaborationRecipientSessionTitle: item.collaborationRecipientSessionTitle,
            collaborationRecipientSessionKind: item.collaborationRecipientSessionKind,
            collaborationSourceWorkId: item.collaborationSourceWorkId,
            collaborationSourceWorkName: item.collaborationSourceWorkName,
            collaborationTargetWorkId: item.collaborationTargetWorkId,
            collaborationTargetWorkName: item.collaborationTargetWorkName,
            collaborationSourceCorptieTaskId: item.collaborationSourceCorptieTaskId,
            collaborationTargetCorptieTaskId: item.collaborationTargetCorptieTaskId,
            collaborationRelation: item.collaborationRelation,
            collaborationRouteStatus: item.collaborationRouteStatus,
            collaborationRoutingVersion: item.collaborationRoutingVersion,
            collaborationTaskTitle: item.collaborationTaskTitle,
            collaborationMessageKind: item.collaborationMessageKind,
            collaborationProcessingStatus: item.collaborationProcessingStatus,
            collaborationConfirmationId: item.collaborationConfirmationId,
            collaborationConfirmationStatus: item.collaborationConfirmationStatus,
            collaborationAcceptanceCriteria: item.collaborationAcceptanceCriteria,
            fileChanges: item.fileChanges, turnDiff: item.turnDiff
        )
    }
}
