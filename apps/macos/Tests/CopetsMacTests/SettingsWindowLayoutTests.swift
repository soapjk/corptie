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
            .appearance,
            .notifications,
            .memory,
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

        for route in ["general", "appearance", "notifications", "memory", "proxy", "gateway", "devices", "archivedSessions"] {
            #expect(contents.contains("case .\(route):"))
        }
        #expect(contents.contains("LocalWallpaperSettingsView()"))
        #expect(contents.contains("ForEach(SettingsTab.allCases"))
        #expect(contents.contains("selectedTab = tab"))
        #expect(!contents.contains(".tabItem"))
        #expect(contents.contains("if selectedTab == .archivedSessions || selectedTab == .notifications || selectedTab == .memory"))
        #expect(contents.contains("Button(L10n(\"Close\"))"))
        #expect(contents.contains("Button(L10n(\"Save\"))"))
        #expect(contents.contains("await saveAllSettings()"))
    }
}
