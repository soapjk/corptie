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

    func testCurrentTurnAndPendingInputAreNeverCutInHalf() {
        let oneTurn = detail(items: (0..<1000).map { item($0, turn: "current") })
        XCTAssertEqual(ResidentTimelineWindow.compact(oneTurn, protectingHistory: false).items.count, 1000)
        var source = (0..<1000).map { item($0) }
        source[0].userMessageStatus = "queued"
        XCTAssertEqual(ResidentTimelineWindow.compact(detail(items: source), protectingHistory: false).items.count, 1000)
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

    private func item(_ index: Int, turn: String? = nil) -> CodexThreadItem {
        CodexThreadItem(id: "item-\(index)", turnId: turn ?? "turn-\(index)", turnStatus: "completed",
            type: "userMessage", title: "User", text: "Message \(index)", options: nil, status: nil,
            createdAt: "2026-11-06T00:00:00Z")
    }

    private func detail(items: [CodexThreadItem]) -> CodexThreadDetail {
        CodexThreadDetail(id: "thread", title: "Test", status: .complete, source: nil,
            connectionStatus: nil, currentModel: nil, currentReasoningLevel: nil, activityStatus: nil,
            cwd: nil, createdAt: "", updatedAt: "", canSend: true, sendUnavailableReason: nil,
            capabilities: nil, turnCount: 1000, items: items)
    }

    private func processRow(count: Int) -> AppKitChatTimelineRow {
        AppKitChatTimelineRow(id: "process:turn", contentRevision: 1, nativeText: "Execution", copyText: "Execution",
            nativeStyle: .process, title: "", metadata: "", expandableTurnId: "turn", isExpanded: true,
            processCount: count, processSteps: (0..<count).map { .init(id: "step-\($0)", kind: .action,
                state: .completed, title: "Step \($0)", detail: "Completed output") }, showsHeader: false)
    }
}
