import Foundation
import XCTest
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor
final class ConversationNativeRowBuilderTests: XCTestCase {
    private func item(_ overrides: [String: Any] = [:]) throws -> CodexThreadItem {
        var fields: [String: Any] = [
            "id": "message:one", "turnId": "turn:one", "turnStatus": "completed",
            "type": "agentMessage", "title": "Agent", "text": "Answer",
            "status": "completed", "presentationRole": "final_answer"
        ]
        fields.merge(overrides) { _, new in new }
        return try JSONDecoder().decode(
            CodexThreadItem.self, from: JSONSerialization.data(withJSONObject: fields)
        )
    }

    private func builder(allowsFork: Bool = true) -> ConversationNativeRowBuilder {
        ConversationNativeRowBuilder(
            sessionTitle: "Session", workingDirectory: nil, allowsFork: allowsFork,
            imageURL: { _ in nil }
        )
    }

    func testUserInputOptionsRenderInlineWithoutAnswerSheetAction() throws {
        let input: [String: Any] = [
            "schemaVersion": 1, "isBlocking": true,
            "questions": [["id": "route", "header": "Route", "question": "Choose route",
                "isOther": false, "isSecret": false,
                "options": [["label": "A", "description": "Fast"],
                    ["label": "B", "description": "Safe"]]]]
        ]
        let pending = ChatDisplayEntry(kind: .message(try item([
            "type": "userInput", "status": "pending", "userInput": input
        ])))
        let row = builder().nativeAppKitRow(pending, expandedTurnIds: [])
        XCTAssertTrue(row.actions.isEmpty)
        XCTAssertNotNil(row.userInput)
        XCTAssertTrue(MacSharedMessageTextCard.supports(row))
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 600)
        XCTAssertGreaterThan(layout.rowHeight, 180)

        let submitted = ChatDisplayEntry(kind: .message(try item([
            "type": "userInput", "status": "submitted", "userInput": input.merging(
                ["selectedOptions": ["route": ["B"]]]) { _, new in new }
        ])))
        let completedRow = builder().nativeAppKitRow(submitted, expandedTurnIds: [])
        XCTAssertEqual(completedRow.userInput?.selectedOptions?["route"], ["B"])
        XCTAssertNotEqual(row.contentRevision, completedRow.contentRevision)
    }

    func testSubmittedTextAnswerExpandsCardInsteadOfBeingClipped() throws {
        let longAnswer = String(repeating: "This is a complete answer. ", count: 35)
        let question: [String: Any] = [
            "id": "answer", "header": "", "question": "Explain your choice",
            "isOther": false, "isSecret": true, "options": NSNull()
        ]
        let base: [String: Any] = ["schemaVersion": 1, "isBlocking": true, "questions": [question]]
        let short = builder().nativeAppKitRow(ChatDisplayEntry(kind: .message(try item([
            "type": "userInput", "status": "submitted", "userInput": base.merging(
                ["submittedAnswers": ["answer": ["Short"]]]) { _, new in new }
        ]))), expandedTurnIds: [])
        let long = builder().nativeAppKitRow(ChatDisplayEntry(kind: .message(try item([
            "type": "userInput", "status": "submitted", "userInput": base.merging(
                ["submittedAnswers": ["answer": [longAnswer]]]) { _, new in new }
        ]))), expandedTurnIds: [])
        XCTAssertNotEqual(short.contentRevision, long.contentRevision)
        XCTAssertGreaterThan(NativeTimelineLayoutCache.shared.layout(for: long, columnWidth: 500).rowHeight,
                             NativeTimelineLayoutCache.shared.layout(for: short, columnWidth: 500).rowHeight)
    }

    func testFinalAnswerForkAvailabilityChangesRevisionWithoutChangingIdentity() throws {
        let entry = ChatDisplayEntry(kind: .message(try item()))
        let enabled = builder()
        let disabled = builder(allowsFork: false)
        let first = enabled.nativeAppKitRow(entry, expandedTurnIds: [])
        let second = disabled.nativeAppKitRow(entry, expandedTurnIds: [])
        XCTAssertEqual(first.id, second.id)
        XCTAssertEqual(first.forkItemID, "message:one")
        XCTAssertNil(second.forkItemID)
        XCTAssertNotEqual(first.contentRevision, second.contentRevision)
        XCTAssertEqual(first.copyText, "Answer")
    }

    func testUnfinishedAnswerDoesNotOfferFork() throws {
        let entry = ChatDisplayEntry(kind: .message(try item(["turnStatus": "inProgress"])))
        XCTAssertNil(builder().forkItemID(for: entry))
    }

    func testProcessExpansionUsesTheSameRowAndDoesNotExposeRawMetadata() throws {
        let entry = ChatDisplayEntry(kind: .process(turnId: "turn:one", items: [
            try item(["type": "commandExecution", "text": "Inspect project", "presentationRole": "commentary"])
        ]))
        let projection = builder()
        let collapsed = projection.nativeAppKitRow(entry, expandedTurnIds: [])
        let expanded = projection.nativeAppKitRow(entry, expandedTurnIds: ["turn:one"])
        XCTAssertEqual(collapsed.id, expanded.id)
        XCTAssertFalse(collapsed.isExpanded)
        XCTAssertTrue(expanded.isExpanded)
        XCTAssertEqual(collapsed.copyText, "")
        XCTAssertEqual(collapsed.rawStatusText, "")
        XCTAssertEqual(expanded.rawStatusText, "")
        XCTAssertNotEqual(collapsed.contentRevision, expanded.contentRevision)
    }

    func testPendingApprovalKeepsActionsAndIdentityWhenItExpires() throws {
        let pending = ChatDisplayEntry(kind: .message(try item([
            "type": "approval", "status": "pending", "presentationRole": ""
        ])))
        let expired = ChatDisplayEntry(kind: .message(try item([
            "type": "approval", "status": "expired", "presentationRole": ""
        ])))
        let projection = builder()
        let first = projection.nativeAppKitRow(pending, expandedTurnIds: [])
        let second = projection.nativeAppKitRow(expired, expandedTurnIds: [])
        XCTAssertEqual(first.id, second.id)
        XCTAssertTrue(first.isPendingInteraction)
        XCTAssertEqual(first.actions.count, 2)
        XCTAssertFalse(second.isPendingInteraction)
        XCTAssertTrue(second.actions.isEmpty)
    }
}
