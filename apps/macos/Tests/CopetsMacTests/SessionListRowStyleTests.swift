import SwiftUI
import XCTest
@testable import CorptieMac

final class SessionListRowStyleTests: XCTestCase {
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
