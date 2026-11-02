import SwiftUI
import Testing
@testable import CorptieMac

struct MainTabContentLayoutTests {
    @Test
    func selectedIndexTracksTheStableTabOrder() {
        #expect(AppTab.allCases == [.console, .automations, .scenes, .worktrees, .resources, .roles, .memory, .settings])
        #expect(AppTab.console.index == 0)
        #expect(AppTab.automations.index == 1)
        #expect(AppTab.scenes.index == 2)
        #expect(AppTab.worktrees.index == 3)
        #expect(AppTab.resources.index == 4)
        #expect(AppTab.roles.index == 5)
        #expect(AppTab.console.systemImage == "circle.hexagongrid.fill")
        #expect(AppTab.scenes.systemImage == "camera.macro")
    }

    @MainActor
    @Test
    func sceneNavigationSymbolExistsInTheSystemLibrary() {
        #expect(NSImage(systemSymbolName: AppTab.scenes.systemImage, accessibilityDescription: nil) != nil)
    }

    @Test
    func sceneCreationActionIsRenderedInsideTheSidebar() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/ScenesView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("sidebarHeader\n                Divider()\n                List(client.scenes"))
        #expect(contents.contains("private var sidebarHeader: some View"))
        #expect(contents.contains(".accessibilityIdentifier(\"scenes.create\")"))
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
    func fadeImmediatelyHidesOldPageAndPreservesFixedSizeHosts() throws {
        let container = makeContainer(animationDuration: 10)
        container.frame = NSRect(x: 0, y: 0, width: 1_200, height: 700)
        container.select(.automations, animated: false)
        let layoutCount = container.activePageLayoutCount

        container.select(.worktrees)

        #expect(container.transition == MainTabTransition(
            from: .automations,
            to: .worktrees
        ))
        #expect(container.attachedTabs == [.automations, .worktrees])
        #expect(container.visibleTabs == [.worktrees])
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
    func rapidClicksImmediatelySelectTheLatestPageWithoutWaitingForTheFade() {
        let container = makeContainer(animationDuration: 10)
        container.frame = NSRect(x: 0, y: 0, width: 980, height: 620)
        container.select(.roles, animated: false)
        container.select(.automations)
        #expect(container.visibleTabs == [.automations])
        container.select(.automations)
        #expect(container.transition != nil, "A normal update of the same page must preserve its fade")

        container.select(.worktrees)
        #expect(container.selectedTab == .worktrees)
        #expect(container.transition == MainTabTransition(from: .automations, to: .worktrees))
        #expect(container.visibleTabs == [.worktrees])
        #expect(container.cachedPage(for: .automations)?.layer?.animation(forKey: "main-tab-opacity") == nil)

        container.select(.console)
        #expect(container.selectedTab == .console)
        #expect(container.transition == MainTabTransition(from: .worktrees, to: .console))
        #expect(container.visibleTabs == [.console])
        #expect(container.cachedPage(for: .worktrees)?.layer?.animation(forKey: "main-tab-opacity") == nil)
        #expect(container.cachedPageCount == 4)

        container.finishActiveTransition()
        #expect(container.transition == nil)
        #expect(container.visibleTabs == [.console])
        #expect(container.cachedPage(for: .roles)?.isHidden == true)
        container.select(.roles)
        container.select(.roles, animated: false)
        #expect(container.transition == nil, "Reduced motion or live resize must finish the fade immediately")
        #expect(container.visibleTabs == [.roles])
        #expect(container.cachedPage(for: .roles)?.layer?.animation(forKey: "main-tab-opacity") == nil)
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

        container.select(.roles)
        let roles = try #require(container.cachedPage(for: .roles))

        #expect(console.frame == fixedFrame)
        #expect(roles.frame == fixedFrame)
        #expect(container.activePageLayoutCount == layoutCount + 1)
        #expect(console.isHidden)
        #expect(!roles.isHidden)
        #expect(console.layer?.animation(forKey: "main-tab-translation") == nil)
        #expect(roles.layer?.animation(forKey: "main-tab-translation") == nil)
        #expect(console.layer?.animation(forKey: "main-tab-opacity") == nil)
        let incomingOpacity = try #require(roles.layer?.animation(forKey: "main-tab-opacity") as? CABasicAnimation)
        #expect((incomingOpacity.fromValue as? Float) == 0)
        #expect((incomingOpacity.toValue as? Float) == 1)
        #expect(roles.layer.map { CATransform3DIsIdentity($0.transform) } == true)
        #expect(MainTabPageContainer.defaultAnimationDuration == 0.12)
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
            .appendingPathComponent("Sources/CopetsMac")
        let contents = try String(contentsOf: source.appendingPathComponent("Application/AppDelegate.swift"), encoding: .utf8)
            + String(contentsOf: source.appendingPathComponent("Application/MainWindowRuntime.swift"), encoding: .utf8)

        #expect(contents.contains("let hostingView = MainWindowSurfaceContainer("))
        #expect(contents.contains("rootView: FirstRunSetupRoot { MainWindowContentView() }.environmentObject(resizeState)"))
        #expect(!contents.contains("window.addTitlebarAccessoryViewController("))
        #expect(contents.contains("window.titlebarAppearsTransparent = true"))
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
            .appendingPathComponent("Sources/CopetsMac/MainWindowNavigationRail.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("accessibilityID: \"main-tab.\\($0.rawValue)\""))
        #expect(contents.contains("PlatformNavigationRail("))
    }

    @Test
    func tabCapsuleStaysBelowTitlebarAndKeepsSettingsInside() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainWindowNavigationRail.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("settingsAccessibilityID: \"main-window.settings\""))
        #expect(contents.contains("PlatformNavigationRail("))
        #expect(!contents.contains("verticalAlignment: .center"))
        #expect(contents.contains(".padding(.top, MainWindowLayoutMetrics.titlebarHeight + 8)"))
        #expect(contents.contains(".padding(.bottom, 8)"))
        #expect(!contents.contains(".background(Color(nsColor: .windowBackgroundColor)"))
        #expect(!contents.contains(".fill(Color(nsColor: .controlBackgroundColor))"))

        let shared = source
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/CorptieConversation/Sources/CorptieConversation/PlatformNavigationRail.swift")
        let sharedContents = try String(contentsOf: shared, encoding: .utf8)
        #expect(sharedContents.contains("onSettings()"))
        #expect(sharedContents.contains("Text(settingsTitle)"))
        #expect(!sharedContents.contains(".platformGlassSurface(in: Circle()"))
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
        #expect(!contentView.contains("LinearGradient("))
    }
}
