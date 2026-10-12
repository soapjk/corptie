import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct SettingsWindowLayoutTests {
    @Test
    func settingsContentIsWideEnoughForEveryVisibleTab() {
        let minimumUsableTabWidth: CGFloat = 96
        let horizontalPadding: CGFloat = 40
        let interTabSpacing: CGFloat = 8

        #expect(SettingsTab.allCases.count == 8)
        #expect(
            SettingsWindowLayout.contentSize.width
                >= CGFloat(SettingsTab.allCases.count) * minimumUsableTabWidth
                    + CGFloat(SettingsTab.allCases.count - 1) * interTabSpacing + horizontalPadding
        )
    }

    @Test
    func settingsViewUsesOneStableSizeAcrossTabRoutes() {
        let hostingView = NSHostingView(rootView: SettingsView())

        #expect(hostingView.fittingSize.width == SettingsWindowLayout.contentSize.width)
        #expect(hostingView.fittingSize.height == SettingsWindowLayout.contentSize.height)
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
        #expect(contents.contains("if selectedTab == .archivedSessions || selectedTab == .notifications"))
        #expect(contents.contains("Button(L10n(\"Close\"))"))
        #expect(contents.contains("Button(L10n(\"Save\"))"))
        #expect(contents.contains("await saveAllSettings()"))
        let general = contents.components(separatedBy: "private var generalSettingsTab")[1]
            .components(separatedBy: "private var providerSettingsTab")[0]
        #expect(!general.contains("ProviderEnvironmentSettingsView()"))
        #expect(!general.contains("FoundationModelSettingsView("))
        #expect(!general.contains("终端选项解析"))
        #expect(contents.contains("TaskCreationDefaultsSettingsView("))
        let mobileSource = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("ipad/Sources/PadAppShell.swift")
        let mobile = try String(contentsOf: mobileSource, encoding: .utf8)
        #expect(mobile.contains("case .provider:"))
        #expect(mobile.contains("TaskCreationDefaultsSettingsView("))
        #expect(mobile.contains("api.saveTaskCreationSettings(value)"))
    }
}
