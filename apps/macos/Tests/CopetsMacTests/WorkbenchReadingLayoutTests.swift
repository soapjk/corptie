import AppKit
import SwiftUI
import XCTest
import CorptieConversation
@testable import CorptieMac

@MainActor
final class WorkbenchReadingLayoutTests: XCTestCase {
    func testNativeReadingLaneRecentersWhenWidthIsClampedAndKeepsFullScrollViewport() throws {
        _ = NSApplication.shared
        let table = AppKitChatTimelineView.makeTableView()
        let scroll = AppKitChatTimelineView.makeScrollView(tableView: table)
        let coordinator = AppKitChatTimelineView.Coordinator(followsLatest: .constant(true),
            onToggleExpansion: { _ in }, onAction: { _ in }, onNearTop: {})
        coordinator.attach(tableView: table, scrollView: scroll)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = scroll
        defer { window.contentView = nil; window.close() }
        coordinator.updateSkin(.codexFlat)
        let row = AppKitChatTimelineRow(id: "answer", contentRevision: 1,
            nativeText: String(repeating: "A readable paragraph with enough content to wrap. ", count: 80),
            copyText: "Answer", nativeStyle: .agent, title: "", metadata: "",
            expandableTurnId: nil, isExpanded: false)
        coordinator.apply(rows: [row])
        for width: CGFloat in [1200, 1440, 640, 400, 1200] {
            window.setContentSize(NSSize(width: width, height: 600))
            window.layoutIfNeeded()
            scroll.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.03))
            let lane = WorkbenchStyle.lane(viewportWidth: scroll.contentView.bounds.width)
            XCTAssertEqual(table.frame.minX, lane.minX, accuracy: 0.5)
            XCTAssertEqual(table.tableColumns[0].width, lane.width, accuracy: 0.5)
            XCTAssertEqual(table.frame.width, lane.width, accuracy: 0.5)
            XCTAssertEqual(scroll.documentView?.frame.width ?? 0, scroll.contentView.bounds.width, accuracy: 0.5)
            XCTAssertEqual(table.numberOfRows, 1)
        }
        // Compact/floating conversations keep their full-width native layout.
        coordinator.setReservesVerticalScrollerGutter(false)
        XCTAssertEqual(table.frame.minX, 0, accuracy: 0.5)
        XCTAssertEqual(table.tableColumns[0].width, scroll.contentView.bounds.width, accuracy: 0.5)
        withExtendedLifetime(coordinator) {}
    }
}
