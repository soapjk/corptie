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

    private func builder(allowsFork: Bool = true, unavailableReason: String? = nil) -> ConversationNativeRowBuilder {
        ConversationNativeRowBuilder(
            sessionTitle: "Session", workingDirectory: nil, allowsFork: allowsFork,
            forkUnavailableReason: unavailableReason,
            imageURL: { _ in nil }
        )
    }

    func testCompletedAnswerExplainsUnavailableForkWithoutMakingItActionable() throws {
        let row = builder(allowsFork: false, unavailableReason: "Work Chat 不支持分叉")
            .nativeAppKitRow(ChatDisplayEntry(kind: .message(try item())), expandedTurnIds: [])
        XCTAssertNil(row.forkItemID)
        XCTAssertEqual(row.forkUnavailableReason, "Work Chat 不支持分叉")
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
