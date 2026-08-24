import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct MainTabNotificationIsolationTests {
    @Test
    func notificationRendererUsesAnIndependentSurfaceWithLeafOwnedState() throws {
        let source = try mainTabSource()
        let contentSurface = try sourceSlice(
            source,
            from: "struct MainWindowContentView: View {",
            through: "struct MainWindowFixedChromeView: View {"
        )
        let taskSurface = try sourceSlice(
            source,
            from: "struct MainWindowTaskSurfaceView: View {",
            through: "private struct MainWindowChromeControls: View {"
        )
        let notification = try sourceSlice(
            source,
            from: "private struct MainWindowBackgroundTaskOverlay: View {",
            through: "// 跨 Tab 导航路由器"
        )

        #expect(!contentSurface.contains("MainWindowBackgroundTaskOverlay()"))
        #expect(taskSurface.contains("MainWindowBackgroundTaskOverlay()"))
        #expect(!contentSurface.contains("@StateObject private var backgroundTasks"))
        #expect(!contentSurface.contains("@StateObject private var backendClient"))
        #expect(!contentSurface.contains("@StateObject private var entityClient"))
        #expect(notification.contains("@StateObject private var backgroundTasks"))
        #expect(notification.contains("@StateObject private var backendClient"))
        #expect(notification.contains("@StateObject private var entityClient"))
    }

    @Test
    func tabHeaderContainerDoesNotContainNotificationRendering() throws {
        let source = try mainTabSource()
        let tabSurface = try sourceSlice(
            source,
            from: "struct MainWindowTabBarSurfaceView: View {",
            through: "struct MainWindowTaskSurfaceView: View {"
        )

        #expect(tabSurface.contains("UnderlineTabBar(selection:"))
        #expect(!tabSurface.contains("BackgroundTaskStatusBar"))
        #expect(!tabSurface.contains("backgroundTasks.records"))
        #expect(!tabSurface.contains("Connecting to the server…"))
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
