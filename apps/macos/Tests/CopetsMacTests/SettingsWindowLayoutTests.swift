import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@MainActor
struct SettingsWindowLayoutTests {
    @Test
    func settingsContentIsWideEnoughForEveryVisibleTab() {
        let minimumUsableTabWidth: CGFloat = 120
        let horizontalPadding: CGFloat = 40

        #expect(SettingsTab.allCases.count == 6)
        #expect(
            SettingsWindowLayout.contentSize.width
                >= CGFloat(SettingsTab.allCases.count) * minimumUsableTabWidth + horizontalPadding
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
            .notifications,
            .memory,
            .proxy,
            .gateway,
            .archivedSessions,
        ])

        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/CopetsMacApp.swift")
        let contents = try String(contentsOf: source, encoding: .utf8)

        for route in ["general", "notifications", "memory", "proxy", "gateway", "archivedSessions"] {
            #expect(contents.contains("case .\(route):"))
        }
        #expect(contents.contains("ForEach(SettingsTab.allCases"))
        #expect(contents.contains("selectedTab = tab"))
        #expect(!contents.contains(".tabItem"))
        #expect(contents.contains("if selectedTab == .archivedSessions || selectedTab == .notifications || selectedTab == .memory"))
        #expect(contents.contains("Button(L10n(\"Close\"))"))
        #expect(contents.contains("Button(L10n(\"Save\"))"))
        #expect(contents.contains("await saveAllSettings()"))
    }
}
