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
    func sessionHeaderUsesDisplayedSessionTitle() throws {
        let source = try contents(of: "Conversation/ConversationHeader.swift")
        let headerStart = try #require(source.range(of: "struct DetailHeaderView: View"))
        let header = source[headerStart.lowerBound...]

        #expect(header.contains("let session: TaskSession?"))
        #expect(header.contains("Self.displayTitle(session: session, workName: workName)"))
        #expect(header.contains("return session.title"))
        #expect(!header.contains("backendClient.selectedSession?.title"))
        #expect(try contents(of: "Conversation/SessionConversationContent.swift")
            .contains("DetailHeaderView(session: selectedSession, historicalWorkspacePath: displayedDetail?.cwd)"))
        #expect(header.contains("Text(selectedTitle)"))
        #expect(header.contains("copySessionTitle(selectedTitle)"))
        #expect(header.contains("copyConfirmation(visible: didCopySessionTitle)"))
        #expect(header.contains("copyConfirmation(visible: didCopyWorkspacePath)"))
        #expect(!header.contains("Label(L10n(\"Copied\"), systemImage: \"checkmark\")"))
        #expect(!header.contains(".transition(.opacity.combined(with: .scale"))
    }

    @Test
    func sessionHeaderHidesGitHubPushEntryButKeepsOtherActions() throws {
        let source = try contents(of: "Conversation/ConversationHeader.swift")
        #expect(!source.contains("GitHubPushButtonVisual"))
        #expect(!source.contains("prepareGitHubPush()"))
        #expect(!source.contains("Commit and Push to GitHub"))
        #expect(source.contains("case manageWorktrees"))
        #expect(source.contains("case reconnect"))
    }

    @Test
    func sessionHeaderKeepsProviderPathAndWorktreeBelowTheTitle() throws {
        let source = try contents(of: "Conversation/ConversationHeader.swift")
        let rowStart = try #require(source.range(of: "private var headerControlRow: some View"))
        let rowEnd = try #require(source.range(of: "private var selectedTitle:", range: rowStart.upperBound..<source.endIndex))
        let row = source[rowStart.lowerBound..<rowEnd.lowerBound]

        #expect(source.contains("GlassEffectContainer(spacing: 6)"))
        #expect(row.contains("headerIdentityCapsule"))
        // Keep the title close to the path/worktree metadata line: two rows
        // only, so the capsule has a constant height that fits the pinned
        // header accessory. Badges ride along the title row instead of adding
        // a third row that would clip the path line.
        #expect(row.contains("VStack(alignment: .leading, spacing: 2)"))
        #expect(row.contains("if showsHistoricalThread {"))
        #expect(row.contains("} else if showsContinuationFailure {"))
        #expect(!row.contains("HStack(alignment: .firstTextBaseline, spacing: 6)"))
        // The title box hugs its 14pt text; do not restore the old 28pt
        // control-height box that made the whole header look thick.
        #expect(row.contains(".frame(height: 20)"))
        #expect(!row.contains(".frame(height: 28)"))
        #expect(row.contains(".multilineTextAlignment(.leading)"))
        #expect(row.contains("SessionHeaderProviderIdentity(session: selectedSession, providers: providers)"))
        #expect(row.contains(".foregroundStyle(.primary)"))
        #expect(row.contains("if let cwd = workspacePath"))
        #expect(!row.contains("gitHeadState.stampText"))
        #expect(!row.contains("GitBranchStamp(headState: gitHeadState)"))
        #expect(!row.contains("Label(L10n(\"Context handoff\")"))
        #expect(row.contains("ProjectServiceStatusDot(status: status.service)"))
        #expect(row.contains("if hasWorktreeTarget {\n                    headerActionButton(.manageWorktrees)"))
        #expect(!source.contains("shouldSuggestWorktreeManagement"))
        #expect(source.contains("session?.external?.workspace?.repositoryId != nil || displayedProjectStatus != nil"))
        #expect(source.contains(".accessibilityIdentifier(\"session.detail.worktree\")"))
        #expect(row.contains(".accessibilityIdentifier(\"session.detail.detach\")"))
        #expect(row.contains(".accessibilityIdentifier(\"session.detail.actions\")"))
        #expect(row.contains(".accessibilityIdentifier(\"session.detail.toggle-column\")"))
        #expect(row.contains("visibility.wrappedValue.toggle()"))
        #expect(row.contains(".menuStyle(.borderlessButton)"))
        #expect(row.contains(".menuIndicator(.hidden)"))
        #expect(!row.contains(".conversationGlassControl()"))
    }

    @Test
    func selectedSessionHeaderMenuOnlyOpensTheWorkspaceAndHidesItsIndicator() throws {
        let source = try contents(of: "Conversation/ConversationHeader.swift")
        let headerStart = try #require(source.range(of: "struct DetailHeaderView: View"))
        let menuEnd = try #require(source.range(of: ".accessibilityIdentifier(\"session.detail.actions\")"))
        let menuStart = try #require(source.range(
            of: "if session != nil {",
            range: headerStart.upperBound..<menuEnd.lowerBound
        ))
        let menu = source[menuStart.lowerBound..<menuEnd.upperBound]

        #expect(menu.contains("headerActionMenu"))
        #expect(source.components(separatedBy: "Button(action: openWorkspaceInVSCode)").count - 1 == 1)
        #expect(source.components(separatedBy: "Button(action: openWorkspaceInFinder)").count - 1 == 1)
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
