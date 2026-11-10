import AppKit
import SwiftUI
import XCTest
import CorptieClientCore
@testable import CorptieMac

@MainActor
final class ResizeWorkBudgetTests: XCTestCase {
    func testLocalChangeAtEqualDurableRevisionAdvancesPresentationVersion() {
        let state = SessionTimelineState(sessionID: "test")
        let initial = detail(items: [item(0)])
        state.apply(initial, timelineRevision: 7)
        let revision = state.presentationRevision
        let tail = state.tailContentRevision
        state.apply(initial, timelineRevision: 7)
        XCTAssertEqual(state.presentationRevision, revision)
        var changed = item(0)
        changed.userMessageStatus = "queued"
        state.apply(detail(items: [changed]), timelineRevision: 7)
        XCTAssertEqual(state.presentationRevision, revision + 1)
        XCTAssertNotEqual(state.tailContentRevision, tail)
        state.apply(initial, timelineRevision: 6)
        XCTAssertEqual(state.presentationRevision, revision + 1)
    }

    func testIdleRevisionAndMetadataSnapshotsDoNotAdvancePresentationVersion() {
        let state = SessionTimelineState(sessionID: "idle")
        let items = [item(0), item(1, turn: "turn-1")]
        let initial = detail(items: items)
        state.apply(initial, timelineRevision: 3)
        let revision = state.presentationRevision
        let tail = state.tailContentRevision

        // A newer durable revision with byte-identical items is bookkeeping.
        // It must not rebuild the display projection and dirty the window.
        state.apply(initial, timelineRevision: 4)
        XCTAssertEqual(state.presentationRevision, revision)
        XCTAssertEqual(state.tailContentRevision, tail)

        // A metadata-only snapshot (updatedAt / status / actions) is the
        // common shape of an idle background poll. Same rule applies.
        state.apply(detail(items: items, updatedAt: "2026-11-10T03:00:00Z"), timelineRevision: 5)
        XCTAssertEqual(state.presentationRevision, revision)
        XCTAssertEqual(state.tailContentRevision, tail)
        XCTAssertEqual(state.detail?.updatedAt, "2026-11-10T03:00:00Z",
            "Suppressing the version bump must not discard fresh metadata")

        // Real content still advances immediately.
        var changed = items
        changed[1].userMessageStatus = "queued"
        state.apply(detail(items: changed), timelineRevision: 6)
        XCTAssertEqual(state.presentationRevision, revision + 1)
    }

    func testEvictedDetachedCellReleasesItsHostingTree() {
        let cell = AppKitSharedMessageTextCell(identifier: .init("release"))
        let row = processRow(count: 1)
        cell.setContent(row, availableWidth: 480, onToggleExpansion: { _ in })
        XCTAssertEqual(cell.subviews.count, 1)
        cell.releaseRenderingResources()
        XCTAssertTrue(cell.subviews.isEmpty, "An offscreen evicted cell must not retain its NSHostingView")
        XCTAssertFalse(cell.updateLayoutIfContentUnchanged(row, availableWidth: 480),
            "A released cell must be rebuilt from scratch instead of reusing stale content")
    }

    func testMountedCellKeepsItsHostingTree() {
        let cell = AppKitSharedMessageTextCell(identifier: .init("mounted"))
        let row = processRow(count: 1)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 120),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = cell
        defer { window.contentView = nil; window.orderOut(nil) }
        cell.setContent(row, availableWidth: 480, onToggleExpansion: { _ in })
        XCTAssertEqual(cell.subviews.count, 1)
        cell.releaseRenderingResources()
        XCTAssertEqual(cell.subviews.count, 1,
            "A cell still owned by AppKit must never be stripped into a blank row")
    }

    func testResidentHistoryCanBeRecoveredWhileReadingAndCompactedOnReturnToLatest() {
        let source = detail(items: (0..<1000).map { item($0) })
        let state = SessionTimelineState(sessionID: "test")
        state.apply(source)
        XCTAssertEqual(state.detail?.items.count, ResidentTimelineWindow.itemBudget)
        XCTAssertEqual(state.detail?.hasMoreHistory, true)
        XCTAssertNil(state.detail?.historyItemsCount, "Local pruning cannot invent an authoritative history total")
        state.setProtectsHistoryWindow(true)
        state.apply(source)
        XCTAssertEqual(state.detail?.items.count, 1000)
        state.setProtectsHistoryWindow(false)
        XCTAssertEqual(state.detail?.items.last?.id, source.items.last?.id)
        XCTAssertEqual(state.detail?.items.count, ResidentTimelineWindow.itemBudget)
        XCTAssertEqual(state.detail?.status, source.status)
    }

    func testLongTurnHasAContiguousBoundedTailAndPendingInputRemainsProtected() {
        let oneTurn = detail(items: (0..<1000).map { item($0, turn: "current") })
        XCTAssertEqual(ResidentTimelineWindow.compact(oneTurn, protectingHistory: false).items.count, 400)
        var source = (0..<1000).map { item($0) }
        source[0].userMessageStatus = "queued"
        XCTAssertEqual(ResidentTimelineWindow.compact(detail(items: source), protectingHistory: false).items.count, 1000)
    }

    func testLongTaskRetainsPromptOutsideTheContiguousHistoryCursor() throws {
        let state = SessionTimelineState(sessionID: "long-task")
        var items = (0..<5000).map { item($0, turn: "long", type: $0 == 0 ? "userMessage" : "commandExecution") }
        items[0].userMessageStatus = "processing"
        state.apply(detail(items: items))
        XCTAssertEqual(state.detail?.items.count, 400)
        XCTAssertEqual(state.detail?.items.first?.id, "item-4600")
        XCTAssertEqual(state.presentationDetail?.items.first?.id, "item-0")
        XCTAssertEqual(state.presentationDetail?.items.count, 401)
        let tail = try XCTUnwrap(state.detail?.items)
        let restored = try XCTUnwrap(SessionHistoryPageMerger.prepend(pageItems: Array(items[4400..<4600]),
            to: tail, requestedBeforeID: "item-4600"))
        state.setProtectsHistoryWindow(true)
        state.apply(detail(items: restored))
        XCTAssertEqual(state.detail?.items.first?.id, "item-4400")
        XCTAssertEqual(state.presentationDetail?.items.first?.id, "item-0")
        state.setProtectsHistoryWindow(false)
        XCTAssertEqual(state.detail?.items.count, 400)
        for index in 5000..<5100 {
            let step = item(index, turn: "long", type: "commandExecution")
            state.apply(detail(items: (state.detail?.items ?? []) + [step]))
        }
        XCTAssertEqual(state.detail?.items.count, 400)
        XCTAssertEqual(state.detail?.items.first?.id, "item-4700")
        XCTAssertEqual(state.presentationDetail?.items.first?.id, "item-0")
        XCTAssertEqual(state.presentationDetail?.items.count, 401)
        state.apply(detail(items: (state.detail?.items ?? []) + [item(5100, turn: "auxiliary", type: "reasoning")]))
        XCTAssertEqual(state.presentationDetail?.items.first?.id, "item-0", "An auxiliary event must not discard the prompt")
        state.discardRetainedContext(for: ["item-0"])
        state.apply(detail(items: state.detail?.items ?? []), timelineRevision: 1)
        XCTAssertFalse(state.presentationDetail?.items.contains { $0.id == "item-0" } ?? true)
    }

    func testPublishedVersionCanSupplyProjectionIdentityWithoutContentSignatures() {
        let source = detail(items: [item(0), item(1)])
        let cache = makeDetailDisplayCache(for: source, sessionId: "test", visibleMessageLimit: 100,
            preparedSourceSignature: "published:42")
        XCTAssertEqual(cache.signature, "published:42")
        XCTAssertEqual(cache.sourceSignature, "published:42")
    }

    func testCancelledProjectionStopsBeforeGroupingHistory() async {
        let source = detail(items: (0..<1000).map { item($0) })
        let worker = Task.detached {
            withUnsafeCurrentTask { $0?.cancel() }
            return makeDetailDisplayCache(for: source, sessionId: "cancelled", visibleMessageLimit: 100,
                preparedSourceSignature: "cancelled")
        }
        let cache = await worker.value
        XCTAssertTrue(cache.displayItems.isEmpty)
        XCTAssertTrue(cache.displayEntries.isEmpty)
    }

    func testExpandedProcessUsesNativeRowsAndReusesUnchangedSteps() throws {
        _ = NSApplication.shared
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(false), onToggleExpansion: { _ in })
        coordinator.attach(tableView: table, scrollView: scroll)
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 480, height: 400),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = scroll
        defer { window.contentView = nil; window.orderOut(nil) }
        let nativeTable = try XCTUnwrap(table as? IntrinsicHeightTableView)
        let reloads = nativeTable.fullReloadCount
        var process = processRow(count: 1000)
        let before = ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated]
        coordinator.apply(rows: [process], contentRevision: 1)
        table.layoutSubtreeIfNeeded()
        XCTAssertEqual(table.numberOfRows, 1001)
        let first = try XCTUnwrap(coordinator.tableView(table, viewFor: table.tableColumns.first, row: 1) as? AppKitSharedMessageTextCell)
        let configurations = first.contentConfigurationCount
        XCTAssertLessThan(ChatPerformanceRecorder.shared.snapshot()[.appKitCellsCreated] - before, 80,
            "A thousand expanded steps must not instantiate a thousand hosting trees")
        let last = process.processSteps[999]
        process.processSteps[999] = .init(id: last.id, kind: last.kind, state: .completed, title: "Updated", detail: "Changed")
        process.contentRevision += 1
        coordinator.apply(rows: [process], contentRevision: 2)
        let reused = try XCTUnwrap(coordinator.tableView(table, viewFor: table.tableColumns.first, row: 1) as? AppKitSharedMessageTextCell)
        XCTAssertTrue(reused === first)
        XCTAssertEqual(first.contentConfigurationCount, configurations)
        process.isExpanded = false; process.contentRevision += 1
        coordinator.apply(rows: [process], contentRevision: 3)
        XCTAssertEqual(table.numberOfRows, 1)
        XCTAssertEqual(nativeTable.fullReloadCount, reloads, "Process expansion, updates and collapse must retain the native table")
    }

    func testWidthUpdateKeepsTheHostingRootAndContentConfiguration() {
        let cell = AppKitSharedMessageTextCell(identifier: .init("width-test"))
        let process = processRow(count: 1)
        cell.setContent(process, availableWidth: 480, onToggleExpansion: { _ in })
        let configurations = cell.contentConfigurationCount, hosts = cell.hostUpdateCount
        for width in stride(from: 480, through: 320, by: -8) {
            XCTAssertTrue(cell.updateLayoutIfContentUnchanged(process, availableWidth: CGFloat(width)))
        }
        XCTAssertEqual(cell.contentConfigurationCount, configurations)
        XCTAssertEqual(cell.hostUpdateCount, hosts)
    }

    private func item(_ index: Int, turn: String? = nil, type: String = "userMessage") -> CodexThreadItem {
        CodexThreadItem(id: "item-\(index)", turnId: turn ?? "turn-\(index)", turnStatus: "completed",
            type: type, title: "User", text: "Message \(index)", options: nil, status: nil,
            createdAt: "2026-11-06T00:00:00Z")
    }

    private func detail(items: [CodexThreadItem], updatedAt: String = "") -> CodexThreadDetail {
        CodexThreadDetail(id: "thread", title: "Test", status: .complete, source: nil,
            connectionStatus: nil, currentModel: nil, currentReasoningLevel: nil, activityStatus: nil,
            cwd: nil, createdAt: "", updatedAt: updatedAt, canSend: true, sendUnavailableReason: nil,
            capabilities: nil, turnCount: 1000, items: items)
    }

    private func processRow(count: Int) -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(id: "process:turn", contentRevision: 1, nativeText: "Execution", copyText: "Execution",
            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn", isExpanded: true,
            processCount: count, processSteps: (0..<count).map { .init(id: "step-\($0)", kind: .action,
                state: .completed, title: "Step \($0)", detail: "Completed output") }, showsHeader: false)
    }
}
