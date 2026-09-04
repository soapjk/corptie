import Foundation
import Testing
@testable import CorptieMac

struct SessionRestartInteractionTests {
    @Test
    func selectedTaskContextMenuUsesTaskOperationsOnly() throws {
        let source = try contents(of: "UnifiedConsoleView.swift")
        let rowStart = try #require(source.range(of: "private func taskRow(_ task: CorptieTask)"))
        let rowEnd = try #require(source.range(
            of: "private func restartTask(_ task: CorptieTask)",
            range: rowStart.upperBound..<source.endIndex
        ))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(row.contains("taskPendingRename = task"))
        #expect(row.contains("taskPendingEdit = task"))
        #expect(row.contains("restartTask(task)"))
        #expect(row.contains("prepareTaskDeletion(task)"))
        #expect(!row.contains("SessionContextMenuContent("))
        #expect(row.components(separatedBy: "systemImage: \"trash\"").count - 1 == 1)
        #expect(source.contains("restartCorptieTask(taskId: task.id)"))
    }

    @Test
    func taskChatHeaderUsesTaskTitleAsItsCanonicalName() throws {
        let source = try contents(of: "FloatingRootView.swift")
        let headerStart = try #require(source.range(of: "struct DetailHeaderView: View"))
        let header = source[headerStart.lowerBound...]

        #expect(header.contains("let task = entityClient.tasks.first(where: { $0.id == taskID })"))
        #expect(header.contains("return task.title"))
        #expect(header.contains("Text(selectedTitle)"))
        #expect(header.contains("copySessionTitle(selectedTitle)"))
    }

    @Test
    func selectedSessionHeaderMenuOnlyOpensTheWorkspaceAndHidesItsIndicator() throws {
        let source = try contents(of: "FloatingRootView.swift")
        let headerStart = try #require(source.range(of: "struct DetailHeaderView: View"))
        let menuEnd = try #require(source.range(of: ".accessibilityIdentifier(\"session.detail.actions\")"))
        let menuStart = try #require(source.range(
            of: "if backendClient.selectedSession != nil {",
            range: headerStart.upperBound..<menuEnd.lowerBound
        ))
        let menu = source[menuStart.lowerBound..<menuEnd.upperBound]

        #expect(menu.contains("Button(action: openWorkspaceInVSCode)"))
        #expect(menu.contains("Button(action: openWorkspaceInFinder)"))
        #expect(menu.contains(".menuIndicator(.hidden)"))
        #expect(!menu.contains("SessionContextMenuContent("))
    }

    @Test
    func selectedSessionHeaderHidesOrdinaryWorkspaceContinuationState() throws {
        let source = try contents(of: "FloatingRootView.swift")

        #expect(!source.contains("Continuing after Worktree switch"))
        #expect(source.contains("Worktree continuation failed"))
    }

    @Test
    func sessionsTabSidebarExposesRestartThroughTheSharedContextMenu() throws {
        let sessionsSource = try contents(of: "UnifiedConsoleView.swift")
        let rowStart = try #require(sessionsSource.range(of: "private struct SessionsSidebarRow: View"))
        let rowEnd = try #require(sessionsSource.range(
            of: "func sessionMatchingPendingSelection",
            range: rowStart.upperBound..<sessionsSource.endIndex
        ))
        let row = sessionsSource[rowStart.lowerBound..<rowEnd.lowerBound]
        let sharedSource = try contents(of: "FloatingRootView.swift")
        let sharedStart = try #require(sharedSource.range(of: "struct CompactSessionRow: View"))
        let sharedEnd = try #require(sharedSource.range(
            of: "private struct SessionIdentityLine: View",
            range: sharedStart.upperBound..<sharedSource.endIndex
        ))
        let sharedRow = sharedSource[sharedStart.lowerBound..<sharedEnd.lowerBound]

        #expect(row.contains("CompactSessionRow("))
        #expect(sharedRow.contains(".contextMenu"))
        #expect(sharedRow.contains("SessionContextMenuContent(session: session"))
    }

    @Test
    func restartRemainsDiscoverableWhenTemporarilyUnavailable() throws {
        let source = try contents(of: "FloatingRootView.swift")
        let menuStart = try #require(source.range(of: "struct SessionContextMenuContent: View"))
        let menuEnd = try #require(source.range(
            of: "private struct LiquidGlassControlBackground: View",
            range: menuStart.upperBound..<source.endIndex
        ))
        let menu = source[menuStart.lowerBound..<menuEnd.lowerBound]

        #expect(menu.contains("Label(L10n(\"Restart Session\")"))
        #expect(menu.contains("session.actions?.restart?.available != true"))
        #expect(!menu.contains("if session.actions?.restart?.available == true"))
    }

    @Test
    func restartRequestCarriesAStableOperationKeyAndSurfacesFailures() throws {
        let source = try contents(of: "BackendClient.swift")
        let restartStart = try #require(source.range(of: "func restart(session: TaskSession)"))
        let restartEnd = try #require(source.range(
            of: "func switchProvider(session:",
            range: restartStart.upperBound..<source.endIndex
        ))
        let restart = source[restartStart.lowerBound..<restartEnd.lowerBound]

        #expect(restart.contains("\"idempotencyKey\": \"session-restart:"))
        #expect(restart.contains("failRestartActivity(for: session.id)"))
        #expect(restart.contains("Restart failed: %@"))
    }

    private func contents(of fileName: String) throws -> String {
        let sourceRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac")
        return try String(
            contentsOf: sourceRoot.appendingPathComponent(fileName),
            encoding: .utf8
        )
    }
}
