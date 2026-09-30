import Foundation
import Testing
@testable import CorptieMac

struct SessionRestartInteractionTests {
    @Test
    func selectedTaskContextMenuUsesTaskOperationsOnly() throws {
        let source = try contents(of: "Console/UnifiedConsoleWorkTaskList.swift")
        let menuStart = try #require(source.range(of: "func taskContextMenuContent("))
        let row = source[menuStart.lowerBound...]

        #expect(row.contains("taskPendingRename = task"))
        #expect(row.contains("taskPendingEdit = task"))
        #expect(row.contains("restartTask(task)"))
        #expect(row.contains("prepareTaskDeletion(task)"))
        #expect(!row.contains("SessionContextMenuContent("))
        #expect(row.components(separatedBy: "systemImage: \"trash\"").count - 1 == 1)
        #expect(try contents(of: "Console/UnifiedConsoleTaskActions.swift").contains("restartCorptieTask(taskId: task.id)"))
    }

    @Test
    func sessionHeaderUsesSelectedSessionTitle() throws {
        let source = try contents(of: "Conversation/ConversationHeader.swift")
        let headerStart = try #require(source.range(of: "struct DetailHeaderView: View"))
        let header = source[headerStart.lowerBound...]

        #expect(header.contains("backendClient.selectedSession?.title"))
        #expect(header.contains("Text(selectedTitle)"))
        #expect(header.contains("copySessionTitle(selectedTitle)"))
    }

    @Test
    func sessionHeaderGroupsMetadataInOneGlassCapsuleAndKeepsActionsSeparate() throws {
        let source = try contents(of: "Conversation/ConversationHeader.swift")
        let rowStart = try #require(source.range(of: "private var headerControlRow: some View"))
        let rowEnd = try #require(source.range(of: "private var selectedTitle:", range: rowStart.upperBound..<source.endIndex))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(source.contains("GlassEffectContainer(spacing: 6)"))
        #expect(row.contains("headerIdentityCapsule"))
        #expect(row.components(separatedBy: ".frame(width: 66, alignment:").count - 1 == 2)
        #expect(row.contains("VStack(alignment: .center, spacing: 3)"))
        #expect(row.contains(".multilineTextAlignment(.center)"))
        #expect(row.contains(".platformGlassSurface(in: Capsule())"))
        #expect(row.contains("SessionProviderIdentity(session: selectedSession, prominentText: true)"))
        #expect(row.contains(".foregroundStyle(.primary)"))
        #expect(row.contains("if let cwd = workspacePath"))
        #expect(row.contains("gitHeadState.stampText"))
        #expect(row.contains("GitBranchStamp(headState: gitHeadState)"))
        #expect(row.contains("ProjectServiceStatusDot(status: status.service)"))
        #expect(row.components(separatedBy: ".platformGlassSurface(in: Circle(), interactive: true)").count - 1 >= 2)
        #expect(row.contains(".accessibilityIdentifier(\"session.detail.detach\")"))
        #expect(row.contains(".accessibilityIdentifier(\"session.detail.actions\")"))
        let menu = try #require(row.range(of: "Menu {"))
        let menuGlass = try #require(row.range(of: ".platformGlassSurface(in: Circle(), interactive: true)", range: menu.upperBound..<row.endIndex))
        #expect(menu.upperBound < menuGlass.lowerBound)
        #expect(!row.contains(".conversationGlassControl()"))
    }

    @Test
    func selectedSessionHeaderMenuOnlyOpensTheWorkspaceAndHidesItsIndicator() throws {
        let source = try contents(of: "Conversation/ConversationHeader.swift")
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
        let source = try contents(of: "Conversation/ConversationHeader.swift")

        #expect(!source.contains("Continuing after Worktree switch"))
        #expect(source.contains("Worktree continuation failed"))
    }

    @Test
    func sessionsTabSidebarExposesRestartThroughTheSharedContextMenu() throws {
        let sessionsSource = try contents(of: "Console/ConsoleSessionRows.swift")
        let rowStart = try #require(sessionsSource.range(of: "struct ConsoleSessionRow: View"))
        let rowEnd = try #require(sessionsSource.range(
            of: "func sessionMatchingPendingSelection",
            range: rowStart.upperBound..<sessionsSource.endIndex
        ))
        let row = sessionsSource[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(row.contains(".contextMenu"))
        #expect(row.contains("SessionContextMenuContent(session: session"))
    }

    @Test
    func restartRemainsDiscoverableWhenTemporarilyUnavailable() throws {
        let source = try contents(of: "Floating/SessionList/SessionListRows.swift")
        let menuStart = try #require(source.range(of: "struct SessionContextMenuContent: View"))
        let menu = source[menuStart.lowerBound...]

        #expect(menu.contains("Label(L10n(\"Restart Session\")"))
        #expect(menu.contains("session.actions?.restart?.available != true"))
        #expect(!menu.contains("if session.actions?.restart?.available == true"))
    }

    @Test
    func restartRequestCarriesAStableOperationKeyAndSurfacesFailures() throws {
        let backendSource = try contents(of: "Backend/SessionLifecycleController.swift")
        let restartStart = try #require(backendSource.range(of: "func restart(session: TaskSession)"))
        let restartEnd = try #require(backendSource.range(
            of: "func switchProvider(session:",
            range: restartStart.upperBound..<backendSource.endIndex
        ))
        let restart = backendSource[restartStart.lowerBound..<restartEnd.lowerBound]

        #expect(restart.contains("\"idempotencyKey\": \"session-restart:"))
        #expect(restart.contains("failRestartActivity(for: session.id)"))
        #expect(restart.contains("Restart failed: %@"))

        let consoleSource = try contents(of: "Console/UnifiedConsoleTaskActions.swift")
        let taskRestartStart = try #require(consoleSource.range(of: "func restartTask(_ task: CorptieTask)"))
        let taskRestartEnd = try #require(consoleSource.range(
            of: "func prepareTaskChat(",
            range: taskRestartStart.upperBound..<consoleSource.endIndex
        ))
        let taskRestart = consoleSource[taskRestartStart.lowerBound..<taskRestartEnd.lowerBound]
        #expect(taskRestart.contains("guard await entityClient.restartCorptieTask"))
        #expect(taskRestart.contains("taskRestartError = entityClient.errorMessage"))
    }

    @Test
    func providerSwitchReconcilesAndRetriesAStaleRouteExactlyOnce() throws {
        let source = try contents(of: "Backend/SessionLifecycleController.swift")
        let start = try #require(source.range(of: "func switchProvider(session: TaskSession"))
        let end = try #require(source.range(
            of: "private func beginRestartActivity",
            range: start.upperBound..<source.endIndex
        ))
        let providerSwitch = source[start.lowerBound..<end.lowerBound]

        #expect(providerSwitch.contains("retryOnStaleRoute: true"))
        #expect(providerSwitch.contains("failure?.code == \"STALE_SESSION_ROUTE\""))
        #expect(providerSwitch.contains("acceptRoute(current)"))
        #expect(providerSwitch.contains("retryOnStaleRoute: false"))
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
