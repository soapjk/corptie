import AppKit
import SwiftUI
import Foundation
import XCTest
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor
final class ConversationNativeRowBuilderTests: XCTestCase {
    func testScheduledTriggerPreviewsThreeVisualLinesAndExpandsWithoutTruncatingCopy() throws {
        let message = (0..<30).map { "Trigger line \($0): " + String(repeating: "完整任务内容 **literal** ", count: 8) }.joined(separator: "\n")
        let entry = ChatDisplayEntry(kind: .message(try item(["id": "scheduled-preview", "type": "automationEvent",
            "presentationRole": "automation", "automationEventType": "ScheduledSessionTaskCreated",
            "automationName": "A scheduled task", "text": message])))
        let collapsed = builder().nativeAppKitRow(entry, expandedTurnIds: [])
        let id = try XCTUnwrap(collapsed.scheduledTrigger?.expansionID)
        XCTAssertEqual(collapsed.copyText, message)
        XCTAssertFalse(collapsed.nativeText.contains("Trigger line"))
        XCTAssertEqual(collapsed.expandableTurnId, id)
        let expanded = builder().nativeAppKitRow(entry, expandedTurnIds: [id])
        XCTAssertNotEqual(expanded.contentRevision, collapsed.contentRevision)
        for width: CGFloat in [320, 1000, 2400] {
            let preview = NativeTimelineLayoutCache.shared.layout(for: collapsed, columnWidth: width)
            let full = NativeTimelineLayoutCache.shared.layout(for: expanded, columnWidth: width)
            XCTAssertEqual(preview.cardWidth, min(480, width - 4))
            XCTAssertTrue(preview.triggerCanExpand)
            XCTAssertEqual(preview.triggerTextHeight, NativeTextKitLayout.height(of: try XCTUnwrap(preview.triggerText),
                width: preview.cardWidth - 20, maximumLines: 3))
            XCTAssertGreaterThan(full.rowHeight, preview.rowHeight)
            XCTAssertEqual(full.triggerText?.string, message)
            XCTAssertTrue(preview.attributedText === full.attributedText)
            XCTAssertEqual(NativeTimelineLayoutCache.shared.layout(for: collapsed, columnWidth: width).rowHeight, preview.rowHeight)
        }
        _ = NSApplication.shared
        let layout = NativeTimelineLayoutCache.shared.layout(for: collapsed, columnWidth: 1000)
        let cell = AppKitSharedMessageTextCell(identifier: .init("scheduled-preview"))
        cell.frame = .init(x: 0, y: 0, width: 1000, height: layout.rowHeight)
        var toggled: String?
        cell.setContent(collapsed, availableWidth: 1000, onToggleExpansion: { toggled = $0 })
        cell.layoutSubtreeIfNeeded()
        func textViews(_ view: NSView) -> [NativeTimelineTextView] {
            if let text = view as? NativeTimelineTextView { return [text] }
            return view.subviews.flatMap(textViews)
        }
        let triggerView = try XCTUnwrap(textViews(cell).first { $0.string == message })
        XCTAssertEqual(triggerView.textContainer?.maximumNumberOfLines, 3)
        cell.toggleRepresentedProcess()
        XCTAssertEqual(toggled, id)
        cell.copyRepresentedMessage()
        XCTAssertEqual(NSPasteboard.general.string(forType: .string), message)
        let short = ChatDisplayEntry(kind: .message(try item(["id": "short-scheduled", "type": "automationEvent",
            "presentationRole": "automation", "text": "Short trigger"])))
        let shortRow = builder().nativeAppKitRow(short, expandedTurnIds: [])
        XCTAssertFalse(NativeTimelineLayoutCache.shared.layout(for: shortRow, columnWidth: 1000).triggerCanExpand)
    }

    func testFunctionalCardsStayCompactWhileReplyDocumentsUseTheWideLane() {
        let text = String(repeating: "A long document response. ", count: 300)
        let document = AppKitChatTimelineRow(id: "document", contentRevision: 0, nativeText: text, copyText: text,
            nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil, isExpanded: false, showsHeader: false)
        let card = AppKitChatTimelineRow(id: "functional-card", contentRevision: 0, nativeText: text, copyText: text,
            nativeStyle: .agent, title: "Event", metadata: "", expandableTurnId: nil, isExpanded: false, showsHeader: true)
        for typography in [ConversationTypography.classic, .codexReading] {
            XCTAssertEqual(NativeTimelineLayoutCache.shared.layout(for: document, columnWidth: 1600, typography: typography).cardWidth, 1596)
            XCTAssertEqual(NativeTimelineLayoutCache.shared.layout(for: card, columnWidth: 1600, typography: typography).cardWidth, 480)
            XCTAssertEqual(NativeTimelineLayoutCache.shared.layout(for: card, columnWidth: 320, typography: typography).cardWidth, 316)
        }
    }

    func testMergedProcessClockIgnoresClosedSegmentsUntilWholeReplyEnds() throws {
        let first = try item(["id": "first-tool", "type": "mcpToolCall", "turnStatus": "running",
            "createdAt": "2026-10-29T12:00:01Z", "processStartedAt": "2026-10-29T12:00:00Z",
            "processEndedAt": "2026-10-29T12:00:02Z"])
        let explanation = try item(["id": "explanation", "presentationRole": "commentary", "turnStatus": "running",
            "createdAt": "2026-10-29T12:00:03Z"])
        let last = try item(["id": "last-tool", "type": "mcpToolCall", "turnStatus": "running",
            "createdAt": "2026-10-29T12:00:04Z", "processStartedAt": "2026-10-29T12:00:04Z"])
        let entries: [ChatDisplayEntry] = [.init(kind: .process(turnId: "turn:one", items: [first])),
            .init(kind: .message(explanation)), .init(kind: .process(turnId: "turn:one:process-segment:1", items: [last]))]
        let projected = ConversationReplyProgressProjection.entries(entries)
        let running = builder().nativeAppKitRow(projected[0], expandedTurnIds: [])
        XCTAssertEqual(running.processState, .running)
        let start = try XCTUnwrap(running.processStartedAt)
        XCTAssertTrue(running.processSummaryText(now: start.addingTimeInterval(5), advancing: true, languageCode: "en").contains("5.00s"))
        XCTAssertTrue(running.processSummaryText(now: start.addingTimeInterval(6), advancing: true, languageCode: "en").contains("6.00s"))
        guard case .process(_, let source) = projected[0].kind else { return XCTFail("Missing aggregate") }
        XCTAssertEqual(source[0].processEndedAt, first.processEndedAt)
        let again = ConversationReplyProgressProjection.entries(projected)
        XCTAssertEqual(again[0].processReplyState, .running)
        for (status, expected) in [("completed", ConversationProcessState.completed), ("failed", .failed), ("interrupted", .cancelled)] {
            let final = ChatDisplayEntry(kind: .message(try item(["id": "final", "turnStatus": status,
                "createdAt": "2026-10-29T12:00:10Z"])))
            let ended = ConversationReplyProgressProjection.entries(entries + [final])
            let completed = builder().nativeAppKitRow(ended[0], expandedTurnIds: [])
            XCTAssertEqual(ConversationReplyProgressProjection.entries(ended)[0].processReplyState, expected)
            XCTAssertEqual(completed.processState, expected)
            XCTAssertNil(completed.processStartedAt)
            XCTAssertNotEqual(running.contentRevision, completed.contentRevision)
        }
    }

    func testLatestExplanationReplacesEarlierOneAndCompletionArchivesAll() throws {
        let oldText = String(repeating: "Earlier explanation in full.\n", count: 40)
        let old = try item(["id": "old", "text": oldText, "presentationRole": "commentary", "turnStatus": "running"])
        let latest = try item(["id": "latest", "text": "Latest explanation", "presentationRole": "commentary", "turnStatus": "running"])
        let tool = try item(["id": "tool", "type": "mcpToolCall", "presentationRole": NSNull(), "turnStatus": "running"])
        let original: [ChatDisplayEntry] = [.init(kind: .message(old)), .init(kind: .process(turnId: "turn:one", items: [tool])), .init(kind: .message(latest))]
        let projected = ConversationReplyProgressProjection.entries(original)
        XCTAssertEqual(projected.count, 2)
        XCTAssertEqual(projected.last?.id, "message:latest")
        guard case .process(let id, let items) = projected[0].kind else { return XCTFail("Expected the original process card") }
        XCTAssertEqual(id, "turn:one")
        XCTAssertEqual(items.map(\.id), ["old", "tool"])
        XCTAssertEqual(items[0].text, oldText)
        let expanded = builder().nativeAppKitRow(projected[0], expandedTurnIds: [id])
        XCTAssertTrue(expanded.copyText.contains(oldText))
        let again = ConversationReplyProgressProjection.entries(projected)
        XCTAssertEqual(again.map(\.id), projected.map(\.id))
        guard case .process(_, let repeatedItems) = again[0].kind else { return XCTFail("Missing process") }
        XCTAssertEqual(repeatedItems.map(\.id), items.map(\.id))
        let final = ChatDisplayEntry(kind: .message(try item(["id": "final", "turnStatus": "completed"])))
        let completed = ConversationReplyProgressProjection.entries(original + [final])
        XCTAssertEqual(completed.count, 2)
        XCTAssertEqual(completed.last?.id, final.id)
        XCTAssertTrue(completed[0].processReplyCompleted)
        guard case .process(_, let archived) = completed[0].kind else { return XCTFail("Missing archive") }
        XCTAssertEqual(archived.map(\.id), ["old", "tool", "latest"])
        XCTAssertEqual(builder().nativeAppKitRow(completed[0], expandedTurnIds: []).processState, .completed)
        XCTAssertEqual(ConversationReplyProgressProjection.archivedProcess(forRowID: "message:latest", in: completed)?.id, completed[0].id)
        let single = ConversationReplyProgressProjection.entries([.init(kind: .message(latest))])
        XCTAssertEqual(single.map(\.id), ["message:latest"])
    }

    func testArchivedExplanationsDoNotHideQuestionsOrCreatePhantomHistoryWeight() throws {
        let first = try item(["id": "first", "presentationRole": "commentary", "turnStatus": "running"])
        let question = try item(["id": "question", "type": "userInput", "presentationRole": NSNull(), "turnId": "question:synthetic"])
        let next = try item(["id": "next", "presentationRole": "commentary", "turnStatus": "running"])
        let final = try item(["id": "final", "turnStatus": "completed"])
        let entries: [ChatDisplayEntry] = [first, question, next, final].map { .init(kind: .message($0)) }
        let cache = DetailDisplayCache(sessionId: "session", displayItems: [first, question, next, final],
            displayEntries: entries, totalDisplayEntryCount: 4, visibleMessageLimit: 100,
            signature: "source", sourceSignature: "source", restorationAnchorRowID: "message:first")
        let projected = cache.projectingReplyProgress()
        XCTAssertEqual(projected.displayEntries.count, 3)
        XCTAssertEqual(projected.displayEntries[1].id, "message:question")
        XCTAssertEqual(projected.displayEntries[2].id, "message:final")
        XCTAssertEqual(projected.totalDisplayEntryCount, projected.displayEntries.reduce(0) { $0 + $1.displayWeight })
        XCTAssertEqual(projected.restorationAnchorRowID, projected.displayEntries[0].id)
        XCTAssertEqual(projected.projectingReplyProgress().totalDisplayEntryCount, projected.totalDisplayEntryCount)
        let user = try item(["id": "user", "type": "userMessage", "presentationRole": NSNull()])
        let separated = ConversationReplyProgressProjection.entries([.init(kind: .message(first)), .init(kind: .message(user)), .init(kind: .message(next))])
        XCTAssertEqual(separated.map(\.id), ["message:first", "message:user", "message:next"])
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
            XCTAssertEqual(decorated.rowHeight, original.rowHeight + 44)
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

    func testReplyActionIconsKeepDisabledButtonsNeutral() {
        let button = ReplyActionIconButton()
        let event = NSEvent()
        button.mouseEntered(with: event)
        XCTAssertEqual(button.contentTintColor, .labelColor)
        button.mouseExited(with: event)
        XCTAssertEqual(button.contentTintColor, .secondaryLabelColor)
        button.isEnabled = false
        button.mouseEntered(with: event)
        XCTAssertEqual(button.contentTintColor, .secondaryLabelColor)
    }

    func testFinalReplyActionsAreOutsideContentAndRespectLifecycleAndCapabilities() throws {
        let final = builder().nativeAppKitRow(.init(kind: .message(try item([
            "createdAt": "2026-10-29T12:00:00Z"]))), expandedTurnIds: [])
        XCTAssertTrue(final.showsReplyActions)
        for overrides: [String: Any] in [["turnStatus": "running"], ["presentationRole": "commentary"],
            ["type": "userMessage"], ["type": "systemMessage"], ["messageOrigin": "scheduled_task"]] {
            XCTAssertFalse(builder().nativeAppKitRow(.init(kind: .message(try item(overrides))), expandedTurnIds: []).showsReplyActions)
        }
        var without = final
        without.showsReplyActions = false
        for typography in [ConversationTypography.classic, .codexReading] {
            let layout = NativeTimelineLayoutCache.shared.layout(for: final, columnWidth: 900, typography: typography)
            let previous = NativeTimelineLayoutCache.shared.layout(for: without, columnWidth: 900, typography: typography)
            XCTAssertEqual(layout.rowHeight - previous.rowHeight, 26)
            XCTAssertEqual(layout.cardHeight, previous.cardHeight)
            XCTAssertEqual(layout.cardWidth, previous.cardWidth)
            XCTAssertTrue(layout.attributedText === previous.attributedText)
        }
        _ = NSApplication.shared
        func button(_ view: NSView, _ suffix: String) -> NSButton? {
            if let result = view as? NSButton, result.identifier?.rawValue == "chat.timeline.reply-actions." + suffix { return result }
            return view.subviews.lazy.compactMap { button($0, suffix) }.first
        }
        for shared in [false, true] {
            var acted: String?
            let renderer: any AppKitChatRowRendering = shared
                ? AppKitSharedMessageTextCell(identifier: .init("shared-actions"))
                : AppKitChatNativeTextCell(identifier: .init("native-actions"))
            let cell = try XCTUnwrap(renderer as? NSView)
            let layout = NativeTimelineLayoutCache.shared.layout(for: final, columnWidth: 900)
            cell.frame = .init(x: 0, y: 0, width: 900, height: layout.rowHeight)
            renderer.setContent(final, availableWidth: 900, baseDirectory: nil, onToggleExpansion: { _ in },
                onAction: { acted = $0.id })
            cell.layoutSubtreeIfNeeded()
            let copy = try XCTUnwrap(button(cell, "copy"))
            copy.performClick(nil)
            XCTAssertEqual(NSPasteboard.general.string(forType: .string), final.copyText)
            let clock = try XCTUnwrap(button(cell, "timestamp"))
            XCTAssertFalse(clock.isHiddenOrHasHiddenAncestor)
            XCTAssertEqual(clock.title, final.contextTimestamp)
            XCTAssertEqual(clock.imagePosition, .noImage)
            clock.performClick(nil)
            XCTAssertEqual(NSPasteboard.general.string(forType: .string), final.contextTimestamp)
            let fork = try XCTUnwrap(button(cell, "fork"))
            fork.performClick(nil)
            XCTAssertEqual(acted, "fork:" + (final.forkItemID ?? ""))
            let unavailable = builder(allowsFork: false, unavailableReason: "Unavailable")
                .nativeAppKitRow(.init(kind: .message(try item())), expandedTurnIds: [])
            renderer.setContent(unavailable, availableWidth: 900, baseDirectory: nil, onToggleExpansion: { _ in }, onAction: { _ in })
            cell.layoutSubtreeIfNeeded()
            let disabled = try XCTUnwrap(button(cell, "fork"))
            XCTAssertFalse(disabled.isEnabled)
            XCTAssertEqual(disabled.toolTip, "Unavailable")
            renderer.setContent(without, availableWidth: 900, baseDirectory: nil, onToggleExpansion: { _ in }, onAction: { _ in })
            cell.layoutSubtreeIfNeeded()
            XCTAssertTrue(button(cell, "copy")?.isHiddenOrHasHiddenAncestor ?? true)
        }
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

    func testQuestionRowHeightMatchesRenderedFormWithoutTrailingBlankSpace() throws {
        _ = NSApplication.shared
        for status in ["pending", "submitted", "cancelled"] {
            for width: CGFloat in [320, 900] {
                let input: [String: Any] = ["schemaVersion": 1, "isBlocking": true, "canCancel": true,
                    "selectedOptions": ["route": ["A"]], "submittedAnswers": ["route": ["A"]],
                    "questions": [["id": "route", "header": "Route", "question": "Choose how to proceed",
                        "isOther": true, "isSecret": false, "options": [
                            ["label": "A", "description": "A short description"],
                            ["label": "B", "description": String(repeating: "Long wrapped description. ", count: 8)]]]]]
                let row = builder().nativeAppKitRow(.init(kind: .message(try item([
                    "type": "userInput", "status": status, "userInput": input]))), expandedTurnIds: [])
                for skin in [ConversationSkin.classic, .codexFlat] {
                    let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: width,
                        typography: skin.typography(for: .assistant))
                    let host = NSHostingView(rootView: MacSharedMessageTextCard(skin: skin, row: row, layout: layout)
                        .frame(width: width).fixedSize(horizontal: false, vertical: true))
                    host.frame = .init(x: 0, y: 0, width: width, height: layout.rowHeight)
                    host.layoutSubtreeIfNeeded()
                    XCTAssertEqual(layout.rowHeight, ceil(host.fittingSize.height), accuracy: 1,
                        "Question row reserves unused space: status=\(status), width=\(width), skin=\(skin)")
                    XCTAssertEqual(layout.rowHeight, layout.cardHeight + 2 * layout.typography.rowInset)
                    XCTAssertEqual(NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: width,
                        typography: skin.typography(for: .assistant)).rowHeight, layout.rowHeight)
                }
            }
        }
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
