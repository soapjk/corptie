import Foundation
import Testing
@testable import CorptieMac

struct CorptieTaskDeletionInteractionTests {
    @Test
    func taskCardsExposeTheSafeDeletionFlowFromAContextMenu() throws {
        let contents = try warRoomSource()

        #expect(contents.contains(".contextMenu {"))
        #expect(contents.contains("Button(L10n(\"Open Details\"), systemImage: \"sidebar.right\")"))
        #expect(contents.contains("Button(L10n(\"编辑\"), systemImage: \"square.and.pencil\")"))
        #expect(contents.contains("Label(L10n(\"删除 CorptieTask\"), systemImage: \"trash\")"))
        #expect(contents.contains("onRequestDeletion(item)"))
        #expect(contents.contains(".disabled(pendingDeletionIds.contains(item.id))"))
        #expect(contents.contains(".contentShape(Rectangle())"))
    }

    @Test
    func objectiveRowsExposeFullWidthEditAndDeleteContextActions() throws {
        let contents = try warRoomSource()

        #expect(contents.contains("Button(L10n(\"View Tasks\"), systemImage: \"rectangle.grid.1x2\")"))
        #expect(contents.contains("objectivePendingEdit = objective"))
        #expect(contents.contains("objectivePendingDeletion = objective"))
        #expect(contents.contains("private func deleteObjective(_ objective: Objective) async"))

        let clientSource = try entityAPIClientSource()
        #expect(clientSource.contains("!(200..<300).contains(http.statusCode)"))
        #expect(clientSource.contains("envelope?.displayMessage ?? L10n(\"Unable to delete Objective.\")"))
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
        let request = try #require(functionBody.range(of: "client.deleteCorptieTask("))
        #expect(dismiss.lowerBound < backgroundTask.lowerBound)
        #expect(backgroundTask.lowerBound < request.lowerBound)
        #expect(functionBody.contains("phase: .deleting"))
        #expect(functionBody.contains("phase: .failure"))
        #expect(functionBody.contains("retryItem: task"))
        #expect(functionBody.contains("if deleted"))
        #expect(functionBody.contains("tasks.removeAll { $0.id == task.id }"))
    }

    @Test
    func deletionFailureEnvelopeKeepsTheBackendReasonForPresentation() throws {
        let data = Data(#"{"error":"CorptieTask 仍绑定不可随之删除的 Artifact：验收证据。","code":"TASK_DELETE_BLOCKED"}"#.utf8)
        let envelope = try JSONDecoder().decode(EntityErrorEnvelope.self, from: data)
        #expect(envelope.code == "TASK_DELETE_BLOCKED")
        #expect(envelope.displayMessage == "CorptieTask 仍绑定不可随之删除的 Artifact：验收证据。")

        let clientSource = try entityAPIClientSource()
        #expect(clientSource.contains("envelope?.displayMessage ?? L10n(\"Unable to inspect CorptieTask deletion.\")"))
        #expect(clientSource.contains("envelope?.displayMessage ?? L10n(\"Unable to delete CorptieTask.\")"))
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
