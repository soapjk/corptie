import Foundation
import Testing
@testable import CorptieMac

struct WorkItemDeletionInteractionTests {
    @Test
    func workItemCardsExposeTheSafeDeletionFlowFromAContextMenu() throws {
        let contents = try warRoomSource()

        #expect(contents.contains(".contextMenu {"))
        #expect(contents.contains("Label(L10n(\"删除 WorkItem\"), systemImage: \"trash\")"))
        #expect(contents.contains("onRequestDeletion(item)"))
        #expect(contents.contains(".disabled(pendingDeletionIds.contains(item.id))"))
    }

    @Test
    func confirmedDeletionDismissesTheSheetBeforeStartingBackgroundWork() throws {
        let contents = try warRoomSource()
        let functionStart = try #require(contents.range(of: "private func enqueueDeletion("))
        let functionEnd = try #require(contents.range(
            of: "private func deletionNoticeView",
            range: functionStart.upperBound..<contents.endIndex
        ))
        let functionBody = contents[functionStart.lowerBound..<functionEnd.lowerBound]

        let dismiss = try #require(functionBody.range(of: "deletionPresentation = nil"))
        let backgroundTask = try #require(functionBody.range(of: "Task {"))
        let request = try #require(functionBody.range(of: "client.deleteWorkItem("))
        #expect(dismiss.lowerBound < backgroundTask.lowerBound)
        #expect(backgroundTask.lowerBound < request.lowerBound)
        #expect(functionBody.contains("phase: .deleting"))
        #expect(functionBody.contains("phase: .failure"))
        #expect(functionBody.contains("retryItem: workItem"))
        #expect(functionBody.contains("if deleted"))
        #expect(functionBody.contains("workItems.removeAll { $0.id == workItem.id }"))
    }

    @Test
    func deletionFailureEnvelopeKeepsTheBackendReasonForPresentation() throws {
        let data = Data(#"{"error":"WorkItem 仍绑定不可随之删除的 Artifact：验收证据。","code":"WORK_ITEM_DELETE_BLOCKED"}"#.utf8)
        let envelope = try JSONDecoder().decode(EntityErrorEnvelope.self, from: data)
        #expect(envelope.code == "WORK_ITEM_DELETE_BLOCKED")
        #expect(envelope.displayMessage == "WorkItem 仍绑定不可随之删除的 Artifact：验收证据。")

        let clientSource = try entityAPIClientSource()
        #expect(clientSource.contains("envelope?.displayMessage ?? L10n(\"Unable to inspect WorkItem deletion.\")"))
        #expect(clientSource.contains("envelope?.displayMessage ?? L10n(\"Unable to delete WorkItem.\")"))
    }

    @Test
    func deletionConfirmationWarnsThatSessionsAndConversationHistoryArePermanent() throws {
        let contents = try warRoomSource()

        #expect(contents.contains("plan.associatedSessionCount"))
        #expect(contents.contains("关联会话及完整会话历史"))
        #expect(contents.contains("此操作无法撤销"))
    }

    private func warRoomSource() throws -> String {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/WarRoomView.swift")
        return try String(contentsOf: source, encoding: .utf8)
    }

    private func entityAPIClientSource() throws -> String {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/EntityAPIClient.swift")
        return try String(contentsOf: source, encoding: .utf8)
    }
}
