import AppKit
import Combine
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Legacy observation stays outside the value-only header used by retained pages.
struct DetailHeaderView: View {
    let session: TaskSession?
    var historicalWorkspacePath: String? = nil
    var activity: ConversationDetailPresentationActivity? = nil
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var entityClient = EntityAPIClient.shared
    @ObservedObject private var supplementaryData = BackendClient.shared.supplementaryDataController
    @ObservedObject private var modelCatalog = BackendClient.shared.modelCatalog
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    var body: some View {
        SessionConversationHeaderSurface(session: session, historicalWorkspacePath: historicalWorkspacePath,
            activity: activity, backendClient: backendClient,
            projectStatus: supplementaryData.selectedSessionID == session?.id ? supplementaryData.selectedProjectWorktreeStatus : nil,
            showsHistoricalThread: backendClient.sessionSelectionController.selectedSessionID == session?.id && backendClient.viewingHistoricalThreadId != nil,
            hasPendingScheduledWake: session?.taskId.flatMap { id in entityClient.tasks.first { $0.id == id } }?.hasPendingScheduledWake == true,
            providers: modelCatalog.agentProviders)
    }
}

struct SessionConversationHeaderSurface: View {
    let session: TaskSession?
    let historicalWorkspacePath: String?
    var activity: ConversationDetailPresentationActivity? = nil
    private var isPresentationActive: Bool { activity?.isActive ?? true }
    private var canAct: Bool {
        if let renderInputs { return renderInputs.actionSession(generation: renderInputs.activity.generation) != nil }
        return (activity?.allows(generation: activity?.generation ?? 0) ?? true)
            && session?.id != nil && backendClient.sessionSelectionController.selectedSessionID == session?.id
    }
    private let backendClient: BackendClient
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    @Environment(\.scenePhase) private var scenePhase
    @State private var didCopySessionTitle = false
    @State private var sessionTitleCopyFeedbackTask: Task<Void, Never>?
    @State private var didCopyWorkspacePath = false
    private struct WorkspaceGitHead: Equatable {
        let path: String
        let head: GitHeadState?
    }
    @State private var workspaceGitHead: WorkspaceGitHead?
    private var gitHeadState: GitHeadState? {
        guard let path = workspacePath else { return nil }
        if workspaceGitHead?.path == path { return workspaceGitHead?.head }
        if let cached = GitBranchResolver.cachedHeadState(at: path) { return cached }
        // State Sync may already carry this exact routed worktree's HEAD.
        // Never borrow metadata for an unrelated historical workspace.
        if !showsHistoricalThread, let workspace = session?.external?.workspace,
           workspace.path == path, let branch = workspace.branchName, !branch.isEmpty,
           let oid = workspace.headOid, !oid.isEmpty {
            return .branch(name: branch, oid: oid)
        }
        return nil
    }

    struct ProjectStatusSnapshot {
        let serverID: String
        let sessionID: String?
        let workspacePath: String?
        let status: ProjectWorktreeStatusResponse
        func value(serverID: String, sessionID: String?, workspacePath: String?) -> ProjectWorktreeStatusResponse? {
            self.serverID == serverID && self.sessionID == sessionID && self.workspacePath == workspacePath ? status : nil
        }
    }
    @State private var lastProjectStatus: ProjectStatusSnapshot?
    private let incomingProjectStatus: ProjectWorktreeStatusResponse?
    private var displayedProjectStatus: ProjectWorktreeStatusResponse? {
        incomingProjectStatus ?? lastProjectStatus?.value(serverID: backendClient.baseURL.absoluteString, sessionID: session?.id, workspacePath: workspacePath)
    }
    private let showsHistoricalThread: Bool
    private let hasPendingScheduledWake: Bool
    private let providers: [AgentProviderDescriptor]
    private let renderInputs: SessionPageRenderInputs?

    init(session: TaskSession?, historicalWorkspacePath: String? = nil,
         activity: ConversationDetailPresentationActivity? = nil, backendClient: BackendClient,
         projectStatus: ProjectWorktreeStatusResponse?, showsHistoricalThread: Bool,
         hasPendingScheduledWake: Bool, providers: [AgentProviderDescriptor],
         renderInputs: SessionPageRenderInputs? = nil) {
        self.session = session; self.historicalWorkspacePath = historicalWorkspacePath
        self.activity = renderInputs?.activity ?? activity; self.backendClient = backendClient
        self.incomingProjectStatus = projectStatus; self.showsHistoricalThread = showsHistoricalThread
        self.hasPendingScheduledWake = hasPendingScheduledWake; self.providers = providers
        self.renderInputs = renderInputs
    }

    var body: some View {
        let _ = SessionSwitchTrace.shared.mark(.headerBody, sessionID: session?.id ?? "")
        headerControls
            .onChange(of: incomingProjectStatus, initial: true) { _, status in
                guard let status else { return }
                lastProjectStatus = ProjectStatusSnapshot(serverID: backendClient.baseURL.absoluteString, sessionID: session?.id, workspacePath: workspacePath, status: status)
            }
            .task(id: isPresentationActive ? workspaceRouteIdentity : nil) {
                guard isPresentationActive else { return }
                await refreshGitBranch()
            }
            .onReceive(backendClient.gitHubPushController.$preparation.dropFirst()) { preparation in
                guard canAct else { return }
                if let preparation {
                    GitHubPushConfirmationWindowManager.shared.show(
                        preparation: preparation,
                        backendClient: backendClient
                    )
                } else {
                    GitHubPushConfirmationWindowManager.shared.close()
                }
            }
            .onChange(of: session?.id) { _, _ in
                sessionTitleCopyFeedbackTask?.cancel()
                sessionTitleCopyFeedbackTask = nil
                didCopySessionTitle = false
            }
            .onChange(of: isPresentationActive) { _, active in
                guard !active else { return }
                sessionTitleCopyFeedbackTask?.cancel(); sessionTitleCopyFeedbackTask = nil
                didCopySessionTitle = false; didCopyWorkspacePath = false
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
                            guard canAct else { return }
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
                if session != nil {
                    Button {
                        guard canAct, let session else { return }
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
                    HStack(spacing: 4) {
                        Text(selectedTitle)
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .truncationMode(.tail)
                            .multilineTextAlignment(.center)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("conversation-task-title")
                        if hasPendingScheduledWake {
                            ConsoleScheduledWakeIcon(isActive: scenePhase == .active && isPresentationActive)
                                .accessibilityIdentifier("conversation-task-scheduled-wake")
                        }
                    }
                }
                .buttonStyle(.plain)
                .help(L10n("Click to copy Session title"))
                .accessibilityLabel(L10n("Copy Session title"))
                .accessibilityValue(selectedTitle)

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
                if showsHistoricalThread {
                    Label(L10n("Read-only history"), systemImage: "clock.arrow.circlepath")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.orange)
                } else if session?.external?.workspace?.continuationState == "failed" {
                    Label(L10n("Worktree continuation failed"), systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.orange)
                } else if session?.external?.workspace?.transitionStrategy == "handoff" {
                    Label(L10n("Context handoff"), systemImage: "arrow.triangle.branch")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
            }
            HStack(alignment: .center, spacing: 6) {
                if let selectedSession = session {
                    SessionHeaderProviderIdentity(session: selectedSession, providers: providers)
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
                if let status = displayedProjectStatus {
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
        .fixedSize(horizontal: true, vertical: false)
        .platformGlassSurface(in: Capsule())
    }

    private var selectedTitle: String? {
        session?.title
    }

    private var selectedSessionWorktree: ProjectWorktreeStatus? {
        guard let sessionId = session?.id,
              let status = displayedProjectStatus else { return nil }
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
        if showsHistoricalThread {
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
        session?.canResumeNow == true
            && session?.isConnected == false
    }

    private var shouldSuggestWorktreeManagement: Bool {
        guard let project = displayedProjectStatus?.project else { return false }
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
                guard canAct else { return }
                backendClient.returnToActiveThread()
            } label: {
                Label(L10n("Active thread"), systemImage: "arrow.forward.circle")
                    .font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.plain)
            .help(L10n("Return to the active workspace thread"))
        case .reconnect:
            Button {
                guard canAct else { return }
                backendClient.reconnectSelectedSession()
            } label: {
                Image(systemName: "link")
                    .font(.system(size: 11, weight: .bold))
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help(L10n("Reconnect session"))
        case .manageWorktrees:
            if let status = displayedProjectStatus {
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
        if showsHistoricalThread {
            Button {
                guard canAct else { return }
                backendClient.returnToActiveThread()
            } label: {
                Label(L10n("Active thread"), systemImage: "arrow.forward.circle")
            }
        }

        if canReconnectSelectedSession {
            Button {
                guard canAct else { return }
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
        .disabled(displayedProjectStatus == nil)

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
        guard canAct else { return }
        AppDelegate.shared?.openWorktreeManagement(
            repositoryId: WorktreeNavigationTarget.preferredRepositoryId(
                sessionRepositoryId: session?.external?.workspace?.repositoryId,
                loadedProjectRepositoryId: displayedProjectStatus?.project.repositoryId
            ),
            worktreeId: selectedSessionWorktree?.worktreeId
                ?? session?.external?.workspace?.id,
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
        if showsHistoricalThread {
            let historicalPath = historicalWorkspacePath?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if let historicalPath, !historicalPath.isEmpty {
                return historicalPath
            }
        }
        let routedPath = session?.external?.workspace?.path?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let routedPath, !routedPath.isEmpty {
            return routedPath
        }
        let sessionPath = session?.external?.cwd?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return sessionPath?.isEmpty == false ? sessionPath : nil
    }

    private var projectName: String? {
        let projectPath = session?.external?.workspace?.projectPath?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let path = projectPath?.isEmpty == false ? projectPath : workspacePath
        guard let path, !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path).standardizedFileURL.lastPathComponent
    }

    private var workspaceRouteIdentity: String {
        let version = session?.external?.routingVersion ?? 0
        return "\(version):\(workspacePath ?? "")"
    }

    private func refreshGitBranch() async {
        guard isPresentationActive, renderInputs?.acceptsPresentationUpdates ?? true else { return }
        guard let workspacePath else {
            workspaceGitHead = nil
            return
        }
        let generation = activity?.generation ?? 0
        while isPresentationActive && (renderInputs?.acceptsPresentationUpdates ?? true) && !Task.isCancelled {
            let nextHeadState = await GitBranchResolver.headState(at: workspacePath)
            guard !Task.isCancelled, activity?.allows(generation: generation) ?? true, workspacePath == self.workspacePath else {
                return
            }
            let next = WorkspaceGitHead(path: workspacePath, head: nextHeadState)
            if workspaceGitHead != next {
                workspaceGitHead = next
            }
            try? await Task.sleep(for: .seconds(3))
        }
    }

    private var canInterruptCurrentRun: Bool {
        session?.canInterruptNow == true
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

/// Provider branding rendered from the page's captured catalog, with no global observation.
private struct SessionHeaderProviderIdentity: View {
    let session: TaskSession
    let providers: [AgentProviderDescriptor]
    var body: some View {
        HStack(spacing: 2) {
            if let icon = ProviderBrandIcon.image(for: session.external?.provider ?? session.agent, providers: providers) {
                Image(nsImage: icon).resizable().interpolation(.high).frame(width: 13, height: 13).accessibilityHidden(true)
            } else {
                Image(systemName: "cpu").foregroundStyle(session.accent.color).accessibilityHidden(true)
            }
            Text(sessionProviderIdentityLabel(providerIdentity: session.external?.provider,
                legacyAgentLabel: session.agent, providers: providers)).foregroundStyle(Color.primary)
        }.fixedSize(horizontal: true, vertical: false)
    }
}
