import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct SettingsWindowLayoutTests {
    @Test
    func categoriesUseCompactResizableColumnInsteadOfAnEightItemHorizontalBar() {
        #expect(SettingsTab.allCases.count == 8)
        #expect(SettingsPageLayout.sidebarMinimum == 180)
        #expect(SettingsPageLayout.sidebarIdeal == 200)
        #expect(SettingsPageLayout.sidebarMaximum == 240)
    }

    @Test
    func actualSplitPaneCapsTheOuterCardWhenTheWindowGrows() throws {
        let host = NSHostingView(rootView: SettingsView())
        func split(in view: NSView) -> NSSplitView? {
            if let view = view as? NSSplitView { return view }
            return view.subviews.lazy.compactMap { split(in: $0) }.first
        }
        for width: CGFloat in [900, 1280, 1920, 900] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: 700)
            host.layoutSubtreeIfNeeded()
            let splitView = try #require(split(in: host))
            splitView.layoutSubtreeIfNeeded()
            let sidebar = try #require(splitView.arrangedSubviews.first)
            let detail = try #require(splitView.arrangedSubviews.last)
            let gap = MainWindowPageLayoutMetrics.halfColumnSpacing
            #expect(sidebar.frame.width >= SettingsPageLayout.sidebarMinimum + gap - 1)
            #expect(sidebar.frame.width <= SettingsPageLayout.sidebarMaximum + gap + 1)
            #expect(detail.frame.width > sidebar.frame.width)
            print("settings split: host=\(width) sidebar=\(sidebar.frame.width) detail=\(detail.frame.width)")
        }
    }

    @Test
    func settingsPageFitsMultipleMainWindowSizesWithoutFixedWindowDimensions() {
        let hostingView = NSHostingView(rootView: SettingsView())
        for size in [NSSize(width: 900, height: 650), NSSize(width: 1280, height: 900)] {
            hostingView.frame = NSRect(origin: .zero, size: size)
            hostingView.layoutSubtreeIfNeeded()
            #expect(hostingView.fittingSize.width <= size.width)
            #expect(hostingView.fittingSize.height <= size.height)
        }
    }

    @Test
    func everyExistingSettingsRouteRemainsDeclared() throws {
        #expect(Set(SettingsTab.allCases) == [
            .general,
            .provider,
            .appearance,
            .notifications,
            .proxy,
            .gateway,
            .devices,
            .archivedSessions,
        ])

        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/Settings/SettingsView.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        for route in ["general", "provider", "appearance", "notifications", "proxy", "gateway", "devices", "archivedSessions"] {
            #expect(contents.contains("case .\(route):"))
        }
        #expect(contents.contains("LocalWallpaperSettingsView()"))
        #expect(contents.contains("ForEach(SettingsTab.allCases"))
        #expect(contents.contains("selectedTab = tab"))
        #expect(!contents.contains(".tabItem"))
        #expect(contents.contains("HSplitView {"))
        #expect(!contents.contains("onClose()"))
        #expect(!contents.contains("SettingsWindowLayout"))
        #expect(!contents.contains("sidebarToggle"))
        #expect(!contents.contains("@ObservedObject private var backendClient"))
        #expect(contents.contains("backendClient.$lastError.removeDuplicates()"))
        #expect(contents.contains("Button(L10n(\"Save\"))"))
        #expect(contents.contains("await saveAllSettings()"))
        let general = contents.components(separatedBy: "private var generalSettingsTab")[1]
            .components(separatedBy: "private var providerSettingsTab")[0]
        #expect(!general.contains("ProviderEnvironmentSettingsView()"))
        #expect(!general.contains("FoundationModelSettingsView("))
        #expect(!general.contains("终端选项解析"))
        #expect(contents.contains("TaskCreationDefaultsSettingsView("))
        #expect(contents.contains("draft: Binding("))
        #expect(!contents.contains("Text(L10n(\"Codex Backend\"))"))
        #expect(!contents.contains("DisclosureGroup(\"终端选项解析"))
        #expect(contents.contains("sessionCreationDefaults: sessionCreationDraft"))
        let mobileSource = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ipad/Sources/PadAppShell.swift")
        let mobile = try String(contentsOf: mobileSource, encoding: .utf8)
        #expect(mobile.contains("case .provider:"))
        #expect(mobile.contains("TaskCreationDefaultsSettingsView("))
        #expect(mobile.contains("api.saveTaskCreationSettings(value)"))
    }

    @Test func everySettingsEntryRoutesToTheResidentMainWindowPage() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/CopetsMac")
        let delegate = try String(contentsOf: sources.appendingPathComponent("Application/AppDelegate.swift"), encoding: .utf8)
        let route = delegate.components(separatedBy: "@objc func openSettings() {")[1]
            .components(separatedBy: "@objc private func openCollaboration")[0]
        #expect(route.contains("AppTabRouter.shared.selectTab(.settings)"))
        #expect(route.contains("openWarRoom()"))
        #expect(!route.contains("NSWindow("))
        #expect(!delegate.contains("settingsWindow"))
        let app = try String(contentsOf: sources.appendingPathComponent("CopetsMacApp.swift"), encoding: .utf8)
        #expect(app.contains("CommandGroup(replacing: .appSettings)"))
        #expect(app.contains(".keyboardShortcut(\",\", modifiers: .command)"))
        #expect(!app.contains("SettingsView()"))
        let router = AppTabRouter()
        router.selectTab(.settings)
        #expect(router.selectedTab == .settings)
        #expect(router.sidebarState(for: .settings).isSelected)
        router.selectTab(.console)
        #expect(!router.sidebarState(for: .settings).isSelected)
        var pages: [AppTab: NSView] = [:]
        let container = MainTabPageContainer(animationDuration: 0) { tab in
            let page = NSView()
            pages[tab] = page
            return page
        }
        container.frame = NSRect(x: 0, y: 0, width: 1000, height: 700)
        container.select(.settings, animated: false)
        let settingsPage = try #require(pages[.settings])
        settingsPage.identifier = .init("unsaved-draft")
        container.select(.console, animated: false)
        container.select(.settings, animated: false)
        #expect(pages[.settings] === settingsPage)
        #expect(pages[.settings]?.identifier?.rawValue == "unsaved-draft")
        #expect(container.cachedPageCount == 2)
    }

    @Test func providerSettingsSeparateSharedModelsFromProviderSpecificGroups() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/CopetsMac")
        let settings = try String(contentsOf: sources.appendingPathComponent("Settings/SettingsView.swift"), encoding: .utf8)
        let page = settings.components(separatedBy: "private var providerSettingsTab: some View {")[1]
            .components(separatedBy: "private var archivedSessionsTab")[0]
        let sharedModels = try #require(page.range(of: "TaskCreationDefaultsSettingsView("))
        let backgroundModels = try #require(page.range(of: "FoundationModelSettingsView("))
        let providerGroups = try #require(page.range(of: "ProviderEnvironmentSettingsView("))
        #expect(page.contains("共用配置"))
        #expect(page.components(separatedBy: "GroupBox {").count == 3)
        #expect(sharedModels.lowerBound < backgroundModels.lowerBound)
        #expect(backgroundModels.lowerBound < providerGroups.lowerBound)
        #expect(page.contains("draft: Binding("))

        let firstRun = try String(contentsOf: sources.appendingPathComponent("FirstRunSetupView.swift"), encoding: .utf8)
        let groups = firstRun.components(separatedBy: "struct ProviderEnvironmentSettingsView: View {")[1]
        #expect(groups.contains("Provider 专属配置"))
        #expect(groups.contains("ForEach(status.providers)"))
        #expect(!groups.contains(".filter"))
        #expect(groups.contains("FirstRunProviderCard(provider: provider"))
        #expect(groups.contains("allowsAutomaticChecks: false"))
        #expect(firstRun.contains("guard allowsAutomaticChecks || checkGeneration > 0 else { return }"))
        #expect(!groups.contains("TaskCreationDefaultsSettingsView"))
    }
}
