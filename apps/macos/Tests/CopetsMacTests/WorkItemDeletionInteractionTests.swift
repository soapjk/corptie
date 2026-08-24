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
    }

    private func warRoomSource() throws -> String {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/WarRoomView.swift")
        return try String(contentsOf: source, encoding: .utf8)
    }
}
