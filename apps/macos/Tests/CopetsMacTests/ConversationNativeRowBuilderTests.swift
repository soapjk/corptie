import AppKit
import Foundation
import XCTest
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor
final class ConversationNativeRowBuilderTests: XCTestCase {
    func testOuterReplyActivityCollapsesCommentaryAndKeepsFinalAndAgentIdentityVisible() throws {
        var projection = builder()
        projection.replyIdentity = .init(agentID: "agent:one", name: "Developer", avatarPath: nil)
        let entries: [ChatDisplayEntry] = [
            .init(kind: .message(try item(["id": "u", "type": "userMessage", "presentationRole": NSNull()]))),
            .init(kind: .message(try item(["id": "middle", "presentationRole": "commentary"]))),
            .init(kind: .process(turnId: "turn:one", items: [try item(["id": "tool", "type": "mcpToolCall", "presentationRole": NSNull()])])),
            .init(kind: .message(try item(["id": "middle-2", "presentationRole": "commentary"]))),
            .init(kind: .message(try item(["id": "final"]))),
        ]
        let source = projection.applyingReplyIdentity(to: entries.map { projection.nativeAppKitRow($0, expandedTurnIds: []) }, entries: entries)
        let collapsed = ConversationReplyActivityProjection.rows(source, entries: entries, expandedIDs: [])
        XCTAssertEqual(collapsed.count, 3)
        XCTAssertEqual(collapsed.last?.id, source.last?.id)
        let group = try XCTUnwrap(collapsed[1].replyActivity)
        XCTAssertFalse(group.isExpanded)
        XCTAssertEqual(group.commentaryCount, 2)
        XCTAssertEqual(group.processCount, 1)
        XCTAssertEqual(collapsed[1].replyIdentity, projection.replyIdentity)
        let expanded = ConversationReplyActivityProjection.rows(source, entries: entries, expandedIDs: [collapsed[1].id])
        XCTAssertEqual(expanded.count, source.count + 1)
        XCTAssertEqual(expanded.filter { $0.replyIdentity != nil }.count, 1)
        XCTAssertFalse(try XCTUnwrap(expanded.first { $0.id == source[2].id }).isExpanded,
            "Opening the outer group must leave the inner process folded")
        let innerSource = projection.applyingReplyIdentity(to: entries.map { projection.nativeAppKitRow($0, expandedTurnIds: ["turn:one"]) }, entries: entries)
        let both = ConversationReplyActivityProjection.rows(innerSource, entries: entries, expandedIDs: [collapsed[1].id])
        XCTAssertTrue(try XCTUnwrap(both.first { $0.id == source[2].id }).isExpanded)
        XCTAssertEqual(ConversationReplyActivityProjection.rows(source, entries: entries, expandedIDs: []).map(\.id), collapsed.map(\.id))
        let searched = ConversationReplyActivityProjection.rows(source, entries: entries, expandedIDs: [], revealingRowID: source[3].id)
        XCTAssertTrue(try XCTUnwrap(searched[1].replyActivity).isExpanded)
        XCTAssertTrue(searched.contains { $0.id == source[3].id })
    }

    func testReplyActivityDoesNotHideSpecialMessagesOrCrossTurnBoundaries() throws {
        let entries: [ChatDisplayEntry] = [
            .init(kind: .message(try item(["id": "one", "presentationRole": "commentary"]))),
            .init(kind: .message(try item(["id": "event", "type": "automationEvent", "presentationRole": "automation"]))),
            .init(kind: .message(try item(["id": "two", "turnId": "turn:two", "presentationRole": "commentary"]))),
            .init(kind: .message(try item(["id": "three", "turnId": "turn:three", "presentationRole": "commentary"]))),
        ]
        let source = entries.map { builder().nativeAppKitRow($0, expandedTurnIds: []) }
        let rows = ConversationReplyActivityProjection.rows(source, entries: entries, expandedIDs: [])
        XCTAssertEqual(rows.count, 4)
        XCTAssertEqual(rows.filter { $0.replyActivity != nil }.count, 3)
        XCTAssertEqual(rows[1].id, source[1].id)
        XCTAssertNil(rows[1].replyActivity)
        let streamed = source + [builder().nativeAppKitRow(.init(kind: .message(try item(["id": "four", "turnId": "turn:three", "presentationRole": "commentary"]))), expandedTurnIds: [])]
        let nextEntries = entries + [.init(kind: .message(try item(["id": "four", "turnId": "turn:three", "presentationRole": "commentary"])))]
        let next = ConversationReplyActivityProjection.rows(streamed, entries: nextEntries, expandedIDs: [])
        XCTAssertEqual(next.map(\.id), rows.map(\.id))
        XCTAssertEqual(next.last?.replyActivity?.commentaryCount, 2)
    }

    func testSpecialReplyCardsKeepTheSameTypographyAndMeasurementsAcrossSkins() throws {
        for fields: [String: Any] in [
            ["id": "automation", "type": "automationEvent", "presentationRole": "automation"],
            ["id": "system", "presentationRole": "system_event"],
        ] {
            let model = builder().nativeAppKitRow(.init(kind: .message(try item(fields))), expandedTurnIds: [])
            XCTAssertEqual(model.contentSurfaceRole, .interaction)
            let classic = NativeTimelineLayoutCache.shared.layout(for: model, columnWidth: 640, typography: .classic)
            let codex = NativeTimelineLayoutCache.shared.layout(for: model, columnWidth: 640, typography: .codexReading)
            XCTAssertEqual(codex.typography, .classic)
            XCTAssertEqual(codex.rowHeight, classic.rowHeight)
            XCTAssertEqual(codex.cardWidth, classic.cardWidth)
            XCTAssertTrue(codex.attributedText === classic.attributedText)
        }
    }

    func testAgentIdentityAppearsOncePerReplyAndSkipsSpecialMessages() throws {
        var projection = builder()
        let identity = ConversationReplyIdentity(agentID: "agent:one", name: "Developer", avatarPath: nil)
        projection.replyIdentity = identity
        let entries: [ChatDisplayEntry] = [
            .init(kind: .message(try item(["id": "u1", "type": "userMessage", "presentationRole": NSNull()]))),
            .init(kind: .message(try item(["id": "event", "type": "automationEvent", "presentationRole": "automation"]))),
            .init(kind: .process(turnId: "turn:one", items: [try item(["id": "tool", "type": "mcpToolCall", "presentationRole": NSNull()])])),
            .init(kind: .message(try item(["id": "comment", "presentationRole": "commentary"]))),
            .init(kind: .message(try item(["id": "system", "presentationRole": "system_event"]))),
            .init(kind: .message(try item(["id": "final"]))),
            .init(kind: .message(try item(["id": "u2", "turnId": "turn:two", "type": "userMessage", "presentationRole": NSNull()]))),
            .init(kind: .message(try item(["id": "reply2", "turnId": "turn:two"]))),
        ]
        let base = entries.map { projection.nativeAppKitRow($0, expandedTurnIds: []) }
        let rows = projection.applyingReplyIdentity(to: base, entries: entries)
        XCTAssertEqual(rows.indices.filter { rows[$0].replyIdentity != nil }, [2, 7])
        XCTAssertEqual(rows[2].replyIdentity, identity)
        XCTAssertEqual(rows.map(\.id), base.map(\.id))
        for index in [2, 7] {
            let original = NativeTimelineLayoutCache.shared.layout(for: base[index], columnWidth: 640)
            let decorated = NativeTimelineLayoutCache.shared.layout(for: rows[index], columnWidth: 640)
            XCTAssertEqual(decorated.rowHeight, original.rowHeight + 36)
            XCTAssertEqual(decorated.cardHeight, original.cardHeight)
            XCTAssertEqual(decorated.cardWidth, original.cardWidth)
            XCTAssertTrue(decorated.attributedText === original.attributedText)
        }
        let expandedBase = entries.map { projection.nativeAppKitRow($0, expandedTurnIds: ["turn:one"]) }
        let expanded = projection.applyingReplyIdentity(to: expandedBase, entries: entries)
        XCTAssertEqual(expanded.indices.filter { expanded[$0].replyIdentity != nil }, [2, 7])
    }

    func testReplyIdentityMovesToEarlierContentWhenHistoryIsPrepended() throws {
        var projection = builder()
        projection.replyIdentity = .init(agentID: "agent:one", name: "Developer", avatarPath: nil)
        let final = ChatDisplayEntry(kind: .message(try item(["id": "final"])))
        let earlier = ChatDisplayEntry(kind: .message(try item(["id": "earlier", "presentationRole": "commentary"])))
        let initial = projection.applyingReplyIdentity(to: [projection.nativeAppKitRow(final, expandedTurnIds: [])], entries: [final])
        let entries = [earlier, final]
        let rows = projection.applyingReplyIdentity(to: entries.map { projection.nativeAppKitRow($0, expandedTurnIds: []) }, entries: entries)
        XCTAssertNotNil(initial[0].replyIdentity)
        XCTAssertNotNil(rows[0].replyIdentity)
        XCTAssertNil(rows[1].replyIdentity)
        XCTAssertEqual(initial[0].id, rows[1].id)
        XCTAssertEqual(initial[0].contentRevision, rows[1].contentRevision)
        XCTAssertNotEqual(initial[0].replyIdentity, rows[1].replyIdentity)
    }

    func testReplyIdentitySurvivesStreamingTailReplacementAndReusedPrefix() throws {
        var projection = builder()
        projection.replyIdentity = .init(agentID: "agent:one", name: "Developer", avatarPath: nil)
        let first = ChatDisplayEntry(kind: .message(try item(["id": "first", "text": "Partial"])))
        let initial = projection.applyingReplyIdentity(to: [projection.nativeAppKitRow(first, expandedTurnIds: [])], entries: [first])
        let streamed = ChatDisplayEntry(kind: .message(try item(["id": "first", "text": "Complete answer"])))
        let rebuilt = projection.applyingReplyIdentity(to: [projection.nativeAppKitRow(streamed, expandedTurnIds: [])], entries: [streamed])
        XCTAssertEqual(rebuilt[0].replyIdentity, initial[0].replyIdentity)
        let final = ChatDisplayEntry(kind: .message(try item(["id": "final"])))
        let entries = [streamed, final]
        let appended = projection.applyingReplyIdentity(to: rebuilt + [projection.nativeAppKitRow(final, expandedTurnIds: [])], entries: entries)
        let repeated = projection.applyingReplyIdentity(to: appended, entries: entries)
        XCTAssertEqual(repeated.map(\.replyIdentity), [projection.replyIdentity, nil])
        XCTAssertEqual(repeated.map(\.contentRevision), appended.map(\.contentRevision))
        projection.replyIdentity = nil
        XCTAssertTrue(projection.applyingReplyIdentity(to: repeated, entries: entries).allSatisfy { $0.replyIdentity == nil })
    }

    func testCommentaryAndFinalRepliesKeepIdentityButUseDifferentCardRoles() throws {
        let commentary = builder().nativeAppKitRow(ChatDisplayEntry(kind: .message(try item([
            "presentationRole": "commentary"]))), expandedTurnIds: [])
        let final = builder().nativeAppKitRow(ChatDisplayEntry(kind: .message(try item())), expandedTurnIds: [])
        XCTAssertTrue(commentary.isCommentary)
        XCTAssertFalse(final.isCommentary)
        XCTAssertEqual(commentary.id, final.id)
        XCTAssertNotEqual(commentary.contentRevision, final.contentRevision)
        XCTAssertTrue(MacSharedMessageTextCard.supports(commentary))
        XCTAssertFalse(commentary.showsHeader)
    }

    func testDesktopProjectionSplitsSyntheticOutboundCollaborationTurn() throws {
        let items = try [item(["id": "u", "type": "userMessage", "presentationRole": NSNull(), "turnStatus": "running"]),
            item(["id": "t1", "type": "mcpToolCall", "presentationRole": NSNull(), "turnStatus": "running"]),
            item(["id": "sent", "type": "userMessage", "presentationRole": "collaboration",
                  "turnId": "session-channel-message:sent", "collaborationDirection": "outbound",
                  "presentationText": "Status update", "collaborationChannelId": "channel:authorized",
                  "collaborationInitiatorSessionId": "logical:source", "collaborationRecipientSessionId": "logical:target",
                  "collaborationSourceWorkId": "work:source", "collaborationTargetWorkId": "work:target"]),
            item(["id": "t2", "type": "mcpToolCall", "presentationRole": NSNull(), "turnStatus": "running"])]
        let entries = ConversationTimeline.makeEntries(from: items)
        XCTAssertEqual(entries.map(\.id), ["message:u", "process:turn:one", "message:sent", "process:turn:one:process-segment:1"])
        let rows = entries.map { builder().nativeAppKitRow($0, expandedTurnIds: []) }
        XCTAssertTrue(rows[2].isCollaboration)
        XCTAssertEqual(rows[3].processState, .running)
        XCTAssertFalse(rows[2].isCommentary)
    }

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
        XCTAssertEqual(row.id, "message:message:one")
        XCTAssertEqual(row.userInputItemID, "message:one")
        XCTAssertTrue(row.copyText.contains("Choose route"))
        XCTAssertTrue(row.copyText.contains("A — Fast"))
        XCTAssertTrue(MacSharedMessageTextCard.supports(row))
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 600)
        XCTAssertGreaterThan(layout.rowHeight, 180)
        _ = NSApplication.shared
        let cell = AppKitSharedMessageTextCell(identifier: .init("user-input-copy"))
        cell.setContent(row, availableWidth: 600, onToggleExpansion: { _ in })
        XCTAssertNotNil(cell.menu?.items.first { $0.identifier?.rawValue == "chat.timeline.context.copy" })
        cell.copyRepresentedMessage()
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), row.copyText)

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
