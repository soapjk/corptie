import AppKit
import Combine
import SwiftUI
import XCTest
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor
final class TaskExecutionChecklistTimelineTests: XCTestCase {
    private func item(count: Int, revision: Int = 1, closed: Bool = false, activeIndex: Int? = nil) throws -> CodexThreadItem {
        let steps: [[String: Any]] = (0..<count).map { index in
            ["stepId": "item:\(index)", "ordinal": index, "text": "事项 \(index)", "status": index == activeIndex ? "inProgress" : "pending"]
        }
        let fields: [String: Any] = ["id": "checklist:timeline-test:\(count)", "turnId": "turn:one",
            "turnStatus": "completed", "type": "executionChecklist", "title": "执行清单", "text": "执行清单", "status": "completed",
            "executionPlan": ["schemaVersion": 1, "planId": "checklist:timeline-test:\(count)", "taskId": "task:one",
                "revision": revision, "closed": closed, "lifecycle": "active", "completedCount": 0,
                "updatedAt": "2026-11-04T00:00:00Z", "steps": steps]]
        return try JSONDecoder().decode(CodexThreadItem.self, from: JSONSerialization.data(withJSONObject: fields))
    }
    private struct JumpProbe: NSViewRepresentable {
        func makeNSView(context: Context) -> NSView {
            let view = NSView(); view.identifier = .init("jump-probe"); return view
        }
        func updateNSView(_ view: NSView, context: Context) {}
    }
    func testPinnedDisclosureAnimatesLocallyWithStableNativeEnvelopeAndEightPointJumpGap() async throws {
        let systemReduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        for (count, reduceMotion) in [(2, systemReduceMotion), (80, systemReduceMotion), (80, true)] {
            let plan = try XCTUnwrap(item(count: count).executionPlan)
            let card = PinnedExecutionChecklistCard(plan: plan,
                jumpControl: AnyView(JumpProbe().frame(height: 30)))
                .environment(\.accessibilityReduceMotion, reduceMotion)
            let floating = VStack(spacing: 0) { Color.clear.frame(height: 38); card }
            let region = ConversationRegionContainer(content: Color.clear, accessory: Color.clear.frame(height: 80),
                atTop: false, height: nil, floatingClearanceInset: 38, floating: AnyView(floating))
            let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 520, height: 600),
                styleMask: [.borderless], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = region; window.orderBack(nil)
            defer { window.orderOut(nil); window.contentView = nil }
            try await Task.sleep(for: .milliseconds(100))
            region.layoutSubtreeIfNeeded()
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            let scroll = try XCTUnwrap(descendants(region.floatingHost).compactMap { $0 as? NSScrollView }.first)
            let scrollerProbe = try XCTUnwrap(descendants(scroll).compactMap { $0 as? ConsoleOverlayScroller.Probe }.first)
            // The floating host and shared checklist must not create another
            // scroll owner. Its one native indicator uses the session-list class.
            XCTAssertEqual(descendants(region.floatingHost).compactMap { $0 as? NSScrollView }.count, 1)
            let jump = try XCTUnwrap(descendants(region.floatingHost).first { $0.identifier?.rawValue == "jump-probe" })
            let viewport = region.content.frame
            var clearances: [CGFloat] = []
            region.floatingClearanceDidLayout = { clearances.append($0) }
            func clickDisclosure() throws {
                let document = try XCTUnwrap(scroll.documentView)
                let point = document.convert(.init(x: document.bounds.width - 43,
                    y: document.isFlipped ? 18 : document.bounds.height - 18), to: nil)
                print("Disclosure document=\(document.frame) visible=\(scroll.documentVisibleRect) point=\(point)")
                for (number, type) in [NSEvent.EventType.leftMouseDown, .leftMouseUp].enumerated() {
                    let event = try XCTUnwrap(NSEvent.mouseEvent(with: type, location: point,
                        modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                        windowNumber: window.windowNumber, context: nil, eventNumber: number,
                        clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0))
                    window.sendEvent(event)
                }
            }
            func assertGap() {
                let jf = jump.convert(jump.bounds, to: region)
                let sf = scroll.convert(scroll.bounds, to: region)
                XCTAssertEqual(jf.minY - sf.maxY, 8, accuracy: 1)
            }
            func assertIndicatorHidden() {
                XCTAssertTrue(!scroll.hasVerticalScroller || scroll.verticalScroller?.isHidden != false
                    || scroll.verticalScroller?.alphaValue == 0)
            }
            func assertGateClosed() {
                XCTAssertTrue(scrollerProbe.usesWorkStyle)
                XCTAssertFalse(scrollerProbe.allowsVerticalIndicator)
                // Re-enter the same shared configuration used during native
                // layout; it must not override the disclosure's closed gate.
                scrollerProbe.configure()
                scrollerProbe.configure()
                XCTAssertFalse(scroll.hasVerticalScroller)
                assertIndicatorHidden()
            }
            assertGateClosed()
            assertGap()
            try clickDisclosure()
            try await Task.sleep(for: .milliseconds(70))
            let midHeight = scroll.frame.height
            let envelope = region.floatingHost.frame.height
            if !reduceMotion { assertGateClosed() }
            assertGap()
            try await Task.sleep(for: .milliseconds(210))
            let fullHeight = scroll.frame.height
            XCTAssertGreaterThan(fullHeight, 36)
            if !reduceMotion {
                XCTAssertGreaterThan(midHeight, 36)
                XCTAssertLessThan(midHeight, fullHeight)
                XCTAssertEqual(region.floatingHost.frame.height, envelope, accuracy: 0.5)
            }
            XCTAssertEqual(scroll.scrollerStyle, .overlay)
            XCTAssertTrue(scroll.autohidesScrollers)
            if count == 80 {
                XCTAssertTrue(scroll.hasVerticalScroller)
                XCTAssertTrue(scroll.verticalScroller is WorkOutlineThinScroller)
                XCTAssertEqual(scroll.verticalScroller?.controlSize, .small)
                XCTAssertEqual(scroll.scrollerInsets.right, WorkNavigationScrollStyle.trailingClearance)
                XCTAssertGreaterThan(try XCTUnwrap(scroll.documentView).frame.height, scroll.contentView.bounds.height + 1)
            } else {
                XCTAssertLessThanOrEqual(try XCTUnwrap(scroll.documentView).frame.height, scroll.contentView.bounds.height + 1)
                assertIndicatorHidden()
            }
            assertGap()
            try clickDisclosure()
            try await Task.sleep(for: .milliseconds(70))
            assertGateClosed()
            assertGap()
            if !reduceMotion { XCTAssertEqual(region.floatingHost.frame.height, envelope, accuracy: 0.5) }
            try await Task.sleep(for: .milliseconds(210))
            XCTAssertEqual(scroll.frame.height, 36, accuracy: 0.5)
            assertGateClosed()
            XCTAssertEqual(region.floatingHost.frame.height, 74, accuracy: 0.5)
            XCTAssertEqual(region.content.frame, viewport)
            XCTAssertEqual(region.rootCommitCount, 0)
            XCTAssertLessThanOrEqual(clearances.count, 2, "No per-frame native clearance updates")
            print("Pinned disclosure reduceMotion=\(reduceMotion) middle=\(midHeight) full=\(fullHeight) nativeClearanceUpdates=\(clearances.count) rootCommits=\(region.rootCommitCount)")
        }
    }
    func testDisclosureCompletionCannotReopenAnInterruptedOrHiddenCard() {
        var visibility = ChecklistDisclosureVisibility()
        visibility.setPresented(true)
        let firstExpansion = visibility.begin(animated: true)
        XCTAssertFalse(visibility.allowsIndicators(expanded: true))
        let collapse = visibility.begin(animated: true)
        visibility.complete(firstExpansion)
        XCTAssertFalse(visibility.settled)
        XCTAssertTrue(visibility.retainsExpandedEnvelope)
        visibility.complete(collapse)
        XCTAssertFalse(visibility.allowsIndicators(expanded: false))

        let nextExpansion = visibility.begin(animated: true)
        visibility.complete(collapse)
        XCTAssertFalse(visibility.allowsIndicators(expanded: true))
        visibility.setPresented(false)
        visibility.complete(nextExpansion)
        XCTAssertFalse(visibility.allowsIndicators(expanded: true))
        visibility.setPresented(true)
        let currentExpansion = visibility.begin(animated: true)
        visibility.complete(nextExpansion)
        XCTAssertFalse(visibility.allowsIndicators(expanded: true))
        visibility.complete(currentExpansion)
        XCTAssertTrue(visibility.allowsIndicators(expanded: true))
        XCTAssertFalse(visibility.retainsExpandedEnvelope)
    }

    func testReducedMotionSettlesImmediatelyAndInvalidatesPendingCompletion() {
        var visibility = ChecklistDisclosureVisibility()
        visibility.setPresented(true)
        let animatedExpansion = visibility.begin(animated: true)
        visibility.settleImmediately()
        XCTAssertTrue(visibility.allowsIndicators(expanded: true))
        XCTAssertFalse(visibility.retainsExpandedEnvelope)
        let collapse = visibility.begin(animated: false)
        visibility.complete(animatedExpansion)
        XCTAssertFalse(visibility.allowsIndicators(expanded: false))
        XCTAssertFalse(visibility.retainsExpandedEnvelope)
        visibility.complete(collapse)
        _ = visibility.begin(animated: false)
        XCTAssertTrue(visibility.allowsIndicators(expanded: true))
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
    func testTextUpdatesReuseStructureButRefreshRowsAndChecklistChangesRebuild() throws {
        let planRow = builder.nativeAppKitRow(ChatDisplayEntry(kind: .message(try item(count: 8))), expandedTurnIds: [])
        let message = AppKitChatTimelineRow(id: "stream", contentRevision: 1, nativeText: "Before",
            copyText: "Before", nativeStyle: .agent, title: "", metadata: "",
            expandableTurnId: "stream-turn", isExpanded: false)
        let previous = [planRow, message]
        var dock = ConversationChecklistDockProjection(rows: previous)
        var changed = message
        changed.nativeText = "After streaming"
        changed.contentRevision += 1
        let current = [planRow, changed]
        XCTAssertFalse(dock.update(rows: current, previousRows: previous))
        XCTAssertEqual(dock.timelineRows.first?.nativeText, "After streaming")
        XCTAssertEqual(dock.timelineIndexByRowID[message.id], 0)
        XCTAssertEqual(dock.disclosureRowIndices["stream-turn"], 1)
        let revised = builder.nativeAppKitRow(ChatDisplayEntry(kind: .message(try item(count: 8, revision: 2, closed: true))), expandedTurnIds: [])
        XCTAssertTrue(dock.update(rows: [revised, changed], previousRows: current))
        XCTAssertNil(dock.checklist)
        XCTAssertEqual(dock.latestChecklist?.revision, 2)
        XCTAssertEqual(dock.timelineRows.map(\.id), [revised.id, message.id])
        XCTAssertTrue(dock.update(rows: [changed], previousRows: [revised, changed]))
        XCTAssertEqual(dock.disclosureRowIndices["stream-turn"], 0)
    }

    func testCollapsedPinnedHeightDoesNotPrepareExpandedChecklist() throws {
        let plan = try XCTUnwrap(item(count: 173, revision: 9876).executionPlan)
        let cache = NativePlanChecklistHeightCache.shared
        let before = cache.taskPreparationCount
        for width: CGFloat in [240, 300, 520, 780] {
            XCTAssertEqual(PinnedExecutionChecklistCard.height(plan: plan, width: width, expanded: false), 36)
        }
        XCTAssertEqual(cache.taskPreparationCount, before)
        XCTAssertGreaterThan(PinnedExecutionChecklistCard.height(plan: plan, width: 300, expanded: true), 36)
        XCTAssertEqual(cache.taskPreparationCount, before + 1)
    }

    func testPinnedCardIsOneLineForShortAndLongListsAndSummaryUsesPreparedCurrentItem() throws {
        for count in [0, 2, 200] {
            let plan = try XCTUnwrap(item(count: count, revision: 100, activeIndex: count == 200 ? 150 : nil).executionPlan)
            let cache = NativePlanChecklistHeightCache()
            for width: CGFloat in [240, 520, 780] {
                XCTAssertEqual(PinnedExecutionChecklistCard.height(plan: plan, width: width, expanded: false), 36)
                let summary = cache.summary(of: plan, width: width - 20)
                if count == 200 { XCTAssertEqual(summary, "事项 150") }
                if count == 0 { XCTAssertEqual(summary, "暂无事项") }
                let prepared = cache.taskPreparationCount
                for _ in 0..<10 { _ = cache.summary(of: plan, width: width - 20) }
                XCTAssertEqual(cache.taskPreparationCount, prepared)
            }
        }
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
