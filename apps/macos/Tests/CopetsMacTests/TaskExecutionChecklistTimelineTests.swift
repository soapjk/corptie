import AppKit
import Combine
import SwiftUI
import XCTest
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor
final class TaskExecutionChecklistTimelineTests: XCTestCase {
    private func item(count: Int, revision: Int = 1, closed: Bool = false) throws -> CodexThreadItem {
        let steps: [[String: Any]] = (0..<count).map { index in
            ["stepId": "item:\(index)", "ordinal": index, "text": "事项 \(index)", "status": "pending"]
        }
        let fields: [String: Any] = ["id": "checklist:timeline-test:\(count)", "turnId": "turn:one",
            "turnStatus": "completed", "type": "executionChecklist", "title": "执行清单", "text": "执行清单", "status": "completed",
            "executionPlan": ["schemaVersion": 1, "planId": "checklist:timeline-test:\(count)", "taskId": "task:one",
                "revision": revision, "closed": closed, "lifecycle": "active", "completedCount": 0,
                "updatedAt": "2026-11-04T00:00:00Z", "steps": steps]]
        return try JSONDecoder().decode(CodexThreadItem.self, from: JSONSerialization.data(withJSONObject: fields))
    }
    private var builder: ConversationNativeRowBuilder {
        .init(sessionTitle: "Session", workingDirectory: nil, allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in nil })
    }
    func testCloseEventDeliversTheClosedBatchToCardOwnersImmediately() async throws {
        let plan = try XCTUnwrap(item(count: 8, closed: true).executionPlan)
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(plan))
        let data = try JSONSerialization.data(withJSONObject: ["payload": ["taskId": "task:one", "checklist": payload]])
        let router = BackendEventRouter(ports: .init(channelMessage: { _ in }, loadSettings: {},
            syncNewSessionDefaults: {}, loadProviders: {}, reconcileTimelineRevisions: {}, loadAutomations: {},
            selectedSession: { nil }, loadScheduledTasks: { _ in }, scheduleTimelineSync: { _, _ in },
            timelineRevision: { _, _ in }, projectStatus: { _ in }, terminalAutomation: { _ in },
            automationRefresh: { _ in }, workspaceSwitched: { _ in }, workspaceSwitchFailed: { _ in },
            usageEvent: { _ in }, inventoryEvent: { _ in }, sessionCleared: { _ in }))
        var received: ConversationExecutionPlan?
        let subscription = NotificationCenter.default.publisher(for: .executionChecklistChanged).sink { note in
            received = note.userInfo?["checklist"] as? ConversationExecutionPlan
        }
        defer { subscription.cancel() }
        await router.handle("ExecutionChecklistChanged", data: String(decoding: data, as: UTF8.self))
        XCTAssertEqual(received?.planId, plan.planId)
        XCTAssertEqual(received?.closed, true)
    }
    func testClosedBatchMovesIntoHistoryAndNextBatchOwnsTheDock() throws {
        let old = try item(count: 2, revision: 10, closed: true)
        let next = try item(count: 8, revision: 11)
        let closedRow = builder.nativeAppKitRow(ChatDisplayEntry(kind: .message(old)), expandedTurnIds: [])
        let nextRow = builder.nativeAppKitRow(ChatDisplayEntry(kind: .message(next)), expandedTurnIds: [])
        let closedOnly = ConversationChecklistDockProjection(rows: [closedRow])
        XCTAssertNil(closedOnly.checklist)
        XCTAssertEqual(closedOnly.latestChecklist?.closed, true)
        XCTAssertEqual(closedOnly.latestChecklist?.revision, 10)
        XCTAssertEqual(closedOnly.timelineRows.map(\.id), [closedRow.id])
        let both = ConversationChecklistDockProjection(rows: [closedRow, nextRow])
        XCTAssertEqual(both.checklist?.planId, next.executionPlan?.planId)
        XCTAssertEqual(both.latestChecklist?.planId, next.executionPlan?.planId)
        XCTAssertEqual(both.timelineIndexByRowID[closedRow.id], 0)
        XCTAssertEqual(both.timelineRows.count, 1)
    }
    func testClosedHistoryHasCompactHeightAndCanExpandInline() throws {
        let message = try item(count: 8, revision: 99, closed: true)
        let entry = ChatDisplayEntry(kind: .message(message))
        let key = ScheduledTriggerPresentation.expansionID(for: message.id)
        var compactHeight: CGFloat = 0
        for expanded in [false, true] {
            let row = builder.nativeAppKitRow(entry, expandedTurnIds: expanded ? [key] : [])
            let layout = NativeTimelineLayoutCache.shared.intrinsicContent(for: row, columnWidth: 620, skin: .classic)
            let host = NSHostingView(rootView: MacSharedMessageTextCard(row: row, layout: layout).frame(width: 620))
            host.frame = NSRect(x: 0, y: 0, width: 620, height: 1)
            host.layoutSubtreeIfNeeded()
            if expanded { XCTAssertGreaterThan(host.fittingSize.height, compactHeight) }
            else { compactHeight = host.fittingSize.height; XCTAssertLessThan(compactHeight, 80) }
        }
    }
    func testDockKeepsLatestChecklistOutsideHistoryWithoutDuplicatingRows() throws {
        let first = builder.nativeAppKitRow(ChatDisplayEntry(kind: .message(try item(count: 2))), expandedTurnIds: [])
        let latest = builder.nativeAppKitRow(ChatDisplayEntry(kind: .message(try item(count: 8))), expandedTurnIds: [])
        let message = try JSONDecoder().decode(CodexThreadItem.self, from: Data(
            #"{"id":"message:one","turnId":"turn:one","turnStatus":"completed","type":"agentMessage","title":"执行进度","text":"执行进度","status":"completed"}"#.utf8))
        let normal = builder.nativeAppKitRow(ChatDisplayEntry(kind: .message(message)), expandedTurnIds: [])
        let dock = ConversationChecklistDockProjection(rows: [first, normal, latest])
        XCTAssertEqual(dock.checklist?.planId, latest.executionPlan?.planId)
        XCTAssertEqual(dock.timelineRows.map(\.id), [normal.id])
        XCTAssertNil(ConversationChecklistDockProjection(rows: [normal]).checklist)
        XCTAssertTrue(ConversationChecklistDockProjection(rows: []).timelineRows.isEmpty)
    }
    func testPinnedCardGrowsInlineAndBoundsLongListsToLeaveTheComposerVisible() throws {
        let short = try XCTUnwrap(item(count: 8).executionPlan)
        let compact = PinnedExecutionChecklistCard.height(plan: short, width: 300, expanded: false)
        let expanded = PinnedExecutionChecklistCard.height(plan: short, width: 300, expanded: true)
        XCTAssertGreaterThan(expanded, compact)
        XCTAssertLessThanOrEqual(expanded, 280)
        let long = try XCTUnwrap(item(count: 200).executionPlan)
        for width: CGFloat in [240, 520, 780] {
            XCTAssertLessThanOrEqual(PinnedExecutionChecklistCard.height(plan: long, width: width, expanded: true), 280)
        }
    }
    func testChecklistDisclosureReusesStableRowAndExistingExpansionRevision() throws {
        let item = try item(count: 8), entry = ChatDisplayEntry(kind: .message(item))
        let key = ScheduledTriggerPresentation.expansionID(for: item.id)
        let collapsed = builder.nativeAppKitRow(entry, expandedTurnIds: [])
        let expanded = builder.nativeAppKitRow(entry, expandedTurnIds: [key])
        XCTAssertEqual(collapsed.expandableTurnId, key)
        XCTAssertEqual(collapsed.id, expanded.id)
        XCTAssertFalse(collapsed.isExpanded); XCTAssertTrue(expanded.isExpanded)
        XCTAssertNotEqual(collapsed.contentRevision, expanded.contentRevision)
        XCTAssertTrue(MacSharedMessageTextCard.supports(expanded))
    }
    func testWidthChangesWithinColumnCountReusePreparedHeight() throws {
        let plan = try XCTUnwrap(item(count: 200).executionPlan)
        let cache = NativePlanChecklistHeightCache()
        for widths: [CGFloat] in [[240, 241, 242], [520, 521, 522], [760, 761, 762]] {
            _ = cache.height(of: plan, width: widths[0])
            let prepared = cache.taskPreparationCount
            for width in widths { _ = cache.height(of: plan, width: width) }
            XCTAssertEqual(cache.taskPreparationCount, prepared)
        }
    }
    func testClickUsesPreparedFullHeightAndDoesNotRemeasureTheList() throws {
        let plan = try XCTUnwrap(item(count: 200).executionPlan)
        let cache = NativePlanChecklistHeightCache()
        for width: CGFloat in [240, 520, 752] {
            let collapsed = cache.height(of: plan, width: width)
            let prepared = cache.taskPreparationCount
            for _ in 0..<10 {
                XCTAssertGreaterThan(cache.height(of: plan, width: width, expanded: true), collapsed)
                XCTAssertEqual(cache.height(of: plan, width: width), collapsed)
            }
            XCTAssertEqual(cache.taskPreparationCount, prepared)
        }
        let revised = try XCTUnwrap(item(count: 200, revision: 2).executionPlan)
        let before = cache.taskPreparationCount
        _ = cache.height(of: revised, width: 240)
        XCTAssertEqual(cache.taskPreparationCount, before + 1)
    }
    func testExpandedNativeMessageReservesActualInlineContentHeightAndColumns() throws {
        let item = try item(count: 8), entry = ChatDisplayEntry(kind: .message(item))
        for width: CGFloat in [260, 620, 900] {
            let key = ScheduledTriggerPresentation.expansionID(for: item.id)
            let collapsed = builder.nativeAppKitRow(entry, expandedTurnIds: [])
            let compact = LegacyTimelineLayoutReference.shared.layout(for: collapsed, columnWidth: width)
            let expanded = builder.nativeAppKitRow(entry, expandedTurnIds: [key])
            let full = LegacyTimelineLayoutReference.shared.layout(for: expanded, columnWidth: width)
            XCTAssertGreaterThan(full.rowHeight, compact.rowHeight)
            XCTAssertLessThanOrEqual(full.cardWidth + 14, width + 1)
            let host = NSHostingView(rootView: MacSharedMessageTextCard(row: expanded, layout: full).frame(width: width))
            host.frame = NSRect(x: 0, y: 0, width: width, height: full.rowHeight)
            host.layoutSubtreeIfNeeded()
            XCTAssertEqual(host.fittingSize.height, full.rowHeight, accuracy: 1)
            XCTAssertEqual(LegacyTimelineLayoutReference.shared.layout(for: collapsed, columnWidth: width).rowHeight, compact.rowHeight)
            if width > 600 { XCTAssertGreaterThan(TaskExecutionChecklist.columns(for: full.cardWidth - 28), 1) }
        }
    }
}
