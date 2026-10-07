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
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    @State private var didCopySessionTitle = false
    @State private var sessionTitleCopyFeedbackTask: Task<Void, Never>?
    @State private var didCopyWorkspacePath = false
    @State private var gitHeadState: GitHeadState?

    var body: some View {
        headerControls
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

    @ViewBuilder
    private var headerControls: some View {
        if #available(macOS 26.0, *) {
            GlassEffectContainer(spacing: 6) { headerControlRow }
        } else {
            headerControlRow
        }
    }

    private var headerControlRow: some View {
        HStack(spacing: 10) {
            HStack {
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
                    .buttonStyle(.plain)
                    .platformGlassSurface(in: Circle(), interactive: true)
                    .help(L10n("Back to task list"))
                }
            }
            .frame(width: 66, alignment: .leading)

            HStack {
                Spacer(minLength: 0)
                headerIdentityCapsule
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)

            HStack(spacing: 10) {
                if backendClient.selectedSession != nil {
                    Button {
                        guard let session = backendClient.selectedSession else { return }
                        DetachedChatWindowManager.shared.show(session: session)
                    } label: {
                        Image(systemName: "macwindow.on.rectangle")
                            .font(.system(size: 12, weight: .semibold))
                            .frame(width: 28, height: 28)
                            .platformGlassSurface(in: Circle(), interactive: true)
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
                    .frame(width: 28, height: 28)
                    .platformGlassSurface(in: Circle(), interactive: true)
                    .help(L10n("Open workspace"))
                    .accessibilityLabel(L10n("Open workspace"))
                    .accessibilityIdentifier("session.detail.actions")
                }
            }
            .frame(width: 66, alignment: .trailing)
        }
    }

    private var headerIdentityCapsule: some View {
        VStack(alignment: .center, spacing: 3) {
            if let selectedTitle {
                Button {
                    copySessionTitle(selectedTitle)
                } label: {
                    Text(selectedTitle)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .multilineTextAlignment(.center)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier("conversation-task-title")
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
            HStack(alignment: .center, spacing: 6) {
                if let selectedSession = backendClient.selectedSession {
                    SessionProviderIdentity(session: selectedSession, prominentText: true)
                        .font(.system(size: 11, weight: .semibold))
                }
                if let cwd = workspacePath, !cwd.isEmpty {
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
                        .foregroundStyle(.primary)
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
                        .help(gitHeadState.helpText ?? L10n("Manage project worktrees and service"))
                        .accessibilityLabel(gitHeadState.helpText ?? L10n("Manage project worktrees and service"))
                    }
                }
                if let status = supplementaryData.selectedProjectWorktreeStatus {
                    ProjectServiceStatusDot(status: status.service)
                        .help(projectServiceStatusHelp(status))
                }
            }
            if let action = primaryHeaderAction {
                headerActionButton(action)
                    .contextMenu { headerActionMenu }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(maxWidth: 560)
        .platformGlassSurface(in: Capsule())
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
        case manageWorktrees
    }

    private var primaryHeaderAction: HeaderAction? {
        if backendClient.viewingHistoricalThreadId != nil {
            return .returnToActiveThread
        }
        if canReconnectSelectedSession {
            return .reconnect
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
            .buttonStyle(.plain)
            .help(L10n("Return to the active workspace thread"))
        case .reconnect:
            Button {
                backendClient.reconnectSelectedSession()
            } label: {
                Image(systemName: "link")
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help(L10n("Reconnect session"))
        case .manageWorktrees:
            if let status = supplementaryData.selectedProjectWorktreeStatus {
                Button {
                    openWorktreeManagement()
                } label: {
                    ProjectWorktreeStatusChip(status: status, showsSurface: false)
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
