import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct DetailHeaderView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var entityClient = EntityAPIClient.shared
    @ObservedObject private var supplementaryData = BackendClient.shared.supplementaryDataController
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    @ObservedObject private var gitHubPushState = BackendClient.shared.gitHubPushController
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    @State private var didCopySessionTitle = false
    @State private var sessionTitleCopyFeedbackTask: Task<Void, Never>?
    @State private var didCopyWorkspacePath = false
    @State private var gitHeadState: GitHeadState?

    var body: some View {
        HStack(spacing: 10) {
            if isLiquidGlass {
                Button {
                    withAnimation(.easeOut(duration: 0.16)) {
                        backendClient.closeDetail()
                    }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 13, weight: .bold))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(IconButtonStyle())
                .help(L10n("Back to task list"))
            }

            VStack(alignment: .leading, spacing: 2) {
                if !isLiquidGlass, let selectedTitle {
                    HStack(spacing: 7) {
                        Button {
                            copySessionTitle(selectedTitle)
                        } label: {
                            Text(selectedTitle)
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(1)
                                .truncationMode(.tail)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(L10n("Click to copy Session title"))
                        .accessibilityLabel(L10n("Copy Session title"))

                        if didCopySessionTitle {
                            Label(L10n("Copied"), systemImage: "checkmark")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(CorptiePalette.connected)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 3)
                                .background(CorptiePalette.connected.opacity(0.10), in: Capsule())
                                .transition(.opacity.combined(with: .scale(scale: 0.94)))
                                .accessibilityHidden(true)
                        }
                    }
                }
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if backendClient.viewingHistoricalThreadId != nil {
                        Label(L10n("Read-only history"), systemImage: "clock.arrow.circlepath")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.orange)
                    } else if backendClient.selectedSession?.external?.workspace?.continuationState == "failed" {
                        Label(L10n("Worktree continuation failed"), systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.orange)
                    } else if backendClient.selectedSession?.external?.workspace?.transitionStrategy == "handoff" {
                        Label(L10n("Context handoff"), systemImage: "arrow.triangle.branch")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                }
                if let cwd = workspacePath, !cwd.isEmpty {
                    HStack(alignment: .center, spacing: 6) {
                        if let selectedSession = backendClient.selectedSession {
                            SessionProviderIdentity(session: selectedSession)
                                .font(.system(size: 11, weight: .semibold))
                        }

                        Button(action: copyWorkspacePath) {
                            HStack(spacing: 4) {
                                Text(projectName ?? URL(fileURLWithPath: cwd).lastPathComponent)
                                    .lineLimit(1)
                                if didCopyWorkspacePath {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundStyle(CorptiePalette.connected)
                                        .transition(.opacity.combined(with: .scale))
                                }
                            }
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(L10nFormat("Copy full workspace path: %@", cwd))

                        if let gitHeadState,
                           gitHeadState.stampText != nil {
                            Button {
                                openWorktreeManagement()
                            } label: {
                                GitBranchStamp(headState: gitHeadState)
                            }
                            .buttonStyle(.plain)
                            .help(L10n("Manage project worktrees and service"))
                            .accessibilityLabel(L10n("Manage project worktrees and service"))
                        }
                    }
                } else {
                    Text(backendClient.selectedSession?.summary ?? "")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .lineLimit(1)
                }
            }

            Spacer()

            if let action = primaryHeaderAction {
                headerActionButton(action)
                    .contextMenu {
                        headerActionMenu
                    }
            }

            if let status = supplementaryData.selectedProjectWorktreeStatus {
                ProjectServiceStatusDot(status: status.service)
                    .help(projectServiceStatusHelp(status))
            }

            if backendClient.selectedSession != nil {
                if let session = backendClient.selectedSession {
                    SessionHeaderStopButton(session: session)
                }

                Button {
                    guard let session = backendClient.selectedSession else { return }
                    DetachedChatWindowManager.shared.show(session: session)
                } label: {
                    Image(systemName: "macwindow.on.rectangle")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 28, height: 28)
                        .conversationGlassControl()
                }
                .buttonStyle(.plain)
                .help(L10n("Open chat in floating window"))
                .accessibilityLabel(L10n("Open chat in floating window"))
                .accessibilityIdentifier("session.detail.detach")

                Menu {
                    Button(action: openWorkspaceInVSCode) {
                        Label(
                            L10n("Open in Visual Studio Code"),
                            systemImage: "chevron.left.forwardslash.chevron.right"
                        )
                    }
                    .disabled(workspacePath == nil)

                    Button(action: openWorkspaceInFinder) {
                        Label(L10n("Open in Finder"), systemImage: "folder")
                    }
                    .disabled(workspacePath == nil)
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: 13, weight: .semibold))
                        .frame(width: 28, height: 28)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help(L10n("Open workspace"))
                .accessibilityLabel(L10n("Open workspace"))
                .accessibilityIdentifier("session.detail.actions")

            }
        }
        .task(id: workspaceRouteIdentity) {
            await refreshGitBranch()
        }
        .onChange(of: backendClient.gitHubPushPreparation) { _, preparation in
            if let preparation {
                GitHubPushConfirmationWindowManager.shared.show(
                    preparation: preparation,
                    backendClient: backendClient
                )
            } else {
                GitHubPushConfirmationWindowManager.shared.close()
            }
        }
        .onChange(of: backendClient.selectedSession?.id) { _, _ in
            sessionTitleCopyFeedbackTask?.cancel()
            sessionTitleCopyFeedbackTask = nil
            didCopySessionTitle = false
        }
        .onDisappear {
            sessionTitleCopyFeedbackTask?.cancel()
            sessionTitleCopyFeedbackTask = nil
        }
    }

    private var selectedTitle: String? {
        backendClient.selectedSession?.title
    }

    private var selectedSessionWorktree: ProjectWorktreeStatus? {
        guard let sessionId = backendClient.selectedSession?.id,
              let status = supplementaryData.selectedProjectWorktreeStatus else { return nil }
        if let bound = status.project.worktrees.first(where: { worktree in
            worktree.sessions.contains(where: { $0.sessionId == sessionId })
        }) {
            return bound
        }
        guard let workspacePath else { return nil }
        let normalized = URL(fileURLWithPath: workspacePath).standardizedFileURL.path
        return status.project.worktrees.first {
            URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
        }
    }

    private enum HeaderAction {
        case returnToActiveThread
        case reconnect
        case gitHubPush
        case manageWorktrees
    }

    private var primaryHeaderAction: HeaderAction? {
        if backendClient.viewingHistoricalThreadId != nil {
            return .returnToActiveThread
        }
        if canReconnectSelectedSession {
            return .reconnect
        }
        if backendClient.isSelectedSessionPushingGitHub {
            return .gitHubPush
        }
        if gitHubPushHasPendingChanges, selectedSessionWorktree != nil {
            return .gitHubPush
        }
        if shouldSuggestWorktreeManagement {
            return .manageWorktrees
        }
        return nil
    }

    private var canReconnectSelectedSession: Bool {
        backendClient.selectedSession?.canResumeNow == true
            && backendClient.selectedSession?.isConnected == false
    }

    private var shouldSuggestWorktreeManagement: Bool {
        guard let project = supplementaryData.selectedProjectWorktreeStatus?.project else { return false }
        return project.pendingWorktreeCount > 0 || project.worktrees.contains { worktree in
            worktree.availability != "available"
                || worktree.dirty == true
                || worktree.pendingIntegration
                || (worktree.behindMain ?? 0) > 0
        }
    }

    @ViewBuilder
    private func headerActionButton(_ action: HeaderAction) -> some View {
        switch action {
        case .returnToActiveThread:
            Button {
                backendClient.returnToActiveThread()
            } label: {
                Label(L10n("Active thread"), systemImage: "arrow.forward.circle")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help(L10n("Return to the active workspace thread"))
        case .reconnect:
            Button {
                backendClient.reconnectSelectedSession()
            } label: {
                Image(systemName: "link")
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(IconButtonStyle())
            .help(L10n("Reconnect session"))
        case .gitHubPush:
            let worktree = selectedSessionWorktree
            let color = gitHubButtonColor(worktree)
            if backendClient.isSelectedSessionPushingGitHub {
                GitHubPushButtonVisual(color: color, state: .pushing)
                    .help(gitHubPushButtonHelp(worktree))
            } else {
                Button {
                    backendClient.prepareGitHubPush()
                } label: {
                    GitHubPushButtonVisual(
                        color: color,
                        state: backendClient.isPreparingGitHubPush ? .preparing : .ready
                    )
                }
                .buttonStyle(.plain)
                .disabled(
                    backendClient.isPreparingGitHubPush || backendClient.isPushingGitHub
                )
                .help(gitHubPushButtonHelp(worktree))
            }
        case .manageWorktrees:
            if let status = supplementaryData.selectedProjectWorktreeStatus {
                Button {
                    openWorktreeManagement()
                } label: {
                    ProjectWorktreeStatusChip(status: status)
                }
                .buttonStyle(.plain)
                .help(L10n("Manage project worktrees and service"))
            }
        }
    }

    @ViewBuilder
    private var headerActionMenu: some View {
        if backendClient.viewingHistoricalThreadId != nil {
            Button {
                backendClient.returnToActiveThread()
            } label: {
                Label(L10n("Active thread"), systemImage: "arrow.forward.circle")
            }
        }

        if canReconnectSelectedSession {
            Button {
                backendClient.reconnectSelectedSession()
            } label: {
                Label(L10n("Reconnect session"), systemImage: "link")
            }
        }

        Button {
            backendClient.prepareGitHubPush()
        } label: {
            Label(L10n("Commit and Push to GitHub"), systemImage: "arrow.up.circle.fill")
        }
        .disabled(
            backendClient.viewingHistoricalThreadId != nil
                || backendClient.isPreparingGitHubPush
                || backendClient.isPushingGitHub
                || !gitHubPushHasPendingChanges
        )

        Button {
            openWorktreeManagement()
        } label: {
            Label(L10n("Manage project worktrees and service"), systemImage: "arrow.triangle.branch")
        }
        .disabled(supplementaryData.selectedProjectWorktreeStatus == nil)

        Divider()

        Button(action: openWorkspaceInVSCode) {
            Label(L10n("Open in Visual Studio Code"), systemImage: "chevron.left.forwardslash.chevron.right")
        }
        .disabled(workspacePath == nil)

        Button(action: openWorkspaceInFinder) {
            Label(L10n("Open in Finder"), systemImage: "folder")
        }
        .disabled(workspacePath == nil)
    }

    private func gitHubButtonColor(_ worktree: ProjectWorktreeStatus?) -> Color {
        if backendClient.isSelectedSessionPushingGitHub {
            return worktree?.dirty == true ? CorptiePalette.amber : CorptiePalette.connected
        }
        guard gitHubPushHasPendingChanges else { return CorptiePalette.mutedText }
        return worktree?.dirty == true ? CorptiePalette.amber : CorptiePalette.connected
    }

    private func openWorktreeManagement() {
        AppDelegate.shared?.openWorktreeManagement(
            repositoryId: WorktreeNavigationTarget.preferredRepositoryId(
                sessionRepositoryId: backendClient.selectedSession?.external?.workspace?.repositoryId,
                loadedProjectRepositoryId: supplementaryData.selectedProjectWorktreeStatus?.project.repositoryId
            ),
            worktreeId: selectedSessionWorktree?.worktreeId
                ?? backendClient.selectedSession?.external?.workspace?.id,
            worktreePath: workspacePath
        )
    }

    private var gitHubPushHasPendingChanges: Bool {
        guard let push = selectedGitHubPushStatus else { return false }
        return push.available && push.pending
    }

    private var selectedGitHubPushStatus: GitHubPushStatus? {
        ProjectGitHubPushSelection.status(
            for: selectedSessionWorktree,
            fallback: supplementaryData.selectedProjectWorktreeStatus?.gitHubPush
        )
    }

    private func gitHubPushButtonHelp(_ worktree: ProjectWorktreeStatus?) -> String {
        if backendClient.isSelectedSessionPushingGitHub {
            return L10n("Pushing to GitHub…")
        }
        if let error = backendClient.gitHubPushError {
            return error
        }
        guard let push = selectedGitHubPushStatus else {
            return L10n("Checking for changes to push")
        }
        if !push.available {
            return push.error ?? L10n("GitHub push is unavailable")
        }
        if !push.pending {
            return L10n("No changes or commits to push")
        }
        return worktree?.dirty == true
            ? L10n("Uncommitted changes — review commit and GitHub push")
            : L10nFormat("%d commit(s) ready to push", push.unpushedCommitCount)
    }

    private func projectServiceStatusHelp(_ status: ProjectWorktreeStatusResponse) -> String {
        let service: String
        switch status.service.freshness {
        case "current": service = L10n("Service is running the latest code")
        case "stale": service = L10n("Service is running older or modified code")
        case "configurationMismatch": service = L10n("Service profile does not match the selected profile")
        case "unverifiedBuild": service = L10n("Running build cannot be verified")
        case "toolsetUpdateRequired": service = L10n("Update the project toolset to verify this service")
        case "unhealthy": service = L10n("Service is running but unhealthy")
        case "stopped": service = L10n("Service is stopped")
        default: service = L10n("Service version is unknown")
        }
        return service
    }

    private var workspacePath: String? {
        if backendClient.viewingHistoricalThreadId != nil {
            let historicalPath = backendClient.selectedDetail?.cwd?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let historicalPath, !historicalPath.isEmpty {
                return historicalPath
            }
        }
        let routedPath = backendClient.selectedSession?.external?.workspace?.path?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let routedPath, !routedPath.isEmpty {
            return routedPath
        }
        let sessionPath = backendClient.selectedSession?.external?.cwd?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return sessionPath?.isEmpty == false ? sessionPath : nil
    }

    private var projectName: String? {
        let projectPath = backendClient.selectedSession?.external?.workspace?.projectPath?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let path = projectPath?.isEmpty == false ? projectPath : workspacePath
        guard let path, !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path).standardizedFileURL.lastPathComponent
    }

    private var workspaceRouteIdentity: String {
        let version = backendClient.selectedSession?.external?.routingVersion ?? 0
        return "\(version):\(workspacePath ?? "")"
    }

    private func refreshGitBranch() async {
        guard let workspacePath else {
            gitHeadState = nil
            return
        }
        while !Task.isCancelled {
            let nextHeadState = await GitBranchResolver.headState(at: workspacePath)
            guard !Task.isCancelled, workspacePath == self.workspacePath else {
                return
            }
            if gitHeadState != nextHeadState {
                gitHeadState = nextHeadState
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private var canInterruptCurrentRun: Bool {
        backendClient.selectedCanInterruptNow
    }

    private func copyWorkspacePath() {
        guard copySessionNameToPasteboard(workspacePath) else { return }
        withAnimation(.easeOut(duration: 0.12)) {
            didCopyWorkspacePath = true
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 900_000_000)
            withAnimation(.easeOut(duration: 0.12)) {
                didCopyWorkspacePath = false
            }
        }
    }

    private func copySessionTitle(_ title: String) {
        guard copySessionNameToPasteboard(title) else { return }
        sessionTitleCopyFeedbackTask?.cancel()
        withAnimation(.easeOut(duration: 0.12)) {
            didCopySessionTitle = true
        }
        sessionTitleCopyFeedbackTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(900))
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.12)) {
                didCopySessionTitle = false
            }
            sessionTitleCopyFeedbackTask = nil
        }
    }

    private func openWorkspaceInFinder() {
        guard let workspacePath else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: workspacePath, isDirectory: true))
    }

    private func openWorkspaceInVSCode() {
        guard let workspacePath else { return }
        let workspaceURL = URL(fileURLWithPath: workspacePath, isDirectory: true)
        if let applicationURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.microsoft.VSCode") {
            NSWorkspace.shared.open(
                [workspaceURL],
                withApplicationAt: applicationURL,
                configuration: NSWorkspace.OpenConfiguration()
            )
            return
        }
        var components = URLComponents()
        components.scheme = "vscode"
        components.host = "file"
        components.path = workspaceURL.path
        if let url = components.url {
            NSWorkspace.shared.open(url)
        }
    }
}
