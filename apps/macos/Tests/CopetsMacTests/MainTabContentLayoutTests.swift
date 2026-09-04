import SwiftUI
import Testing
@testable import CorptieMac

struct MainTabContentLayoutTests {
    @Test
    func selectedIndexTracksTheStableTabOrder() {
        #expect(AppTab.allCases == [.console, .automations, .worktrees, .agents])
        #expect(AppTab.console.index == 0)
        #expect(AppTab.automations.index == 1)
        #expect(AppTab.worktrees.index == 2)
        #expect(AppTab.agents.index == 3)
        #expect(AppTab.console.systemImage == "circle.hexagongrid.fill")
    }

    @Test
    func consoleDirectlyHostsTheUnifiedConversationSurface() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("root = AnyView(UnifiedConsoleView())"))
        #expect(contents.contains("case .console: L10n(\"Workbench\")"))
        #expect(contents.contains("case .console: \"circle.hexagongrid.fill\""))
        #expect(!contents.contains("case .console: \"square.grid.2x2\""))
        #expect(!contents.contains("case sessions"))
        #expect(!contents.contains("root = AnyView(WarRoomView())"))
        #expect(contents.contains("selectTab(.console)"))
    }

    @MainActor
    @Test
    func transitionsUseStableTabOrderAndAttachOnlyTwoFixedSizePages() throws {
        let container = makeContainer(animationDuration: 10)
        container.frame = NSRect(x: 0, y: 0, width: 1_200, height: 700)
        container.select(.automations, animated: false)
        let layoutCount = container.activePageLayoutCount

        container.select(.worktrees)

        #expect(container.transition == MainTabTransition(
            from: .automations,
            to: .worktrees,
            direction: .forward
        ))
        #expect(container.attachedTabs == [.automations, .worktrees])
        #expect(container.visibleTabs == [.automations, .worktrees])
        #expect(container.attachedPageCount == 2)
        #expect(container.cachedPage(for: .automations)?.frame == container.bounds)
        #expect(container.cachedPage(for: .worktrees)?.frame == container.bounds)
        #expect(container.activePageLayoutCount == layoutCount + 1)

        container.finishActiveTransition()
        #expect(container.transition == nil)
        #expect(container.attachedTabs == [.automations, .worktrees])
        #expect(container.visibleTabs == [.worktrees])
        #expect(container.cachedPage(for: .automations)?.isHidden == true)
    }

    @MainActor
    @Test
    func backwardAndRapidTransitionsNeverExposeAThirdOrWrongPage() {
        let container = makeContainer(animationDuration: 10)
        container.frame = NSRect(x: 0, y: 0, width: 980, height: 620)
        container.select(.agents, animated: false)
        container.select(.automations)

        #expect(container.transition?.direction == .backward)
        #expect(container.attachedTabs == [.automations, .agents])
        #expect(container.visibleTabs == [.automations, .agents])

        container.select(.worktrees)
        #expect(container.selectedTab == .automations)
        #expect(container.transition == MainTabTransition(
            from: .agents,
            to: .automations,
            direction: .backward
        ))
        #expect(container.pendingTab == .worktrees)
        #expect(container.attachedTabs == [.automations, .agents])
        #expect(container.visibleTabs == [.automations, .agents])
        #expect(container.attachedPageCount == 2)

        container.select(.console)
        #expect(container.pendingTab == .console)
        #expect(container.attachedTabs == [.automations, .agents])
        #expect(container.visibleTabs == [.automations, .agents])
        #expect(container.cachedPage(for: .worktrees) == nil)

        container.finishActiveTransition()
        #expect(container.selectedTab == .console)
        #expect(container.transition == MainTabTransition(
            from: .automations,
            to: .console,
            direction: .backward
        ))
        #expect(container.pendingTab == nil)
        #expect(container.attachedTabs == [.console, .automations, .agents])
        #expect(container.visibleTabs == [.console, .automations])
        #expect(container.attachedPageCount == 3)
        #expect(container.cachedPage(for: .agents)?.isHidden == true)
    }

    @MainActor
    @Test
    func compositeAnimationDoesNotMutatePageLayoutFrames() throws {
        let container = makeContainer(animationDuration: 10)
        container.frame = NSRect(x: 0, y: 0, width: 1_111, height: 777)
        container.select(.console, animated: false)
        let console = try #require(container.cachedPage(for: .console))
        let fixedFrame = console.frame
        let layoutCount = container.activePageLayoutCount

        container.select(.agents)
        let agents = try #require(container.cachedPage(for: .agents))

        #expect(console.frame == fixedFrame)
        #expect(agents.frame == fixedFrame)
        #expect(container.activePageLayoutCount == layoutCount + 1)
        #expect(console.layer?.animation(forKey: "main-tab-translation") != nil)
        #expect(agents.layer?.animation(forKey: "main-tab-translation") != nil)
        #expect(console.layer?.animation(forKey: "main-tab-opacity") != nil)
        #expect(agents.layer?.animation(forKey: "main-tab-opacity") != nil)

        let outgoingTranslation = try #require(
            console.layer?.animation(forKey: "main-tab-translation") as? CABasicAnimation
        )
        let incomingTranslation = try #require(
            agents.layer?.animation(forKey: "main-tab-translation") as? CABasicAnimation
        )
        #expect((outgoingTranslation.fromValue as? CGFloat) == 0)
        #expect((outgoingTranslation.toValue as? CGFloat) == -fixedFrame.width)
        #expect((incomingTranslation.fromValue as? CGFloat) == fixedFrame.width)
        #expect((incomingTranslation.toValue as? CGFloat) == 0)
    }

    @MainActor
    @Test
    func cachedPageIdentityAndLocalStateSurviveSwitches() throws {
        final class StatefulPage: NSView {
            var marker = "initial"
        }
        var created: [AppTab: StatefulPage] = [:]
        let container = MainTabPageContainer(animationDuration: 0) { tab in
            let page = StatefulPage()
            created[tab] = page
            return page
        }
        container.frame = NSRect(x: 0, y: 0, width: 980, height: 620)
        container.select(.console, animated: false)
        let console = try #require(created[.console])
        console.marker = "scroll-and-selection-state"

        container.select(.worktrees, animated: false)
        container.select(.console, animated: false)

        #expect(created[.console] === console)
        #expect(created[.console]?.marker == "scroll-and-selection-state")
        #expect(container.cachedPageCount == 2)
        #expect(container.attachedTabs == [.console, .worktrees])
        #expect(container.visibleTabs == [.console])
    }

    @MainActor
    private func makeContainer(animationDuration: TimeInterval) -> MainTabPageContainer {
        MainTabPageContainer(animationDuration: animationDuration) { _ in
            NSView(frame: .zero)
        }
    }

    @Test
    func mainWindowCoalescesNativeLiveResizeAndEnforcesContentMinimum() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/CopetsMacApp.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("let hostingView = MainWindowSurfaceContainer("))
        #expect(contents.contains("rootView: MainWindowContentView()"))
        #expect(contents.contains("let leadingChrome = MainWindowLeadingChromeAccessoryController()"))
        #expect(contents.contains("let titlebarChrome = MainWindowTitlebarAccessoryController()"))
        #expect(contents.contains("window.addTitlebarAccessoryViewController(leadingChrome)"))
        #expect(contents.contains("window.addTitlebarAccessoryViewController(titlebarChrome)"))
        #expect(!contents.contains("chromeSurfaces: MainWindowChromeSurfaces("))
        #expect(contents.contains("override func viewWillStartLiveResize()"))
        #expect(contents.contains("override func viewDidEndLiveResize()"))
        #expect(contents.contains("NSWindow.willEnterFullScreenNotification"))
        #expect(contents.contains("scheduleExactLayoutAfterStability()"))
        #expect(contents.contains("displayLink("))
        #expect(contents.contains("link.add(to: .main, forMode: .common)"))
        #expect(!contents.contains("private var layoutTimer"))
        #expect(!contents.contains("scaleAxesIndependently"))
        #expect(!contents.contains("contentContainer.layer?.setAffineTransform"))
        #expect(!contents.contains("applyPresentationTransform"))
        #expect(contents.contains("layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor"))
        #expect(contents.contains("CATransaction.setDisableActions(true)"))
        #expect(!contents.contains("bitmapImageRepForCachingDisplay"))
        #expect(contents.contains("window.preservesContentDuringLiveResize = true"))
        #expect(contents.contains("window.contentMinSize = MainWindowInitialLayout.minimumContentSize"))
    }

    @Test
    func tabButtonsExposeStableAutomationIdentifiersAndSelectionValues() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains(".accessibilityIdentifier(\"main-tab.\\(tab.rawValue)\")"))
        #expect(contents.contains(".accessibilityLabel(tab.title)"))
        #expect(contents.contains(".accessibilityValue(isSelected ? \"selected\" : \"not-selected\")"))
    }

    @Test
    func contentDoesNotReserveASecondRowBelowTheNativeTitlebar() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)
        let start = try #require(contents.range(of: "struct MainWindowContentView: View"))
        let end = try #require(contents.range(
            of: "struct MainWindowFixedChromeView: View",
            range: start.upperBound..<contents.endIndex
        ))
        let contentView = contents[start.lowerBound..<end.lowerBound]

        #expect(contentView.contains("MainTabPageHost("))
        #expect(!contentView.contains("Color.clear"))
        #expect(!contentView.contains("contentTopInset"))
    }
}
