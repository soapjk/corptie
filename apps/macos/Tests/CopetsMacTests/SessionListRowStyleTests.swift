import SwiftUI
import XCTest
import AppKit
@testable import CorptieMac

final class SessionListRowStyleTests: XCTestCase {
    @MainActor
    func testOutlineSurfaceContainsTheActualTitleButtonAndStatusAtEveryWidth() throws {
        for title in ["短标题", "消息列表 UI 持续优化", String(repeating: "很长的会话标题 ", count: 20)] {
            for selected in [false, true] {
                let buttonBounds = NSView(), surfaceBounds = NSView()
                let task = CorptieTask(id: "task:row", workId: "work:row", title: title,
                    description: "", acceptanceCriteria: "", priority: "medium", lifecycleState: "in_progress",
                    mainRoleId: "role:row", currentSessionId: nil, executionStatus: "running",
                    acceptanceAssessment: nil, completionSuggestion: nil,
                    createdAt: "2026-11-03T00:00:00Z", updatedAt: "2026-11-03T00:00:00Z")
                let host = NSHostingView(rootView:
                    ConsoleTaskRowContent(showsHoverFeedback: false, task: task, sessionActivity: .processing,
                        isSelected: selected, isUnread: true, isActive: false, onOpen: {})
                        .background(RowBoundsProbe(view: buttonBounds))
                        .consoleOutlineRowSurface(isSelected: selected)
                        .background(RowBoundsProbe(view: surfaceBounds)))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 300, height: 30),
                    styleMask: [.borderless], backing: .buffered, defer: false)
                window.isReleasedWhenClosed = false
                window.contentView = host
                defer { window.contentView = nil; window.close() }
                for width: CGFloat in [160, 220, 300, 520] {
                    window.setContentSize(NSSize(width: width, height: 30))
                    host.layoutSubtreeIfNeeded()
                    let surface = surfaceBounds.convert(surfaceBounds.bounds, to: host)
                    let button = buttonBounds.convert(buttonBounds.bounds, to: host)
                    XCTAssertEqual(surface.width, width, accuracy: 0.5)
                    XCTAssertEqual(surface.height, 30, accuracy: 0.5)
                    XCTAssertGreaterThan(button.width, 0)
                    // This is the exact painted rectangle, including its 8pt inset.
                    XCTAssertTrue(surface.insetBy(dx: 8, dy: 0).contains(button),
                        "Title/button and status must fit inside the background: \(button) in \(surface)")
                    let background = surface.insetBy(dx: 8, dy: 0)
                    XCTAssertGreaterThanOrEqual(button.minX - background.minX, 7.5,
                        "The title needs visible breathing room inside the left edge")
                    XCTAssertGreaterThanOrEqual(background.maxX - button.maxX, 7.5,
                        "The status needs matching breathing room inside the right edge")
                }
            }
        }
    }

    func testSessionsSidebarIsMoreCompactThanStandardRow() {
        XCTAssertEqual(CompactSessionRowStyle.standard.height, 46)
        XCTAssertEqual(CompactSessionRowStyle.sessionsSidebar.height, 38)
        XCTAssertLessThan(
            CompactSessionRowStyle.sessionsSidebar.height,
            CompactSessionRowStyle.standard.height
        )
    }

    func testSessionsSidebarUsesHigherTitleWeight() {
        XCTAssertEqual(CompactSessionRowStyle.standard.titleWeight, .semibold)
        XCTAssertEqual(CompactSessionRowStyle.sessionsSidebar.titleWeight, .bold)
        XCTAssertEqual(CompactSessionRowStyle.sessionsSidebarWithSubtitle.titleWeight, .bold)
    }

    func testAllModeSubtitleRowStaysCompact() {
        XCTAssertEqual(CompactSessionRowStyle.sessionsSidebarWithSubtitle.height, 44)
        XCTAssertGreaterThan(
            CompactSessionRowStyle.sessionsSidebarWithSubtitle.height,
            CompactSessionRowStyle.sessionsSidebar.height
        )
        XCTAssertLessThan(
            CompactSessionRowStyle.sessionsSidebarWithSubtitle.height,
            CompactSessionRowStyle.standard.height
        )
    }

    func testLongCorptieTaskSessionTitleUsesCompactListProjection() {
        let title = "完善 Session 规划列表折叠、Tab 分组和多轮样式微调"
        let displayTitle = SessionListTitlePolicy.displayTitle(title, isCorptieTaskSession: true)

        XCTAssertTrue(displayTitle.hasSuffix("…"))
        XCTAssertLessThan(displayTitle.count, title.count)
        XCTAssertLessThanOrEqual(
            SessionListTitlePolicy.visualWidth(of: displayTitle),
            SessionListTitlePolicy.maximumVisualWidth
        )
    }

    func testShortCorptieTaskSessionTitleRemainsUnchanged() {
        XCTAssertEqual(
            SessionListTitlePolicy.displayTitle(
                "优化 Session 列表行样式",
                isCorptieTaskSession: true
            ),
            "优化 Session 列表行样式"
        )
    }

    func testNonCorptieTaskSessionTitleIsNeverContentCompacted() {
        let title = "A deliberately long Assistant Session title that must remain intact"
        XCTAssertEqual(
            SessionListTitlePolicy.displayTitle(title, isCorptieTaskSession: false),
            title
        )
    }
}

private struct RowBoundsProbe: NSViewRepresentable {
    let view: NSView
    func makeNSView(context: Context) -> NSView { view }
    func updateNSView(_ nsView: NSView, context: Context) {}
}
