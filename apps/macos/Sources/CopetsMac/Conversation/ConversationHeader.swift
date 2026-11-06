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
            providers: modelCatalog.agentProviders,
            workName: session?.workId.flatMap { AppStateStore.shared.work($0)?.name })
    }
}

struct SessionConversationHeaderSurface: View {
    @Environment(\.detailColumnVisibility) private var detailColumnVisibility
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var didCopySessionTitle = false
    @State private var sessionTitleCopyFeedbackTask: Task<Void, Never>?
    @State private var didCopyWorkspacePath = false
    @State private var workspacePathCopyFeedbackTask: Task<Void, Never>?
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
    private let workName: String?

    init(session: TaskSession?, historicalWorkspacePath: String? = nil,
         activity: ConversationDetailPresentationActivity? = nil, backendClient: BackendClient,
         projectStatus: ProjectWorktreeStatusResponse?, showsHistoricalThread: Bool,
         hasPendingScheduledWake: Bool, providers: [AgentProviderDescriptor],
         renderInputs: SessionPageRenderInputs? = nil, workName: String? = nil) {
        self.session = session; self.historicalWorkspacePath = historicalWorkspacePath
        self.activity = renderInputs?.activity ?? activity; self.backendClient = backendClient
        self.incomingProjectStatus = projectStatus; self.showsHistoricalThread = showsHistoricalThread
        self.hasPendingScheduledWake = hasPendingScheduledWake; self.providers = providers
        self.renderInputs = renderInputs
        self.workName = workName ?? renderInputs?.workName
    }

    var body: some View {
        let _ = SessionSwitchTrace.shared.mark(.headerBody, sessionID: session?.id ?? "")
        headerControls
            .onChange(of: incomingProjectStatus, initial: true) { _, status in
                guard let status else { return }
                lastProjectStatus = ProjectStatusSnapshot(serverID: backendClient.baseURL.absoluteString, sessionID: session?.id, workspacePath: workspacePath, status: status)
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
                workspacePathCopyFeedbackTask?.cancel(); workspacePathCopyFeedbackTask = nil
                didCopyWorkspacePath = false
            }
            .onChange(of: isPresentationActive) { _, active in
                guard !active else { return }
                sessionTitleCopyFeedbackTask?.cancel(); sessionTitleCopyFeedbackTask = nil
                workspacePathCopyFeedbackTask?.cancel(); workspacePathCopyFeedbackTask = nil
                didCopySessionTitle = false; didCopyWorkspacePath = false
            }
            .onDisappear {
                sessionTitleCopyFeedbackTask?.cancel()
                sessionTitleCopyFeedbackTask = nil
                workspacePathCopyFeedbackTask?.cancel(); workspacePathCopyFeedbackTask = nil
                didCopySessionTitle = false; didCopyWorkspacePath = false
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
        HStack(alignment: .top, spacing: 10) {
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

                    .help(L10n("Back to task list"))
                }
            }
            .frame(width: isLiquidGlass ? 28 : 0, alignment: .leading)

            headerIdentityCapsule
                .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 6) {
                if let action = primaryHeaderAction { headerActionButton(action) }
                if session != nil {
                    if let visibility = detailColumnVisibility {
                        Button {
                            guard canAct, let session else { return }
                            visibility.wrappedValue = true
                            NotificationCenter.default.post(name: .sessionMailboxRequested, object: session.id)
                        } label: {
                            HStack(spacing: 2) {
                                Image(systemName: "envelope")
                                if let count = session?.mailboxPendingCount, count > 0 { Text(count > 99 ? "99+" : "\(count)").font(.caption2) }
                            }.frame(minWidth: 28, minHeight: 28)
                        }.buttonStyle(.plain).help("打开会话信箱").accessibilityLabel("打开会话信箱")
                        Button {
                            visibility.wrappedValue.toggle()
                        } label: {
                            Image(systemName: "sidebar.right")
                                .font(.system(size: 12, weight: .semibold))
                                .frame(width: 28, height: 28)
                        }
                        .buttonStyle(.plain)
                        .help(L10n(visibility.wrappedValue ? "Hide Detail" : "Show Detail"))
                        .accessibilityLabel(L10n(visibility.wrappedValue ? "Hide Detail" : "Show Detail"))
                        .accessibilityIdentifier("session.detail.toggle-column")
                    }
                    Button {
                        guard canAct, let session else { return }
                        DetachedChatWindowManager.shared.show(session: session)
                    } label: {
                        Image(systemName: "macwindow.on.rectangle")
                            .font(.system(size: 12, weight: .semibold))
                            .frame(width: 28, height: 28)
                    }
                    .buttonStyle(.plain)
                    .help(L10n("Open chat in floating window"))
                    .accessibilityLabel(L10n("Open chat in floating window"))
                    .accessibilityIdentifier("session.detail.detach")

                    Menu {
                        headerActionMenu
                        Divider()
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

                    .help(L10n("Open workspace"))
                    .accessibilityLabel(L10n("Open workspace"))
                    .accessibilityIdentifier("session.detail.actions")
                }
            }
            .fixedSize(horizontal: true, vertical: false)
            .foregroundStyle(.secondary)
        }
    }

    private var headerIdentityCapsule: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let selectedTitle {
                Button {
                    copySessionTitle(selectedTitle)
                } label: {
                    HStack(spacing: 4) {
                        Text(selectedTitle)
                            .font(WorkbenchTypography.font(for: .conversationTitle))
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .multilineTextAlignment(.leading)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("conversation-task-title")
                        if hasPendingScheduledWake {
                            ConsoleScheduledWakeIcon(isActive: scenePhase == .active && isPresentationActive)
                                .accessibilityIdentifier("conversation-task-scheduled-wake")
                        }
                        copyConfirmation(visible: didCopySessionTitle)
                    }
                }
                .buttonStyle(.plain)
                .help(L10n("Click to copy Session title"))
                .accessibilityLabel(L10n("Copy Session title"))
                .accessibilityValue(selectedTitle)
                .frame(height: 28)
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
                }
            }
            HStack(alignment: .center, spacing: 6) {
                if let selectedSession = session {
                    SessionHeaderProviderIdentity(session: selectedSession, providers: providers)
                        .font(WorkbenchTypography.font(for: .conversationMetadata))
                }
                if let cwd = workspacePath, !cwd.isEmpty {
                    Button(action: copyWorkspacePath) {
                        HStack(spacing: 4) {
                            Text(projectName ?? URL(fileURLWithPath: cwd).lastPathComponent)
                                .lineLimit(1)
                            copyConfirmation(visible: didCopyWorkspacePath)
                        }
                        .font(WorkbenchTypography.font(for: .conversationMetadata))
                        .foregroundStyle(.secondary)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(L10nFormat("Copy full workspace path: %@", cwd))
                }
                if hasWorktreeTarget {
                    headerActionButton(.manageWorktrees)
                        .fixedSize(horizontal: true, vertical: false)
                }
                if let status = displayedProjectStatus {
                    ProjectServiceStatusDot(status: status.service)
                        .help(projectServiceStatusHelp(status))
                }
            }

        }
        .padding(.horizontal, 8)
        .help(selectedTitle ?? "")
    }

    private var selectedTitle: String? {
        guard let session else { return nil }
        return Self.displayTitle(session: session, workName: workName)
    }

    static func displayTitle(session: TaskSession, workName: String?) -> String {
        guard session.resolvedSessionKind == .workChat else { return session.title }
        guard let name = workName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else {
            return L10n("Work Chat")
        }
        return "\(name) · \(L10n("Work Chat"))"
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
        return nil
    }

    private var canReconnectSelectedSession: Bool {
        session?.canResumeNow == true
            && session?.isConnected == false
    }

    private var hasWorktreeTarget: Bool {
        session?.external?.workspace?.repositoryId != nil || displayedProjectStatus != nil
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
            Button {
                openWorktreeManagement()
            } label: {
                if let status = displayedProjectStatus {
                    ProjectWorktreeStatusChip(status: status, showsSurface: false)
                } else {
                    Label("Worktree", systemImage: "arrow.triangle.branch")
                        .font(WorkbenchTypography.font(for: .conversationMetadata))
                }
            }
            .buttonStyle(.plain)
            .help(L10n("Manage project worktrees and service"))
            .accessibilityLabel(L10n("Manage project worktrees and service"))
            .accessibilityIdentifier("session.detail.worktree")
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
        .disabled(!hasWorktreeTarget)

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

    private var canInterruptCurrentRun: Bool {
        session?.canInterruptNow == true
    }

    private func copyConfirmation(visible: Bool) -> some View {
        Image(systemName: "checkmark")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(CorptiePalette.connected)
            .frame(width: 12, height: 12)
            .opacity(visible ? 1 : 0)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: visible)
            .accessibilityHidden(true)
            .allowsHitTesting(false)
    }

    private func copyWorkspacePath() {
        guard copySessionNameToPasteboard(workspacePath) else { return }
        workspacePathCopyFeedbackTask?.cancel()
        didCopyWorkspacePath = true
        workspacePathCopyFeedbackTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(900)) }
            catch { return }
            didCopyWorkspacePath = false
            workspacePathCopyFeedbackTask = nil
        }
    }

    private func copySessionTitle(_ title: String) {
        guard copySessionNameToPasteboard(title) else { return }
        sessionTitleCopyFeedbackTask?.cancel()
        didCopySessionTitle = true
        sessionTitleCopyFeedbackTask = Task { @MainActor in
            do { try await Task.sleep(for: .milliseconds(900)) }
            catch { return }
            didCopySessionTitle = false
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
