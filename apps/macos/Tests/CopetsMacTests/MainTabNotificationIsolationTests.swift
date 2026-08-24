import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct MainTabNotificationIsolationTests {
    @Test
    func notificationRendererIsAnOverlayWithLeafOwnedState() throws {
        let source = try mainTabSource()
        let mainTab = try sourceSlice(
            source,
            from: "struct MainTabView: View {",
            through: "private struct MainWindowBackgroundTaskOverlay: View {"
        )
        let notification = try sourceSlice(
            source,
            from: "private struct MainWindowBackgroundTaskOverlay: View {",
            through: "// 跨 Tab 导航路由器"
        )

        #expect(mainTab.contains(".overlay(alignment: .topTrailing)"))
        #expect(mainTab.contains("MainWindowBackgroundTaskOverlay()"))
        #expect(!mainTab.contains("@StateObject private var backgroundTasks"))
        #expect(!mainTab.contains("@StateObject private var backendClient"))
        #expect(!mainTab.contains("@StateObject private var entityClient"))
        #expect(notification.contains("@StateObject private var backgroundTasks"))
        #expect(notification.contains("@StateObject private var backendClient"))
        #expect(notification.contains("@StateObject private var entityClient"))
    }

    @Test
    func tabHeaderContainerDoesNotContainNotificationRendering() throws {
        let source = try mainTabSource()
        let mainTab = try sourceSlice(
            source,
            from: "struct MainTabView: View {",
            through: "private struct MainWindowBackgroundTaskOverlay: View {"
        )
        let body = try sourceSlice(
            String(mainTab),
            from: "var body: some View {",
            through: ".overlay(alignment: .topTrailing)"
        )

        #expect(body.contains("UnderlineTabBar(selection:"))
        #expect(!body.contains("BackgroundTaskStatusBar"))
        #expect(!body.contains("backgroundTasks.records"))
        #expect(!body.contains("Connecting to the server…"))
    }

    @Test
    func tabSelectionPublishesOnlyThroughSelectionAndPerTabActivationState() {
        let router = AppTabRouter()

        #expect(router.selectedTab == .console)
        #expect(router.sidebarState(for: .console).isSelected)
        router.selectTab(.agents)
        #expect(router.selectedTab == .agents)
        #expect(!router.sidebarState(for: .console).isSelected)
        #expect(router.sidebarState(for: .agents).isSelected)

        router.selectTab(.sessions)
        #expect(router.selectedTab == .sessions)
        #expect(!router.sidebarState(for: .agents).isSelected)
        #expect(router.sidebarState(for: .sessions).isSelected)

        router.selectTab(.sessions)
        #expect(router.selectedTab == .sessions)
        #expect(router.sidebarState(for: .sessions).isSelected)
        for tab in AppTab.allCases where tab != .sessions {
            #expect(!router.sidebarState(for: tab).isSelected)
        }
    }

    private func mainTabSource() throws -> String {
        let source = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/MainTabView.swift")
        return try String(contentsOf: source, encoding: .utf8)
    }

    private func sourceSlice(
        _ source: String,
        from startMarker: String,
        through endMarker: String
    ) throws -> Substring {
        let start = try #require(source.range(of: startMarker)?.lowerBound)
        let end = try #require(source.range(of: endMarker, range: start..<source.endIndex)?.lowerBound)
        return source[start..<end]
    }
}
