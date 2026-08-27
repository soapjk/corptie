import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct MainWindowAndSidebarStateTests {
    @Test
    func everyTabOwnsAnIndependentSidebarState() {
        let router = AppTabRouter()

        for tab in AppTab.allCases {
            #expect(router.sidebarState(for: tab).isVisible)
        }

        router.sidebarState(for: .console).toggle()
        #expect(!router.sidebarState(for: .console).isVisible)
        for tab in AppTab.allCases where tab != .console {
            #expect(router.sidebarState(for: tab).isVisible)
        }

        router.selectTab(.sessions)
        router.sidebarState(for: .sessions).toggle()
        #expect(!router.sidebarState(for: .sessions).isVisible)
        router.selectTab(.console)
        #expect(!router.sidebarState(for: .console).isVisible)
        #expect(router.sidebarState(for: .automations).isVisible)
    }

    @Test
    func everyTabSidebarCanToggleWithoutChangingSelection() {
        let router = AppTabRouter()
        #expect(router.selectedTab == .console)

        for tab in AppTab.allCases {
            let state = router.sidebarState(for: tab)
            state.toggle()
            #expect(!state.isVisible)
            state.toggle()
            #expect(state.isVisible)
            #expect(router.selectedTab == .console)
        }
    }

    @Test
    func sessionSidebarNativeButtonRemainsOperableAcrossRepeatedCloseOpenCycles() {
        let state = TabSidebarState(tab: .sessions)
        let button = MainWindowSidebarNSButton(sidebarState: state)

        #expect(!button.isHidden)
        #expect(button.isEnabled)
        #expect(!button.isBordered)
        #expect(button.contentTintColor == .secondaryLabelColor)
        #expect(button.accessibilityIdentifier() == "main-window.sidebar")
        #expect(button.accessibilityValue() as? String == L10n("Expanded"))

        for _ in 0..<3 {
            button.performClick(nil)
            #expect(!state.isVisible)
            #expect(!button.isHidden)
            #expect(button.isEnabled)
            #expect(!button.isBordered)
            #expect(button.contentTintColor == .secondaryLabelColor)
            #expect(button.accessibilityValue() as? String == L10n("Collapsed"))

            button.performClick(nil)
            #expect(state.isVisible)
            #expect(!button.isHidden)
            #expect(button.isEnabled)
            #expect(!button.isBordered)
            #expect(button.contentTintColor == .secondaryLabelColor)
            #expect(button.accessibilityValue() as? String == L10n("Expanded"))
        }
    }

    @Test
    func sidebarButtonUsesQuietStateSpecificSymbols() throws {
        let expanded = try #require(
            MainWindowSidebarButtonAppearance.image(isVisible: true)
        )
        let collapsed = try #require(
            MainWindowSidebarButtonAppearance.image(isVisible: false)
        )

        #expect(expanded.isTemplate)
        #expect(collapsed.isTemplate)
        #expect(expanded.tiffRepresentation != collapsed.tiffRepresentation)
    }

    @Test
    func nativeSidebarButtonRebindsWithoutOverwritingAnotherTabsState() {
        let sessions = TabSidebarState(tab: .sessions)
        let console = TabSidebarState(tab: .console)
        let button = MainWindowSidebarNSButton(sidebarState: sessions)

        button.performClick(nil)
        #expect(!sessions.isVisible)
        #expect(console.isVisible)

        button.bind(to: console)
        button.performClick(nil)
        #expect(!sessions.isVisible)
        #expect(!console.isVisible)

        button.bind(to: sessions)
        button.performClick(nil)
        #expect(sessions.isVisible)
        #expect(!console.isVisible)
    }

    @Test
    func mainWindowLevelPolicyRestoresTheDefaultLevel() {
        #expect(MainWindowLevelPolicy.level(isPinned: true) == .floating)
        #expect(MainWindowLevelPolicy.level(isPinned: false) == .normal)

        let window = NSWindow()
        window.level = MainWindowLevelPolicy.level(isPinned: true)
        #expect(window.level == .floating)
        window.level = MainWindowLevelPolicy.level(isPinned: false)
        #expect(window.level == .normal)
    }

    @Test
    func repeatedTabSidebarAndWindowLevelChangesStayOnTheSynchronousFastPath() {
        let router = AppTabRouter()
        let window = NSWindow()
        let tabs = AppTab.allCases
        let iterations = 10_000
        let start = CFAbsoluteTimeGetCurrent()

        for index in 0..<iterations {
            let tab = tabs[index % tabs.count]
            router.selectTab(tab)
            let state = router.sidebarState(for: tab)
            state.toggle()
            state.toggle()
            window.level = MainWindowLevelPolicy.level(isPinned: index.isMultiple(of: 2))
        }

        let elapsed = CFAbsoluteTimeGetCurrent() - start
        print("[MainWindowInteractionPerformance] \(iterations) mixed cycles: \(elapsed) seconds")
        #expect(elapsed < 1.0)
        #expect(router.sidebarState(for: .console).isVisible)
    }

    @Test
    func chromeAndEveryTabDeclareTheirSidebarContracts() throws {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")

        let mainTab = try String(
            contentsOf: sourceRoot.appendingPathComponent("MainTabView.swift"),
            encoding: .utf8
        )
        #expect(mainTab.contains("systemName: windowState.isPinned ? \"pin.fill\" : \"pin\""))
        #expect(mainTab.contains("isActive: windowState.isPinned"))
        #expect(mainTab.contains("MainWindowSidebarToggleButton(sidebarState: sidebarState)"))
        #expect(mainTab.contains("setAccessibilityValue(L10n(isVisible ? \"Expanded\" : \"Collapsed\"))"))
        #expect(mainTab.contains(".environmentObject(router.sidebarState(for: tab))"))

        for fileName in ["WarRoomView.swift", "SessionsView.swift", "AutomationsView.swift", "WorktreeManagementView.swift"] {
            let contents = try String(
                contentsOf: sourceRoot.appendingPathComponent(fileName),
                encoding: .utf8
            )
            #expect(contents.contains("NavigationSplitView(columnVisibility: $sidebarState.visibility)"))
        }

        let agents = try String(
            contentsOf: sourceRoot.appendingPathComponent("AgentManagementView.swift"),
            encoding: .utf8
        )
        #expect(agents.contains("if sidebarState.isVisible && layoutMode == .split"))

        let dsh = try String(
            contentsOf: sourceRoot.appendingPathComponent("SessionDSHView.swift"),
            encoding: .utf8
        )
        #expect(dsh.contains("DSHWebView(store: .shared, isSidebarVisible: sidebarState.isVisible)"))
        #expect(dsh.contains("'[data-sidebar-collapsed]'"))
    }

    @Test
    func appUsesRegularActivationAndRestoresMainWindowOnActivation() throws {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/CopetsMacApp.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        #expect(contents.contains("NSApp.setActivationPolicy(.regular)"))
        #expect(!contents.contains("NSApp.setActivationPolicy(.accessory)"))
        #expect(contents.contains("func applicationDidBecomeActive"))
        #expect(contents.contains("presentMainWindowAfterActivation()"))
        #expect(contents.contains("window.deminiaturize(nil)"))
        #expect(contents.contains("window.makeKeyAndOrderFront(nil)"))
    }
}
