import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class MessageWithdrawalTests: XCTestCase {
    private func row(withdrawn: Bool = false, status: String = "queued") throws -> AppKitChatTimelineRow {
        let message = try JSONDecoder().decode(CodexThreadItem.self, from: Data("""
        {"id":"message:one","turnId":"turn:one","turnStatus":"cancelled","type":"userMessage",
         "title":"User","text":"\(withdrawn ? "已撤回" : "Original instruction")",
         "status":"\(status)","userMessageStatus":"\(status)","deletionAvailable":true,
         "images":[],"withdrawnMessage":\(withdrawn ? "{\"text\":\"Original instruction\",\"images\":[]}" : "null")}
        """.utf8))
        let builder = ConversationNativeRowBuilder(sessionTitle: "Session", workingDirectory: nil,
            allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in nil })
        return builder.nativeAppKitRow(.init(kind: .message(message)), expandedTurnIds: [])
    }

    func testQueuedAndFailedMenusExposeOneWithdrawalInsteadOfCancelOrDelete() throws {
        _ = NSApplication.shared
        for status in ["queued", "failed"] {
            let row = try row(status: status)
            XCTAssertEqual(row.withdrawableMessageID, "message:one")
            let cell = AppKitSharedMessageTextCell(identifier: .init("withdrawal-test"))
            var action: AppKitChatTimelineRow.Action?
            cell.setContent(row, availableWidth: 400, onToggleExpansion: { _ in }, onAction: { action = $0 })
            let menus = try XCTUnwrap(cell.menu)
            let withdraw = try XCTUnwrap(menus.items.first { $0.identifier?.rawValue == "chat.timeline.context.withdraw" })
            XCTAssertEqual(menus.items.filter { $0.identifier?.rawValue == "chat.timeline.context.withdraw" }.count, 1)
            XCTAssertFalse(menus.items.contains { $0.identifier?.rawValue == "chat.timeline.context.cancel-queued" })
            XCTAssertFalse(menus.items.contains { ["删除", "Delete", "取消", "Cancel"].contains($0.title) })
            NSApp.sendAction(try XCTUnwrap(withdraw.action), to: withdraw.target, from: withdraw)
            guard let action, case .withdrawMessage(let id) = action.kind else { return XCTFail("Expected withdrawal") }
            XCTAssertEqual(id, "message:one")
        }
    }

    func testWithdrawnRowHasCompactInlineEditAndReusesOneControlAcrossWidths() throws {
        _ = NSApplication.shared
        let row = try row(withdrawn: true, status: "cancelled")
        XCTAssertNil(row.withdrawableMessageID)
        XCTAssertNil(row.deletableMessageID)
        XCTAssertNil(row.queuedMessageTaskID)
        XCTAssertNil(row.messageStatus)
        XCTAssertTrue(row.images.isEmpty)
        XCTAssertFalse(MacSharedMessageTextCard.supports(row))
        let cell = AppKitChatNativeTextCell(identifier: .init("withdrawn-marker"))
        var action: AppKitChatTimelineRow.Action?
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        for width: CGFloat in [240, 480, 900, 240] {
            cell.setContent(row, availableWidth: width, onToggleExpansion: { _ in }, onAction: { action = $0 })
            cell.layoutSubtreeIfNeeded()
            let controls = descendants(cell).compactMap { $0 as? NSButton }.filter {
                $0.identifier?.rawValue == "chat.timeline.withdrawn.edit"
            }
            XCTAssertEqual(controls.count, 1)
            let edit = try XCTUnwrap(controls.first)
            XCTAssertFalse(edit.isHidden)
            edit.performClick(nil)
            let text = descendants(cell).compactMap { ($0 as? NSTextView)?.string }.joined()
            XCTAssertTrue(text.contains("已撤回"))
            XCTAssertFalse(text.contains("Original instruction"))
        }
        guard let action, case .editWithdrawnMessage(let id) = action.kind else { return XCTFail("Expected edit") }
        XCTAssertEqual(id, "message:one")
    }

    func testEditingRestoresContentAlongsideExistingDraftWithoutSendingOrDuplicating() throws {
        let draft = ComposerDraftBuffer(text: "Existing draft")
        let message = WithdrawnUserMessage(text: "Original instruction", images: [])
        draft.restoreWithdrawnMessage(id: "message:one", message: message)
        XCTAssertEqual(draft.text, "Existing draft\n\nOriginal instruction")
        draft.restoreWithdrawnMessage(id: "message:one", message: message)
        XCTAssertEqual(draft.text, "Existing draft\n\nOriginal instruction")
        let editor = ComposerEditorController(draft: draft)
        let view = NSTextView()
        editor.attach(view)
        draft.restoreWithdrawnMessage(id: "message:two", message: .init(text: "Second", images: []))
        editor.synchronizeExternalDraft()
        XCTAssertEqual(view.string, draft.text)
        XCTAssertTrue(draft.hasSendableText)
    }
}
