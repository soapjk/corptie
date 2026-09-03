import Foundation
import Testing
@testable import CorptieMac

struct CorptieTaskDeletionInteractionTests {
    @Test
    func taskCardsExposeTheSafeDeletionFlowFromAContextMenu() throws {
        let contents = try warRoomSource()

        #expect(contents.contains(".contextMenu {"))
        #expect(!contents.contains("Button(L10n(\"Open Details\"), systemImage: \"sidebar.right\")"))
        #expect(contents.contains("Button(L10n(\"编辑\"), systemImage: \"square.and.pencil\")"))
        #expect(contents.contains("Label(L10n(\"删除 CorptieTask\"), systemImage: \"trash\")"))
        #expect(contents.contains("onRequestDeletion(item)"))
        #expect(contents.contains(".disabled(pendingDeletionIds.contains(item.id))"))
        #expect(contents.contains(".contentShape(Rectangle())"))
    }

    @Test
    func workRowsExposeFullWidthEditAndDeleteContextActions() throws {
        let contents = try warRoomSource()

        #expect(contents.contains("Button(L10n(\"View Tasks\"), systemImage: \"rectangle.grid.1x2\")"))
        #expect(contents.contains("workPendingEdit = work"))
        #expect(contents.contains("workPendingDeletion = work"))
        #expect(contents.contains("private func deleteWork(_ work: Work) async"))

        let clientSource = try entityAPIClientSource()
        #expect(clientSource.contains("!(200..<300).contains(http.statusCode)"))
        #expect(clientSource.contains("envelope?.displayMessage ?? L10n(\"Unable to delete Work.\")"))
    }

    @Test
    func productionConsoleWorkAvatarsAndTaskRowsExposeContextActions() throws {
        let source = try unifiedConsoleSource()

        #expect(source.contains("private var workRail: some View"))
        #expect(source.contains("workPendingEdit = work"))
        #expect(source.contains("workPendingDeletion = work"))
        #expect(source.contains("private func taskRow(_ task: CorptieTask) -> some View"))
        #expect(!source.contains("Button(L10n(\"Open Details\"), systemImage: \"sidebar.right\")"))
        #expect(source.contains("taskPendingEdit = task"))
        #expect(source.contains("Task { await prepareTaskDeletion(task) }"))
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
        let backgroundTask = try #require(functionBody.range(of: "BackgroundTaskCenter.shared.start("))
        let request = try #require(functionBody.range(of: "client.deleteCorptieTask("))
        #expect(dismiss.lowerBound < backgroundTask.lowerBound)
        #expect(backgroundTask.lowerBound < request.lowerBound)
        #expect(functionBody.contains("return .failure"))
        #expect(functionBody.contains("return .success"))
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
        #expect(contents.contains("@State private var deleteWorktree = true"))
        #expect(contents.contains("@State private var artifactDisposition: CorptieTaskArtifactDisposition = .delete"))
        #expect(contents.contains("移入 Work 层级"))
        #expect(contents.contains("留在原地"))
    }

    @Test
    func selectingASessionVerifiesItsConcreteProviderBindingBeforeEnablingComposer() throws {
        let source = try backendClientSource()

        #expect(source.contains("actions/probe-binding"))
        #expect(source.contains("bindingVerificationSessionIDs.insert(session.id)"))
        #expect(source.contains("bindingVerificationSessionIDs.contains(id) { return false }"))
        #expect(source.contains("await AppStateSyncController.shared.refreshSnapshot()"))
    }

    private func warRoomSource() throws -> String {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/WarRoomView.swift")
        return try String(contentsOf: source, encoding: .utf8)
    }

    private func unifiedConsoleSource() throws -> String {
        let testsURL = URL(fileURLWithPath: #filePath)
        let packageRoot = testsURL
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: packageRoot.appendingPathComponent("Sources/CopetsMac/UnifiedConsoleView.swift"),
            encoding: .utf8
        )
    }

    private func entityAPIClientSource() throws -> String {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/EntityAPIClient.swift")
        return try String(contentsOf: source, encoding: .utf8)
    }

    private func backendClientSource() throws -> String {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/BackendClient.swift")
        return try String(contentsOf: source, encoding: .utf8)
    }
}
