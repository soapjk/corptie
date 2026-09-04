import AppKit
import Combine
import Foundation
import UserNotifications

extension Notification.Name {
    /// 请求在主悬浮窗（液态玻璃）打开某个 session 的对话，userInfo["sessionId"] 传 session id。
    /// 控制台 CorptieTask 详情「打开对话」用，桥接新版控制台与旧版 session 对话视图。
    static let openSessionConversation = Notification.Name("openSessionConversation")
    static let openSessionOverview = Notification.Name("openSessionOverview")
    static let showAgentOrb = Notification.Name("showAgentOrb")
    static let scrollSessionTimelineToTurn = Notification.Name("scrollSessionTimelineToTurn")
}

struct SessionRestartActivity: Equatable {
    let text: String
    let isActive: Bool
}

struct PendingDataRootMigrationRecovery: Codable, Equatable {
    let operationId: String?
    let targetDataRoot: String
    let recordedAt: Date
}

private struct AutomationClientActionEnvelope: Decodable {
    let payload: Payload

    struct Payload: Decodable {
        let sessionId: String
        let runId: String
        let title: String?
        let body: String?
    }
}

private struct GlobalEventReplayRequiredEnvelope: Decodable {
    let latestCursor: Int
}

private struct DataRootMigrationStatusEnvelope: Decodable {
    let operation: DataRootMigrationOperation?
}

private struct DataRootMigrationErrorEnvelope: Decodable {
    let error: String
    let code: String
    let operation: DataRootMigrationOperation?
}

private struct SessionTimelineChangedEventEnvelope: Decodable {
    let payload: Payload

    struct Payload: Decodable {
        let sessionId: String
        let timelineRevision: Int
    }
}

private struct SessionTimelineRevisionIndex: Decodable {
    let sessions: [Entry]

    struct Entry: Decodable {
        let sessionId: String
        let timelineRevision: Int
    }
}

struct ProjectWorktreeIntegrationLaunchGate: Equatable {
    private(set) var isRunning = false

    mutating func begin() -> Bool {
        guard !isRunning else { return false }
        isRunning = true
        return true
    }

    mutating func finish() {
        isRunning = false
    }
}

struct AutomationRefreshCoalescer: Equatable {
    private(set) var isRunning = false
    private(set) var isPending = false

    mutating func request() -> Bool {
        isPending = true
        guard !isRunning else { return false }
        isRunning = true
        return true
    }

    mutating func beginPass() {
        isPending = false
    }

    mutating func completePass() -> Bool {
        guard isPending else {
            isRunning = false
            return false
        }
        return true
    }

    mutating func finish() {
        isRunning = false
        isPending = false
    }
}

enum ScheduledTaskListLoadOutcome: Sendable {
    case success([ScheduledSessionTask])
    case failure(String)
}

@MainActor
final class BackendClient: ObservableObject {
    static let shared = BackendClient()

    private let appState = AppStateStore.shared
    private let timelineDeltaProcessor = SessionTimelineDeltaProcessor()
    var sessions: [TaskSession] { appState.sessions.filter { $0.archived != true } }
    let sessionIndexStore = SessionIndexStore()

    private static let iso8601Formatter = ISO8601DateFormatter()

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
    @Published private(set) var archivedSessions: [TaskSession] = []
    /// Selection has one owner: `SessionSelectionController.selectedSessionID`.
    /// Resolve the value from an authoritative collection instead of retaining
    /// a second mutable Session snapshot that can keep an obsolete status.
    var selectedSession: TaskSession? {
        guard let id = sessionSelectionController.selectedSessionID else { return nil }
        return appState.session(id) ?? archivedSessions.first(where: { $0.id == id })
    }
    @Published private(set) var pendingCollaborationConfirmationsBySessionID: [String: PendingCollaborationConfirmation] = [:]
    @Published private var selectedHistoricalDetail: CodexThreadDetail?
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
    @Published private(set) var viewingHistoricalThreadId: String?
    @Published private(set) var isLoadingDetail = false
    @Published private(set) var selectedTimelineLoadError: String?
    @Published private(set) var earlierHistoryLoadStateBySessionID: [String: EarlierHistoryLoadState] = [:]
    @Published private(set) var bindingVerificationSessionIDs = Set<String>()
    private(set) var isSendingMessage: Bool {
        get { sessionCommandController.isSendingMessage }
        set { sessionCommandController.isSendingMessage = newValue }
    }
    private(set) var sendStatusMessage: String? {
        get { sessionCommandController.sendStatusMessage }
        set { sessionCommandController.sendStatusMessage = newValue }
    }
    @Published private(set) var isOnline = false
    @Published private(set) var lastError: String?
    @Published private(set) var isCreatingTask = false
    @Published private(set) var settings: BackendSettings?
    @Published private(set) var isUpdatingSettings = false
    @Published private(set) var dataRootMigration: DataRootMigrationOperation?
    @Published private(set) var dataRootMigrationPresentationPhase: String?
    private var dataRootMigrationHandoffTasks: [String: Task<Void, Error>] = [:]
    private var completedDataRootMigrationHandoffs: Set<String> = []
    @Published private(set) var isTestingChoiceParser = false
    @Published private(set) var feishuBots: [FeishuBot] = []
    @Published private(set) var feishuProfiles: [FeishuProfile] = []
    @Published private(set) var isUpdatingFeishu = false
    @Published private(set) var codexModels: [CodexModel] = []
    @Published private(set) var agentProviders: [AgentProviderDescriptor] = []
    @Published private(set) var defaultSessionProviderId: String?
    @Published private(set) var codexDefaultModel: String?
    @Published private(set) var codexDefaultReasoningLevel: String?
    @Published private(set) var loadedModelProvider: String?
    @Published private(set) var isLoadingCodexModels = false
    private(set) var isSwitchingModel: Bool { get { sessionCommandController.isSwitchingModel } set { sessionCommandController.isSwitchingModel = newValue } }
    private(set) var isSwitchingReasoning: Bool { get { sessionCommandController.isSwitchingReasoning } set { sessionCommandController.isSwitchingReasoning = newValue } }
    private(set) var connectionTransitionSessionIds: Set<String> { get { sessionCommandController.connectionTransitionSessionIds } set { sessionCommandController.connectionTransitionSessionIds = newValue } }
    private(set) var restartingSessionIds: Set<String> { get { sessionCommandController.restartingSessionIds } set { sessionCommandController.restartingSessionIds = newValue } }
    private(set) var restartActivityBySessionId: [String: SessionRestartActivity] { get { sessionCommandController.restartActivityBySessionId } set { sessionCommandController.restartActivityBySessionId = newValue } }
    @Published private(set) var isLoadingArchivedSessions = false
    @Published private(set) var isLoadingMoreArchivedSessions = false
    @Published private(set) var archivedSessionsHasMore = false
    @Published private(set) var archivedSessionsLoadError: String?
    private var archivedSessionsNextCursor: String?
    private var archivedSessionsKind: SessionKind?
    private(set) var selectedSessionUsage: SessionUsageResponse? {
        get { supplementaryDataController.selectedSessionUsage }
        set { supplementaryDataController.selectedSessionUsage = newValue }
    }
    private(set) var selectedContextReferences: [SessionContextReference] {
        get { supplementaryDataController.selectedContextReferences }
        set { supplementaryDataController.selectedContextReferences = newValue }
    }
    private(set) var isLoadingContextReferences: Bool {
        get { supplementaryDataController.isLoadingContextReferences }
        set { supplementaryDataController.isLoadingContextReferences = newValue }
    }
    private(set) var selectedProjectWorktreeStatus: ProjectWorktreeStatusResponse? {
        get { supplementaryDataController.selectedProjectWorktreeStatus }
        set { supplementaryDataController.selectedProjectWorktreeStatus = newValue }
    }
    private(set) var selectedProjectIntegrationStatus: ProjectIntegrationStatusResponse? {
        get { supplementaryDataController.selectedProjectIntegrationStatus }
        set { supplementaryDataController.selectedProjectIntegrationStatus = newValue }
    }
    private(set) var projectWorktreeLoadError: String? {
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
    private(set) var gitHubPushPreparation: GitHubPushPreparation? { get { sessionCommandController.gitHubPushPreparation } set { sessionCommandController.gitHubPushPreparation = newValue } }
    private(set) var gitHubPushError: String? { get { sessionCommandController.gitHubPushError } set { sessionCommandController.gitHubPushError = newValue } }
    private(set) var isPreparingGitHubPush: Bool { get { sessionCommandController.isPreparingGitHubPush } set { sessionCommandController.isPreparingGitHubPush = newValue } }
    private(set) var isGeneratingGitHubCommitMessage: Bool { get { sessionCommandController.isGeneratingGitHubCommitMessage } set { sessionCommandController.isGeneratingGitHubCommitMessage = newValue } }
    private(set) var gitHubPushingSessionId: String? { get { sessionCommandController.gitHubPushingSessionId } set { sessionCommandController.gitHubPushingSessionId = newValue } }
    private(set) var workspaceRecoveryStatus: WorkspaceRecoveryStatus? {
        get { supplementaryDataController.workspaceRecoveryStatus }
        set { supplementaryDataController.workspaceRecoveryStatus = newValue }
    }
    private(set) var isRecoveringWorkspace: Bool {
        get { sessionCommandController.isRecoveringWorkspace }
        set { sessionCommandController.isRecoveringWorkspace = newValue }
    }
    @Published private(set) var worktreeCommitReviewPrompt: WorktreeCommitReviewPrompt?
    private(set) var isGeneratingWorktreeCommitMessage: Bool { get { sessionCommandController.isGeneratingWorktreeCommitMessage } set { sessionCommandController.isGeneratingWorktreeCommitMessage = newValue } }
    private(set) var selectedScheduledTasks: [ScheduledSessionTask] {
        get { supplementaryDataController.selectedScheduledTasks }
        set { supplementaryDataController.selectedScheduledTasks = newValue }
    }
    @Published private(set) var automations: [ScheduledSessionTask] = []
    @Published private(set) var isLoadingAutomations = false
    @Published private(set) var automationsError: String?
    private(set) var isLoadingScheduledTasks: Bool {
        get { supplementaryDataController.isLoadingScheduledTasks }
        set { supplementaryDataController.isLoadingScheduledTasks = newValue }
    }
    private(set) var scheduledTaskMutationIds: Set<String> {
        get { sessionCommandController.scheduledTaskMutationIds }
        set { sessionCommandController.scheduledTaskMutationIds = newValue }
    }
    private(set) var scheduledTaskError: String? {
        get { sessionCommandController.scheduledTaskError }
        set { sessionCommandController.scheduledTaskError = newValue }
    }
    let sessionReplacements = PassthroughSubject<SessionReplacement, Never>()
    let automationTerminalEvents = PassthroughSubject<AutomationTerminalNotificationEvent, Never>()

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    var defaultWorkspacePath: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("corptie", isDirectory: true).path
    }
    private var eventStreamTask: Task<Void, Never>?
    private var coldTimelineLoadTask: Task<Void, Never>?
    private var routeTimelineSyncTasks: [String: Task<Void, Never>] = [:]
    private var performanceFixtureStreamTask: Task<Void, Never>?
    private var pendingUserMessagesBySessionID: [String: [CodexThreadItem]] = [:]
    private var handledChoiceIds = Set<String>()
    private var knownTimelineRevisionBySessionID: [String: Int] = [:]
    private lazy var activeTimelineSyncEngine = ActiveTimelineSyncEngine(
        localRevision: {
            SessionTimelineRepository.shared.detail(for: $0) == nil
                ? -1
                : SessionTimelineRepository.shared.timelineRevision(for: $0)
        },
        synchronize: { [weak self] session, revision in
            await self?.synchronizeStoredTimeline(for: session, localRevision: revision) ?? false
        }
    )
    private var globalEventCursor = 0
    private var sessionEventStreamConnected = false
    private static let historyPageSize = 200
    private var timelineWindowLoadSessionIDs = Set<String>()
    private var earlierHistoryLoadSessionIDs = Set<String>()
    private var usageRefreshTask: Task<Void, Never>?
    private var usageEventRefreshTask: Task<Void, Never>?
    private var usageBySessionId: [String: SessionUsageResponse] = [:]
    private var automationRefreshCoalescer = AutomationRefreshCoalescer()
    private var automationEventRefreshTask: Task<Void, Never>?
    private var scheduledTaskLoadTasks: [String: Task<ScheduledTaskListLoadOutcome, Never>] = [:]
    private var projectStatusRefreshTask: Task<Void, Never>?
    private var projectStatusEventRefreshTask: Task<Void, Never>?
    private var projectStatusRequestSequence = 0
    private var restartActivityClearTasks: [String: Task<Void, Never>] = [:]

    var isPushingGitHub: Bool {
        gitHubPushingSessionId != nil
    }

    var isSelectedSessionPushingGitHub: Bool {
        gitHubPushingSessionId == selectedSession?.id
    }
    private var hasSyncedNewSessionDefaults = false
    private var sessionReorderRevision = 0
    private var pendingProtectedWorktreeAction: (
        worktree: ProjectWorktreeStatus,
        action: String,
        body: [String: Any]
    )?
    private var appStateCancellable: AnyCancellable?
    private var reachabilityCancellable: AnyCancellable?
    private var pageControllerCancellables = Set<AnyCancellable>()
    private var lastProjectedSessions: [TaskSession]?
    private var completedWorktreeIntegrationGate = ProjectWorktreeIntegrationLaunchGate()

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
        eventStreamTask?.cancel()
        coldTimelineLoadTask?.cancel()
        coldTimelineLoadTask = nil
        routeTimelineSyncTasks.values.forEach { $0.cancel() }
        routeTimelineSyncTasks.removeAll()
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
        eventStreamTask?.cancel()
        eventStreamTask = nil
        AppStateSyncController.shared.stop()
        coldTimelineLoadTask?.cancel()
        coldTimelineLoadTask = nil
        performanceFixtureStreamTask?.cancel()
        performanceFixtureStreamTask = nil
        usageRefreshTask?.cancel()
        usageRefreshTask = nil
        usageEventRefreshTask?.cancel()
        usageEventRefreshTask = nil
        projectStatusRefreshTask?.cancel()
        projectStatusRefreshTask = nil
        projectStatusEventRefreshTask?.cancel()
        projectStatusEventRefreshTask = nil
        automationEventRefreshTask?.cancel()
        automationEventRefreshTask = nil
        activeTimelineSyncEngine.stop()
        knownTimelineRevisionBySessionID.removeAll()
    }

    func reportNavigationError(sessionId: String) {
        lastError = L10nFormat("Session %@ could not be loaded.", sessionId)
    }

    private func startEventStream() {
        eventStreamTask = Task { [weak self] in
            guard let self else {
                return
            }
            while !Task.isCancelled {
                var components = URLComponents(
                    url: self.baseURL.appending(path: "events"),
                    resolvingAgainstBaseURL: false
                )!
                components.queryItems = [
                    URLQueryItem(name: "cursor", value: String(self.globalEventCursor))
                ]
                var request = URLRequest(url: components.url!)
                request.setValue("text/event-stream", forHTTPHeaderField: "accept")
                do {
                    let (bytes, response) = try await URLSession.shared.bytes(for: request)
                    guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                        throw URLError(.badServerResponse)
                    }
                    self.markBackendConnectedFromSessionStream()
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
                    for try await event in ServerSentEventStream.events(from: bytes) {
                        if Task.isCancelled {
                            return
                        }
                        if event.isComment { continue }
                        await self.handleGlobalEvent(event.name, data: event.data)
                        if event.name == "EventReplayRequired",
                           let payload = event.data.data(using: .utf8),
                           let replay = try? JSONDecoder().decode(
                               GlobalEventReplayRequiredEnvelope.self,
                               from: payload
                           ) {
                            self.globalEventCursor = max(0, replay.latestCursor)
                        } else if let eventID = event.id.flatMap(Int.init) {
                            // Advance only after the event handler returns. A
                            // disconnect during handling therefore replays the
                            // event instead of silently acknowledging it.
                            self.globalEventCursor = max(self.globalEventCursor, eventID)
                        }
                    }
                    self.markBackendSessionStreamDisconnected()
                } catch {
                    if Task.isCancelled {
                        return
                    }
                    self.markBackendSessionStreamDisconnected()
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
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
        projectWorktreeActionError = nil
    }

    func recordProjectWorktreeActionError(_ message: String) {
        projectWorktreeActionError = message
        lastError = message
    }

    private func beginProjectWorktreeAction() {
        projectWorktreeActionError = nil
        lastError = nil
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
        if eventName == "BackendStoreReady" {
            // Startup requests are allowed to receive a retryable 503 while the
            // migration Worker is running. Reissue their authoritative reads as
            // soon as the Store crosses its independent readiness boundary.
            await AppStateSyncController.shared.refreshSnapshot()
            await loadSettings()
            await syncNewSessionDefaultsFromPreferences(force: true)
            await loadProviders()
            await reconcileTimelineRevisionIndex()
            await loadAutomations()
            if let selectedSession { await loadScheduledTasks(for: selectedSession) }
            return
        }
        if eventName == "EventReplayRequired" {
            // The bounded wake-event buffer cannot cover this cursor. State and
            // timelines have their own durable authorities, so repair those
            // directly instead of replaying ambiguous side effects.
            await AppStateSyncController.shared.refreshSnapshot()
            await reconcileTimelineRevisionIndex()
            await loadAutomations()
            if let selectedSession {
                await loadScheduledTasks(for: selectedSession)
                scheduleBackgroundTimelineSync(
                    for: selectedSession,
                    desiredRevision: selectedSession.timelineRevision ?? 0
                )
            }
            return
        }
        if eventName == "SessionTimelineChanged" {
            guard let payload = data.data(using: .utf8),
                  let event = try? JSONDecoder().decode(
                    SessionTimelineChangedEventEnvelope.self,
                    from: payload
                  ) else { return }
            applyTimelineRevisionAdvance(
                sessionId: event.payload.sessionId,
                revision: event.payload.timelineRevision
            )
            return
        }
        if eventName == "ProjectWorkspaceChanged"
            || eventName == "ProjectWorktreeIntegrationStarted"
            || eventName == "ProjectWorktreeIntegrationCompleted" {
            scheduleSelectedProjectStatusEventRefresh(data: data)
            return
        }
        if eventName == "AutomationSessionActivationRequested" {
            guard let payload = data.data(using: .utf8),
                  let event = try? JSONDecoder().decode(AutomationClientActionEnvelope.self, from: payload) else { return }
            AppTabRouter.shared.openSession(event.payload.sessionId)
            return
        }
        if eventName == "AutomationLocalNotificationRequested" {
            guard let payload = data.data(using: .utf8),
                  let event = try? JSONDecoder().decode(AutomationClientActionEnvelope.self, from: payload),
                  let center = SystemNotificationCenter.currentIfAvailable() else { return }
            let content = UNMutableNotificationContent()
            content.title = event.payload.title ?? L10n("Corptie Automation")
            content.body = event.payload.body ?? L10n("Automation completed.")
            content.userInfo = ["sessionId": event.payload.sessionId]
            try? await center.add(UNNotificationRequest(
                identifier: "automation:\(event.payload.runId)",
                content: content,
                trigger: nil
            ))
            return
        }
        if ScheduledSessionEventMapping.authoritativeEventNames.contains(eventName) {
            if ScheduledSessionEventMapping.terminalNotificationEventNames.contains(eventName),
               let event = AutomationTerminalNotificationEvent.decode(eventName: eventName, data: data) {
                automationTerminalEvents.send(event)
            }
            let payload = data.data(using: .utf8)
            scheduleAutomationEventRefresh(eventSessionId: payload.flatMap(ScheduledSessionEventMapping.sessionId))
            // Timeline projection and its revision event are emitted by the
            // backend mutation; selected state never pulls detail here.
            return
        }
        if eventName == "SessionWorkspaceSwitched" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionWorkspaceSwitchedEventEnvelope.self, from: payload) {
                acceptCommittedSessionRoute(event.payload.session)
                if restartActivityBySessionId[event.payload.session.id] != nil {
                    completeRestartActivity(for: event.payload.session.id)
                }
            }
            if let selectedSession { await loadScheduledTasks(for: selectedSession) }
            scheduleSelectedProjectStatusEventRefresh(data: data)
            return
        }
        if eventName == "SessionWorkspaceSwitchFailed" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionTransitionEventEnvelope.self, from: payload),
               let sessionId = event.payload.sessionId,
               restartActivityBySessionId[sessionId] != nil {
                failRestartActivity(for: sessionId)
            }
            return
        }
        if eventName == "ProviderSwitchPending" {
            return
        }
        if eventName == "ProviderSwitched" {
            return
        }
        if eventName == "ProviderSessionChanged" {
            return
        }
        if eventName == "SessionUsageUpdated" {
            applyLiveUsageEvent(data)
            return
        }
        if eventName == "WorkspaceInventoryChanged" {
            applyWorkspaceInventoryEvent(data)
            return
        }
        if eventName == "SessionCleared" {
            if let payload = data.data(using: .utf8),
               let event = try? JSONDecoder().decode(SessionClearedEventEnvelope.self, from: payload) {
                let wasSelected = selectedSession?.id == event.payload.previousSessionId
                publishSessionReplacement(event.payload)
                if wasSelected {
                    select(session: sessions.first(where: { $0.id == event.payload.session.id }) ?? event.payload.session)
                }
                return
            }
            return
        }
    }

    private func scheduleAutomationEventRefresh(eventSessionId: String?) {
        guard automationEventRefreshTask == nil else { return }
        automationEventRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(150))
            guard let self, !Task.isCancelled else { return }
            defer { self.automationEventRefreshTask = nil }
            async let automationLoad: Void = self.loadAutomations()
            if let selectedSession = self.selectedSession {
                let selectedLogicalSessionId = selectedSession.external?.logicalSessionId ?? selectedSession.id
                if eventSessionId == nil
                    || eventSessionId == selectedLogicalSessionId
                    || eventSessionId == selectedSession.id {
                    async let selectedLoad: Void = self.loadScheduledTasks(for: selectedSession)
                    _ = await (automationLoad, selectedLoad)
                    return
                }
            }
            await automationLoad
        }
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
        guard let payload = data.data(using: .utf8),
              let event = try? JSONDecoder().decode(SessionUsageEventEnvelope.self, from: payload),
              selectedSession?.id == event.payload.sessionId else {
            return
        }
        let currentAccount = selectedSessionUsage?.account ?? CodexAccountUsage(
            available: nil,
            provider: "codex",
            model: nil,
            rateLimits: nil,
            rateLimitsByLimitId: nil
        )
        let usage = SessionUsageResponse(
            account: currentAccount,
            context: event.payload.context,
            resetForecast: selectedSessionUsage?.resetForecast
        )
        usageBySessionId[event.payload.sessionId] = usage
        selectedSessionUsage = usage
        scheduleUsageRefreshAfterLiveUpdate(sessionID: event.payload.sessionId)
    }

    private func scheduleUsageRefreshAfterLiveUpdate(sessionID: String) {
        usageEventRefreshTask?.cancel()
        usageEventRefreshTask = Task { [weak self] in
            do {
                // Token-usage notifications may arrive in a short burst. One
                // authoritative account read after the burst keeps the plan
                // balance current without issuing a request for every event.
                try await Task.sleep(for: .seconds(1))
            } catch {
                return
            }
            guard let self, self.selectedSession?.id == sessionID else { return }
            await self.refreshSelectedUsage()
        }
    }

    func loadSettings() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "settings"))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            settings = try JSONDecoder().decode(BackendSettings.self, from: data)
            dataRootMigration = settings?.dataRootMigration
            dataRootMigrationPresentationPhase = settings?.dataRootMigration?.phase
        } catch {
            lastError = error.localizedDescription
        }
    }

    func syncNewSessionDefaultsFromPreferences(force: Bool = false) async {
        guard isOnline, force || !hasSyncedNewSessionDefaults else { return }

        let defaults = CorptieAppEnvironment.userDefaults
        let sandbox = defaults.string(forKey: "newTask.defaultSandboxMode") ?? "workspace-write"
        let approvalPolicy = defaults.string(forKey: "newTask.defaultApprovalPolicy") ?? "on-request"
        let codexModel = nonEmptyPreference(defaults.string(forKey: "newTask.defaultCodexModel"))
        let codexReasoningLevel = nonEmptyPreference(defaults.string(forKey: "newTask.defaultCodexReasoningLevel"))
        let claudeModel = nonEmptyPreference(defaults.string(forKey: "newTask.defaultClaudeModel"))
        if !force,
           settings?.newSessionDefaults?.sandbox == sandbox,
           settings?.newSessionDefaults?.approvalPolicy == approvalPolicy,
           codexModel == nil || settings?.newSessionDefaults?.codexModel == codexModel,
           codexReasoningLevel == nil || settings?.newSessionDefaults?.codexReasoningLevel == codexReasoningLevel,
           claudeModel == nil || settings?.newSessionDefaults?.claudeModel == claudeModel {
            hasSyncedNewSessionDefaults = true
            return
        }

        do {
            var newSessionDefaults: [String: Any] = [
                "sandbox": sandbox,
                "approvalPolicy": approvalPolicy
            ]
            if let codexModel {
                newSessionDefaults["codexModel"] = codexModel
            }
            if let codexReasoningLevel {
                newSessionDefaults["codexReasoningLevel"] = codexReasoningLevel
            }
            if let claudeModel {
                newSessionDefaults["claudeModel"] = claudeModel
            }
            var request = URLRequest(url: baseURL.appending(path: "settings"))
            request.httpMethod = "PATCH"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "newSessionDefaults": newSessionDefaults
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw URLError(.badServerResponse)
            }
            settings = try JSONDecoder().decode(BackendSettings.self, from: data)
            hasSyncedNewSessionDefaults = true
        } catch {
            hasSyncedNewSessionDefaults = false
        }
    }

    func loadFeishuBots() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "feishu/bots"))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            feishuBots = try JSONDecoder().decode(FeishuBotsResponse.self, from: data).bots
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func loadFeishuProfiles() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "feishu/profiles"))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            feishuProfiles = try JSONDecoder().decode(FeishuProfilesResponse.self, from: data).profiles
            if lastError?.contains("Feishu") == true {
                lastError = nil
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

    @discardableResult
    func addFeishuBot(appId: String, appSecret: String) async -> Bool {
        let trimmedAppId = appId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedSecret = appSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedAppId.isEmpty, !trimmedSecret.isEmpty else {
            lastError = L10n("Feishu App ID and App Secret are required.")
            return false
        }
        return await performFeishuMutation(method: "POST", path: "feishu/bots", body: [
            "appId": trimmedAppId,
            "appSecret": trimmedSecret,
            "brand": "feishu"
        ])
    }

    @discardableResult
    func addFeishuBot(profile: String) async -> Bool {
        let trimmedProfile = profile.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProfile.isEmpty else {
            lastError = L10n("lark-cli Profile is required.")
            return false
        }
        return await performFeishuMutation(method: "POST", path: "feishu/bots", body: [
            "profile": trimmedProfile
        ])
    }

    @discardableResult
    func setFeishuBotEnabled(_ bot: FeishuBot, enabled: Bool) async -> Bool {
        await performFeishuMutation(method: "PATCH", path: "feishu/bots/\(bot.id)", body: ["enabled": enabled])
    }

    @discardableResult
    func deleteFeishuBot(_ bot: FeishuBot) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bots/\(bot.id)")
    }

    @discardableResult
    func releaseFeishuSession(for bot: FeishuBot) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bots/\(bot.id)/assignment")
    }

    @discardableResult
    func revokeFeishuBinding(_ binding: FeishuBinding) async -> Bool {
        await performFeishuMutation(method: "DELETE", path: "feishu/bindings/\(binding.id)")
    }

    func createFeishuPairingCode(for bot: FeishuBot) async -> Result<FeishuPairingCodeResponse, Error> {
        isUpdatingFeishu = true
        defer { isUpdatingFeishu = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "feishu/bots/\(bot.id)/pairing-code"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [:])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not create pairing code.")
            }
            let pairing = try JSONDecoder().decode(FeishuPairingCodeResponse.self, from: data)
            lastError = nil
            return .success(pairing)
        } catch {
            lastError = error.localizedDescription
            return .failure(error)
        }
    }

    private func performFeishuMutation(method: String, path: String, body: [String: Any]? = nil) async -> Bool {
        isUpdatingFeishu = true
        defer { isUpdatingFeishu = false }
        do {
            var request = URLRequest(url: baseURL.appending(path: path))
            request.httpMethod = method
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Feishu gateway request failed.")
            }
            lastError = nil
            await loadFeishuBots()
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func updateDataRoot(_ dataRoot: String) async {
        await updateSettings(dataRoot: dataRoot, choiceParser: settings?.choiceParser, codexBackend: settings?.codexBackend, agentProxy: settings?.agentProxy, gateway: settings?.gateway)
    }

    @discardableResult
    func updateSettings(dataRoot: String, choiceParser: ChoiceParserSettings?, codexBackend: CodexBackendSettings? = nil, codeDiff: CodeDiffSettings? = nil, agentProxy: AgentProxySettings? = nil, gateway: GatewaySettings? = nil) async -> Bool {
        let trimmed = dataRoot.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            lastError = L10n("Data root is required.")
            return false
        }

        isUpdatingSettings = true
        defer { isUpdatingSettings = false }

        let migrationRequested = !DataRootMigrationPresentation.pathsEqual(settings?.dataRoot, trimmed)
        if migrationRequested {
            dataRootMigrationPresentationPhase = "preflight"
            persistPendingDataRootMigration(targetDataRoot: trimmed)
        }
        let migrationStatusTask: Task<Void, Never>? = migrationRequested
            ? Task { [weak self] in
                while !Task.isCancelled {
                    await self?.refreshDataRootMigrationStatus(expectedTarget: trimmed)
                    do {
                        try await Task.sleep(for: .milliseconds(250))
                    } catch {
                        return
                    }
                }
            }
            : nil
        defer { migrationStatusTask?.cancel() }

        do {
            var request = URLRequest(url: baseURL.appending(path: "settings"))
            request.httpMethod = "PATCH"
            // A verified migration can hash and copy many gigabytes. The
            // progress endpoint owns liveness; this request must not inherit
            // the short timeout used by ordinary settings updates.
            request.timeoutInterval = 60 * 60
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = ["dataRoot": trimmed]
            if migrationRequested, let activeDataRoot = settings?.dataRoot {
                body["expectedSourceDataRoot"] = activeDataRoot
            }
            if let choiceParser {
                body["choiceParser"] = [
                    "provider": choiceParser.provider,
                    "openaiBaseURL": choiceParser.openaiBaseURL,
                    "openaiApiKey": choiceParser.openaiApiKey,
                    "openaiModel": choiceParser.openaiModel,
                    "localCommand": choiceParser.localCommand,
                    "localArgs": choiceParser.localArgs,
                    "localModel": choiceParser.localModel,
                    "timeoutMs": choiceParser.timeoutMs
                ]
            }
            if let codexBackend {
                body["codexBackend"] = [
                    "mode": codexBackend.mode
                ]
            }
            if let codeDiff {
                body["codeDiff"] = ["tool": codeDiff.tool]
            }
            if let agentProxy {
                body["agentProxy"] = agentProxyBody(agentProxy)
            }
            if let gateway {
                body["gateway"] = ["trustedWorkspaces": gateway.trustedWorkspaces]
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            if !(200..<300).contains(httpResponse.statusCode) {
                if migrationRequested {
                    clearPendingDataRootMigration()
                }
                if let failure = try? JSONDecoder().decode(DataRootMigrationErrorEnvelope.self, from: data) {
                    if let operation = failure.operation {
                        dataRootMigration = operation
                        dataRootMigrationPresentationPhase = operation.phase
                    }
                    throw BackendError.message("\(failure.code): \(failure.error)")
                }
                throw BackendError.message(Self.errorMessage(from: data) ?? "Bad server response")
            }
            let updatedSettings = try JSONDecoder().decode(BackendSettings.self, from: data)
            settings = updatedSettings
            dataRootMigration = updatedSettings.dataRootMigration
            dataRootMigrationPresentationPhase = updatedSettings.dataRootMigration?.phase
            if let operation = updatedSettings.dataRootMigration, operation.restartRequired {
                try await completeDataRootMigrationHandoff(operation)
            }
            lastError = nil
            return true
        } catch {
            if migrationRequested,
               let current = settings,
               DataRootMigrationPresentation.pathsEqual(current.dataRoot, trimmed),
               dataRootMigration?.phase == "completed" {
                lastError = nil
                return true
            }
            if migrationRequested,
               let operation = dataRootMigration,
               DataRootMigrationPresentation.pathsEqual(operation.targetDataRoot, trimmed),
               operation.restartRequired || dataRootMigrationHandoffTasks[operation.operationId] != nil {
                do {
                    try await completeDataRootMigrationHandoff(operation)
                    lastError = nil
                    return true
                } catch {
                    lastError = error.localizedDescription
                    return false
                }
            }
            lastError = error.localizedDescription
            return false
        }
    }

    private func refreshDataRootMigrationStatus(expectedTarget: String) async {
        do {
            let (data, response) = try await URLSession.shared.data(
                from: baseURL.appending(path: "data-root-migrations/current")
            )
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return }
            let status = try JSONDecoder().decode(DataRootMigrationStatusEnvelope.self, from: data)
            guard let operation = status.operation,
                  DataRootMigrationPresentation.pathsEqual(operation.targetDataRoot, expectedTarget) else { return }
            dataRootMigration = operation
            dataRootMigrationPresentationPhase = operation.phase
            if operation.restartRequired {
                try await completeDataRootMigrationHandoff(operation)
            }
        } catch {
            // A disconnect is expected after the selector is committed and the
            // host replaces the Backend. The reconnect loop owns that phase.
            if !(error is CancellationError) {
                lastError = error.localizedDescription
            }
        }
    }

    private func completeDataRootMigrationHandoff(_ operation: DataRootMigrationOperation) async throws {
        if completedDataRootMigrationHandoffs.contains(operation.operationId) {
            return
        }
        if let existing = dataRootMigrationHandoffTasks[operation.operationId] {
            try await existing.value
            return
        }

        persistPendingDataRootMigration(operation)
        let task = Task { @MainActor [weak self] in
            guard let self else { throw CancellationError() }
            try await CorptieBackendSupervisor.restartBackendForDataRootMigration()
            self.dataRootMigrationPresentationPhase = "reconnecting"
            try await self.reconnectAfterDataRootMigration(
                operationId: operation.operationId,
                targetDataRoot: operation.targetDataRoot
            )
        }
        dataRootMigrationHandoffTasks[operation.operationId] = task
        defer { dataRootMigrationHandoffTasks.removeValue(forKey: operation.operationId) }
        try await task.value
        completedDataRootMigrationHandoffs.insert(operation.operationId)
    }

    private func reconnectAfterDataRootMigration(operationId: String, targetDataRoot: String) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(45))
        while ContinuousClock.now < deadline {
            do {
                let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "settings"))
                if let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 {
                    let current = try JSONDecoder().decode(BackendSettings.self, from: data)
                    if current.dataRoot == targetDataRoot,
                       current.dataRootMigration?.operationId == operationId,
                       current.dataRootMigration?.phase == "completed" {
                        settings = current
                        dataRootMigration = current.dataRootMigration
                        dataRootMigrationPresentationPhase = current.dataRootMigration?.phase
                        clearPendingDataRootMigration()
                        AppStateSyncController.shared.start()
                        startEventStream()
                        return
                    }
                }
            } catch {
                // The verified old Backend is expected to disconnect while the
                // host replaces it. Keep this transition inside migration UI.
            }
            try await Task.sleep(for: .milliseconds(350))
        }
        throw BackendError.message(L10n("The Backend did not reconnect from the new Data Root in time."))
    }

    private static let pendingDataRootMigrationKey = "dataRootMigration.pendingRecovery"

    private func persistPendingDataRootMigration(_ operation: DataRootMigrationOperation) {
        persistPendingDataRootMigration(
            targetDataRoot: operation.targetDataRoot,
            operationId: operation.operationId
        )
    }

    private func persistPendingDataRootMigration(targetDataRoot: String, operationId: String? = nil) {
        let value = PendingDataRootMigrationRecovery(
            operationId: operationId,
            targetDataRoot: targetDataRoot,
            recordedAt: Date()
        )
        if let data = try? JSONEncoder().encode(value) {
            CorptieAppEnvironment.userDefaults.set(data, forKey: Self.pendingDataRootMigrationKey)
            CorptieAppEnvironment.userDefaults.synchronize()
        }
    }

    private func clearPendingDataRootMigration() {
        CorptieAppEnvironment.userDefaults.removeObject(forKey: Self.pendingDataRootMigrationKey)
        CorptieAppEnvironment.userDefaults.synchronize()
    }

    private func recoverPendingDataRootMigrationIfNeeded() async {
        guard let data = CorptieAppEnvironment.userDefaults.data(forKey: Self.pendingDataRootMigrationKey),
              let pending = try? JSONDecoder().decode(PendingDataRootMigrationRecovery.self, from: data) else {
            return
        }
        do {
            if (try? await fetchSettingsForDataRootRecovery()) == nil {
                try await CorptieBackendSupervisor.ensureBackendRunningForPendingDataRootMigration()
            }
            let deadline = ContinuousClock.now.advanced(by: .seconds(60 * 60))
            while ContinuousClock.now < deadline {
                let current = try await fetchSettingsForDataRootRecovery()
                settings = current
                dataRootMigration = current.dataRootMigration
                dataRootMigrationPresentationPhase = current.dataRootMigration?.phase

                if DataRootMigrationPresentation.pathsEqual(current.dataRoot, pending.targetDataRoot),
                   current.dataRootMigration?.phase == "completed" {
                    clearPendingDataRootMigration()
                    return
                }
                guard let operation = current.dataRootMigration,
                      DataRootMigrationPresentation.pathsEqual(operation.targetDataRoot, pending.targetDataRoot),
                      pending.operationId == nil || pending.operationId == operation.operationId else {
                    clearPendingDataRootMigration()
                    return
                }
                if operation.phase == "failed" {
                    clearPendingDataRootMigration()
                    return
                }
                if operation.restartRequired {
                    try await completeDataRootMigrationHandoff(operation)
                    return
                }
                try await Task.sleep(for: .milliseconds(350))
            }
            throw BackendError.message(L10n("The Backend did not reconnect from the new Data Root in time."))
        } catch {
            // Keep the durable recovery marker. A later App launch or manual
            // retry resumes the same operation instead of starting a second one.
            lastError = L10nFormat("Data Root recovery is pending: %@", error.localizedDescription)
        }
    }

    private func fetchSettingsForDataRootRecovery() async throws -> BackendSettings {
        let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "settings"))
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(BackendSettings.self, from: data)
    }

    func testChoiceParser(_ choiceParser: ChoiceParserSettings, agentProxy: AgentProxySettings? = nil) async -> Result<String, Error> {
        isTestingChoiceParser = true
        defer { isTestingChoiceParser = false }

        do {
            var request = URLRequest(url: baseURL.appending(path: "settings/choice-parser/test"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = [
                "choiceParser": [
                    "provider": choiceParser.provider,
                    "openaiBaseURL": choiceParser.openaiBaseURL,
                    "openaiApiKey": choiceParser.openaiApiKey,
                    "openaiModel": choiceParser.openaiModel,
                    "localCommand": choiceParser.localCommand,
                    "localArgs": choiceParser.localArgs,
                    "localModel": choiceParser.localModel,
                    "timeoutMs": choiceParser.timeoutMs
                ]
            ]
            if let agentProxy {
                body["agentProxy"] = agentProxyBody(agentProxy)
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            let decoded = try JSONDecoder().decode(ChoiceParserTestResponse.self, from: data)
            if !(200..<300).contains(httpResponse.statusCode) || !decoded.ok {
                throw BackendError.message(decoded.error ?? "Choice parser test failed.")
            }
            lastError = nil
            return .success(choiceParserTestMessage(durationMs: decoded.durationMs))
        } catch {
            lastError = error.localizedDescription
            return .failure(error)
        }
    }

    func loadModelsForSelectedSession(forceRefresh: Bool = false) async {
        let provider = selectedSession?.external?.provider ?? "codex-pty"
        await loadModels(for: provider, forceRefresh: forceRefresh)
    }

    func loadProviders() async {
        do {
            let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: "providers"))
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let catalog = try JSONDecoder().decode(AgentProvidersResponse.self, from: data)
            agentProviders = catalog.providers
            defaultSessionProviderId = catalog.providers.canonicalProviderId(for: catalog.defaultProviderId)
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func providerDisplayName(for providerIdentity: String?) -> String? {
        guard let providerIdentity else { return nil }
        let fallback = providerIdentity.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !fallback.isEmpty else { return nil }
        return agentProviders.displayName(for: fallback) ?? fallback
    }

    func loadModels(for provider: String, forceRefresh: Bool = false) async {
        if isLoadingCodexModels {
            return
        }
        isLoadingCodexModels = true
        defer { isLoadingCodexModels = false }

        do {
            var components = URLComponents(url: baseURL.appending(path: "providers/\(provider)/models"), resolvingAgainstBaseURL: false)!
            if forceRefresh {
                components.queryItems = [URLQueryItem(name: "refresh", value: "true")]
            }
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            let decoded = try JSONDecoder().decode(CodexModelsResponse.self, from: data)
            loadedModelProvider = provider
            codexDefaultModel = decoded.currentModel
            codexDefaultReasoningLevel = decoded.currentReasoningLevel
            codexModels = decoded.models
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    func lookupCodexSession(_ sessionId: String) async throws -> CodexSessionLookupResponse {
        let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedSessionId.isEmpty else {
            throw BackendError.message("Session ID is required.")
        }

        let url = baseURL
            .appending(path: "codex")
            .appending(path: "sessions")
            .appending(path: trimmedSessionId)
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        let decoded = try? JSONDecoder().decode(CodexSessionLookupResponse.self, from: data)
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw BackendError.message(decoded?.error ?? String(data: data, encoding: .utf8) ?? "Codex session not found.")
        }
        if let decoded {
            return decoded
        }
        throw URLError(.cannotParseResponse)
    }

    /// A successful command response is merged into the canonical AppStateStore
    /// synchronously so the list has read-your-write behavior. The revisioned
    /// snapshot/SSE stream then reconciles the returned projection.
    func acceptCreatedSession(_ session: TaskSession, selectImmediately: Bool = true) {
        let accepted = appState.acceptCreatedSession(session)
        if selectImmediately { select(session: accepted) }
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
        activeTimelineSyncEngine.retainActiveSessions(activeSessionIDs)
        var residentSessionIDs = activeSessionIDs
        if let selectedSession { residentSessionIDs.insert(selectedSession.id) }
        retainResidentSessionCaches(activeSessionIDs: activeSessionIDs)
        for sessionID in knownTimelineRevisionBySessionID.keys where !residentSessionIDs.contains(sessionID) {
            knownTimelineRevisionBySessionID[sessionID] = nil
            SessionTimelineRepository.shared.remove(sessionID)
            pendingCollaborationConfirmationsBySessionID[sessionID] = nil
        }

        let previous = sessionIndexStore.sessions
        let patch = SessionCollectionDiffer.patch(from: previous, to: nextSessions, revision: UInt64(max(0, appState.revision)))
        sessionIndexStore.apply(patch, authoritativeSessions: nextSessions)
        sessionsDidChange.send(nextSessions)
        let previousByID = Dictionary(uniqueKeysWithValues: (previousSessions ?? []).map { ($0.id, $0) })
        for session in nextSessions {
            let desiredRevision = session.timelineRevision ?? 0
            knownTimelineRevisionBySessionID[session.id] = max(
                knownTimelineRevisionBySessionID[session.id] ?? 0,
                desiredRevision
            )
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

    private func retainResidentSessionCaches(activeSessionIDs: Set<String>? = nil) {
        var residentSessionIDs = activeSessionIDs ?? Set(sessions.map(\.id))
        if let selectedSession { residentSessionIDs.insert(selectedSession.id) }
        SessionTimelineRepository.shared.pin(residentSessionIDs)
        SessionTimelineRepository.shared.prune(to: residentSessionIDs)
        SessionPresentationCache.shared.pin(residentSessionIDs)
        SessionPresentationCache.shared.prune(to: residentSessionIDs)
    }

    func refreshArchivedSessions(sessionKind: SessionKind? = nil) async {
        guard !isLoadingArchivedSessions, !isLoadingMoreArchivedSessions else { return }
        archivedSessionsKind = sessionKind
        isLoadingArchivedSessions = true
        defer { isLoadingArchivedSessions = false }
        await loadArchivedSessionPage(reset: true)
    }

    func loadMoreArchivedSessions() async {
        guard archivedSessionsHasMore,
              archivedSessionsNextCursor != nil,
              !isLoadingArchivedSessions,
              !isLoadingMoreArchivedSessions else { return }
        isLoadingMoreArchivedSessions = true
        defer { isLoadingMoreArchivedSessions = false }
        await loadArchivedSessionPage(reset: false)
    }

    /// Resolves one archived Session through an indexed lookup. Deep links do
    /// not walk every archive page just to locate a single durable Session.
    func loadArchivedSession(id: String) async -> TaskSession? {
        do {
            var components = URLComponents(url: baseURL.appending(path: "sessions"), resolvingAgainstBaseURL: false)!
            components.queryItems = [
                URLQueryItem(name: "archived", value: "true"),
                URLQueryItem(name: "sessionId", value: id),
                URLQueryItem(name: "limit", value: "1")
            ]
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }
            guard let session = try JSONDecoder().decode(SessionsResponse.self, from: data).sessions.first,
                  session.archived == true else { return nil }
            if let index = archivedSessions.firstIndex(where: { $0.id == session.id }) {
                archivedSessions[index] = session
            } else {
                archivedSessions.append(session)
            }
            archivedSessionsLoadError = nil
            return session
        } catch {
            archivedSessionsLoadError = error.localizedDescription
            return nil
        }
    }

    private func loadArchivedSessionPage(reset: Bool) async {
        do {
            var components = URLComponents(url: baseURL.appending(path: "sessions"), resolvingAgainstBaseURL: false)!
            var queryItems = [
                URLQueryItem(name: "archived", value: "true"),
                URLQueryItem(name: "limit", value: "50")
            ]
            if let archivedSessionsKind {
                queryItems.append(URLQueryItem(name: "sessionKind", value: archivedSessionsKind.rawValue))
            }
            if !reset, let archivedSessionsNextCursor {
                queryItems.append(URLQueryItem(name: "cursor", value: archivedSessionsNextCursor))
            }
            components.queryItems = queryItems
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard let httpResponse = response as? HTTPURLResponse, httpResponse.statusCode == 200 else {
                throw URLError(.badServerResponse)
            }

            let decoded = try JSONDecoder().decode(SessionsResponse.self, from: data)
            let pageSessions = decoded.sessions.filter { $0.archived == true }
            let explicitlyArchivedSessions: [TaskSession]
            if reset {
                explicitlyArchivedSessions = pageSessions
            } else {
                var byID = Dictionary(uniqueKeysWithValues: archivedSessions.map { ($0.id, $0) })
                pageSessions.forEach { byID[$0.id] = $0 }
                explicitlyArchivedSessions = archivedSessions.compactMap { byID.removeValue(forKey: $0.id) }
                    + pageSessions.compactMap { byID.removeValue(forKey: $0.id) }
            }
            if archivedSessions != explicitlyArchivedSessions {
                let selectedID = sessionSelectionController.selectedSessionID
                let previousSelected = selectedID.flatMap { id in
                    archivedSessions.first(where: { $0.id == id })
                }
                archivedSessions = explicitlyArchivedSessions
                let nextSelected = selectedID.flatMap { id in
                    explicitlyArchivedSessions.first(where: { $0.id == id })
                }
                if previousSelected != nextSelected, let selectedID {
                    sessionSelectionController.notifySelectedSessionChanged(selectedID)
                }
            }
            archivedSessionsHasMore = decoded.page?.hasMore ?? false
            archivedSessionsNextCursor = decoded.page?.nextCursor
            archivedSessionsLoadError = nil
            if lastError != nil {
                lastError = nil
            }
        } catch {
            let message = error.localizedDescription
            archivedSessionsLoadError = message
            if lastError != message {
                lastError = message
            }
        }
    }

    func createPtyTask(title: String, command: String, arguments: [String], initialInput: String, cwd: String, onNameConflict: @escaping (String) -> Void = { _ in }, onSuccess: @escaping () -> Void = {}) {
        let trimmedCommand = command.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCommand.isEmpty else {
            lastError = L10n("Command is required.")
            return
        }
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "providerId": "pty",
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "command": trimmedCommand,
                    "args": arguments,
                    "initialInput": initialInput,
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    let message = httpResponse.statusCode == 409
                        ? L10n("A session with this name already exists.")
                        : decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }
                guard let session = decoded?.session else {
                    throw URLError(.cannotParseResponse)
                }

                acceptCreatedSession(session, selectImmediately: false)
                onSuccess()
                sendStatusMessage = L10n("Started PTY agent")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func createCodexPtyTask(
        title: String,
        prompt: String,
        cwd: String,
        existingSessionId: String = "",
        sandbox: String = "workspace-write",
        approvalPolicy: String = "on-request",
        model: String = "",
        reasoningLevel: String = "",
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedExistingSessionId = existingSessionId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedReasoningLevel = reasoningLevel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }

            do {
                let usesAppServer = settings?.codexBackend?.mode != "pty" && trimmedExistingSessionId.isEmpty
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
                    "providerId": usesAppServer ? "codex-app-server" : "codex-pty",
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "prompt": trimmedPrompt.isEmpty ? "Reply exactly: Ready" : trimmedPrompt,
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd,
                    "sandbox": sandbox,
                    "approvalPolicy": approvalPolicy
                ]
                if !trimmedModel.isEmpty {
                    body["model"] = trimmedModel
                }
                if !trimmedReasoningLevel.isEmpty {
                    body["reasoningLevel"] = trimmedReasoningLevel
                }
                if !usesAppServer {
                    body["prompt"] = trimmedPrompt
                    body["existingSessionId"] = trimmedExistingSessionId
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    let message = httpResponse.statusCode == 409
                        ? L10n("A session with this name already exists.")
                        : decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }
                guard let session = decoded?.session else {
                    throw URLError(.cannotParseResponse)
                }

                acceptCreatedSession(session, selectImmediately: false)
                onSuccess()
                sendStatusMessage = usesAppServer ? L10n("Started Codex App Server session") : L10n("Started Codex CLI")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func createClaudeTask(
        title: String,
        prompt: String,
        cwd: String,
        sandbox: String = "workspace-write",
        approvalPolicy: String = "on-request",
        model: String = "",
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
                    "providerId": "claude-sdk",
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Reply exactly: Ready" : prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd,
                    "sandbox": sandbox,
                    "approvalPolicy": approvalPolicy
                ]
                if !trimmedModel.isEmpty {
                    body["model"] = trimmedModel
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    let message = httpResponse.statusCode == 409
                        ? L10n("A session with this name already exists.")
                        : decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }
                guard let session = decoded?.session else {
                    throw URLError(.cannotParseResponse)
                }

                acceptCreatedSession(session, selectImmediately: false)
                onSuccess()
                sendStatusMessage = L10n("Started Claude Code")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func createProviderTask(
        providerId: String,
        title: String,
        prompt: String,
        cwd: String,
        sandbox: String = "workspace-write",
        approvalPolicy: String = "on-request",
        model: String = "",
        reasoningLevel: String = "",
        onNameConflict: @escaping (String) -> Void = { _ in },
        onSuccess: @escaping () -> Void = {}
    ) {
        let trimmedProviderId = providerId.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedProviderId.isEmpty, !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = [
                    "providerId": trimmedProviderId,
                    "title": title.trimmingCharacters(in: .whitespacesAndNewlines),
                    "prompt": prompt.trimmingCharacters(in: .whitespacesAndNewlines),
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd,
                    "sandbox": sandbox,
                    "approvalPolicy": approvalPolicy
                ]
                if !model.isEmpty { body["model"] = model }
                if !reasoningLevel.isEmpty { body["reasoningLevel"] = reasoningLevel }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreatePtySessionResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    throw BackendError.message(decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response")
                }
                guard let session = decoded?.session else {
                    throw URLError(.cannotParseResponse)
                }
                acceptCreatedSession(session, selectImmediately: false)
                onSuccess()
                let providerName = agentProviders.first(where: { $0.id == trimmedProviderId })?.displayName ?? trimmedProviderId
                sendStatusMessage = L10nFormat("Started %@", providerName)
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func respondToCodexApproval(option: CodexApprovalOption) {
        guard let session = selectedSession else {
            sendStatusMessage = L10n("No Codex approval is active.")
            return
        }
        respondToCodexApproval(option: option, to: session)
    }

    func respondToCodexApproval(option: CodexApprovalOption, to session: TaskSession) {
        Task {
            isSendingMessage = true
            sendStatusMessage = L10n("Selecting Codex option...")
            defer { isSendingMessage = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/approve"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "optionId": option.id,
                    "optionIndex": option.index ?? 0,
                    "itemType": "approval",
                    "approved": option.role?.localizedCaseInsensitiveContains("deny") != true
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? "Bad server response")
                }

                sendStatusMessage = L10nFormat("Selected %@", option.label)
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Approval failed: %@", error.localizedDescription)
            }
        }
    }

    func respondToCodexApproval(approved: Bool) {
        let fallback = CodexApprovalOption(
            id: approved ? "approve" : "deny",
            label: approved ? L10n("Approve") : L10n("Deny"),
            role: approved ? "approve" : "deny",
            index: approved ? 0 : 1,
            selected: approved
        )
        respondToCodexApproval(option: fallback)
    }

    func respondToPtyChoice(option: CodexApprovalOption, choiceId: String? = nil, in targetSession: TaskSession? = nil) {
        guard let session = targetSession ?? selectedSession else {
            sendStatusMessage = L10n("No terminal choice is active.")
            return
        }

        Task {
            await submitChoice(option: option, choiceId: choiceId, in: session)
        }
    }

    func respondToSuggestedOption(_ option: CodexApprovalOption, in session: TaskSession) {
        Task {
            let detail = cachedDetail(for: session.id)
            if let choiceId = SuggestedOptionRouting.pendingChoiceId(
                for: option.id,
                items: detail?.items ?? []
            ) {
                await submitChoice(option: option, choiceId: choiceId, in: session)
            } else {
                sendText(
                    option.label,
                    images: [],
                    to: session,
                    reloadDetail: selectedSession?.id == session.id,
                    isChoiceSelection: true,
                    onSuccess: {}
                )
            }
        }
    }

    private func submitChoice(option: CodexApprovalOption, choiceId: String?, in session: TaskSession) async {
        isSendingMessage = true
        sendStatusMessage = L10n("Selecting option...")
        defer { isSendingMessage = false }

        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/approve"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = [
                "optionId": option.id,
                "optionIndex": option.index ?? 0,
                "itemType": "choice",
                "approved": true
            ]
            if let choiceId, !choiceId.isEmpty {
                body["choiceId"] = choiceId
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Bad server response")
            }

            if let choiceId, !choiceId.isEmpty {
                markChoiceHandled(choiceId: choiceId, selectedOptionId: option.id)
            }
            sendStatusMessage = L10nFormat("Selected %@", option.label)
        } catch {
            lastError = error.localizedDescription
            sendStatusMessage = L10nFormat("Choice failed: %@", error.localizedDescription)
        }
    }

    func createCodexTask(prompt: String, cwd: String, onNameConflict: @escaping (String) -> Void = { _ in }, onSuccess: @escaping () -> Void = {}) {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedCwd = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else {
            lastError = L10n("Task prompt is required.")
            return
        }
        guard !isCreatingTask else { return }
        isCreatingTask = true

        Task {
            defer { isCreatingTask = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "providerId": "codex-app-server",
                    "prompt": trimmedPrompt,
                    "cwd": trimmedCwd.isEmpty ? defaultWorkspacePath : trimmedCwd
                ])

                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(CreateCodexThreadResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409, let suggestedTitle = decoded?.suggestedTitle {
                        onNameConflict(suggestedTitle)
                        return
                    }
                    let message = httpResponse.statusCode == 409
                        ? L10n("A session with this name already exists.")
                        : decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(message)
                }

                onSuccess()
                sendStatusMessage = decoded?.warning ?? "Started Codex"
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Create failed: %@", error.localizedDescription)
            }
        }
    }

    func select(session: TaskSession) {
        PerfStopwatch.event("会话切换.select", value: 1)
        coldTimelineLoadTask?.cancel()
        coldTimelineLoadTask = nil
        deferredDetailPublishTask?.cancel()
        deferredDetailPublishTask = nil
        viewingHistoricalThreadId = nil
        selectedHistoricalDetail = nil
        let generation = sessionSelectionController.select(session.id)
        selectedTimelineLoadError = nil
        supplementaryDataController.select(session.id)
        retainResidentSessionCaches()
        selectedScheduledTasks = []
        scheduledTaskError = nil
        let cachedDetail = cachedDetail(for: session.id)
        // Publish a cache hit in the same event turn as the row selection. If
        // this waits for the selection Task below, SwiftUI briefly enters the
        // empty/loading branch even though the messages are already resident.
        isLoadingDetail = cachedDetail == nil
        selectedSessionUsage = usageBySessionId[session.id]
        selectedContextReferences = []
        usageRefreshTask?.cancel()
        usageEventRefreshTask?.cancel()
        usageEventRefreshTask = nil
        selectedProjectWorktreeStatus = nil
        selectedProjectIntegrationStatus = nil
        projectWorktreeLoadError = nil
        projectStatusRequestSequence &+= 1
        workspaceRecoveryStatus = nil
        projectStatusRefreshTask?.cancel()
        projectStatusEventRefreshTask?.cancel()
        projectStatusEventRefreshTask = nil
        Task { [weak self] in
            await Task.yield()
            guard let self,
                  self.sessionSelectionController.generation == generation,
                  self.selectedSession?.id == session.id else {
                return
            }
            // State Sync already carries the Backend's binding-scoped
            // readiness cache. Re-probing a Session whose exact active
            // projection is ready makes the composer flash a client-created
            // "verifying" state on every row click. Dispatch still performs
            // the authoritative Provider probe before sending, while a
            // genuinely not-ready selection keeps this recovery probe.
            if Self.selectionRequiresProviderBindingVerification(
                sessionIsReady: self.selectedSession?.isReady == true
            ) {
                Task { [weak self] in
                    await self?.verifyProviderBinding(for: session, expectedSelectionGeneration: generation)
                }
            }
            Task { [weak self] in
                await self?.loadScheduledTasks(for: session, expectedSelectionGeneration: generation)
            }
            // Every supplementary request starts after local selection and
            // Timeline binding have committed. None can enter the click path.
            self.usageRefreshTask = Task { [weak self] in
                while !Task.isCancelled {
                    await self?.loadUsage(for: session)
                    try? await Task.sleep(for: .seconds(30))
                    if Task.isCancelled { return }
                }
            }
            self.startProjectStatusFallbackRefresh(for: session, refreshImmediately: true)
            if session.resolvedSessionKind == .assistantChat || session.resolvedSessionKind == .workChat {
                // References are supplementary metadata. Do not put them in
                // front of the message snapshot on the critical click path.
                Task { [weak self] in await self?.loadContextReferences(for: session) }
            }
            // Active Sessions are normally resident before selection. A cold
            // cache (notably an archived Session) performs one Corptie-local
            // snapshot load after selection has committed; it never opens a
            // Provider connection or a second selected-detail stream.
            if cachedDetail == nil {
                self.coldTimelineLoadTask = Task { [weak self] in
                    guard !Task.isCancelled, let self,
                          self.sessionSelectionController.generation == generation,
                          self.selectedSession?.id == session.id,
                          self.selectedDetail == nil else { return }
                    _ = await self.synchronizeStoredTimeline(for: session, localRevision: 0)
                }
            }
        }
    }

    nonisolated static func selectionRequiresProviderBindingVerification(
        sessionIsReady: Bool
    ) -> Bool {
        !sessionIsReady
    }

    private func verifyProviderBinding(
        for session: TaskSession,
        expectedSelectionGeneration: UInt64
    ) async {
        bindingVerificationSessionIDs.insert(session.id)
        defer { bindingVerificationSessionIDs.remove(session.id) }
        do {
            var request = URLRequest(
                url: baseURL.appending(path: "sessions/\(session.id)/actions/probe-binding")
            )
            request.httpMethod = "POST"
            let (data, response) = try await URLSession.shared.data(for: request)
            try Self.requireSuccess(response, data: data)
            await AppStateSyncController.shared.refreshSnapshot()
        } catch {
            // The Backend records the authoritative unavailable reason before
            // returning. Refresh that projection instead of inventing a
            // client-only Provider status from the transport error.
            await AppStateSyncController.shared.refreshSnapshot()
        }
        guard sessionSelectionController.generation == expectedSelectionGeneration else { return }
    }

    func reloadSelectedSessionMessages() async {
        guard let session = selectedSession else { return }
        coldTimelineLoadTask?.cancel()
        coldTimelineLoadTask = nil
        selectedTimelineLoadError = nil
        isLoadingDetail = cachedDetail(for: session.id) == nil
        let localRevision = SessionTimelineRepository.shared.detail(for: session.id) == nil
            ? 0
            : SessionTimelineRepository.shared.timelineRevision(for: session.id)
        _ = await synchronizeStoredTimeline(for: session, localRevision: localRevision)
    }

    func loadSessionMessages(_ session: TaskSession) async {
        let localRevision = SessionTimelineRepository.shared.detail(for: session.id) == nil
            ? 0
            : SessionTimelineRepository.shared.timelineRevision(for: session.id)
        _ = await synchronizeStoredTimeline(for: session, localRevision: localRevision)
    }

    func loadContextReferences(for session: TaskSession? = nil) async {
        guard let target = session ?? selectedSession,
              target.resolvedSessionKind == .assistantChat || target.resolvedSessionKind == .workChat else {
            selectedContextReferences = []
            return
        }
        isLoadingContextReferences = true
        defer { isLoadingContextReferences = false }
        do {
            let url = baseURL.appending(path: "sessions/\(target.id)/context-references")
            let (data, response) = try await URLSession.shared.data(from: url)
            try Self.requireSuccess(response, data: data)
            let references = try JSONDecoder().decode(SessionContextReferenceListEnvelope.self, from: data).references
            if selectedSession?.id == target.id {
                selectedContextReferences = references
            }
            lastError = nil
        } catch {
            lastError = error.localizedDescription
        }
    }

    @discardableResult
    func addContextReference(
        to session: TaskSession,
        type: SessionContextReferenceType,
        targetId: String? = nil,
        locator: String? = nil,
        displayName: String? = nil
    ) async -> Bool {
        var body: [String: Any] = ["targetType": type.rawValue]
        if let targetId { body["targetId"] = targetId }
        if let locator { body["locator"] = locator }
        if let displayName, !displayName.isEmpty { body["displayName"] = displayName }
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/context-references"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            try Self.requireSuccess(response, data: data)
            await loadContextReferences(for: session)
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func setContextReferenceEnabled(_ reference: SessionContextReference, enabled: Bool) async {
        await updateContextReference(reference, body: ["enabled": enabled])
    }

    func refreshContextReference(_ reference: SessionContextReference) async {
        guard let session = selectedSession else { return }
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/context-references/\(reference.referenceId)/refresh"))
            request.httpMethod = "POST"
            let (data, response) = try await URLSession.shared.data(for: request)
            try Self.requireSuccess(response, data: data)
            await loadContextReferences(for: session)
        } catch {
            lastError = error.localizedDescription
        }
    }

    func deleteContextReference(_ reference: SessionContextReference) async {
        guard let session = selectedSession else { return }
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/context-references/\(reference.referenceId)"))
            request.httpMethod = "DELETE"
            let (data, response) = try await URLSession.shared.data(for: request)
            try Self.requireSuccess(response, data: data)
            await loadContextReferences(for: session)
        } catch {
            lastError = error.localizedDescription
        }
    }

    private func updateContextReference(_ reference: SessionContextReference, body: [String: Any]) async {
        guard let session = selectedSession else { return }
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/context-references/\(reference.referenceId)"))
            request.httpMethod = "PATCH"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            try Self.requireSuccess(response, data: data)
            await loadContextReferences(for: session)
        } catch {
            lastError = error.localizedDescription
        }
    }

    private static func requireSuccess(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw BackendError.message(payload?["error"] as? String ?? "Context reference request failed (HTTP \(http.statusCode)).")
        }
    }

    func closeDetail() {
        usageRefreshTask?.cancel()
        usageRefreshTask = nil
        usageEventRefreshTask?.cancel()
        usageEventRefreshTask = nil
        projectStatusRefreshTask?.cancel()
        projectStatusRefreshTask = nil
        projectStatusEventRefreshTask?.cancel()
        projectStatusEventRefreshTask = nil
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
        projectStatusRequestSequence &+= 1
        workspaceRecoveryStatus = nil
        gitHubPushPreparation = nil
        gitHubPushError = nil
        worktreeCommitReviewPrompt = nil
        isLoadingDetail = false
    }

    func refreshSelectedProjectWorktrees() async {
        guard let selectedSession else { return }
        await loadProjectWorktreeStatus(for: selectedSession)
    }

    func applicationDidBecomeActive() {
        guard let selectedSession else { return }
        startProjectStatusFallbackRefresh(for: selectedSession, refreshImmediately: true)
    }

    func applicationDidResignActive() {
        projectStatusRefreshTask?.cancel()
        projectStatusRefreshTask = nil
        projectStatusEventRefreshTask?.cancel()
        projectStatusEventRefreshTask = nil
    }

    private func startProjectStatusFallbackRefresh(
        for session: TaskSession,
        refreshImmediately: Bool
    ) {
        projectStatusRefreshTask?.cancel()
        guard !suppressBackgroundPolling else {
            projectStatusRefreshTask = nil
            return
        }
        projectStatusRefreshTask = Task { [weak self] in
            if refreshImmediately { await self?.loadWorkspaceStatus(for: session) }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                await self?.loadWorkspaceStatus(for: session)
            }
        }
    }

    private func loadWorkspaceStatus(for session: TaskSession) async {
        if projectId(for: session) != nil {
            await loadProjectWorktreeStatus(for: session)
        } else {
            await loadWorkspaceRecoveryStatus(for: session)
        }
    }

    private func scheduleSelectedProjectStatusEventRefresh(data: String) {
        guard let session = selectedSession else { return }
        if let eventProjectId = Self.projectId(fromEventData: data),
           eventProjectId != projectId(for: session) {
            return
        }
        projectStatusEventRefreshTask?.cancel()
        projectStatusEventRefreshTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard !Task.isCancelled, self?.selectedSession?.id == session.id else { return }
            await self?.loadProjectWorktreeStatus(for: session)
        }
    }

    nonisolated private static func projectId(fromEventData data: String) -> String? {
        guard let bytes = data.data(using: .utf8),
              let envelope = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let payload = envelope["payload"] as? [String: Any] else { return nil }
        return payload["projectId"] as? String
            ?? payload["repositoryId"] as? String
            ?? (payload["run"] as? [String: Any])?["repositoryId"] as? String
    }

    func prepareGitHubPush() {
        guard let session = selectedSession, !isPreparingGitHubPush, !isPushingGitHub else { return }
        Task {
            isPreparingGitHubPush = true
            gitHubPushError = nil
            defer { isPreparingGitHubPush = false }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "sessions/\(session.id)/github-push/prepare")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not prepare GitHub push."))
                }
                guard selectedSession?.id == session.id else { return }
                gitHubPushPreparation = try JSONDecoder().decode(GitHubPushPreparation.self, from: data)
            } catch {
                gitHubPushError = error.localizedDescription
                lastError = error.localizedDescription
            }
        }
    }

    func cancelGitHubPush() {
        guard !isPushingGitHub else { return }
        gitHubPushPreparation = nil
        gitHubPushError = nil
    }

    func generateGitHubCommitMessage() async -> String? {
        guard let session = selectedSession,
              let preparation = gitHubPushPreparation,
              preparation.dirty,
              !isGeneratingGitHubCommitMessage,
              !isPushingGitHub else { return nil }
        isGeneratingGitHubCommitMessage = true
        gitHubPushError = nil
        defer { isGeneratingGitHubCommitMessage = false }
        do {
            var request = URLRequest(
                url: baseURL.appending(path: "sessions/\(session.id)/github-push/commit-message")
            )
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "confirmationToken": preparation.confirmationToken
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(
                    Self.errorMessage(from: data) ?? L10n("Could not generate commit message.")
                )
            }
            let result = try JSONDecoder().decode(GitHubCommitMessageSuggestion.self, from: data)
            guard selectedSession?.id == session.id,
                  gitHubPushPreparation?.confirmationToken == preparation.confirmationToken else {
                return nil
            }
            return result.commitMessage
        } catch {
            if gitHubPushPreparation?.confirmationToken == preparation.confirmationToken {
                gitHubPushError = error.localizedDescription
            }
            return nil
        }
    }

    func confirmGitHubPush(
        commitMessage: String? = nil,
        privateFilesDecision: String? = nil,
        neverRemindPrivateFiles: Bool = false
    ) {
        guard let session = selectedSession,
              let preparation = gitHubPushPreparation,
              !isPushingGitHub,
              !isGeneratingGitHubCommitMessage else { return }

        // Confirmation ends the modal interaction. The potentially slow commit and
        // network push continue independently and are represented in the header.
        gitHubPushingSessionId = session.id
        gitHubPushPreparation = nil
        gitHubPushError = nil
        sendStatusMessage = L10n("Pushing to GitHub…")

        Task {
            defer {
                if gitHubPushingSessionId == session.id {
                    gitHubPushingSessionId = nil
                }
            }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "sessions/\(session.id)/github-push/confirm")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = ["confirmationToken": preparation.confirmationToken]
                if let commitMessage {
                    body["commitMessage"] = commitMessage
                }
                if let privateFilesDecision {
                    body["privateFilesDecision"] = privateFilesDecision
                    body["neverRemindPrivateFiles"] = neverRemindPrivateFiles
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("GitHub push failed."))
                }
                let result = try JSONDecoder().decode(GitHubPushResult.self, from: data)
                gitHubPushPreparation = nil
                sendStatusMessage = result.committed
                    ? L10n("Changes committed and pushed to GitHub")
                    : L10n("Branch pushed to GitHub")
                SessionCompletionSoundManager.playGitHubPushSuccess()
                if selectedSession?.id == session.id {
                    await loadProjectWorktreeStatus(for: session)
                }
            } catch {
                gitHubPushError = error.localizedDescription
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("GitHub push failed: %@", error.localizedDescription)
            }
        }
    }

    private func loadProjectWorktreeStatus(for session: TaskSession) async {
        guard selectedSession?.id == session.id else { return }
        projectStatusRequestSequence &+= 1
        let requestSequence = projectStatusRequestSequence
        if selectedProjectWorktreeStatus == nil {
            projectWorktreeLoadError = nil
        }
        do {
            let url: URL
            if let projectId = projectId(for: session) {
                let base = baseURL.appending(path: "projects/\(projectId)/workspaces")
                if let activeWorkspaceId = session.external?.workspace?.id,
                   !activeWorkspaceId.isEmpty,
                   var components = URLComponents(url: base, resolvingAgainstBaseURL: false) {
                    components.queryItems = [
                        URLQueryItem(name: "activeWorkspaceId", value: activeWorkspaceId)
                    ]
                    url = components.url ?? base
                } else {
                    url = base
                }
            } else {
                url = baseURL.appending(path: "sessions/\(session.id)/project-worktrees")
            }
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                if selectedSession?.id == session.id,
                   requestSequence == projectStatusRequestSequence {
                    projectWorktreeLoadError = Self.errorMessage(from: data)
                        ?? L10n("Could not load project worktrees")
                }
                await loadWorkspaceRecoveryStatus(for: session)
                return
            }
            let status = try JSONDecoder().decode(ProjectWorktreeStatusResponse.self, from: data)
            guard selectedSession?.id == session.id,
                  requestSequence == projectStatusRequestSequence else { return }
            selectedProjectWorktreeStatus = status
            projectWorktreeLoadError = nil
            workspaceRecoveryStatus = nil
            await loadProjectIntegrationStatus(for: session, projectId: status.project.repositoryId)
        } catch {
            if selectedSession?.id == session.id,
               requestSequence == projectStatusRequestSequence {
                projectWorktreeLoadError = error.localizedDescription
            }
            await loadWorkspaceRecoveryStatus(for: session)
        }
    }

    private func loadProjectIntegrationStatus(for session: TaskSession, projectId: String) async {
        guard selectedSession?.id == session.id,
              let workId = session.workId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !workId.isEmpty else {
            selectedProjectIntegrationStatus = nil
            return
        }
        do {
            let url = baseURL.appending(
                path: "projects/\(projectId)/works/\(workId)/integrations"
            )
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                selectedProjectIntegrationStatus = nil
                return
            }
            let result = try JSONDecoder().decode(ProjectIntegrationStatusResponse.self, from: data)
            guard selectedSession?.id == session.id else { return }
            selectedProjectIntegrationStatus = result
        } catch {
            selectedProjectIntegrationStatus = nil
        }
    }

    func integrateCompletedWorktrees() {
        guard completedWorktreeIntegrationGate.begin() else {
            recordProjectWorktreeActionError(L10n("Worktree integration is already running."))
            return
        }
        guard let session = selectedSession else {
            completedWorktreeIntegrationGate.finish()
            recordProjectWorktreeActionError(L10n("Select a Session before starting Worktree integration."))
            return
        }
        guard let projectId = projectId(for: session) else {
            completedWorktreeIntegrationGate.finish()
            recordProjectWorktreeActionError(L10n("The selected Session is not attached to a repository workspace."))
            return
        }
        guard let workId = session.workId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !workId.isEmpty else {
            completedWorktreeIntegrationGate.finish()
            recordProjectWorktreeActionError(L10n("The selected Session is not attached to an Work."))
            return
        }
        beginProjectWorktreeAction()
        isIntegratingCompletedWorktrees = true
        Task {
            defer {
                completedWorktreeIntegrationGate.finish()
                isIntegratingCompletedWorktrees = false
            }
            do {
                var request = URLRequest(url: baseURL.appending(
                    path: "projects/\(projectId)/works/\(workId)/integrations"
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        Self.errorMessage(from: data) ?? L10n("Could not integrate completed Worktrees.")
                    )
                }
                selectedProjectIntegrationStatus = try JSONDecoder().decode(
                    ProjectIntegrationStatusResponse.self,
                    from: data
                )
                let counts = selectedProjectIntegrationStatus?.latestRun?.counts
                sendStatusMessage = L10nFormat(
                    "Integrated %d Worktrees; %d have conflicts; %d failed",
                    counts?.integrated ?? 0,
                    counts?.conflicts ?? 0,
                    counts?.failed ?? 0
                )
                if let failed = counts?.failed, failed > 0 {
                    recordProjectWorktreeActionError(L10nFormat(
                        "Integration finished with %d failed Worktrees. Review the failure details below.",
                        failed
                    ))
                }
                await loadProjectWorktreeStatus(for: session)
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func createIntegrationConflictCorptieTask(runId: String, agentId: String, title: String? = nil) {
        guard let session = selectedSession,
              let projectId = projectId(for: session),
              let workId = session.workId,
              !isCreatingIntegrationConflictCorptieTask else { return }
        Task {
            beginProjectWorktreeAction()
            isCreatingIntegrationConflictCorptieTask = true
            defer { isCreatingIntegrationConflictCorptieTask = false }
            do {
                var request = URLRequest(url: baseURL.appending(
                    path: "projects/\(projectId)/works/\(workId)/integrations/\(runId)/conflict-task"
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                var body: [String: Any] = ["agentId": agentId]
                if let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    body["title"] = title
                }
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        Self.errorMessage(from: data) ?? L10n("Could not create the conflict-resolution CorptieTask.")
                    )
                }
                let result = try JSONDecoder().decode(
                    ProjectIntegrationConflictCorptieTaskResponse.self,
                    from: data
                )
                if var current = selectedProjectIntegrationStatus {
                    current = ProjectIntegrationStatusResponse(
                        projectId: current.projectId,
                        work: current.work,
                        mainHeadOid: current.mainHeadOid,
                        eligibleWorktrees: current.eligibleWorktrees,
                        excludedWorktrees: current.excludedWorktrees,
                        eligibleAgents: current.eligibleAgents,
                        latestRun: result.run
                    )
                    selectedProjectIntegrationStatus = current
                }
                if let createdSession = result.session {
                    acceptCreatedSession(createdSession, selectImmediately: true)
                }
                sendStatusMessage = result.reused
                    ? L10n("Opened the existing conflict-resolution CorptieTask")
                    : L10n("Created and started the conflict-resolution CorptieTask")
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    private func loadWorkspaceRecoveryStatus(for session: TaskSession) async {
        guard selectedSession?.id == session.id else { return }
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/workspace/recovery")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return }
            let status = try JSONDecoder().decode(WorkspaceRecoveryStatus.self, from: data)
            guard selectedSession?.id == session.id else { return }
            workspaceRecoveryStatus = status.orphaned ? status : nil
        } catch {
            // Recovery is supplementary and must not hide the existing session history.
        }
    }

    func recoverSelectedWorkspace(action: String, targetWorktreeId: String? = nil) {
        guard let session = selectedSession, !isRecoveringWorkspace else { return }
        Task {
            isRecoveringWorkspace = true
            lastError = nil
            defer { isRecoveringWorkspace = false }
            do {
                var body: [String: Any] = ["action": action]
                if let targetWorktreeId { body["targetWorktreeId"] = targetWorktreeId }
                var request = URLRequest(
                    url: baseURL.appending(path: "sessions/\(session.id)/workspace/recovery")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Workspace recovery failed."))
                }
                workspaceRecoveryStatus = nil
                sendStatusMessage = action == "rebuild"
                    ? L10n("Workspace rebuilt")
                    : L10n("Session switched to an available Worktree")
                await loadWorkspaceStatus(for: session)
            } catch {
                lastError = error.localizedDescription
                await loadWorkspaceRecoveryStatus(for: session)
            }
        }
    }

    func initializeProjectToolset(update: Bool = false) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let action = update ? "update" : "initialize"
        Task {
            beginProjectWorktreeAction()
            isLoadingProjectWorktrees = true
            defer { isLoadingProjectWorktrees = false }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "projects/\(projectId)/development-service/actions/\(action)")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not initialize project tools."))
                }
                sendStatusMessage = update
                    ? L10n("Project tools update started")
                    : L10n("Project tools initialization started")
                try? await Task.sleep(for: .seconds(1))
                await loadProjectWorktreeStatus(for: session)
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func runProjectServiceAction(_ action: String) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let actionId = "service:\(action)"
        Task {
            beginProjectWorktreeAction()
            projectWorktreeActionIds.insert(actionId)
            defer { projectWorktreeActionIds.remove(actionId) }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "projects/\(projectId)/development-service/actions/\(action)")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Project service action failed."))
                }
                await loadProjectWorktreeStatus(for: session)
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func selectProjectServiceProfile(_ profileId: String) {
        guard let session = selectedSession,
              let projectId = projectId(for: session) else { return }
        let actionId = "service:profile"
        Task {
            beginProjectWorktreeAction()
            projectWorktreeActionIds.insert(actionId)
            defer { projectWorktreeActionIds.remove(actionId) }
            do {
                var request = URLRequest(
                    url: baseURL.appending(path: "projects/\(projectId)/development-service/actions/profile")
                )
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["profileId": profileId])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        Self.errorMessage(from: data) ?? L10n("Could not update the service profile.")
                    )
                }
                await loadProjectWorktreeStatus(for: session)
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func mergeProjectWorktree(_ worktree: ProjectWorktreeStatus, restartService: Bool) {
        performProtectedProjectWorktreeAction(
            worktree,
            action: "merge",
            body: ["restartService": restartService]
        )
    }

    func restartProjectService(from worktree: ProjectWorktreeStatus) {
        performProjectWorktreeAction(
            worktree,
            action: "restart",
            body: [:]
        )
    }

    func commitProjectWorktreeChanges(_ worktree: ProjectWorktreeStatus) {
        performProtectedProjectWorktreeAction(worktree, action: "commit", body: [:])
    }

    private func performProtectedProjectWorktreeAction(
        _ worktree: ProjectWorktreeStatus,
        action: String,
        body: [String: Any]
    ) {
        let actionMayCommit = action == "commit"
            || action == "merge"
            || action == "complete"
            || (action == "operate" && body["mergeIntoMain"] as? Bool == true)
        guard worktree.dirty == true, actionMayCommit else {
            performProjectWorktreeAction(worktree, action: action, body: body)
            return
        }
        guard let session = selectedSession else { return }
        Task {
            beginProjectWorktreeAction()
            projectWorktreeActionIds.insert(worktree.worktreeId)
            defer { projectWorktreeActionIds.remove(worktree.worktreeId) }
            do {
                var request = URLRequest(url: baseURL.appending(
                    path: "sessions/\(session.id)/project-worktrees/\(worktree.worktreeId)/commit-prepare"
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = Data("{}".utf8)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not inspect commit contents."))
                }
                let protection = try JSONDecoder().decode(GitCommitProtectionStatus.self, from: data)
                pendingProtectedWorktreeAction = (worktree, action, body)
                worktreeCommitReviewPrompt = WorktreeCommitReviewPrompt(
                    worktree: worktree,
                    protection: protection,
                    operation: Self.commitReviewOperation(for: action)
                )
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    func confirmProtectedWorktreeCommit(
        commitMessage: String,
        decision: String,
        neverRemindPrivateFiles: Bool
    ) {
        guard worktreeCommitReviewPrompt != nil,
              let pending = pendingProtectedWorktreeAction else { return }
        worktreeCommitReviewPrompt = nil
        pendingProtectedWorktreeAction = nil
        var body = pending.body
        body["commitMessage"] = commitMessage
        body["privateFilesDecision"] = decision
        body["neverRemindPrivateFiles"] = neverRemindPrivateFiles
        performProjectWorktreeAction(
            pending.worktree,
            action: pending.action,
            body: body
        )
    }

    func cancelProtectedWorktreeCommit() {
        worktreeCommitReviewPrompt = nil
        pendingProtectedWorktreeAction = nil
    }

    func generateWorktreeCommitMessage() async -> String? {
        guard let session = selectedSession,
              let prompt = worktreeCommitReviewPrompt,
              !isGeneratingWorktreeCommitMessage else { return nil }
        isGeneratingWorktreeCommitMessage = true
        beginProjectWorktreeAction()
        defer { isGeneratingWorktreeCommitMessage = false }
        do {
            var request = URLRequest(url: baseURL.appending(
                path: "sessions/\(session.id)/project-worktrees/\(prompt.worktree.worktreeId)/commit-message"
            ))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = Data("{}".utf8)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  (200..<300).contains(httpResponse.statusCode) else {
                throw BackendError.message(
                    Self.errorMessage(from: data) ?? L10n("Could not generate commit message.")
                )
            }
            let result = try JSONDecoder().decode(GitHubCommitMessageSuggestion.self, from: data)
            guard worktreeCommitReviewPrompt?.id == prompt.id else { return nil }
            return result.commitMessage
        } catch {
            recordProjectWorktreeActionError(error.localizedDescription)
            return nil
        }
    }

    private static func commitReviewOperation(for action: String) -> WorktreeCommitReviewOperation {
        switch action {
        case "commit": .commit
        case "merge": .merge
        case "complete": .complete
        default: .operate
        }
    }

    func operateProjectWorktree(
        _ worktree: ProjectWorktreeStatus,
        mergeIntoMain: Bool,
        synchronizeWithMain: Bool,
        deleteWorktree: Bool,
        deleteSessions: Bool,
        restartService: Bool,
        forceDeleteUnmerged: Bool = false,
        confirmedBranchName: String? = nil
    ) {
        var body: [String: Any] = [
            "mergeIntoMain": mergeIntoMain,
            "synchronizeWithMain": synchronizeWithMain,
            "deleteWorktree": deleteWorktree,
            "deleteSessions": deleteSessions,
            "restartService": restartService
        ]
        if forceDeleteUnmerged, let confirmedBranchName {
            body["forceDeleteUnmerged"] = true
            body["acknowledgeIrrecoverable"] = true
            body["confirmedBranchName"] = confirmedBranchName
        }
        performProtectedProjectWorktreeAction(
            worktree,
            action: "operate",
            body: body
        )
    }

    func synchronizeProjectWorktree(_ worktree: ProjectWorktreeStatus) {
        let needsMerge = worktree.dirty == true || worktree.mergedIntoMain != true
        operateProjectWorktree(
            worktree,
            mergeIntoMain: needsMerge,
            synchronizeWithMain: true,
            deleteWorktree: false,
            deleteSessions: false,
            restartService: false
        )
    }

    func completeProjectWorktree(_ worktree: ProjectWorktreeStatus, restartService: Bool = true) {
        performProtectedProjectWorktreeAction(
            worktree,
            action: "complete",
            body: [
                "restartService": restartService,
                "deleteSessions": true,
                "deleteBranch": true
            ]
        )
    }

    func cleanupMergedProjectWorktrees(_ worktrees: [ProjectWorktreeStatus]) {
        guard !worktrees.isEmpty,
              let session = selectedSession,
              let projectId = projectId(for: session),
              !isCleaningMergedProjectWorktrees else { return }
        let worktreeIds = Set(worktrees.map(\.worktreeId))
        Task {
            beginProjectWorktreeAction()
            isCleaningMergedProjectWorktrees = true
            projectWorktreeActionIds.formUnion(worktreeIds)
            defer {
                projectWorktreeActionIds.subtract(worktreeIds)
                isCleaningMergedProjectWorktrees = false
            }

            var removedCount = 0
            var failures: [String] = []
            for worktree in worktrees {
                do {
                    var request = URLRequest(url: baseURL.appending(
                        path: "projects/\(projectId)/workspaces/\(worktree.worktreeId)/actions/delete"
                    ))
                    request.httpMethod = "POST"
                    request.setValue("application/json", forHTTPHeaderField: "content-type")
                    request.httpBody = try JSONSerialization.data(withJSONObject: ["deleteBranch": true])
                    let (data, response) = try await URLSession.shared.data(for: request)
                    guard let httpResponse = response as? HTTPURLResponse,
                          (200..<300).contains(httpResponse.statusCode) else {
                        throw BackendError.message(
                            Self.errorMessage(from: data) ?? L10n("Worktree action failed.")
                        )
                    }
                    removedCount += 1
                } catch {
                    let name = worktree.branchName ?? worktree.path
                    failures.append("\(name): \(error.localizedDescription)")
                }
            }

            if failures.isEmpty {
                sendStatusMessage = L10nFormat("Removed %d merged Worktrees", removedCount)
            } else {
                recordProjectWorktreeActionError(L10nFormat(
                    "Removed %d Worktrees; %d could not be removed:\n%@",
                    removedCount,
                    failures.count,
                    failures.joined(separator: "\n")
                ))
            }
            if selectedSession?.id == session.id {
                await loadProjectWorktreeStatus(for: session)
            }
        }
    }

    private func performProjectWorktreeAction(
        _ worktree: ProjectWorktreeStatus,
        action: String,
        body: [String: Any]
    ) {
        guard let session = selectedSession else { return }
        Task {
            beginProjectWorktreeAction()
            projectWorktreeActionIds.insert(worktree.worktreeId)
            defer { projectWorktreeActionIds.remove(worktree.worktreeId) }
            do {
                let path: String
                if action == "restart", let projectId = projectId(for: session) {
                    path = "projects/\(projectId)/workspaces/\(worktree.worktreeId)/actions/restart"
                } else {
                    path = "sessions/\(session.id)/project-worktrees/\(worktree.worktreeId)/\(action)"
                }
                var request = URLRequest(url: baseURL.appending(
                    path: path
                ))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Worktree action failed."))
                }
                let result = try? JSONDecoder().decode(ProjectWorktreeActionResponse.self, from: data)
                if action == "commit" {
                    sendStatusMessage = L10n("Worktree changes committed")
                }
                if result?.deletedSessionIds?.contains(session.id) == true {
                    closeDetail()
                }
                if selectedSession?.id == session.id {
                    await loadProjectWorktreeStatus(for: session)
                }
            } catch {
                recordProjectWorktreeActionError(error.localizedDescription)
            }
        }
    }

    private func projectId(for session: TaskSession) -> String? {
        let projectId = session.external?.workspace?.repositoryId?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return projectId?.isEmpty == false ? projectId : nil
    }

    private func loadUsage(for session: TaskSession) async {
        guard selectedSession?.id == session.id else { return }
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/usage")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return }
            let usage = try JSONDecoder().decode(SessionUsageResponse.self, from: data)
            guard selectedSession?.id == session.id else { return }
            usageBySessionId[session.id] = usage
            selectedSessionUsage = usage
        } catch {
            // Usage is supplementary; chat remains usable if Codex cannot report it.
        }
    }

    func refreshSelectedUsage() async {
        guard let selectedSession else { return }
        await loadUsage(for: selectedSession)
    }

    func cachedDetail(for sessionId: String) -> CodexThreadDetail? {
        SessionTimelineRepository.shared.detail(for: sessionId)
    }

    func pendingCollaborationConfirmation(for sessionID: String) -> PendingCollaborationConfirmation? {
        pendingCollaborationConfirmationsBySessionID[sessionID]
    }

    private func storeCachedDetail(
        _ detail: CodexThreadDetail,
        for sessionId: String,
        timelineRevision: Int? = nil
    ) {
        SessionTimelineRepository.shared.publish(
            detail,
            for: sessionId,
            timelineRevision: timelineRevision
        )
        let pending = Self.pendingCollaborationConfirmation(in: detail)
        if pendingCollaborationConfirmationsBySessionID[sessionId] != pending {
            pendingCollaborationConfirmationsBySessionID[sessionId] = pending
        }
        if viewingHistoricalThreadId == nil,
           selectedSession?.id == sessionId {
            isLoadingDetail = false
        }
    }

    private func removeCachedDetail(for sessionId: String) {
        SessionTimelineRepository.shared.remove(sessionId)
        pendingCollaborationConfirmationsBySessionID[sessionId] = nil
    }

    nonisolated static func pendingCollaborationConfirmation(
        in detail: CodexThreadDetail
    ) -> PendingCollaborationConfirmation? {
        guard let item = detail.items.last(where: {
            $0.type == "collaborationConfirmation"
                && ($0.collaborationConfirmationStatus ?? $0.status ?? "pending").lowercased() == "pending"
        }), let confirmationID = item.collaborationConfirmationId else { return nil }
        return PendingCollaborationConfirmation(
            confirmationId: confirmationID,
            initiatorAgentId: item.collaborationSenderAgentId,
            initiatorName: item.collaborationSenderName,
            recipientAgentId: item.collaborationRecipientAgentId,
            recipientName: item.collaborationRecipientName ?? "Agent",
            sourceWorkId: item.collaborationSourceWorkId,
            sourceWorkName: item.collaborationSourceWorkName,
            targetWorkId: item.collaborationTargetWorkId,
            targetWorkName: item.collaborationTargetWorkName,
            initiatorSessionId: item.collaborationInitiatorSessionId,
            initiatorSessionTitle: item.collaborationInitiatorSessionTitle,
            initiatorSessionKind: item.collaborationInitiatorSessionKind,
            initiatorCorptieTaskId: item.collaborationSourceCorptieTaskId,
            recipientSessionId: item.collaborationRecipientSessionId,
            recipientSessionTitle: item.collaborationRecipientSessionTitle,
            recipientSessionKind: item.collaborationRecipientSessionKind,
            recipientCorptieTaskId: item.collaborationTargetCorptieTaskId,
            routeStatus: item.collaborationRouteStatus,
            routingVersion: item.collaborationRoutingVersion,
            taskTitle: item.collaborationTaskTitle ?? "Cross-session collaboration",
            summary: item.presentationText ?? item.text,
            acceptanceCriteria: item.collaborationAcceptanceCriteria ?? []
        )
    }

    private func reconcileTimelineRevisionIndex() async {
        do {
            let (data, response) = try await URLSession.shared.data(
                from: baseURL.appending(path: "session-timelines/revisions")
            )
            guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200 else { return }
            let index = try JSONDecoder().decode(SessionTimelineRevisionIndex.self, from: data)
            for entry in index.sessions {
                applyTimelineRevisionAdvance(
                    sessionId: entry.sessionId,
                    revision: entry.timelineRevision
                )
            }
        } catch {
            // The state stream remains independently authoritative for Session
            // lifecycle. A future timeline event or reconnect retries this
            // lightweight index without marking the whole backend offline.
        }
    }

    private func applyTimelineRevisionAdvance(sessionId: String, revision: Int) {
        guard revision > 0 else { return }
        let previous = knownTimelineRevisionBySessionID[sessionId] ?? 0
        knownTimelineRevisionBySessionID[sessionId] = max(previous, revision)
        // State patches and Timeline wake events race. Always let the sync
        // engine compare this desired revision with resident authority instead
        // of dropping a wake because another channel observed it first.
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }
        scheduleBackgroundTimelineSync(for: session, desiredRevision: revision)
    }

    private func scheduleBackgroundTimelineSync(
        for session: TaskSession,
        desiredRevision: Int
    ) {
        activeTimelineSyncEngine.schedule(session, desiredRevision: desiredRevision)
    }

    private func synchronizeStoredTimeline(
        for session: TaskSession,
        localRevision: Int,
        forceSnapshot: Bool = false
    ) async -> Bool {
        guard sessionRouteIsCurrent(session) else { return false }
        if !forceSnapshot,
           localRevision > 0,
           let currentDetail = SessionTimelineRepository.shared.detail(for: session.id),
           let envelope = await fetchTimelineChanges(for: session, after: localRevision) {
            let mergeResult = await timelineDeltaProcessor.merge(
                envelope,
                into: currentDetail,
                localRevision: localRevision
            )
            switch mergeResult {
            case .applied(let detail, let revision):
                guard sessionRouteIsCurrent(session) else { return false }
                let reconciledDetail = detailByMergingPendingMessages(detail)
                storeCachedDetail(
                    reconciledDetail,
                    for: session.id,
                    timelineRevision: revision
                )
                await warmPresentationCache(reconciledDetail, for: session.id)
                return true
            case .duplicate:
                return true
            case .requiresSnapshot:
                break
            }
        }
        let snapshot: (detail: CodexThreadDetail, timelineRevision: Int)
        switch await fetchStoredDetail(for: session) {
        case .success(let loaded):
            snapshot = loaded
        case .failure(let error):
            if selectedSession?.id == session.id,
               SessionTimelineRepository.shared.detail(for: session.id) == nil {
                selectedTimelineLoadError = L10nFormat(
                    "Could not load session messages: %@",
                    error.localizedDescription
                )
                isLoadingDetail = false
            }
            return false
        }
        guard sessionRouteIsCurrent(session) else { return false }
        let reconciledDetail = detailByMergingPendingMessages(snapshot.detail)
        storeCachedDetail(
            reconciledDetail,
            for: session.id,
            timelineRevision: snapshot.timelineRevision
        )
        await warmPresentationCache(reconciledDetail, for: session.id)
        if selectedSession?.id == session.id {
            selectedTimelineLoadError = nil
        }
        return true
    }

    private func sessionRouteIsCurrent(_ requested: TaskSession) -> Bool {
        let current = appState.session(requested.id)
            ?? archivedSessions.first(where: { $0.id == requested.id })
        guard let current else { return false }
        return SessionTimelineBindingReconciler.sameRoute(requested, current)
    }

    private func acceptCommittedSessionRoute(_ committed: TaskSession) {
        let session = appState.acceptSessionWorkspaceTransition(committed) ?? committed
        SessionTimelineRepository.shared.rebindProviderIdentity(for: session)
        routeTimelineSyncTasks[session.id]?.cancel()
        let localRevision = SessionTimelineRepository.shared.timelineRevision(for: session.id)
        routeTimelineSyncTasks[session.id] = Task { @MainActor [weak self] in
            guard let self else { return }
            _ = await self.synchronizeStoredTimeline(
                for: session,
                localRevision: localRevision,
                forceSnapshot: true
            )
            guard self.sessionRouteIsCurrent(session) else { return }
            self.routeTimelineSyncTasks[session.id] = nil
        }
    }

    private func warmPresentationCache(_ detail: CodexThreadDetail, for sessionID: String) async {
        let visibleMessageLimit = ChatTimelineFeatureFlags.current.initialDisplayWeight
        let restorationAnchorRowID = SessionViewportController.shared.position(for: sessionID).flatMap {
            $0.followsLatest ? nil : $0.rowID
        }
        let cache = await Task.detached(priority: .utility) {
            makeDetailDisplayCache(
                for: detail,
                sessionId: sessionID,
                visibleMessageLimit: visibleMessageLimit,
                restorationAnchorRowID: restorationAnchorRowID
            )
        }.value
        guard sessions.contains(where: { $0.id == sessionID })
                || selectedSession?.id == sessionID else { return }
        SessionPresentationCache.shared.store(cache)
    }

    private func fetchTimelineChanges(
        for session: TaskSession,
        after revision: Int
    ) async -> SessionTimelineChangeEnvelope? {
        do {
            var components = URLComponents(
                url: baseURL.appending(path: "sessions/\(session.id)/timeline/changes"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [
                URLQueryItem(name: "after", value: String(revision)),
                URLQueryItem(name: "limit", value: "200")
            ]
            let (data, response) = try await URLSession.shared.data(from: components.url!)
            guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200 || http.statusCode == 410 else {
                return nil
            }
            return try await timelineDeltaProcessor.decode(data)
        } catch {
            return nil
        }
    }

    private func fetchStoredDetail(
        for session: TaskSession
    ) async -> Result<(detail: CodexThreadDetail, timelineRevision: Int), Error> {
        let threadId = session.external?.threadId ?? session.id
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/stored-snapshot")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse else {
                throw BackendError.message(L10n("The history server returned an invalid response."))
            }
            guard http.statusCode == 200 else {
                let serverMessage = Self.errorMessage(from: data)
                    ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode)
                throw BackendError.message(serverMessage)
            }
            async let header = Task.detached(priority: .utility) {
                try JSONDecoder().decode(StoredSessionTimelineSnapshotHeader.self, from: data)
            }.value
            async let detail = decodeDetail(data, for: session, threadId: threadId)
            let result = try await (detail, header.timelineRevision)
            return .success(result)
        } catch {
            return .failure(error)
        }
    }

    @discardableResult
    func sendMessage(
        _ text: String,
        images: [ChatImageReference] = [],
        onSuccess: @escaping () -> Void = {},
        onFailure: @escaping () -> Void = {}
    ) -> Bool {
        if !selectedCanSendNow {
            sendStatusMessage = selectedNotReadyReason?.message
                ?? selectedDetail?.sendUnavailableReason
                ?? "This Session is not ready to accept messages."
            return false
        }

        guard let selectedSession, selectedSession.external?.threadId != nil else {
            lastError = L10n("This task does not expose a Codex thread id.")
            sendStatusMessage = lastError
            return false
        }

        return sendText(
            text,
            images: images,
            to: selectedSession,
            reloadDetail: true,
            isChoiceSelection: false,
            onSuccess: onSuccess,
            onFailure: onFailure
        )
    }

    func importChatImage(
        at fileURL: URL,
        to session: TaskSession,
        preserveOriginal: Bool
    ) async throws -> ChatImageReference {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/images"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "sourcePath": fileURL.path,
            "preserveOriginal": preserveOriginal
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not attach image."))
        }
        if let direct = try? JSONDecoder().decode(ChatImageReference.self, from: data) {
            return direct
        }
        return try JSONDecoder().decode(ChatImageImportResponse.self, from: data).image
    }

    func presentChatImageError(_ error: Error) {
        lastError = error.localizedDescription
    }

    func removeUnsentChatImage(_ image: ChatImageReference, from session: TaskSession) async {
        var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/images"))
        request.httpMethod = "DELETE"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["managedPath": image.managedPath])
        _ = try? await URLSession.shared.data(for: request)
    }

    func chatImageURL(sessionID: String, managedPath: String) -> URL? {
        var components = URLComponents(
            url: baseURL.appending(path: "sessions/\(sessionID)/images"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "path", value: managedPath)]
        return components?.url
    }

    func respondToCollaborationConfirmation(confirmationId: String, approve: Bool, in session: TaskSession? = nil) {
        let sourceSessionID = session?.id
            ?? pendingCollaborationConfirmationsBySessionID.first(where: {
                $0.value.confirmationId == confirmationId
            })?.key
        Task {
            isSendingMessage = true
            defer { isSendingMessage = false }
            do {
                sendStatusMessage = approve
                    ? L10n("Sending collaboration request…")
                    : L10n("Cancelling collaboration request…")
                try await Self.requestCollaborationConfirmationResolution(
                    at: baseURL,
                    confirmationId: confirmationId,
                    approve: approve
                )
                if let sourceSessionID {
                    pendingCollaborationConfirmationsBySessionID[sourceSessionID] = nil
                }
                sendStatusMessage = approve ? L10n("Collaboration request sent") : L10n("Collaboration request cancelled")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Confirmation failed: %@", error.localizedDescription)
            }
        }
    }

    nonisolated static func requestCollaborationConfirmationResolution(
        at baseURL: URL,
        confirmationId: String,
        approve: Bool,
        urlSession: URLSession = .shared
    ) async throws {
        let action = approve ? "confirm" : "reject"
        var request = URLRequest(
            url: baseURL.appending(path: "collaboration/confirmations/\(confirmationId)/\(action)")
        )
        request.httpMethod = "POST"
        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw BackendError.message(
                payload?["error"] as? String ?? "Could not resolve collaboration confirmation."
            )
        }
    }

    @discardableResult
    func sendMessage(
        _ text: String,
        to session: TaskSession,
        images: [ChatImageReference] = [],
        isChoiceSelection: Bool = false,
        onSuccess: @escaping () -> Void = {},
        onFailure: @escaping () -> Void = {}
    ) -> Bool {
        sendText(
            text,
            images: images,
            to: session,
            reloadDetail: selectedSession?.id == session.id,
            isChoiceSelection: isChoiceSelection,
            onSuccess: onSuccess,
            onFailure: onFailure
        )
    }

    func reviewTurnChanges(sessionId: String, turnId: String) async -> Result<String, Error> {
        await performTurnChangesAction("review", sessionId: sessionId, turnId: turnId)
    }

    func undoTurnChanges(sessionId: String, turnId: String) async -> Result<String, Error> {
        await performTurnChangesAction("undo", sessionId: sessionId, turnId: turnId)
    }

    private func performTurnChangesAction(_ action: String, sessionId: String, turnId: String) async -> Result<String, Error> {
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(sessionId)/turns/\(turnId)/changes/\(action)"))
            request.httpMethod = "POST"
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                throw BackendError.message(payload?["error"] as? String ?? "The code diff action failed.")
            }
            let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            return .success(payload?["tool"] as? String ?? action)
        } catch {
            return .failure(error)
        }
    }

    @discardableResult
    private func sendText(
        _ text: String,
        images: [ChatImageReference],
        to session: TaskSession,
        reloadDetail: Bool,
        isChoiceSelection: Bool,
        onSuccess: @escaping () -> Void,
        onFailure: @escaping () -> Void = {}
    ) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !images.isEmpty else {
            return false
        }
        let latencyTrace = SessionMessageLatencyTrace(sessionId: session.id)
        let messageID = "message:\(UUID().uuidString)"
        let deliveryID = "delivery:\(UUID().uuidString)"
        latencyTrace.log(stage: "send_clicked")
        let isClearCommand = trimmed.lowercased() == "/clear"
        let resolvesCollaborationConfirmation = selectedDetail?.items.contains(where: {
            $0.type == "collaborationConfirmation" && $0.collaborationConfirmationStatus == "pending"
        }) == true && Self.isCollaborationConfirmationReply(trimmed)
        let presentsAcknowledgedUserMessage = reloadDetail
            && !isClearCommand
            && !resolvesCollaborationConfirmation

        Task {
            isSendingMessage = true
            sendStatusMessage = L10n("Sending...")
            defer { isSendingMessage = false }

            do {
                let requestStartedAtMs = SessionMessageLatencyTrace.nowMs
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/messages"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.setValue(latencyTrace.traceId, forHTTPHeaderField: "x-corptie-message-trace-id")
                request.setValue(String(latencyTrace.clickedAtMs), forHTTPHeaderField: "x-corptie-message-clicked-at-ms")
                request.setValue(String(requestStartedAtMs), forHTTPHeaderField: "x-corptie-message-request-started-at-ms")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "text": trimmed,
                    "images": images.map { image in
                        [
                            "managedPath": image.managedPath,
                            "originalPath": image.originalPath ?? NSNull()
                        ] as [String: Any]
                    },
                    "isChoiceSelection": isChoiceSelection,
                    "messageId": messageID,
                    "deliveryId": deliveryID
                ])

                latencyTrace.log(stage: "request_sent", requestStartedAtMs: requestStartedAtMs)
                let (data, response) = try await URLSession.shared.data(for: request)
                latencyTrace.log(stage: "response_received", requestStartedAtMs: requestStartedAtMs)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                let decoded = try? JSONDecoder().decode(SendMessageResponse.self, from: data)
                guard (200..<300).contains(httpResponse.statusCode) else {
                    let message = decoded?.error ?? String(data: data, encoding: .utf8) ?? "Bad server response"
                    let hint = decoded?.hint.map { "\n\($0)" } ?? ""
                    throw BackendError.message("\(message)\(hint)")
                }

                // A Timeline row is product state, not a send animation. The
                // backend creates the MessageDelivery and its session_items
                // projection in one transaction before returning success, so
                // only a 2xx acknowledgement may make this local echo visible.
                if presentsAcknowledgedUserMessage {
                    appendAcknowledgedUserMessage(
                        trimmed,
                        images: images,
                        messageID: messageID,
                        deliveryID: deliveryID,
                        to: session
                    )
                }
                onSuccess()
                if decoded?.cleared == true {
                    sendStatusMessage = L10n("Conversation cleared")
                    if let replacement = decoded?.session,
                       replacement.id != session.id {
                        publishSessionReplacement(SessionReplacement(
                            previousSessionId: session.id,
                            session: replacement
                        ))
                    }
                    if let replacement = decoded?.session,
                       replacement.id != session.id {
                        select(session: sessions.first(where: { $0.id == replacement.id }) ?? replacement)
                    }
                    return
                } else if decoded?.mode == "collaboration-confirmation" {
                    sendStatusMessage = L10n("Collaboration confirmation resolved")
                } else if decoded?.queued == true {
                    let position = decoded?.queuePosition.map { " #\($0)" } ?? ""
                    sendStatusMessage = L10nFormat("Queued%@", position)
                } else if decoded?.visibleInCodexDesktop == false {
                    sendStatusMessage = decoded?.warning ?? "Sent to background Codex; Desktop may not refresh."
                } else {
                    sendStatusMessage = L10n("Sent to Codex")
                }
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Send failed: %@", error.localizedDescription)
                if selectedSession?.id == session.id {
                    await loadWorkspaceRecoveryStatus(for: session)
                }
                onFailure()
            }
        }
        return true
    }

    private func publishSessionReplacement(_ replacement: SessionReplacement) {
        appState.acceptSessionReplacement(
            previousSessionID: replacement.previousSessionId,
            session: replacement.session
        )
        sessionReplacements.send(replacement)
    }

    private static func isCollaborationConfirmationReply(_ text: String) -> Bool {
        let normalized = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["确认", "确认发送", "发送", "同意", "yes", "y", "confirm", "approve",
                "取消", "拒绝", "不发送", "否", "no", "n", "reject", "cancel"].contains(normalized)
    }

    private func appendAcknowledgedUserMessage(
        _ text: String,
        images: [ChatImageReference] = [],
        messageID: String,
        deliveryID: String,
        to session: TaskSession
    ) {
        let threadId = session.external?.threadId ?? session.id
        guard selectedSession?.id == session.id || selectedDetail?.id == threadId else {
            return
        }
        let now = Self.iso8601Formatter.string(from: Date())
        let item = CodexThreadItem(
            id: messageID,
            turnId: "delivery:\(deliveryID)",
            turnStatus: "running",
            type: "userMessage",
            title: "User",
            text: text,
            options: nil,
            status: "queued",
            createdAt: now,
            images: images
        )
        pendingUserMessagesBySessionID[session.id, default: []].append(item)

        guard let residentDetail = cachedDetail(for: session.id) else {
            storeCachedDetail(
                optimisticDetail(for: session, threadId: threadId, now: now),
                for: session.id
            )
            return
        }
        let detail = SessionTimelineBindingReconciler.rebind(residentDetail, to: session)
        storeCachedDetail(CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: detail.status,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus,
            cwd: detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: now,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: detail.turnCount,
            items: mergedItems(serverItems: detail.items, pendingItems: pendingUserMessagesBySessionID[session.id] ?? []),
            lastAgentMessageSequence: detail.lastAgentMessageSequence,
            hasMoreHistory: detail.hasMoreHistory,
            historyItemsCount: detail.historyItemsCount,
            actions: detail.actions
        ), for: session.id)
    }

    private func optimisticDetail(for session: TaskSession, threadId: String, now: String) -> CodexThreadDetail {
        CodexThreadDetail(
            id: threadId,
            title: session.title,
            status: session.executionTaskStatus,
            source: session.external?.source,
            connectionStatus: session.external?.connectionStatus,
            currentModel: session.external?.currentModel,
            currentReasoningLevel: session.external?.currentReasoningLevel,
            activityStatus: session.activityStatus,
            cwd: session.external?.cwd,
            createdAt: session.updatedAt,
            updatedAt: now,
            canSend: true,
            sendUnavailableReason: nil,
            capabilities: session.capabilities,
            turnCount: 0,
            items: pendingUserMessagesBySessionID[session.id] ?? [],
            lastAgentMessageSequence: session.lastAgentMessageSequence
        )
    }

    func interrupt(session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/interrupt"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse,
                      (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? "Interrupt failed")
                }
                sendStatusMessage = L10n("Interrupted")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Interrupt failed: %@", error.localizedDescription)
            }
        }
    }

    func togglePtyConnection(for session: TaskSession) {
        guard session.usesManualConnection else {
            return
        }

        Task {
            connectionTransitionSessionIds.insert(session.id)
            defer {
                connectionTransitionSessionIds.remove(session.id)
            }
            do {
                let action = session.isConnected ? "disconnect" : "reconnect"
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/\(action)"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                sendStatusMessage = session.isConnected ? L10n("PTY disconnected") : L10n("PTY reconnected")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = session.isConnected
                    ? "Disconnect failed: \(error.localizedDescription)"
                    : "Reconnect failed: \(error.localizedDescription)"
            }
        }
    }

    func reconnect(session: TaskSession) {
        Task {
            connectionTransitionSessionIds.insert(session.id)
            defer {
                connectionTransitionSessionIds.remove(session.id)
            }
            do {
                sendStatusMessage = L10n("Reconnecting...")
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/resume"))
                request.httpMethod = "POST"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                sendStatusMessage = L10n("Reconnected")
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Reconnect failed: %@", error.localizedDescription)
            }
        }
    }

    func restart(session: TaskSession) {
        guard session.actions?.restart?.available == true,
              !restartingSessionIds.contains(session.id) else {
            return
        }

        Task {
            restartingSessionIds.insert(session.id)
            beginRestartActivity(for: session.id)
            defer {
                restartingSessionIds.remove(session.id)
            }
            do {
                sendStatusMessage = L10n("Restarting session…")
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/restart"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "idempotencyKey": "session-restart:\(UUID().uuidString.lowercased())"
                ])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(
                        Self.errorMessage(from: data) ?? L10n("Could not restart session.")
                    )
                }
                sendStatusMessage = httpResponse.statusCode == 202
                    ? L10n("Session will restart after the current run finishes")
                    : L10n("Session restarted")
                if httpResponse.statusCode != 202 {
                    completeRestartActivity(for: session.id)
                }
            } catch {
                failRestartActivity(for: session.id)
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Restart failed: %@", error.localizedDescription)
            }
        }
    }

    @discardableResult
    func switchProvider(session: TaskSession, to providerId: String) async -> Bool {
        let target = providerId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !target.isEmpty, target != session.external?.provider else { return false }
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/actions/switch-provider"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            var body: [String: Any] = [
                "providerId": target,
                "transitionId": "provider-transition:\(UUID().uuidString.lowercased())"
            ]
            if let routingVersion = session.external?.routingVersion {
                body["expectedRoutingVersion"] = routingVersion
            }
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
            guard (200..<300).contains(http.statusCode) else {
                throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Provider 切换失败"))
            }
            sendStatusMessage = http.statusCode == 202
                ? L10n("当前回复完成后切换 Provider")
                : L10n("Provider 已切换")
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    private func beginRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Restarting session…"),
            isActive: true
        )
    }

    private func completeRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Session restarted"),
            isActive: false
        )
        scheduleRestartActivityClear(for: sessionId, after: .seconds(2))
    }

    private func failRestartActivity(for sessionId: String) {
        restartActivityClearTasks.removeValue(forKey: sessionId)?.cancel()
        restartActivityBySessionId[sessionId] = SessionRestartActivity(
            text: L10n("Restart failed"),
            isActive: false
        )
        scheduleRestartActivityClear(for: sessionId, after: .seconds(4))
    }

    private func scheduleRestartActivityClear(for sessionId: String, after delay: Duration) {
        restartActivityClearTasks[sessionId] = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.restartActivityBySessionId.removeValue(forKey: sessionId)
            self?.restartActivityClearTasks.removeValue(forKey: sessionId)
        }
    }

    func setArchived(_ archived: Bool, session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/archive"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["archived": archived])
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                if selectedSession?.id == session.id {
                    closeDetail()
                }
                await refreshArchivedSessions(sessionKind: archivedSessionsKind)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func setPinned(_ pinned: Bool, session: TaskSession) {
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/pin"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["pinned": pinned])
                let (_, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func moveSession(draggedSessionId: String, before targetSessionId: String?) {
        guard draggedSessionId != targetSessionId else { return }
        sessionIndexStore.move(draggedSessionId, before: targetSessionId)
    }

    func beginSessionReorder() {
        sessionReorderRevision += 1
        sessionIndexStore.beginReorder()
    }

    func persistSessionOrder() {
        let orderedIds = sessionIndexStore.orderedIDs
        let revision = sessionReorderRevision
        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/reorder"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["sessionIds": orderedIds])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw URLError(.badServerResponse)
                }
                if revision == sessionReorderRevision {
                    let persistedIDs = (try? await BackendResponseDecoder.sessions(from: data).map(\.id))
                        ?? orderedIds
                    let authoritativeByID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
                    let residentByID = Dictionary(uniqueKeysWithValues: sessionIndexStore.sessions.map { ($0.id, $0) })
                    var reconciled = persistedIDs.compactMap { authoritativeByID[$0] ?? residentByID[$0] }
                    let included = Set(reconciled.map(\.id))
                    reconciled.append(contentsOf: sessions.filter { !included.contains($0.id) })
                    sessionIndexStore.endReorder(authoritativeSessions: reconciled)
                }
            } catch {
                if revision == sessionReorderRevision {
                    lastError = error.localizedDescription
                    sessionIndexStore.endReorder(authoritativeSessions: sessions)
                }
            }
        }
    }

    func rename(session: TaskSession, title: String, onSuccess: @escaping () -> Void = {}) {
        let trimmedTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedTitle.isEmpty else {
            lastError = L10n("Title is required.")
            return
        }

        Task {
            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)"))
                request.httpMethod = "PATCH"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["title": trimmedTitle])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(httpResponse.statusCode) else {
                    if httpResponse.statusCode == 409 {
                        throw BackendError.message(L10n("A session with this name already exists."))
                    }
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not rename session."))
                }
                onSuccess()
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    func delete(session: TaskSession) {
        Task {
            do {
                let planURL = baseURL.appending(path: "sessions/\(session.id)/deletion-plan")
                let (planData, planResponse) = try await URLSession.shared.data(from: planURL)
                guard let planHTTPResponse = planResponse as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                guard (200..<300).contains(planHTTPResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: planData) ?? L10n("Could not inspect the session worktree."))
                }
                let plan = try JSONDecoder().decode(SessionDeletionPlan.self, from: planData)
                var mergeWorktree = false
                if plan.workspaceUnavailable == true {
                    guard confirmOrphanedSessionDeletion(plan: plan) else { return }
                } else if plan.requiresWorktreeMerge {
                    guard let decision = confirmWorktreeDeletion(plan: plan) else { return }
                    mergeWorktree = decision
                }

                var deleteURL = baseURL.appending(path: "sessions/\(session.id)")
                if mergeWorktree {
                    deleteURL.append(queryItems: [URLQueryItem(name: "mergeWorktree", value: "true")])
                }
                var request = URLRequest(url: deleteURL)
                request.httpMethod = "DELETE"
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                    throw BackendError.message(Self.errorMessage(from: data) ?? L10n("Could not delete the session."))
                }
                if selectedSession?.id == session.id {
                    closeDetail()
                }
                await refreshArchivedSessions(sessionKind: archivedSessionsKind)
            } catch {
                lastError = error.localizedDescription
            }
        }
    }

    private func confirmWorktreeDeletion(plan: SessionDeletionPlan) -> Bool? {
        let branch = plan.sourceBranch ?? L10n("detached HEAD")
        let path = plan.sourcePath ?? L10n("Unknown path")
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n("This session is bound to a Git worktree")
        alert.informativeText = L10nFormat(
            "Worktree “%@” at %@ can be merged locally into main before the session is deleted. If it has uncommitted changes, this session will generate the commit message. No remote push will be performed.",
            branch,
            path
        )
        alert.addButton(withTitle: L10n("Merge into main and Delete"))
        alert.addButton(withTitle: L10n("Delete Only"))
        alert.addButton(withTitle: L10n("Cancel"))
        alert.buttons[1].hasDestructiveAction = true
        switch alert.runModal() {
        case .alertFirstButtonReturn: return true
        case .alertSecondButtonReturn: return false
        default: return nil
        }
    }

    private func confirmOrphanedSessionDeletion(plan: SessionDeletionPlan) -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n("This session's workspace is missing")
        alert.informativeText = L10nFormat(
            "The workspace at %@ is unavailable. Corptie can delete only the session and its local conversation record; no Worktree files or Git branches will be changed.",
            plan.sourcePath ?? L10n("Unknown path")
        )
        alert.addButton(withTitle: L10n("Delete Session Only"))
        alert.addButton(withTitle: L10n("Cancel"))
        return alert.runModal() == .alertFirstButtonReturn
    }

    func interruptSelectedSession() {
        guard let selectedSession else {
            return
        }
        interrupt(session: selectedSession)
    }

    func switchSelectedCodexModel(to model: CodexModel) {
        guard let selectedSession,
              selectedSession.canSwitchModelNow else {
            sendStatusMessage = L10n("Model switching is not available for this session.")
            return
        }

        Task {
            isSwitchingModel = true
            defer { isSwitchingModel = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(selectedSession.id)/model"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["model": model.id])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                let command = try JSONDecoder().decode(SessionConfigurationCommandResponse.self, from: data)
                guard appState.acceptSessionConfiguration(
                    command.session,
                    requestedSessionID: selectedSession.id
                ) else {
                    throw BackendError.message(L10n("The model response did not match the current session."))
                }
                sendStatusMessage = L10nFormat("Switching model to %@", model.name)
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Model switch failed: %@", error.localizedDescription)
            }
        }
    }

    func switchSelectedCodexReasoning(to reasoningLevel: String) {
        let trimmedReasoningLevel = reasoningLevel.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedReasoningLevel.isEmpty else {
            return
        }
        guard let selectedSession,
              selectedSession.canSwitchReasoningNow else {
            sendStatusMessage = L10n("Reasoning switching is not available for this session.")
            return
        }
        if let currentModelID = selectedCurrentModel,
           let currentModel = codexModels.first(where: { $0.id == currentModelID }),
           let supportedLevels = currentModel.reasoningLevels,
           !supportedLevels.contains(where: {
               $0.caseInsensitiveCompare(trimmedReasoningLevel) == .orderedSame
           }) {
            sendStatusMessage = L10n("This reasoning strength is not supported by the current model.")
            return
        }

        Task {
            isSwitchingReasoning = true
            defer { isSwitchingReasoning = false }

            do {
                var request = URLRequest(url: baseURL.appending(path: "sessions/\(selectedSession.id)/reasoning"))
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: ["reasoningLevel": trimmedReasoningLevel])
                let (data, response) = try await URLSession.shared.data(for: request)
                guard let httpResponse = response as? HTTPURLResponse else {
                    throw URLError(.badServerResponse)
                }
                if !(200..<300).contains(httpResponse.statusCode) {
                    let text = String(data: data, encoding: .utf8) ?? "Bad server response"
                    throw BackendError.message(text)
                }
                let command = try JSONDecoder().decode(SessionConfigurationCommandResponse.self, from: data)
                guard appState.acceptSessionConfiguration(
                    command.session,
                    requestedSessionID: selectedSession.id
                ) else {
                    throw BackendError.message(L10n("The reasoning response did not match the current session."))
                }
                sendStatusMessage = L10nFormat("Switching Codex reasoning to %@", reasoningLabel(trimmedReasoningLevel))
            } catch {
                lastError = error.localizedDescription
                sendStatusMessage = L10nFormat("Reasoning switch failed: %@", error.localizedDescription)
            }
        }
    }

    func updateSessionPermissions(
        session: TaskSession,
        sandbox: String,
        approvalPolicy: String
    ) async -> Bool {
        do {
            var request = URLRequest(url: baseURL.appending(path: "sessions/\(session.id)/permissions"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "sandbox": sandbox,
                "approvalPolicy": approvalPolicy
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse else {
                throw URLError(.badServerResponse)
            }
            guard (200..<300).contains(httpResponse.statusCode) else {
                let message = Self.errorMessage(from: data)
                    ?? String(data: data, encoding: .utf8)
                    ?? "Bad server response"
                throw BackendError.message(message)
            }
            sendStatusMessage = L10n("Session permissions updated.")
            return true
        } catch {
            lastError = error.localizedDescription
            sendStatusMessage = L10nFormat("Permission update failed: %@", error.localizedDescription)
            return false
        }
    }

    func reconnectSelectedSession() {
        guard let selectedSession else {
            return
        }
        reconnect(session: selectedSession)
    }

    func workspaceHistory(for session: TaskSession) async -> [SessionWorkspaceHistory] {
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/workspaces")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load workspace history.")
            }
            return try JSONDecoder().decode(SessionWorkspaceHistoryResponse.self, from: data).history
        } catch {
            lastError = error.localizedDescription
            return []
        }
    }

    func openHistoricalThread(_ history: SessionWorkspaceHistory, for session: TaskSession) async -> Bool {
        guard history.readOnly else {
            select(session: session)
            return true
        }
        do {
            let url = baseURL.appending(path: "sessions/\(session.id)/bindings/\(history.bindingId)/snapshot")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not load historical thread.")
            }
            let detail = try await BackendResponseDecoder.detail(
                from: data,
                threadId: history.providerThreadId,
                authoritativeCwd: history.boundCwd,
                workspacePath: history.boundCwd
            )
            sessionSelectionController.select(session.id)
            supplementaryDataController.select(session.id)
            viewingHistoricalThreadId = history.providerThreadId
            selectedHistoricalDetail = detail
            return true
        } catch {
            lastError = error.localizedDescription
            return false
        }
    }

    func returnToActiveThread() {
        guard let selectedSession else { return }
        select(session: selectedSession)
    }

    func fetchDetail(for session: TaskSession, reportsErrors: Bool = true) async -> CodexThreadDetail? {
        let snapshot: (detail: CodexThreadDetail, timelineRevision: Int)
        switch await fetchStoredDetail(for: session) {
        case .success(let loaded):
            snapshot = loaded
        case .failure(let error):
            if reportsErrors { lastError = error.localizedDescription }
            return nil
        }
        let detail = applyingHandledChoices(to: detailByMergingPendingMessages(snapshot.detail))
        storeCachedDetail(
            detail,
            for: session.id,
            timelineRevision: snapshot.timelineRevision
        )
        if reportsErrors, lastError != nil { lastError = nil }
        return detail
    }

    /// Persist a read receipt only through the exact agent-message cursor from
    /// the Session snapshot the user opened. A newer message arriving
    /// concurrently therefore remains unread until the open Session snapshot
    /// advances and acknowledges that newer cursor too.
    func markSessionMessagesRead(sessionID: String, throughSequence: Int) async -> Bool {
        guard throughSequence >= 0 else { return false }
        do {
            let url = baseURL.appending(path: "sessions/\(sessionID)/read-receipt")
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "throughSequence": throughSequence
            ])
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                throw BackendError.message(Self.errorMessage(from: data) ?? "Could not update the Session read receipt.")
            }
            let receipt = try JSONDecoder().decode(SessionReadReceiptResponse.self, from: data)
            appState.acceptReadReceipt(receipt, requestedSessionID: sessionID)
            return true
        } catch {
            return false
        }
    }

    func loadScheduledTasks(
        for session: TaskSession,
        expectedSelectionGeneration: UInt64? = nil
    ) async {
        if selectedSession?.id == session.id { isLoadingScheduledTasks = true }
        defer {
            if selectedSession?.id == session.id { isLoadingScheduledTasks = false }
        }
        let logicalSessionId = session.external?.logicalSessionId ?? session.id
        let outcome: ScheduledTaskListLoadOutcome
        if let inFlight = scheduledTaskLoadTasks[logicalSessionId] {
            PerfStopwatch.event("计划任务.合并重复请求", value: 1)
            outcome = await inFlight.value
        } else {
            let endpointBaseURL = baseURL
            let loadTask = Task {
                await Self.fetchScheduledTaskList(baseURL: endpointBaseURL, logicalSessionId: logicalSessionId)
            }
            scheduledTaskLoadTasks[logicalSessionId] = loadTask
            outcome = await loadTask.value
            scheduledTaskLoadTasks[logicalSessionId] = nil
        }
        switch outcome {
        case .success(let tasks):
            guard selectedSession?.id == session.id,
                  expectedSelectionGeneration == nil
                    || expectedSelectionGeneration == sessionSelectionController.generation else { return }
            PerfStopwatch.measure("计划任务.前端发布渲染状态") {
                selectedScheduledTasks = Self.reconciledScheduledTasks(tasks, for: session)
                scheduledTaskError = nil
            }
            PerfStopwatch.event("计划任务.展示条数", value: selectedScheduledTasks.count)
        case .failure(let message):
            guard selectedSession?.id == session.id else { return }
            scheduledTaskError = message
        }
    }

    nonisolated static func scheduledTaskListURL(
        baseURL: URL,
        logicalSessionId: String? = nil
    ) -> URL? {
        var components = URLComponents(
            url: baseURL.appending(path: ScheduledSessionAPIContract.collectionPath),
            resolvingAgainstBaseURL: false
        )
        var queryItems = [URLQueryItem(name: "includeRuns", value: "true")]
        if let logicalSessionId { queryItems.append(URLQueryItem(name: "logicalSessionId", value: logicalSessionId)) }
        components?.queryItems = queryItems
        return components?.url
    }

    private static func fetchScheduledTaskList(
        baseURL: URL,
        logicalSessionId: String
    ) async -> ScheduledTaskListLoadOutcome {
        do {
            guard let listURL = scheduledTaskListURL(baseURL: baseURL, logicalSessionId: logicalSessionId) else {
                throw URLError(.badURL)
            }
            let (data, response) = try await PerfStopwatch.measure("计划任务.前端HTTP") {
                try await URLSession.shared.data(from: listURL)
            }
            try requireScheduledTaskSuccess(response, data: data)
            let tasks = try PerfStopwatch.measure("计划任务.前端解码") {
                if let envelope = try? JSONDecoder().decode(ScheduledSessionTaskListEnvelope.self, from: data) {
                    return envelope.tasks
                }
                return try JSONDecoder().decode([ScheduledSessionTask].self, from: data)
            }
            return .success(tasks)
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    func loadAutomations() async {
        guard automationRefreshCoalescer.request() else { return }
        isLoadingAutomations = true
        defer {
            automationRefreshCoalescer.finish()
            isLoadingAutomations = false
        }
        repeat {
            automationRefreshCoalescer.beginPass()
            await loadAutomationsPass()
        } while automationRefreshCoalescer.completePass()
    }

    private func loadAutomationsPass() async {
        do {
            guard let listURL = Self.scheduledTaskListURL(baseURL: baseURL) else { throw URLError(.badURL) }
            let (data, response) = try await PerfStopwatch.measure("计划任务总览.前端HTTP") {
                try await URLSession.shared.data(from: listURL)
            }
            try Self.requireScheduledTaskSuccess(response, data: data)
            let details = try PerfStopwatch.measure("计划任务总览.前端解码") {
                try JSONDecoder().decode(ScheduledSessionTaskListEnvelope.self, from: data).tasks
            }
            automations = AutomationListOrdering.sorted(details)
            automationsError = nil
        } catch {
            automationsError = error.localizedDescription
        }
    }

    @discardableResult
    func performAutomationAction(_ action: ScheduledSessionTaskAction, task: ScheduledSessionTask) async -> Bool {
        guard scheduledTaskMutationIds.insert(task.id).inserted else { return false }
        defer { scheduledTaskMutationIds.remove(task.id) }
        do {
            var request = URLRequest(url: baseURL.appending(
                path: "automations/\(task.id)/\(action == .retry ? ScheduledSessionTaskAction.resume.rawValue : action.rawValue)"
            ))
            request.httpMethod = "POST"
            let (data, response) = try await URLSession.shared.data(for: request)
            try Self.requireScheduledTaskSuccess(response, data: data)
            await loadAutomations()
            return true
        } catch {
            automationsError = error.localizedDescription
            return false
        }
    }

    @discardableResult
    func createScheduledTask(_ draft: ScheduledSessionTaskDraft, for session: TaskSession) async -> Bool {
        if let validationError = draft.validationError() {
            scheduledTaskError = validationError.localizedDescription
            return false
        }
        return await performScheduledTaskMutation(
            session: session,
            mutationId: "create",
            method: "POST",
            path: ScheduledSessionAPIContract.collectionPath,
            body: draft.requestBody().merging([
                "logicalSessionId": session.external?.logicalSessionId ?? session.id
            ]) { current, _ in current }
        )
    }

    @discardableResult
    func updateScheduledTask(
        _ task: ScheduledSessionTask,
        draft: ScheduledSessionTaskDraft,
        for session: TaskSession
    ) async -> Bool {
        if let validationError = draft.validationError() {
            scheduledTaskError = validationError.localizedDescription
            return false
        }
        var body = draft.requestBody()
        body.removeValue(forKey: "scheduleType")
        body["resourceVersion"] = task.resourceVersion
        return await performScheduledTaskMutation(
            session: session,
            mutationId: task.id,
            method: "PATCH",
            path: ScheduledSessionAPIContract.itemPath(taskId: task.id),
            body: body
        )
    }

    @discardableResult
    func performScheduledTaskAction(
        _ action: ScheduledSessionTaskAction,
        task: ScheduledSessionTask,
        for session: TaskSession
    ) async -> Bool {
        await performScheduledTaskMutation(
            session: session,
            mutationId: task.id,
            method: "POST",
            path: ScheduledSessionAPIContract.actionPath(taskId: task.id, action: action),
            body: nil
        )
    }

    private func performScheduledTaskMutation(
        session: TaskSession,
        mutationId: String,
        method: String,
        path: String,
        body: [String: Any]?
    ) async -> Bool {
        guard scheduledTaskMutationIds.insert(mutationId).inserted else { return false }
        scheduledTaskError = nil
        defer { scheduledTaskMutationIds.remove(mutationId) }
        do {
            var request = URLRequest(url: baseURL.appending(path: path))
            request.httpMethod = method
            if let body {
                request.setValue("application/json", forHTTPHeaderField: "content-type")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
            }
            let (data, response) = try await URLSession.shared.data(for: request)
            try Self.requireScheduledTaskSuccess(response, data: data)
            await loadScheduledTasks(for: session)
            return true
        } catch {
            scheduledTaskError = error.localizedDescription
            return false
        }
    }

    nonisolated static func reconciledScheduledTasks(
        _ tasks: [ScheduledSessionTask],
        for session: TaskSession
    ) -> [ScheduledSessionTask] {
        let logicalSessionId = session.external?.logicalSessionId ?? session.id
        var byID: [String: ScheduledSessionTask] = [:]
        for task in tasks where task.logicalSessionId == logicalSessionId || task.logicalSessionId == session.id {
            if let existing = byID[task.id], existing.resourceVersion > task.resourceVersion { continue }
            byID[task.id] = task
        }
        return byID.values.sorted { left, right in
            let leftDate = ScheduledSessionDateFormatting.date(from: left.nextRunAt) ?? .distantFuture
            let rightDate = ScheduledSessionDateFormatting.date(from: right.nextRunAt) ?? .distantFuture
            if leftDate != rightDate { return leftDate < rightDate }
            return left.id < right.id
        }
    }

    private nonisolated static func requireScheduledTaskSuccess(_ response: URLResponse, data: Data) throws {
        guard let httpResponse = response as? HTTPURLResponse,
              (200..<300).contains(httpResponse.statusCode) else {
            if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                let code = object["code"] as? String
                let message = object["error"] as? String
                if code != nil || message != nil {
                    throw BackendError.message([code, message].compactMap { $0 }.joined(separator: " · "))
                }
            }
            throw BackendError.message("Scheduled Session task request failed.")
        }
    }

    /// 补拉更早的历史消息，prepend 到当前选中会话的 detail.items 头部。
    /// 只在用户滚动到顶时触发（低频），因此直接请求后端切片端点即可。
    func selectionGenerationToken(for sessionID: String) -> UInt64? {
        sessionSelectionController.selectedSessionID == sessionID
            ? sessionSelectionController.generation
            : nil
    }

    nonisolated static func historyPageRequestIsCurrent(
        sessionID: String,
        expectedSelectionGeneration: UInt64?,
        currentSessionID: String?,
        currentSelectionGeneration: UInt64
    ) -> Bool {
        currentSessionID == sessionID
            && (expectedSelectionGeneration == nil
                || expectedSelectionGeneration == currentSelectionGeneration)
    }

    enum TimelineAnchorWindowLoadResult: Equatable {
        case found
        case missing
        case stale
        case unavailable
    }

    func loadTimelineWindow(
        for session: TaskSession,
        anchorRowID: String,
        expectedSelectionGeneration: UInt64
    ) async -> TimelineAnchorWindowLoadResult {
        let anchorKind: String
        let anchorID: String
        if anchorRowID.hasPrefix("message:") {
            anchorKind = "item"
            anchorID = String(anchorRowID.dropFirst("message:".count))
        } else if anchorRowID.hasPrefix("process:") {
            anchorKind = "turn"
            anchorID = String(anchorRowID.dropFirst("process:".count))
        } else {
            return .missing
        }
        guard !anchorID.isEmpty,
              Self.historyPageRequestIsCurrent(
                  sessionID: session.id,
                  expectedSelectionGeneration: expectedSelectionGeneration,
                  currentSessionID: selectedSession?.id,
                  currentSelectionGeneration: sessionSelectionController.generation
              ),
              let current = selectedDetail,
              timelineWindowLoadSessionIDs.insert(session.id).inserted else {
            return .stale
        }
        let threadID = current.id
        defer { timelineWindowLoadSessionIDs.remove(session.id) }

        do {
            var components = URLComponents(
                url: baseURL.appending(path: "sessions/\(session.id)/timeline/window"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [
                URLQueryItem(name: "anchorKind", value: anchorKind),
                URLQueryItem(name: "anchor", value: anchorID),
                URLQueryItem(name: "before", value: "40"),
                URLQueryItem(name: "after", value: "40")
            ]
            guard let url = components?.url else { return .unavailable }
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else { return .unavailable }
            let window = try await Task.detached(priority: .userInitiated) {
                try JSONDecoder().decode(SessionTimelineWindowResponse.self, from: data)
            }.value
            guard Self.historyPageRequestIsCurrent(
                      sessionID: session.id,
                      expectedSelectionGeneration: expectedSelectionGeneration,
                      currentSessionID: selectedSession?.id,
                      currentSelectionGeneration: sessionSelectionController.generation
                  ),
                  let latest = selectedDetail,
                  latest.id == threadID else {
                return .stale
            }
            guard window.anchor.status == "found" else { return .missing }
            let mergedItems = SessionHistoryPageMerger.mergeAnchorWindow(
                window.items,
                with: latest.items
            )
            let merged = CodexThreadDetail(
                id: latest.id,
                title: latest.title,
                status: latest.status,
                source: latest.source,
                connectionStatus: latest.connectionStatus,
                currentModel: latest.currentModel,
                currentReasoningLevel: latest.currentReasoningLevel,
                activityStatus: latest.activityStatus,
                cwd: latest.cwd,
                createdAt: latest.createdAt,
                updatedAt: latest.updatedAt,
                canSend: latest.canSend,
                sendUnavailableReason: latest.sendUnavailableReason,
                capabilities: latest.capabilities,
                turnCount: latest.turnCount,
                items: mergedItems,
                lastAgentMessageSequence: latest.lastAgentMessageSequence,
                hasMoreHistory: window.hasEarlier,
                historyItemsCount: latest.historyItemsCount,
                actions: latest.actions
            )
            publishSelectedDetailIfSafe(merged)
            return .found
        } catch is CancellationError {
            return .stale
        } catch {
            return .unavailable
        }
    }

    func earlierHistoryLoadState(for sessionID: String) -> EarlierHistoryLoadState {
        earlierHistoryLoadStateBySessionID[sessionID] ?? .idle
    }

    private func setEarlierHistoryLoadState(
        _ state: EarlierHistoryLoadState,
        for sessionID: String
    ) {
        var states = earlierHistoryLoadStateBySessionID
        states[sessionID] = state
        earlierHistoryLoadStateBySessionID = states
    }

    static func requestEarlierHistoryPage(
        at url: URL,
        urlSession: URLSession = .shared,
        timeoutInterval: TimeInterval = 15
    ) async throws -> SessionHistoryResponse {
        var request = URLRequest(url: url)
        request.timeoutInterval = timeoutInterval
        let (data, response) = try await urlSession.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              httpResponse.statusCode == 200 else {
            throw BackendError.message(
                Self.errorMessage(from: data) ?? L10n("Could not load earlier messages.")
            )
        }
        let page = try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(SessionHistoryResponse.self, from: data)
        }.value
        if page.cursorStatus == "invalid" {
            throw BackendError.message(L10n("The history cursor is no longer valid. Please retry."))
        }
        return page
    }

    @discardableResult
    func loadEarlierMessages(
        for session: TaskSession,
        expectedSelectionGeneration: UInt64? = nil
    ) async -> EarlierHistoryLoadState {
        let threadId = session.external?.threadId ?? session.id
        guard Self.historyPageRequestIsCurrent(
                  sessionID: session.id,
                  expectedSelectionGeneration: expectedSelectionGeneration,
                  currentSessionID: selectedSession?.id,
                  currentSelectionGeneration: sessionSelectionController.generation
              ),
              let current = selectedDetail,
              current.id == threadId,
              let oldest = current.items.first else {
            return earlierHistoryLoadState(for: session.id)
        }
        guard current.hasMoreHistory == true else {
            setEarlierHistoryLoadState(.exhausted, for: session.id)
            return .exhausted
        }
        guard earlierHistoryLoadSessionIDs.insert(session.id).inserted else {
            return earlierHistoryLoadState(for: session.id)
        }
        setEarlierHistoryLoadState(.loading, for: session.id)
        defer { earlierHistoryLoadSessionIDs.remove(session.id) }

        do {
            var components = URLComponents(
                url: baseURL.appending(path: "sessions/\(session.id)/history"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [
                URLQueryItem(name: "before", value: oldest.id),
                URLQueryItem(name: "limit", value: String(Self.historyPageSize))
            ]
            guard let url = components?.url else {
                throw BackendError.message("Could not build history request.")
            }
            let page = try await Self.requestEarlierHistoryPage(at: url)
            if page.items.isEmpty && page.hasMoreHistory == true {
                throw BackendError.message(L10n("The history page did not advance."))
            }

            guard Self.historyPageRequestIsCurrent(
                      sessionID: session.id,
                      expectedSelectionGeneration: expectedSelectionGeneration,
                      currentSessionID: selectedSession?.id,
                      currentSelectionGeneration: sessionSelectionController.generation
                  ),
                  let current = selectedDetail,
                  current.id == threadId,
                  selectedSession?.id == session.id else {
                setEarlierHistoryLoadState(.idle, for: session.id)
                return .idle
            }
            guard let mergedItems = SessionHistoryPageMerger.prepend(
                pageItems: page.items,
                to: current.items,
                requestedBeforeID: oldest.id
            ) else {
                setEarlierHistoryLoadState(.idle, for: session.id)
                return .idle
            }
            if page.hasMoreHistory == true,
               mergedItems.count == current.items.count {
                throw BackendError.message(L10n("The history page did not advance."))
            }
            let merged = CodexThreadDetail(
                id: current.id,
                title: current.title,
                status: current.status,
                source: current.source,
                connectionStatus: current.connectionStatus,
                currentModel: current.currentModel,
                currentReasoningLevel: current.currentReasoningLevel,
                activityStatus: current.activityStatus,
                cwd: current.cwd,
                createdAt: current.createdAt,
                updatedAt: current.updatedAt,
                canSend: current.canSend,
                sendUnavailableReason: current.sendUnavailableReason,
                capabilities: current.capabilities,
                turnCount: current.turnCount,
                items: mergedItems,
                lastAgentMessageSequence: current.lastAgentMessageSequence,
                hasMoreHistory: page.hasMoreHistory,
                historyItemsCount: page.historyItemsCount,
                actions: current.actions
            )
            publishSelectedDetailIfSafe(merged)
            let nextState: EarlierHistoryLoadState = page.hasMoreHistory == true ? .idle : .exhausted
            setEarlierHistoryLoadState(nextState, for: session.id)
            return nextState
        } catch is CancellationError {
            setEarlierHistoryLoadState(.idle, for: session.id)
            return .idle
        } catch {
            let state = EarlierHistoryLoadState.failed(error.localizedDescription)
            setEarlierHistoryLoadState(state, for: session.id)
            return state
        }
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
        handledChoiceIds.insert(choiceId)
        guard let detail = selectedDetail else {
            return
        }
        let updated = detailReplacingItems(detail) { item in
            guard item.id == choiceId, item.type == "choice" else {
                return item
            }
            return CodexThreadItem(
                id: item.id,
                turnId: item.turnId,
                turnStatus: item.turnStatus,
                type: item.type,
                title: item.title,
                text: item.text,
                options: item.options?.map { option in
                    CodexApprovalOption(
                        id: option.id,
                        label: option.label,
                        role: option.role,
                        index: option.index,
                        selected: option.id == selectedOptionId
                    )
                },
                status: "selected",
                createdAt: item.createdAt,
                fileChanges: item.fileChanges,
                turnDiff: item.turnDiff
            )
        }
        if viewingHistoricalThreadId != nil {
            selectedHistoricalDetail = updated
        } else if let sessionID = selectedSession?.id {
            storeCachedDetail(updated, for: sessionID)
        }
    }

    private func applyingHandledChoices(to detail: CodexThreadDetail) -> CodexThreadDetail {
        guard detail.items.contains(where: { handledChoiceIds.contains($0.id) && $0.status != "selected" }) else {
            return detail
        }
        return detailReplacingItems(detail) { item in
            guard handledChoiceIds.contains(item.id), item.type == "choice", item.status != "selected" else {
                return item
            }
            return CodexThreadItem(
                id: item.id,
                turnId: item.turnId,
                turnStatus: item.turnStatus,
                type: item.type,
                title: item.title,
                text: item.text,
                options: item.options,
                status: "selected",
                createdAt: item.createdAt,
                fileChanges: item.fileChanges,
                turnDiff: item.turnDiff
            )
        }
    }

    private func detailReplacingItems(_ detail: CodexThreadDetail, transform: (CodexThreadItem) -> CodexThreadItem) -> CodexThreadDetail {
        CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: detail.status,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus,
            cwd: detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: detail.turnCount,
            items: detail.items.map(transform),
            lastAgentMessageSequence: detail.lastAgentMessageSequence,
            hasMoreHistory: detail.hasMoreHistory,
            historyItemsCount: detail.historyItemsCount,
            actions: detail.actions
        )
    }

    private var deferredDetailPublishTask: Task<Void, Never>?

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
        archivedSessions = []
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

    private func detailByMergingPendingMessages(_ detail: CodexThreadDetail) -> CodexThreadDetail {
        let selectedSessionID = selectedSession?.id
        let selectedCachedSessionID: String? = selectedSessionID.flatMap { selectedID in
            cachedDetail(for: selectedID)?.id == detail.id ? selectedID : nil
        }
        guard let sessionID = sessions.first(where: {
            ($0.external?.threadId ?? $0.id) == detail.id
        })?.id ?? selectedCachedSessionID else { return detail }
        let pending = pendingUserMessagesBySessionID[sessionID] ?? []
        let merged = mergedItems(serverItems: detail.items, pendingItems: pending)
        pendingUserMessagesBySessionID[sessionID] = remainingPendingItems(
            afterMerging: detail.items,
            pendingItems: pending
        )

        guard merged != detail.items else {
            return detail
        }

        return CodexThreadDetail(
            id: detail.id,
            title: detail.title,
            status: detail.status,
            source: detail.source,
            connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel,
            currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus,
            cwd: detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: detail.updatedAt,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: detail.turnCount,
            items: merged,
            lastAgentMessageSequence: detail.lastAgentMessageSequence,
            hasMoreHistory: detail.hasMoreHistory,
            historyItemsCount: detail.historyItemsCount,
            actions: detail.actions
        )
    }

    private func mergedItems(serverItems: [CodexThreadItem], pendingItems: [CodexThreadItem]) -> [CodexThreadItem] {
        var items = serverItems
        var matchedServerIndexes = Set<Int>()
        for pendingItem in pendingItems {
            if let index = firstMatchingServerUserIndex(for: pendingItem, in: items, excluding: matchedServerIndexes) {
                matchedServerIndexes.insert(index)
            } else {
                items.append(pendingItem)
            }
        }
        return items
    }

    private func remainingPendingItems(afterMerging serverItems: [CodexThreadItem], pendingItems: [CodexThreadItem]) -> [CodexThreadItem] {
        var matchedServerIndexes = Set<Int>()
        return pendingItems.filter { pendingItem in
            if let index = firstMatchingServerUserIndex(for: pendingItem, in: serverItems, excluding: matchedServerIndexes) {
                matchedServerIndexes.insert(index)
                return false
            }
            return true
        }
    }

    private func firstMatchingServerUserIndex(for pendingItem: CodexThreadItem, in serverItems: [CodexThreadItem], excluding matchedIndexes: Set<Int>) -> Int? {
        return serverItems.indices.first { index in
            !matchedIndexes.contains(index)
                && serverItems[index].type == "userMessage"
                && serverItems[index].id == pendingItem.id
        }
    }

    private static func errorMessage(from data: Data) -> String? {
        if let decoded = try? JSONDecoder().decode(BackendErrorResponse.self, from: data) {
            return decoded.error
        }
        return String(data: data, encoding: .utf8)
    }
}

private struct ChatImageImportResponse: Decodable {
    let image: ChatImageReference
}

private func nonEmptyPreference(_ value: String?) -> String? {
    guard let value else {
        return nil
    }
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
}

private func agentProxyBody(_ settings: AgentProxySettings) -> [String: Any] {
    [
        "codex": agentProxyProfileBody(settings.codex),
        "choiceParser": agentProxyProfileBody(settings.choiceParser),
        "pty": agentProxyProfileBody(settings.pty)
    ]
}

private func agentProxyProfileBody(_ profile: AgentProxyProfile) -> [String: Any] {
    [
        "enabled": profile.enabled,
        "httpProxy": profile.httpProxy,
        "httpsProxy": profile.httpsProxy,
        "allProxy": profile.allProxy,
        "noProxy": profile.noProxy
    ]
}

@MainActor
private func choiceParserTestMessage(durationMs: Int?) -> String {
    guard let durationMs else {
        return L10n("Test passed")
    }
    if durationMs < 1000 {
        return L10nFormat("Test passed in %lld ms", durationMs)
    }
    let seconds = Double(durationMs) / 1000
    return L10nFormat("Test passed in %.1f s", seconds)
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

@MainActor
private func reasoningLabel(_ value: String) -> String {
    switch value.lowercased() {
    case "low": L10n("Low")
    case "medium": L10n("Medium")
    case "high": L10n("High")
    case "xhigh": L10n("Extra High")
    default: value
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
