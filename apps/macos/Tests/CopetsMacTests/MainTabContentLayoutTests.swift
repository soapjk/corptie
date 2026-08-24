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

    @MainActor
    @Test
    func transitionsUseStableTabOrderAndAttachOnlyTwoFixedSizePages() throws {
        let container = makeContainer(animationDuration: 10)
        container.frame = NSRect(x: 0, y: 0, width: 1_200, height: 700)
        container.select(.sessions, animated: false)
        let layoutCount = container.activePageLayoutCount

        container.select(.worktrees)

        #expect(container.transition == MainTabTransition(
            from: .sessions,
            to: .worktrees,
            direction: .forward
        ))
        #expect(container.attachedTabs == [.sessions, .worktrees])
        #expect(container.visibleTabs == [.sessions, .worktrees])
        #expect(container.attachedPageCount == 2)
        #expect(container.cachedPage(for: .sessions)?.frame == container.bounds)
        #expect(container.cachedPage(for: .worktrees)?.frame == container.bounds)
        #expect(container.activePageLayoutCount == layoutCount + 1)

        container.finishActiveTransition()
        #expect(container.transition == nil)
        #expect(container.attachedTabs == [.sessions, .worktrees])
        #expect(container.visibleTabs == [.worktrees])
        #expect(container.cachedPage(for: .sessions)?.isHidden == true)
    }

    @MainActor
    @Test
    func backwardAndRapidTransitionsNeverExposeAThirdOrWrongPage() {
        let container = makeContainer(animationDuration: 10)
        container.frame = NSRect(x: 0, y: 0, width: 980, height: 620)
        container.select(.agents, animated: false)
        container.select(.sessions)

        #expect(container.transition?.direction == .backward)
        #expect(container.attachedTabs == [.sessions, .agents])
        #expect(container.visibleTabs == [.sessions, .agents])

        container.select(.automations)
        #expect(container.selectedTab == .sessions)
        #expect(container.transition == MainTabTransition(
            from: .agents,
            to: .sessions,
            direction: .backward
        ))
        #expect(container.pendingTab == .automations)
        #expect(container.attachedTabs == [.sessions, .agents])
        #expect(container.visibleTabs == [.sessions, .agents])
        #expect(container.attachedPageCount == 2)

        container.select(.console)
        #expect(container.pendingTab == .console)
        #expect(container.attachedTabs == [.sessions, .agents])
        #expect(container.visibleTabs == [.sessions, .agents])
        #expect(container.cachedPage(for: .automations) == nil)

        container.finishActiveTransition()
        #expect(container.selectedTab == .console)
        #expect(container.transition == MainTabTransition(
            from: .sessions,
            to: .console,
            direction: .backward
        ))
        #expect(container.pendingTab == nil)
        #expect(container.attachedTabs == [.console, .sessions, .agents])
        #expect(container.visibleTabs == [.console, .sessions])
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
        container.select(.sessions, animated: false)
        let sessions = try #require(created[.sessions])
        sessions.marker = "scroll-and-selection-state"

        container.select(.worktrees, animated: false)
        container.select(.sessions, animated: false)

        #expect(created[.sessions] === sessions)
        #expect(created[.sessions]?.marker == "scroll-and-selection-state")
        #expect(container.cachedPageCount == 2)
        #expect(container.attachedTabs == [.sessions, .worktrees])
        #expect(container.visibleTabs == [.sessions])
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

    @Test
    func tabButtonsExposeStableAutomationIdentifiersAndSelectionValues() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains(".accessibilityIdentifier(\"main-tab.\\(tab.rawValue)\")"))
        #expect(contents.contains(".accessibilityValue(isSelected ? \"selected\" : \"not-selected\")"))
    }
}
