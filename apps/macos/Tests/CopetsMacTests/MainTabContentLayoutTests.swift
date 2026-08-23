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
    func mainTabHostUsesCurrentBoundsForDirectionalPagePlacement() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("MainTabPageHost("))
        #expect(contents.contains("final class MainTabPageContainer: NSView"))
        #expect(contents.contains("pages[selectedTab]?.removeFromSuperview()"))
        #expect(contents.contains("pages[tab] = created"))
        #expect(contents.contains("addSubview(page)"))
        #expect(!contents.contains("MainTabPageLayout(selectedIndex:"))
    }

    @Test
    func mainWindowCoalescesNativeLiveResizeAndEnforcesContentMinimum() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/CopetsMacApp.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("let hostingView = LiveResizeHostingView("))
        #expect(contents.contains("override func viewWillStartLiveResize()"))
        #expect(contents.contains("override func viewDidEndLiveResize()"))
        #expect(contents.contains("NSWindow.willEnterFullScreenNotification"))
        #expect(contents.contains("scheduleExactLayoutAfterStability()"))
        #expect(contents.contains("RunLoop.main.add(timer, forMode: .common)"))
        #expect(!contents.contains("scaleAxesIndependently"))
        #expect(!contents.contains("setAffineTransform"))
        #expect(!contents.contains("bitmapImageRepForCachingDisplay"))
        #expect(contents.contains("window.preservesContentDuringLiveResize = true"))
        #expect(contents.contains("window.contentMinSize = NSSize(width: 980, height: 620)"))
    }
}
