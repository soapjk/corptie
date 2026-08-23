import SwiftUI
import Testing
@testable import CorptieMac

struct MainTabContentLayoutTests {
    @Test
    func selectedIndexTracksTheStableTabOrder() {
        #expect(AppTab.console.index == 0)
        #expect(AppTab.sessions.index == 1)
        #expect(AppTab.worktrees.index == 2)
        #expect(AppTab.sessionDSH.index == 3)
        #expect(AppTab.agents.index == 4)
    }

    @Test
    func mainTabHostUsesCachedPagePlacementInsteadOfGeometryOffsets() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("MainTabPageLayout(selectedIndex: router.selectedTab.index)"))
        #expect(contents.contains("for (index, subview) in subviews.enumerated()"))
        #expect(!contents.contains(".offset(x: slideOffset("))
        #expect(!contents.contains("GeometryReader { geo in"))
    }
}
