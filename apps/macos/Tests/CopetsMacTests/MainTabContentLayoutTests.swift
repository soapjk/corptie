import SwiftUI
import Testing
@testable import CorptieMac

struct MainTabContentLayoutTests {
    @Test
    func selectedIndexTracksTheStableTabOrder() {
        #expect(AppTab.console.index == 0)
        #expect(AppTab.sessions.index == 1)
        #expect(AppTab.automations.index == 2)
        #expect(AppTab.worktrees.index == 3)
        #expect(AppTab.sessionDSH.index == 4)
        #expect(AppTab.agents.index == 5)
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

    @Test
    func mainWindowFreezesLiveResizeAndEnforcesContentMinimum() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/CopetsMacApp.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("LiveResizeFrozenHostingView(rootView: MainTabView())"))
        #expect(contents.contains("override func viewWillStartLiveResize()"))
        #expect(contents.contains("override func viewDidEndLiveResize()"))
        #expect(contents.contains("NSWindow.willEnterFullScreenNotification"))
        #expect(contents.contains("window.contentMinSize = NSSize(width: 980, height: 620)"))
    }
}
