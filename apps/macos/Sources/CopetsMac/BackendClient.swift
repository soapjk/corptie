import AppKit
import Combine
import Foundation

extension Notification.Name {
    /// 请求在主悬浮窗（液态玻璃）打开某个 session 的对话，userInfo["sessionId"] 传 session id。
    /// 控制台 CorptieTask 详情「打开对话」用，桥接新版控制台与旧版 session 对话视图。
    static let openSessionConversation = Notification.Name("openSessionConversation")
    static let openSessionOverview = Notification.Name("openSessionOverview")
    static let showAgentOrb = Notification.Name("showAgentOrb")
    static let scrollSessionTimelineToTurn = Notification.Name("scrollSessionTimelineToTurn")
}

@MainActor
final class BackendClient: ObservableObject {
    static let shared = BackendClient()

    let appState = AppStateStore.shared
    private let timelineDeltaProcessor = SessionTimelineDeltaProcessor()
    var sessions: [TaskSession] { appState.sessions.filter { $0.archived != true } }
    let sessionIndexStore = SessionIndexStore()
    let sessionRestartActivityController = SessionRestartActivityController()


    nonisolated static func reconciledActivityStatus(
        authoritativeStatus: TaskStatus,
        authoritativeActivityStatus: String?,
        fallbackActivityStatus: String?
    ) -> String? {
        switch authoritativeStatus {
        case .running, .blocked:
            return authoritativeActivityStatus ?? fallbackActivityStatus
        case .complete, .failed, .cancelled:
            return nil
        }
    }

    let sessionsDidChange = CurrentValueSubject<[TaskSession], Never>([])
    let sessionSelectionController = SessionSelectionController()
    let supplementaryDataController = SessionSupplementaryDataController()
    let sessionCommandController = SessionCommandController()
    var archivedSessions: [TaskSession] { archivedSessionController.sessions }
    /// Selection has one owner: `SessionSelectionController.selectedSessionID`.
    /// Resolve the value from an authoritative collection instead of retaining
    /// a second mutable Session snapshot that can keep an obsolete status.
    var selectedSession: TaskSession? {
        guard let id = sessionSelectionController.selectedSessionID else { return nil }
        return appState.session(id) ?? archivedSessions.first(where: { $0.id == id })
    }
    @Published var selectedHistoricalDetail: CodexThreadDetail?
    var selectedDetail: CodexThreadDetail? {
        if viewingHistoricalThreadId != nil { return selectedHistoricalDetail }
        guard let sessionID = selectedSession?.id else { return nil }
        return SessionTimelineRepository.shared.detail(for: sessionID)
    }
    var selectedExecutionStatus: TaskStatus {
        viewingHistoricalThreadId != nil
            ? (selectedHistoricalDetail?.status ?? .complete)
            : (selectedSession?.executionTaskStatus ?? .complete)
    }
    var selectedCanSendNow: Bool {
        if !isOnline { return false }
        if workspaceRecoveryStatus?.blocksSessionInput == true { return false }
        if let id = selectedSession?.id, bindingVerificationSessionIDs.contains(id) { return false }
        if viewingHistoricalThreadId != nil { return selectedHistoricalDetail?.canSend ?? false }
        return selectedSession?.isReady ?? false
    }

    var selectedIsReady: Bool {
        if !isOnline { return false }
        if let id = selectedSession?.id, bindingVerificationSessionIDs.contains(id) { return false }
        if viewingHistoricalThreadId != nil { return selectedHistoricalDetail?.isReady ?? false }
        return selectedSession?.isReady ?? false
    }

    var selectedNotReadyReason: SessionNotReadyReason? {
        if let id = selectedSession?.id, bindingVerificationSessionIDs.contains(id) {
            return SessionNotReadyReason(
                code: "BINDING_RUNTIME_VERIFYING",
                message: L10n("The Provider Session binding is being verified."),
                retryable: true
            )
        }
        if viewingHistoricalThreadId != nil { return selectedHistoricalDetail?.notReadyReason }
        return selectedSession?.notReadyReason ?? selectedDetail?.notReadyReason
    }
    var selectedCanInterruptNow: Bool {
        if viewingHistoricalThreadId != nil { return false }
        return selectedSession?.executionTaskStatus == .running
            && selectedSession?.canInterruptNow == true
    }
    var selectedCurrentModel: String? {
        viewingHistoricalThreadId != nil
            ? selectedHistoricalDetail?.currentModel
            : selectedSession?.external?.currentModel
    }
    var selectedCurrentReasoningLevel: String? {
        viewingHistoricalThreadId != nil
            ? selectedHistoricalDetail?.currentReasoningLevel
            : selectedSession?.external?.currentReasoningLevel
    }
    var selectedContentDirectory: String? {
        if viewingHistoricalThreadId != nil { return selectedHistoricalDetail?.cwd }
        return selectedSession?.external?.workspace?.path ?? selectedSession?.external?.cwd
    }
    // Sessions Tab 等轻量场景置 true：select 后不启动 usage/worktree 后台轮询，减少刷新。
    var suppressBackgroundPolling = false
    @Published var viewingHistoricalThreadId: String?
    @Published var isLoadingDetail = false
    @Published var selectedTimelineLoadError: String?
    @Published var bindingVerificationSessionIDs = Set<String>()
    private(set) var isSendingMessage: Bool {
        get { sessionCommandController.isSendingMessage }
        set { sessionCommandController.isSendingMessage = newValue }
    }
    var sendStatusMessage: String? {
        get { sessionCommandController.sendStatusMessage }
        set { sessionCommandController.sendStatusMessage = newValue }
    }
    @Published private(set) var isOnline = false
    @Published var lastError: String?
    var isCreatingTask: Bool { sessionCreationController.isCreatingTask }
    var settings: BackendSettings? { settingsController.settings }
    var isUpdatingSettings: Bool { settingsController.isUpdatingSettings }
    var dataRootMigration: DataRootMigrationOperation? { settingsController.dataRootMigration }
    var dataRootMigrationPresentationPhase: String? { settingsController.dataRootMigrationPresentationPhase }
    var isTestingChoiceParser: Bool { settingsController.isTestingChoiceParser }
    lazy var feishuStore = FeishuSettingsStore(
        baseURL: baseURL,
        currentError: { [weak self] in self?.lastError },
        publishError: { [weak self] in self?.lastError = $0 },
        decodeError: { Self.errorMessage(from: $0) }
    )
    lazy var modelCatalog = ProviderCatalogStore(
        baseURL: baseURL,
        publishError: { [weak self] in self?.lastError = $0 }
    )
    private(set) var isSwitchingModel: Bool { get { sessionCommandController.isSwitchingModel } set { sessionCommandController.isSwitchingModel = newValue } }
    private(set) var isSwitchingReasoning: Bool { get { sessionCommandController.isSwitchingReasoning } set { sessionCommandController.isSwitchingReasoning = newValue } }
    private(set) var connectionTransitionSessionIds: Set<String> { get { sessionCommandController.connectionTransitionSessionIds } set { sessionCommandController.connectionTransitionSessionIds = newValue } }
    private(set) var restartingSessionIds: Set<String> { get { sessionCommandController.restartingSessionIds } set { sessionCommandController.restartingSessionIds = newValue } }
    private(set) var restartActivityBySessionId: [String: SessionRestartActivity] {
        get { sessionRestartActivityController.activityBySessionID }
        set { sessionRestartActivityController.activityBySessionID = newValue }
    }
    var isLoadingArchivedSessions: Bool { archivedSessionController.isLoading }
    var isLoadingMoreArchivedSessions: Bool { archivedSessionController.isLoadingMore }
    var archivedSessionsHasMore: Bool { archivedSessionController.hasMore }
    var archivedSessionsLoadError: String? { archivedSessionController.loadError }
    private var archivedSessionsKind: SessionKind? { archivedSessionController.currentSessionKind }
    private(set) var selectedSessionUsage: SessionUsageResponse? {
        get { supplementaryDataController.selectedSessionUsage }
        set { supplementaryDataController.selectedSessionUsage = newValue }
    }
    var selectedContextReferences: [SessionContextReference] {
        get { supplementaryDataController.selectedContextReferences }
        set { supplementaryDataController.selectedContextReferences = newValue }
    }
    private(set) var isLoadingContextReferences: Bool {
        get { supplementaryDataController.isLoadingContextReferences }
        set { supplementaryDataController.isLoadingContextReferences = newValue }
    }
    var selectedProjectWorktreeStatus: ProjectWorktreeStatusResponse? {
        get { supplementaryDataController.selectedProjectWorktreeStatus }
        set { supplementaryDataController.selectedProjectWorktreeStatus = newValue }
    }
    var selectedProjectIntegrationStatus: ProjectIntegrationStatusResponse? {
        get { supplementaryDataController.selectedProjectIntegrationStatus }
        set { supplementaryDataController.selectedProjectIntegrationStatus = newValue }
    }
    var projectWorktreeLoadError: String? {
        get { supplementaryDataController.projectWorktreeLoadError }
        set { supplementaryDataController.projectWorktreeLoadError = newValue }
    }
    private(set) var projectWorktreeActionError: String? { get { sessionCommandController.projectWorktreeActionError } set { sessionCommandController.projectWorktreeActionError = newValue } }
    private(set) var isLoadingProjectWorktrees: Bool {
        get { supplementaryDataController.isLoadingProjectWorktrees }
        set { supplementaryDataController.isLoadingProjectWorktrees = newValue }
    }
    private(set) var projectWorktreeActionIds: Set<String> { get { sessionCommandController.projectWorktreeActionIds } set { sessionCommandController.projectWorktreeActionIds = newValue } }
    private(set) var isCleaningMergedProjectWorktrees: Bool { get { sessionCommandController.isCleaningMergedProjectWorktrees } set { sessionCommandController.isCleaningMergedProjectWorktrees = newValue } }
    private(set) var isIntegratingCompletedWorktrees: Bool { get { sessionCommandController.isIntegratingCompletedWorktrees } set { sessionCommandController.isIntegratingCompletedWorktrees = newValue } }
    private(set) var isCreatingIntegrationConflictCorptieTask: Bool { get { sessionCommandController.isCreatingIntegrationConflictCorptieTask } set { sessionCommandController.isCreatingIntegrationConflictCorptieTask = newValue } }
    var gitHubPushPreparation: GitHubPushPreparation? { gitHubPushController.preparation }
    var gitHubPushError: String? { gitHubPushController.error }
    var isPreparingGitHubPush: Bool { gitHubPushController.isPreparing }
    var isGeneratingGitHubCommitMessage: Bool { gitHubPushController.isGeneratingCommitMessage }
    var gitHubPushingSessionId: String? { gitHubPushController.pushingSessionID }
    var workspaceRecoveryStatus: WorkspaceRecoveryStatus? {
        get { supplementaryDataController.workspaceRecoveryStatus }
        set { supplementaryDataController.workspaceRecoveryStatus = newValue }
    }
    private(set) var isRecoveringWorkspace: Bool {
        get { sessionCommandController.isRecoveringWorkspace }
        set { sessionCommandController.isRecoveringWorkspace = newValue }
    }
    var worktreeCommitReviewPrompt: WorktreeCommitReviewPrompt? {
        projectWorkspaceCommandController.worktreeCommitReviewPrompt
    }
    private(set) var isGeneratingWorktreeCommitMessage: Bool { get { sessionCommandController.isGeneratingWorktreeCommitMessage } set { sessionCommandController.isGeneratingWorktreeCommitMessage = newValue } }
    var selectedScheduledTasks: [ScheduledSessionTask] {
        get { supplementaryDataController.selectedScheduledTasks }
        set { supplementaryDataController.selectedScheduledTasks = newValue }
    }
    var automations: [ScheduledSessionTask] { scheduledTaskController.automations }
    var isLoadingAutomations: Bool { scheduledTaskController.isLoadingAutomations }
    var automationsError: String? { scheduledTaskController.automationsError }
    private(set) var isLoadingScheduledTasks: Bool {
        get { supplementaryDataController.isLoadingScheduledTasks }
        set { supplementaryDataController.isLoadingScheduledTasks = newValue }
    }
    private(set) var scheduledTaskMutationIds: Set<String> {
        get { sessionCommandController.scheduledTaskMutationIds }
        set { sessionCommandController.scheduledTaskMutationIds = newValue }
    }
    var scheduledTaskError: String? {
        get { sessionCommandController.scheduledTaskError }
        set { sessionCommandController.scheduledTaskError = newValue }
    }
    let sessionReplacements = PassthroughSubject<SessionReplacement, Never>()
    let collaborationFlowEvents = PassthroughSubject<TaskCollaborationFlowEvent, Never>()
    let automationTerminalEvents = PassthroughSubject<AutomationTerminalNotificationEvent, Never>()

    let baseURL = CorptieAppEnvironment.backendBaseURL
    lazy var settingsController = BackendSettingsController(
        baseURL: baseURL,
        backendIsOnline: { [weak self] in self?.isOnline ?? false },
        currentError: { [weak self] in self?.lastError },
        reportError: { [weak self] in self?.lastError = $0 },
        onBackendReconnected: { [weak self] in self?.startEventStream() },
        errorMessage: { Self.errorMessage(from: $0) }
    )
    lazy var archivedSessionController = ArchivedSessionController(
        baseURL: baseURL, urlSession: .shared, selection: sessionSelectionController,
        currentError: { [weak self] in self?.lastError },
        reportError: { [weak self] in self?.lastError = $0 }
    )
    lazy var sessionCreationController = SessionCreationController(
        baseURL: baseURL,
        currentSettings: { [weak self] in self?.settings },
        workspacePath: { [weak self] in self?.defaultWorkspacePath ?? "" },
        providerDisplayName: { [weak self] providerID in
            self?.modelCatalog.agentProviders.first(where: { $0.id == providerID })?.displayName
        },
        onCreatedSession: { [weak self] session, selectImmediately in
            self?.acceptCreatedSession(session, selectImmediately: selectImmediately)
        },
        currentError: { [weak self] in self?.lastError },
        reportError: { [weak self] in self?.lastError = $0 },
        currentStatus: { [weak self] in self?.sendStatusMessage },
        reportStatus: { [weak self] in self?.sendStatusMessage = $0 }
    )
    private lazy var timelineReadAPI = SessionTimelineReadAPI(
        baseURL: baseURL, urlSession: .shared,
        timelineDeltaProcessor: timelineDeltaProcessor,
        errorMessage: { Self.errorMessage(from: $0) }
    )
    lazy var messageController = SessionMessageController(
        baseURL: baseURL, commands: sessionCommandController,
        timelineLocalOverlay: timelineLocalOverlay,
        currentSession: { [weak self] in self?.selectedSession },
        currentDetail: { [weak self] in self?.selectedDetail },
        activeSessions: { [weak self] in self?.sessions ?? [] },
        cachedDetail: { [weak self] in self?.cachedDetail(for: $0) },
        storeDetail: { [weak self] detail, sessionID in
            self?.storeCachedDetail(detail, for: sessionID)
        },
        publishReplacement: { [weak self] in self?.publishSessionReplacement($0) },
        selectSession: { [weak self] in self?.select(session: $0) },
        loadWorkspaceRecoveryStatus: { [weak self] session in
            if let self { await self.loadWorkspaceRecoveryStatus(for: session) }
        },
        currentError: { [weak self] in self?.lastError },
        reportError: { [weak self] in self?.lastError = $0 }
    )
    lazy var collaborationConfirmationController = CollaborationConfirmationController(
        baseURL: baseURL, commands: sessionCommandController,
        activeSessions: { [weak self] in self?.sessions ?? [] },
        cachedDetail: { [weak self] in self?.cachedDetail(for: $0) },
        storeDetail: { [weak self] detail, sessionID, timelineRevision in
            self?.storeCachedDetail(detail, for: sessionID, timelineRevision: timelineRevision)
        },
        loadMessages: { [weak self] session in
            if let self { await self.loadSessionMessages(session) }
        },
        reportError: { [weak self] in self?.lastError = $0 }
    )
    lazy var sessionChoiceController = SessionChoiceController(
        baseURL: baseURL, commands: sessionCommandController,
        selectedSession: { [weak self] in self?.selectedSession },
        activeSessions: { [weak self] in self?.sessions ?? [] },
        cachedDetail: { [weak self] in self?.cachedDetail(for: $0) },
        fetchDetail: { [weak self] session in
            if let self { _ = await self.fetchDetail(for: session, reportsErrors: false) }
        },
        sendText: { [weak self] text, session, reloadDetail in
            self?.sendText(text, images: [], to: session, reloadDetail: reloadDetail,
                           isChoiceSelection: true, onSuccess: {})
        },
        markChoiceHandled: { [weak self] choiceID, optionID in
            self?.markChoiceHandled(choiceId: choiceID, selectedOptionId: optionID)
        },
        reportError: { [weak self] in self?.lastError = $0 },
        errorMessage: { Self.errorMessage(from: $0) }
    )
    private lazy var sessionLifecycleController = SessionLifecycleController(
        baseURL: baseURL, commands: sessionCommandController,
        restartActivity: sessionRestartActivityController,
        acceptRoute: { [weak self] in self?.acceptCommittedSessionRoute($0) },
        errorMessage: { Self.errorMessage(from: $0) },
        currentError: { [weak self] in self?.lastError },
        reportError: { [weak self] in self?.lastError = $0 }
    )
    private lazy var sessionOrganizationController = SessionOrganizationController(
        baseURL: baseURL, sessionIndexStore: sessionIndexStore,
        activeSessions: { [weak self] in self?.sessions ?? [] },
        currentSession: { [weak self] in self?.selectedSession },
        closeDetail: { [weak self] in self?.closeDetail() },
        archivedSessionKind: { [weak self] in self?.archivedSessionsKind },
        refreshArchivedSessions: { [weak self] kind in
            if let self { await self.refreshArchivedSessions(sessionKind: kind) }
        },
        currentError: { [weak self] in self?.lastError },
        reportError: { [weak self] in self?.lastError = $0 },
        errorMessage: { Self.errorMessage(from: $0) }
    )
    private lazy var sessionConfigurationController = SessionConfigurationController(
        baseURL: baseURL, commands: sessionCommandController,
        appState: appState, modelCatalog: modelCatalog,
        currentSession: { [weak self] in self?.selectedSession },
        currentModel: { [weak self] in self?.selectedCurrentModel },
        currentError: { [weak self] in self?.lastError },
        reportError: { [weak self] in self?.lastError = $0 },
        errorMessage: { Self.errorMessage(from: $0) }
    )
    private lazy var timelineSyncController = SessionTimelineSyncController(
        baseURL: baseURL, appState: appState,
        timelineDeltaProcessor: timelineDeltaProcessor, timelineReadAPI: timelineReadAPI,
        activeSessions: { [weak self] in self?.sessions ?? [] },
        currentSession: { [weak self] id in
            self?.appState.session(id) ?? self?.archivedSessions.first(where: { $0.id == id })
        },
        currentSelectedSession: { [weak self] in self?.selectedSession },
        mergePending: { [weak self] detail in
            self?.detailByMergingPendingMessages(detail) ?? detail
        },
        storeDetail: { [weak self] detail, sessionID, revision in
            self?.storeCachedDetail(detail, for: sessionID, timelineRevision: revision)
        },
        reportSelectedLoadError: { [weak self] message in
            self?.selectedTimelineLoadError = message
            self?.isLoadingDetail = false
        },
        clearSelectedLoadError: { [weak self] in self?.selectedTimelineLoadError = nil }
    )
    lazy var timelineHistoryController = SessionTimelineHistoryController(
        baseURL: baseURL, selection: sessionSelectionController,
        sessionForID: { [weak self] id in
            self?.sessions.first(where: { $0.id == id })
                ?? self?.archivedSessions.first(where: { $0.id == id })
        },
        detailForSession: { [weak self] id in self?.cachedDetail(for: id) },
        publishSessionDetail: { [weak self] detail, id in
            guard let self else { return }
            if self.selectedSession?.id == id,
               self.viewingHistoricalThreadId == nil {
                self.publishSelectedDetailIfSafe(detail)
            } else {
                self.storeCachedDetail(detail, for: id)
            }
        },
        requestEarlierHistoryPage: { url in
            try await BackendClient.requestEarlierHistoryPage(at: url)
        }
    )
    lazy var sessionForkAPI = SessionForkAPI(baseURL: baseURL, urlSession: .shared)
    private lazy var workspaceActionAPI = ProjectWorkspaceActionAPI(
        baseURL: baseURL, urlSession: .shared,
        errorMessage: { Self.errorMessage(from: $0) }
    )
    private(set) lazy var scheduledTaskController = ScheduledTaskController(
        api: ScheduledTaskAPI(baseURL: baseURL, urlSession: .shared),
        selection: sessionSelectionController,
        supplementary: supplementaryDataController,
        commands: sessionCommandController,
        selectedSession: { [weak self] in self?.selectedSession }
    )
    private lazy var contextReferenceController = SessionContextReferenceController(
        api: SessionContextReferenceAPI(
            baseURL: baseURL, urlSession: .shared,
            validateResponse: { response, data in try Self.requireSuccess(response, data: data) }
        ),
        state: supplementaryDataController,
        selectedSession: { [weak self] in self?.selectedSession },
        reportError: { [weak self] in self?.lastError = $0 }
    )
    var defaultWorkspacePath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("corptie", isDirectory: true).path
    }
    private lazy var eventStream = BackendEventStream(baseURL: baseURL)
    private lazy var eventRouter = BackendEventRouter(ports: .init(
        channelMessage: { [weak self] envelope in
            self?.collaborationFlowEvents.send(envelope.payload.message)
        },
        loadSettings: { [weak self] in
            if let self { await self.loadSettings() }
        },
        syncNewSessionDefaults: { [weak self] in
            if let self { await self.syncNewSessionDefaultsFromPreferences(force: true) }
        },
        loadProviders: { [weak self] in
            if let self { await self.loadProviders() }
        },
        reconcileTimelineRevisions: { [weak self] in
            if let self { await self.reconcileTimelineRevisionIndex() }
        },
        loadAutomations: { [weak self] in
            if let self { await self.loadAutomations() }
        },
        selectedSession: { [weak self] in self?.selectedSession },
        loadScheduledTasks: { [weak self] session in
            if let self { await self.loadScheduledTasks(for: session) }
        },
        scheduleTimelineSync: { [weak self] session, revision in
            self?.scheduleBackgroundTimelineSync(for: session, desiredRevision: revision)
        },
        timelineRevision: { [weak self] sessionID, revision in
            self?.applyTimelineRevisionAdvance(sessionId: sessionID, revision: revision)
        },
        projectStatus: { [weak self] data in
            self?.scheduleSelectedProjectStatusEventRefresh(data: data)
        },
        terminalAutomation: { [weak self] event in
            self?.automationTerminalEvents.send(event)
        },
        automationRefresh: { [weak self] sessionID in
            self?.scheduleAutomationEventRefresh(eventSessionId: sessionID)
        },
        workspaceSwitched: { [weak self] session in
            guard let self else { return }
            self.acceptCommittedSessionRoute(session)
            if self.restartActivityBySessionId[session.id] != nil {
                self.completeRestartActivity(for: session.id)
            }
        },
        workspaceSwitchFailed: { [weak self] sessionID in
            guard let self, self.restartActivityBySessionId[sessionID] != nil else { return }
            self.failRestartActivity(for: sessionID)
        },
        usageEvent: { [weak self] data in self?.applyLiveUsageEvent(data) },
        inventoryEvent: { [weak self] data in self?.applyWorkspaceInventoryEvent(data) },
        sessionCleared: { [weak self] replacement in
            guard let self else { return }
            let wasSelected = self.selectedSession?.id == replacement.previousSessionId
            self.publishSessionReplacement(replacement)
            if wasSelected {
                self.select(session: self.sessions.first(where: { $0.id == replacement.session.id })
                    ?? replacement.session)
            }
        }
    ))
    var coldTimelineLoadTask: Task<Void, Never>?
    private var performanceFixtureStreamTask: Task<Void, Never>?
    private let timelineLocalOverlay = SessionTimelineLocalOverlay()
    private var sessionEventStreamConnected = false
    lazy var usageController = SessionUsageController(
        client: SessionUsageClient(baseURL: baseURL),
        state: supplementaryDataController,
        selectedSessionID: { [weak self] in self?.selectedSession?.id }
    )
    lazy var workspaceStatusController = ProjectWorkspaceStatusController(
        baseURL: baseURL, state: supplementaryDataController,
        selectedSession: { [weak self] in self?.selectedSession },
        projectID: { [weak self] in self?.projectId(for: $0) },
        suppressBackgroundPolling: { [weak self] in self?.suppressBackgroundPolling ?? true },
        errorMessage: { Self.errorMessage(from: $0) }
    )
    lazy var projectWorkspaceCommandController = ProjectWorkspaceCommandController(
        baseURL: baseURL, workspaceActionAPI: workspaceActionAPI,
        workspaceStatusController: workspaceStatusController,
        supplementary: supplementaryDataController, commands: sessionCommandController,
        currentSession: { [weak self] in self?.selectedSession },
        projectID: { [weak self] in self?.projectId(for: $0) },
        onCreatedSession: { [weak self] in
            self?.acceptCreatedSession($0, selectImmediately: true)
        },
        closeDetail: { [weak self] in self?.closeDetail() },
        currentError: { [weak self] in self?.lastError },
        reportError: { [weak self] in self?.lastError = $0 },
        errorMessage: { Self.errorMessage(from: $0) }
    )
    lazy var gitHubPushController = GitHubPushController(
        baseURL: baseURL,
        selectedSession: { [weak self] in self?.selectedSession },
        reportError: { [weak self] in self?.lastError = $0 },
        reportStatus: { [weak self] in self?.sendStatusMessage = $0 },
        refreshStatus: { [weak self] session in
            await self?.loadProjectWorktreeStatus(for: session)
        },
        errorMessage: { Self.errorMessage(from: $0) }
    )

    var isPushingGitHub: Bool {
        gitHubPushingSessionId != nil
    }

    var isSelectedSessionPushingGitHub: Bool {
        gitHubPushingSessionId == selectedSession?.id
    }
    private var appStateCancellable: AnyCancellable?
    private var reachabilityCancellable: AnyCancellable?
    private var pageControllerCancellables = Set<AnyCancellable>()
    private var lastProjectedSessions: [TaskSession]?

    init() {
        sessionSelectionController.objectWillChange
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &pageControllerCancellables)
        appStateCancellable = appState.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.projectSessionsFromAppState() }
        // `isOnline` is authoritative connection state derived from the sync
        // engine's transport outcome, not from a side effect of state emission.
        // A successful snapshot/change-set sets `isReachable`; a failed request
        // or dropped stream clears it. Reacting here guarantees the console and
        // floating panel refresh whenever the server actually becomes reachable
        // (or drops), regardless of whether session content changed.
        // `AppStateStore` is @MainActor, so `$isReachable` already emits on the
        // main actor; no re-dispatch is needed, and a synchronous sink keeps the
        // console/footer refresh on the same run-loop turn as the transition.
        reachabilityCancellable = appState.$isReachable
            .sink { [weak self] reachable in self?.applyConnectionState(reachable: reachable) }
    }

    func start() {
        eventStream.stop()
        coldTimelineLoadTask?.cancel()
        coldTimelineLoadTask = nil
        timelineSyncController.resetRouteTasks()
        performanceFixtureStreamTask?.cancel()
        let chatFeatures = ChatTimelineFeatureFlags.current
        if chatFeatures.fixtureMode == .standard {
            installPerformanceFixture(replaysStreamingUpdates: chatFeatures.replaysStreamingUpdates)
            return
        }
        Task {
            await recoverPendingDataRootMigrationIfNeeded()
            await loadSettings()
            await syncNewSessionDefaultsFromPreferences()
            await loadProviders()
            // Startup requests race the production launch agent. If the
            // canonical Session stream is already connected, an earlier
            // transport error is stale and must not remain in the UI.
            reconcileConnectedPresentation()
        }
        startEventStream()
        AppStateSyncController.shared.start()
        // ActiveTimelineSyncEngine is the only live Timeline transport. Row
        // selection binds resident local state and never creates a second,
        // selected-only detail subscription.
    }

    func stop() {
        eventStream.stop()
        AppStateSyncController.shared.stop()
        coldTimelineLoadTask?.cancel()
        coldTimelineLoadTask = nil
        performanceFixtureStreamTask?.cancel()
        performanceFixtureStreamTask = nil
        usageController.stopRefreshing()
        workspaceStatusController.stopRefreshing()
        scheduledTaskController.cancelEventRefresh()
        timelineSyncController.stop()
    }

    func reportNavigationError(sessionId: String) {
        lastError = L10nFormat("Session %@ could not be loaded.", sessionId)
    }

    private func startEventStream() {
        eventStream.start(
            connected: { [weak self] in
                guard let self else { return }
                self.markBackendConnectedFromSessionStream()
                OperationNotificationManager.shared.recoverJobs()
                if self.appState.isReachable {
                    await self.reconcileTimelineRevisionIndex()
                    if let selectedSession = self.selectedSession {
                        async let automationLoad: Void = self.loadAutomations()
                        async let scheduledTaskLoad: Void = self.loadScheduledTasks(for: selectedSession)
                        _ = await (automationLoad, scheduledTaskLoad)
                    } else {
                        await self.loadAutomations()
                    }
                }
            },
            disconnected: { [weak self] in
                self?.markBackendSessionStreamDisconnected()
            },
            receive: { [weak self] name, data in
                await self?.handleGlobalEvent(name, data: data)
            }
        )
    }

    private func reconcileConnectedPresentation() {
        guard isOnline, lastError != nil else { return }
        lastError = nil
    }

    /// The UI connection light represents the fixed-cost Backend transport.
    /// Store reachability is additive: it enables data surfaces, but a 503
    /// while SQLite is still initializing must not turn an established SSE
    /// connection back into "server disconnected".
    private func applyConnectionState(reachable: Bool) {
        isOnline = reachable || sessionEventStreamConnected
        if isOnline {
            if lastError != nil { lastError = nil }
        } else {
            if let syncError = appState.syncError, lastError != syncError {
                lastError = syncError
            }
        }
    }

    /// The canonical Session SSE stream (`/events`) established a connection.
    /// Reconcile any stale transport error from startup requests that raced the
    /// production launch agent. Store-backed features remain gated by their own
    /// readiness/state even while the transport is connected.
    func markBackendConnectedFromSessionStream() {
        sessionEventStreamConnected = true
        isOnline = true
        if lastError != nil { lastError = nil }
    }

    private func markBackendSessionStreamDisconnected() {
        sessionEventStreamConnected = false
        applyConnectionState(reachable: appState.isReachable)
    }

    func dismissProjectWorktreeActionError() {
        projectWorkspaceCommandController.dismissProjectWorktreeActionError()
    }

    func recordProjectWorktreeActionError(_ message: String) {
        projectWorkspaceCommandController.recordProjectWorktreeActionError(message)
    }

    nonisolated static func applyingSessionCollectionPatch(
        _ patch: SessionCollectionPatchEnvelope,
        to current: [TaskSession]
    ) -> [TaskSession]? {
        var byID = Dictionary(uniqueKeysWithValues: current.map { ($0.id, $0) })
        patch.removedIds.forEach { byID[$0] = nil }
        patch.inserted.forEach { byID[$0.session.id] = $0.session }
        patch.updated.forEach { byID[$0.sessionId] = $0.session }
        if let orderedIDs = patch.orderedIds {
            guard Set(orderedIDs) == Set(byID.keys) else { return nil }
            return orderedIDs.compactMap { byID[$0] }
        }
        let currentIDs = current.map(\.id).filter { byID[$0] != nil }
        let newInsertions = patch.inserted.sorted { $0.index < $1.index }
        var ids = currentIDs
        for insertion in newInsertions where !ids.contains(insertion.session.id) {
            ids.insert(insertion.session.id, at: min(max(0, insertion.index), ids.count))
        }
        guard Set(ids) == Set(byID.keys) else { return nil }
        return ids.compactMap { byID[$0] }
    }

    private func handleGlobalEvent(_ eventName: String, data: String) async {
        await eventRouter.handle(eventName, data: data)
    }

    private func scheduleAutomationEventRefresh(eventSessionId: String?) {
        scheduledTaskController.scheduleEventRefresh(eventSessionId: eventSessionId)
    }

    private func applyWorkspaceInventoryEvent(_ data: String) {
        guard let payload = data.data(using: .utf8),
              let event = try? JSONDecoder().decode(WorkspaceInventoryEventEnvelope.self, from: payload),
              !event.payload.newlyDiscoveredWorkspaces.isEmpty else {
            return
        }
        sendStatusMessage = L10n(
            "A new Git worktree was detected. Ask the Agent to list workspaces or switch to it."
        )
    }
    private func applyLiveUsageEvent(_ data: String) {
        usageController.applyLiveEvent(data)
    }


    private func projectSessionsFromAppState() {
        let nextSessions = sessions
        // `appState.$state` 对任何实体（tasks/works/agents…）变化都会发射，
        // 但这里只关心活动会话集合是否真的变了。相等时短路，避免无关实体的
        // 高频更新反复触发 sessionsDidChange → 下游预加载/列表重算。
        guard nextSessions != lastProjectedSessions else { return }
        let previousSessions = lastProjectedSessions
        let selectedID = sessionSelectionController.selectedSessionID
        let previousSelected = selectedID.flatMap { id in
            previousSessions?.first(where: { $0.id == id })
        }
        let nextSelected = selectedID.flatMap { id in
            nextSessions.first(where: { $0.id == id })
        }
        lastProjectedSessions = nextSessions
        if previousSelected != nextSelected {
            // The selection identity remains controller-owned. Invalidate only
            // the selected surface when its authoritative row changes.
            if let selectedID {
                sessionSelectionController.notifySelectedSessionChanged(selectedID)
            }
        }
        let activeSessionIDs = Set(nextSessions.map(\.id))
        timelineSyncController.retainActiveSessions(activeSessionIDs)
        var residentSessionIDs = activeSessionIDs
        if let selectedSession { residentSessionIDs.insert(selectedSession.id) }
        retainResidentSessionCaches(activeSessionIDs: activeSessionIDs)
        for sessionID in timelineSyncController.pruneKnownRevisions(keeping: residentSessionIDs) {
            SessionTimelineRepository.shared.remove(sessionID)
            collaborationConfirmationController.removePendingConfirmation(for: sessionID)
        }

        let previous = sessionIndexStore.sessions
        let patch = SessionCollectionDiffer.patch(from: previous, to: nextSessions, revision: UInt64(max(0, appState.revision)))
        sessionIndexStore.apply(patch, authoritativeSessions: nextSessions)
        sessionsDidChange.send(nextSessions)
        let previousByID = Dictionary(uniqueKeysWithValues: (previousSessions ?? []).map { ($0.id, $0) })
        for session in nextSessions {
            let desiredRevision = session.timelineRevision ?? 0
            timelineSyncController.noteSessionRevision(session)
            let resident = SessionTimelineRepository.shared.detail(for: session.id) != nil
            // Missing revision zero and a hydrated empty revision-zero window
            // are different states. Use -1 only as the local scheduling
            // sentinel so every active Session is warmed exactly once.
            let localRevision = resident
                ? SessionTimelineRepository.shared.timelineRevision(for: session.id)
                : -1
            if SessionTimelineBackgroundSyncPolicy.shouldSchedule(
                previousServerRevision: previousSessions == nil
                    ? nil
                    : previousByID[session.id]?.timelineRevision ?? 0,
                desiredServerRevision: desiredRevision,
                localRevision: localRevision
            ) {
                scheduleBackgroundTimelineSync(for: session, desiredRevision: desiredRevision)
            }
        }
    }

    func retainResidentSessionCaches(activeSessionIDs: Set<String>? = nil) {
        var residentSessionIDs = activeSessionIDs ?? Set(sessions.map(\.id))
        if let selectedSession { residentSessionIDs.insert(selectedSession.id) }
        SessionTimelineRepository.shared.pin(residentSessionIDs)
        SessionTimelineRepository.shared.prune(to: residentSessionIDs)
        SessionPresentationCache.shared.pin(residentSessionIDs)
        SessionPresentationCache.shared.prune(to: residentSessionIDs)
    }



    func loadContextReferences(for session: TaskSession? = nil) async {
        await contextReferenceController.loadContextReferences(for: session)
    }

    @discardableResult
    func addContextReference(
        to session: TaskSession, type: SessionContextReferenceType,
        targetId: String? = nil, locator: String? = nil, displayName: String? = nil
    ) async -> Bool {
        await contextReferenceController.addContextReference(
            to: session, type: type, targetId: targetId, locator: locator, displayName: displayName
        )
    }

    func setContextReferenceEnabled(_ reference: SessionContextReference, enabled: Bool) async {
        await contextReferenceController.setContextReferenceEnabled(reference, enabled: enabled)
    }

    func refreshContextReference(_ reference: SessionContextReference) async {
        await contextReferenceController.refreshContextReference(reference)
    }

    func deleteContextReference(_ reference: SessionContextReference) async {
        await contextReferenceController.deleteContextReference(reference)
    }

    static func requireSuccess(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw BackendError.message(payload?["error"] as? String ?? "Context reference request failed (HTTP \(http.statusCode)).")
        }
    }

    func closeDetail() {
        usageController.stopRefreshing()
        workspaceStatusController.stopRefreshing()
        coldTimelineLoadTask?.cancel()
        coldTimelineLoadTask = nil
        sessionSelectionController.clear()
        supplementaryDataController.select(nil)
        selectedHistoricalDetail = nil
        viewingHistoricalThreadId = nil
        selectedSessionUsage = nil
        selectedContextReferences = []
        selectedProjectWorktreeStatus = nil
        projectWorktreeLoadError = nil
        workspaceStatusController.invalidateRequests()
        workspaceRecoveryStatus = nil
        gitHubPushController.clearPreparation()
        projectWorkspaceCommandController.clearWorktreeCommitReview()
        isLoadingDetail = false
    }


    private func projectId(for session: TaskSession) -> String? {
        let projectId = session.external?.workspace?.repositoryId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return projectId?.isEmpty == false ? projectId : nil
    }

    func refreshSelectedUsage() async {
        await usageController.refreshSelectedUsage()
    }

    func cachedDetail(for sessionId: String) -> CodexThreadDetail? {
        SessionTimelineRepository.shared.detail(for: sessionId)
    }

    func pendingCollaborationConfirmation(for sessionID: String) -> PendingCollaborationConfirmation? {
        collaborationConfirmationController.pendingConfirmation(for: sessionID)
    }

    func storeCachedDetail(
        _ detail: CodexThreadDetail,
        for sessionId: String,
        timelineRevision: Int? = nil
    ) {
        SessionTimelineRepository.shared.publish(
            detail,
            for: sessionId,
            timelineRevision: timelineRevision
        )
        collaborationConfirmationController.updatePendingConfirmation(from: detail, for: sessionId)
        if viewingHistoricalThreadId == nil,
           selectedSession?.id == sessionId {
            isLoadingDetail = false
        }
    }

    private func removeCachedDetail(for sessionId: String) {
        SessionTimelineRepository.shared.remove(sessionId)
        collaborationConfirmationController.removePendingConfirmation(for: sessionId)
    }

    nonisolated static func pendingCollaborationConfirmation(
        in detail: CodexThreadDetail
    ) -> PendingCollaborationConfirmation? {
        CollaborationConfirmationController.pendingCollaborationConfirmation(in: detail)
    }

    private func reconcileTimelineRevisionIndex() async {
        await timelineSyncController.reconcileTimelineRevisionIndex()
    }

    private func applyTimelineRevisionAdvance(sessionId: String, revision: Int) {
        timelineSyncController.applyTimelineRevisionAdvance(sessionId: sessionId, revision: revision)
    }

    private func scheduleBackgroundTimelineSync(for session: TaskSession, desiredRevision: Int) {
        timelineSyncController.scheduleBackgroundTimelineSync(for: session, desiredRevision: desiredRevision)
    }

    func synchronizeStoredTimeline(
        for session: TaskSession, localRevision: Int, forceSnapshot: Bool = false
    ) async -> Bool {
        await timelineSyncController.synchronizeStoredTimeline(
            for: session, localRevision: localRevision, forceSnapshot: forceSnapshot
        )
    }

    private func acceptCommittedSessionRoute(_ committed: TaskSession) {
        timelineSyncController.acceptCommittedSessionRoute(committed)
    }

    func fetchStoredDetail(
        for session: TaskSession
    ) async -> Result<(detail: CodexThreadDetail, timelineRevision: Int), Error> {
        await timelineSyncController.fetchStoredDetail(for: session)
    }

    @discardableResult


    func interrupt(session: TaskSession, surface: SessionInterruptSurface) {
        sessionLifecycleController.interrupt(session: session, surface: surface)
    }

    func togglePtyConnection(for session: TaskSession) {
        sessionLifecycleController.togglePtyConnection(for: session)
    }

    func reconnect(session: TaskSession) {
        sessionLifecycleController.reconnect(session: session)
    }

    func restart(session: TaskSession) {
        sessionLifecycleController.restart(session: session)
    }

    @discardableResult
    func switchProvider(session: TaskSession, to providerId: String) async -> Bool {
        await sessionLifecycleController.switchProvider(session: session, to: providerId)
    }

    private func completeRestartActivity(for sessionId: String) {
        sessionLifecycleController.completeRestartActivity(for: sessionId)
    }

    private func failRestartActivity(for sessionId: String) {
        sessionLifecycleController.failRestartActivity(for: sessionId)
    }

    func setArchived(_ archived: Bool, session: TaskSession) {
        sessionOrganizationController.setArchived(archived, session: session)
    }

    func setPinned(_ pinned: Bool, session: TaskSession) {
        sessionOrganizationController.setPinned(pinned, session: session)
    }

    func moveSession(draggedSessionId: String, before targetSessionId: String?) {
        sessionOrganizationController.moveSession(
            draggedSessionId: draggedSessionId, before: targetSessionId
        )
    }

    func beginSessionReorder() { sessionOrganizationController.beginSessionReorder() }
    func persistSessionOrder() { sessionOrganizationController.persistSessionOrder() }

    func rename(session: TaskSession, title: String, onSuccess: @escaping () -> Void = {}) {
        sessionOrganizationController.rename(session: session, title: title, onSuccess: onSuccess)
    }

    func delete(session: TaskSession) {
        sessionOrganizationController.delete(session: session)
    }

    func interruptSelectedSession() {
        guard let selectedSession else {
            return
        }
        interrupt(session: selectedSession, surface: .sessionDetailToolbar)
    }

    func switchSelectedCodexModel(to model: CodexModel) {
        sessionConfigurationController.switchSelectedCodexModel(to: model)
    }

    func switchSelectedCodexReasoning(to reasoningLevel: String) {
        sessionConfigurationController.switchSelectedCodexReasoning(to: reasoningLevel)
    }

    func updateSessionPermissions(
        session: TaskSession, sandbox: String, approvalPolicy: String
    ) async -> Bool {
        await sessionConfigurationController.updateSessionPermissions(
            session: session, sandbox: sandbox, approvalPolicy: approvalPolicy
        )
    }

    func reconnectSelectedSession() {
        guard let selectedSession else {
            return
        }
        reconnect(session: selectedSession)
    }



    private func decodeDetail(_ data: Data, for session: TaskSession, threadId: String) async throws -> CodexThreadDetail {
        try await BackendResponseDecoder.detail(
            from: data,
            threadId: threadId,
            authoritativeCwd: session.external?.cwd,
            workspacePath: session.external?.workspace?.path
        )
    }

    private func markChoiceHandled(choiceId: String, selectedOptionId: String) {
        guard let updated = timelineLocalOverlay.markChoiceHandled(
            choiceId: choiceId, selectedOptionId: selectedOptionId, in: selectedDetail
        ) else { return }
        if viewingHistoricalThreadId != nil {
            selectedHistoricalDetail = updated
        } else if let sessionID = selectedSession?.id {
            storeCachedDetail(updated, for: sessionID)
        }
    }

    func applyingHandledChoices(to detail: CodexThreadDetail) -> CodexThreadDetail {
        timelineLocalOverlay.applyingHandledChoices(to: detail)
    }

    var deferredDetailPublishTask: Task<Void, Never>?

    private func publishSelectedDetailIfSafe(_ detail: CodexThreadDetail) {
        if let historicalThreadID = viewingHistoricalThreadId {
            guard detail.id == historicalThreadID else { return }
            if selectedHistoricalDetail == detail { return }
            selectedHistoricalDetail = detail
            return
        }
        guard let currentSession = selectedSession,
              detailBelongsToSelectedSession(detail, currentSession) else { return }
        if let selectedDetail,
           detailPublicationRevision(selectedDetail) == detailPublicationRevision(detail),
           selectedDetail == detail {
            return
        }
        // A row click can land while the mouse button is still physically held
        // (pressedMouseButtons != 0). Publishing on that exact turn risks a
        // transient gesture-driven re-render, so defer by one runloop turn
        // instead of silently dropping the update — dropping it here left the
        // detail view stuck on an empty placeholder with no way to recover.
        guard NSEvent.pressedMouseButtons == 0 else {
            let publicationGeneration = sessionSelectionController.generation
            deferredDetailPublishTask?.cancel()
            deferredDetailPublishTask = Task { @MainActor [weak self] in
                await Task.yield()
                guard let self,
                      self.sessionSelectionController.generation == publicationGeneration,
                      let current = self.selectedSession,
                      self.detailBelongsToSelectedSession(detail, current) else { return }
                self.publishSelectedDetailIfSafe(detail)
            }
            return
        }
        deferredDetailPublishTask?.cancel()
        deferredDetailPublishTask = nil
        ChatPerformanceRecorder.shared.increment(.detailPublishes)
        ChatPerformanceTrace.event("ui.detail.publish", value: detail.items.count)
        storeCachedDetail(detail, for: currentSession.id)
    }

    private func detailBelongsToSelectedSession(_ detail: CodexThreadDetail, _ session: TaskSession) -> Bool {
        let threadId = session.external?.threadId ?? session.id
        return detail.id == threadId
    }

    private func detailPublicationRevision(_ detail: CodexThreadDetail) -> String {
        let tail = detail.items.last
        return [
            detail.id,
            detail.status.rawValue,
            detail.updatedAt,
            "\(detail.items.count)",
            tail?.id ?? "",
            tail?.turnStatus ?? "",
            tail?.status ?? "",
            "\(tail?.text.count ?? 0)",
            String(tail?.text.suffix(64) ?? "")
        ].joined(separator: ":")
    }

    private func installPerformanceFixture(replaysStreamingUpdates: Bool) {
        let fixture = ChatPerformanceTrace.measure("fixture.generate") {
            ChatPerformanceFixture.make()
        }
        appState.installPerformanceFixtureSession(fixture.session)
        archivedSessionController.reset()
        sessionSelectionController.select(fixture.session.id)
        supplementaryDataController.select(fixture.session.id)
        storeCachedDetail(fixture.detail, for: fixture.session.id)
        isLoadingDetail = false
        isOnline = true
        lastError = nil
        ChatPerformanceRecorder.shared.logSnapshot(reason: "fixture-installed")
        guard replaysStreamingUpdates else { return }

        performanceFixtureStreamTask = Task { [weak self] in
            guard let self else { return }
            var detail = fixture.detail
            var lastPublishedAt = ContinuousClock.now
            let fixtureFlags = ChatTimelineFeatureFlags.current
            let finalStep = fixtureFlags.fixtureStreamSteps
            for step in 1...finalStep {
                if Task.isCancelled { return }
                try? await Task.sleep(for: .milliseconds(fixtureFlags.fixtureStreamIntervalMilliseconds))
                if Task.isCancelled { return }
                detail = ChatPerformanceFixture.appendingStreamStep(step, to: detail, finalStep: finalStep)
                ChatPerformanceRecorder.shared.increment(.fixtureStreamingUpdates)
                let flags = ChatTimelineFeatureFlags.current
                let batchInterval = Duration.milliseconds(flags.uiBatchIntervalMilliseconds)
                if ContinuousClock.now - lastPublishedAt >= batchInterval
                    || step == finalStep {
                    publishSelectedDetailIfSafe(detail)
                    lastPublishedAt = .now
                }
                if step.isMultiple(of: 20) {
                    ChatPerformanceRecorder.shared.logSnapshot(reason: "fixture-stream-step-\(step)")
                }
            }
        }
    }

    func detailByMergingPendingMessages(_ detail: CodexThreadDetail) -> CodexThreadDetail {
        let selectedSessionID = selectedSession?.id
        let selectedCachedSessionID: String? = selectedSessionID.flatMap { selectedID in
            cachedDetail(for: selectedID)?.id == detail.id ? selectedID : nil
        }
        guard let sessionID = sessions.first(where: {
            ($0.external?.threadId ?? $0.id) == detail.id
        })?.id ?? selectedCachedSessionID else { return detail }
        return timelineLocalOverlay.reconcile(detail, for: sessionID)
    }

    static func errorMessage(from data: Data) -> String? {
        if let decoded = try? JSONDecoder().decode(BackendErrorResponse.self, from: data) {
            return decoded.error
        }
        return String(data: data, encoding: .utf8)
    }
}

struct ChatImageImportResponse: Decodable {
    let image: ChatImageReference
}

enum SuggestedOptionRouting {
    static func pendingChoiceId(for optionId: String, items: [CodexThreadItem]) -> String? {
        items.reversed().first { item in
            item.type == "choice"
                && item.status != "selected"
                && (item.options ?? []).contains(where: { $0.id == optionId })
        }?.id
    }
}

enum BackendError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let message):
            message
        }
    }
}
