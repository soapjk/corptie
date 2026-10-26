import AppKit
import Combine
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Compatibility shell for existing single-page and detached-window callers.
/// Retained pages instantiate SessionConversationSurface directly and therefore
/// never subscribe their render tree to these global legacy publishers.
struct SessionConversationContent: View {
    @EnvironmentObject private var panelLayoutState: PanelLayoutState
    let sessionId: String
    let presentationCache: SessionPresentationCache
    let composerDraftRepository: ComposerDraftRepository
    let backendClient: BackendClient
    let initialTimelinePosition: AppKitChatTimelinePosition?
    let onTimelinePositionChange: (AppKitChatTimelinePosition) -> Void
    let showsHeader: Bool
    let allowsModelSwitch: Bool
    let topChromeClearance: CGFloat
    let compactComposer: Bool
    let presentation: SessionConversationPresentation
    private let updates: AnyPublisher<Void, Never>
    @State private var revision: UInt64 = 0

    init(sessionId: String, presentationCache: SessionPresentationCache,
         composerDraftRepository: ComposerDraftRepository, backendClient: BackendClient = .shared,
         initialTimelinePosition: AppKitChatTimelinePosition? = nil,
         onTimelinePositionChange: @escaping (AppKitChatTimelinePosition) -> Void = { _ in },
         showsHeader: Bool = true, allowsModelSwitch: Bool = true, topChromeClearance: CGFloat = 0,
         compactComposer: Bool = false, presentation: SessionConversationPresentation = .standard) {
        self.sessionId = sessionId; self.presentationCache = presentationCache
        self.composerDraftRepository = composerDraftRepository; self.backendClient = backendClient
        self.initialTimelinePosition = initialTimelinePosition; self.onTimelinePositionChange = onTimelinePositionChange
        self.showsHeader = showsHeader; self.allowsModelSwitch = allowsModelSwitch
        self.topChromeClearance = topChromeClearance; self.compactComposer = compactComposer; self.presentation = presentation
        let publishers: [AnyPublisher<Void, Never>] = [
            backendClient.objectWillChange.eraseToAnyPublisher(),
            backendClient.timelineHistoryController.objectWillChange.eraseToAnyPublisher(),
            backendClient.archivedSessionController.objectWillChange.eraseToAnyPublisher(),
            backendClient.sessionSelectionController.objectWillChange.eraseToAnyPublisher(),
            presentationCache.objectWillChange.eraseToAnyPublisher(),
            presentationCache.state(for: sessionId).objectWillChange.eraseToAnyPublisher(),
            SessionTimelineRepository.shared.state(for: sessionId).objectWillChange.eraseToAnyPublisher(),
            UnifiedSearchNavigation.shared.objectWillChange.eraseToAnyPublisher()
        ]
        updates = Publishers.MergeMany(publishers).eraseToAnyPublisher()
    }
    var body: some View {
        SessionConversationSurface(sessionId: sessionId, presentationCache: presentationCache,
            composerDraftRepository: composerDraftRepository, backendClient: backendClient,
            initialTimelinePosition: initialTimelinePosition, onTimelinePositionChange: onTimelinePositionChange,
            showsHeader: showsHeader, allowsModelSwitch: allowsModelSwitch, topChromeClearance: topChromeClearance,
            compactComposer: compactComposer, presentation: presentation, legacyRevision: revision, legacyCanRenderMessages: panelLayoutState.canRenderDetailMessages)
        .onReceive(updates) { _ in revision &+= 1 }
        .onReceive(panelLayoutState.objectWillChange) { _ in revision &+= 1 }
    }
}

struct SessionConversationSurface: View {
    @Environment(\.locale) private var locale
    private let backendClient: BackendClient
    private let timelineHistory: SessionTimelineHistoryController
    private let archivedSessionState: ArchivedSessionController
    private let legacyCanRenderMessages: Bool
    @MainActor
    static var initialVisibleMessageLimit: Int {
        ChatTimelineFeatureFlags.current.initialDisplayWeight
    }
    @State private var visibleMessageLimit: Int
    @State private var cachedSourceItemCount = 0
    @State private var cachedSourcePenultimateItemId: String?
    @State private var cachedSourceTailItem: CodexThreadItem?
    @State private var cachedDisplayEntries: [ChatDisplayEntry] = []
    @State private var cachedRowsRevision: UInt64 = 0
    @State private var cachedAppKitRows: [AppKitChatTimelineRow] = [] {
        didSet { cachedRowsRevision &+= 1 }
    }
    @State private var cachedTotalDisplayEntryCount = 0
    @State private var cachedVisibleMessageLimit = 0
    @State private var cachedItemsSignature = ""
    @State private var cachedDetailSourceSignature = ""
    @State private var cachedSessionId = ""
    let presentationCache: SessionPresentationCache
    private let presentationState: SessionPresentationState
    @State private var expandedProcessTurnIds: Set<String> = []
    @State private var viewportState = ConversationViewportState()
    @State private var appKitScrollToBottomRevision = 0
    @State private var headerClearance: CGFloat = 0
    @State private var composerClearance: CGFloat = 0
    @State private var displayProjectionTask: Task<Void, Never>?
    @State private var displayProjectionGeneration = 0
    @State private var pendingProjectionSourceSignature: String?
    @State private var timelineRestorationIntent: TimelineRestorationIntent
    @State private var historyAnchorRestoreTask: Task<Void, Never>?
    @State private var earlierHistoryLoadState: EarlierHistoryLoadState
    @State private var historyRequestEpoch = 0
    private let timelineState: SessionTimelineState
    @State private var displaysLoadingDetail: Bool
    @State private var displayedWorkspaceRecoveryStatus: WorkspaceRecoveryStatus?
    private let searchNavigation = UnifiedSearchNavigation.shared
    @State private var appliedSearchToken: UUID?
    @State private var loadingSearchToken: UUID?
    @State private var searchRowID: String?
    @State private var searchRowRevision = 0
    @State private var scrollTargetTurnID: String?
    @State private var scrollTargetTurnRevision = 0
    @State private var pendingFork: SessionForkSelection?
    @State private var hasSubmittedMessage = false
    let sessionId: String
    let renderInputs: SessionPageRenderInputs?
    let legacyRevision: UInt64
    let composerDraftRepository: ComposerDraftRepository
    let initialTimelinePosition: AppKitChatTimelinePosition?
    let onTimelinePositionChange: (AppKitChatTimelinePosition) -> Void
    let showsHeader: Bool
    let allowsModelSwitch: Bool
    let topChromeClearance: CGFloat
    let compactComposer: Bool
    let presentation: SessionConversationPresentation

    init(
        sessionId: String,
        presentationCache: SessionPresentationCache,
        composerDraftRepository: ComposerDraftRepository,
        backendClient: BackendClient = .shared,
        initialTimelinePosition: AppKitChatTimelinePosition? = nil,
        onTimelinePositionChange: @escaping (AppKitChatTimelinePosition) -> Void = { _ in },
        showsHeader: Bool = true,
        allowsModelSwitch: Bool = true,
        topChromeClearance: CGFloat = 0,
        compactComposer: Bool = false,
        presentation: SessionConversationPresentation = .standard,
        renderInputs: SessionPageRenderInputs? = nil,
        legacyRevision: UInt64 = 0, legacyCanRenderMessages: Bool = true
    ) {
        self.sessionId = sessionId
        self.presentationCache = presentationCache
        self.composerDraftRepository = composerDraftRepository
        self.backendClient = backendClient
        self.timelineHistory = backendClient.timelineHistoryController
        self.archivedSessionState = backendClient.archivedSessionController
        self.renderInputs = renderInputs; self.legacyRevision = legacyRevision
        self.legacyCanRenderMessages = legacyCanRenderMessages
        self.initialTimelinePosition = initialTimelinePosition
        self.onTimelinePositionChange = onTimelinePositionChange
        self.showsHeader = showsHeader
        self.allowsModelSwitch = allowsModelSwitch
        self.topChromeClearance = topChromeClearance
        self.compactComposer = compactComposer
        self.presentation = presentation
        let presentationState = presentationCache.state(for: sessionId)
        self.presentationState = presentationState
        let timelineState = SessionTimelineRepository.shared.state(for: sessionId)
        self.timelineState = timelineState
        let initialCache = renderInputs == nil ? presentationState.cache : renderInputs?.displayCache
        let initialPosition = initialTimelinePosition
        _visibleMessageLimit = State(
            initialValue: initialCache?.visibleMessageLimit
                ?? ChatTimelineFeatureFlags.current.initialDisplayWeight
        )
        _cachedSourceItemCount = State(initialValue: initialCache?.displayItems.count ?? 0)
        _cachedSourcePenultimateItemId = State(initialValue: initialCache?.displayItems.dropLast().last?.id)
        _cachedSourceTailItem = State(initialValue: initialCache?.displayItems.last)
        _cachedDisplayEntries = State(initialValue: initialCache?.displayEntries ?? [])
        _cachedTotalDisplayEntryCount = State(initialValue: initialCache?.totalDisplayEntryCount ?? 0)
        _cachedVisibleMessageLimit = State(initialValue: initialCache?.visibleMessageLimit ?? 0)
        _cachedItemsSignature = State(initialValue: initialCache?.signature ?? "")
        _cachedDetailSourceSignature = State(initialValue: initialCache?.sourceSignature ?? "")
        _cachedSessionId = State(initialValue: initialCache?.sessionId ?? "")
        _timelineRestorationIntent = State(
            initialValue: TimelineRestorationIntent(initialPosition: initialPosition)
        )
        _earlierHistoryLoadState = State(
            initialValue: backendClient.earlierHistoryLoadState(for: sessionId)
        )
        _displaysLoadingDetail = State(
            initialValue: renderInputs?.loading ?? (backendClient.selectedSession?.id == sessionId && backendClient.isLoadingDetail)
        )
        _displayedWorkspaceRecoveryStatus = State(
            initialValue: renderInputs == nil
                ? (backendClient.selectedSession?.id == sessionId ? backendClient.workspaceRecoveryStatus : nil)
                : renderInputs?.workspaceRecovery
        )
        PerfStopwatch.event("会话切换.DetailView.init", value: 1)
    }

    private var cachedDisplayProjection: DetailDisplayCache? {
        if let renderInputs { return renderInputs.displayCache }
        return presentationState.cache
    }

    private var restorationTimelinePosition: AppKitChatTimelinePosition? {
        initialTimelinePosition
    }

    private var requestedRestorationAnchorRowID: String? {
        timelineRestorationIntent.requestedAnchorRowID
    }

    private var displayedDetail: CodexThreadDetail? {
        if let renderInputs { return renderInputs.detail }
        return timelineState.detail
    }

    private var selectedSession: TaskSession? {
        if let renderInputs { return renderInputs.session }
        return backendClient.appState.session(sessionId)
            ?? backendClient.archivedSessions.first(where: { $0.id == sessionId })
    }

    private var displayedOnline: Bool { renderInputs?.online ?? backendClient.isOnline }
    private var displayedLoadError: String? {
        if let renderInputs { return renderInputs.loadError }
        return backendClient.selectedTimelineLoadError
    }
    private var displayedLastError: String? {
        if let renderInputs { return renderInputs.lastError }
        return backendClient.lastError
    }
    private var pageWorkspaceRecovery: WorkspaceRecoveryStatus? {
        if let renderInputs { return renderInputs.workspaceRecovery }
        return displayedWorkspaceRecoveryStatus
    }
    private var displayedSearchTarget: UnifiedSearchNavigation.Target? {
        if let renderInputs { return renderInputs.searchTarget }
        return searchNavigation.target
    }
    private var acceptsPresentationUpdates: Bool { renderInputs?.acceptsPresentationUpdates ?? true }
    private var allowsPageActions: Bool {
        guard let renderInputs else { return true }
        return renderInputs.actionSession(generation: renderInputs.activity.generation) != nil
    }

    private var contentPhase: SessionDetailContentPhase {
        sessionDetailContentPhase(
            hasLiveDetail: displayedDetail != nil,
            cachedSessionID: hasPreparedDisplayCacheForCurrentSession ? cachedSessionId : nil,
            selectedSessionID: sessionId,
            isLoading: renderInputs?.loading ?? displaysLoadingDetail,
            hasError: displayedLoadError != nil || displayedLastError != nil
        )
    }

    private var showsWelcome: Bool {
        guard presentation == .standard, !compactComposer else { return false }
        return ConversationWelcomePolicy.showsWelcome(
            detail: displayedDetail, sessionID: sessionId,
            isAssistant: selectedSession?.resolvedSessionKind == .assistantChat,
            isLoading: renderInputs?.loading ?? displaysLoadingDetail,
            hasLoadError: displayedLoadError != nil,
            hasSubmittedMessage: hasSubmittedMessage
        )
    }

    @ViewBuilder
    private var backendConnectionBanner: some View {
        if !displayedOnline {
            BackendDisconnectedSessionView(
                wasExecuting: selectedSession?.executionTaskStatus == .running
            )
        }
    }

    @ViewBuilder
    private var sessionComposer: some View {
        if !displayedOnline {
            ReadOnlyComposer(reason: backendDisconnectedSessionMessage(
                wasExecuting: selectedSession?.executionTaskStatus == .running
            ), isRecovering: false)
        } else if let recovery = pageWorkspaceRecovery,
                  recovery.blocksSessionInput {
            WorkspaceMissingComposer(status: recovery)
        } else {
            // Keep the editor identity stable across transient Provider and
            // Binding readiness changes. MessageComposer gates submission from
            // the authoritative Session projection; readiness must not destroy
            // the text view, its focus, or the user's draft.
            if let renderInputs {
                SessionMessageComposerSurface(sessionId: sessionId, draftRepository: composerDraftRepository,
                    modelCatalog: backendClient.modelCatalog, backendClient: backendClient,
                    allowsModelSwitch: allowsModelSwitch, compact: compactComposer,
                    status: selectedSession?.executionTaskStatus ?? displayedDetail?.status,
                    isReady: selectedSession?.isReady ?? displayedDetail?.isReady ?? true,
                    notReadyReason: selectedSession?.notReadyReason ?? displayedDetail?.notReadyReason,
                    activityStatus: selectedSession?.activityStatus ?? displayedDetail?.activityStatus,
                    onSubmissionStarted: { if acceptsPresentationUpdates { hasSubmittedMessage = true } },
                    renderInputs: renderInputs)
                .id(sessionId)
            } else {
            MessageComposer(
                sessionId: sessionId,
                draftRepository: composerDraftRepository,
                modelCatalog: backendClient.modelCatalog,
                allowsModelSwitch: allowsModelSwitch,
                compact: compactComposer,
                status: selectedSession?.executionTaskStatus ?? displayedDetail?.status,
                isReady: selectedSession?.isReady ?? displayedDetail?.isReady ?? true,
                notReadyReason: selectedSession?.notReadyReason ?? displayedDetail?.notReadyReason,
                activityStatus: selectedSession?.activityStatus ?? displayedDetail?.activityStatus,
                onSubmissionStarted: { hasSubmittedMessage = true }
            )
            .id(sessionId)
            }
        }
    }

    @ViewBuilder
    private var sessionReadinessNotice: some View {
        if displayedOnline,
           pageWorkspaceRecovery?.blocksSessionInput != true,
           let session = selectedSession,
           session.readiness == .notReady,
           let reason = session.notReadyReason {
            if let page = renderInputs {
                SessionNotReadyComposerSurface(backendClient: backendClient, session: session,
                    reason: reason, restarting: page.restarting, renderInputs: page)
            } else { SessionNotReadyComposerNotice(session: session, reason: reason) }
        }
    }

    var body: some View {
        let _ = legacyRevision
        let _ = SessionSwitchTrace.shared.mark(.conversationBody, sessionID: sessionId)
        Group {
            if renderInputs?.retired == true {
                Text(L10n("This conversation no longer exists."))
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else { conversationLayout }
        }
        .onAppear {
            guard acceptsPresentationUpdates else { return }
            restoreCachedProjectionDisplayCacheIfNeeded()
            restoreMissingHistoryAnchorIfNeeded()
        }
        .onChange(of: cachedDisplayProjection?.signature) { _, _ in
            restoreCachedProjectionDisplayCacheIfNeeded()
            restoreMissingHistoryAnchorIfNeeded()
        }
        .onChange(of: sessionId) { _, _ in
            hasSubmittedMessage = false
            displayProjectionTask?.cancel()
            displayProjectionTask = nil
            displayProjectionGeneration &+= 1
            pendingProjectionSourceSignature = nil
            historyAnchorRestoreTask?.cancel()
            historyAnchorRestoreTask = nil
            earlierHistoryLoadState = backendClient.earlierHistoryLoadState(for: sessionId)
            historyRequestEpoch &+= 1
            timelineRestorationIntent.reset(initialPosition: restorationTimelinePosition)
            viewportState.reset()
            visibleMessageLimit = ChatTimelineFeatureFlags.current.initialDisplayWeight
            expandedProcessTurnIds.removeAll()
            restoreDisplayCacheForCurrentSession()
        }
        .onChange(of: restorationTimelinePosition) { _, position in
            guard let position, !position.followsLatest else { return }
            guard timelineRestorationIntent.offerRestoration(position) else {
                // The native viewport is already authoritative. Re-publish it
                // after hydration so a stale disk anchor cannot win again on
                // the next render or Session switch.
                if let observed = timelineRestorationIntent.lastObservedPosition {
                    onTimelinePositionChange(observed)
                }
                return
            }
            restoreMissingHistoryAnchorIfNeeded()
        }
        .onChange(of: renderInputs?.activity.isActive ?? true) { _, active in
            guard !active else { return }
            displayProjectionTask?.cancel(); displayProjectionTask = nil
            historyAnchorRestoreTask?.cancel(); historyAnchorRestoreTask = nil
            displayProjectionGeneration &+= 1
        }
        .onDisappear {
            displayProjectionTask?.cancel()
            displayProjectionTask = nil
            historyAnchorRestoreTask?.cancel()
            historyAnchorRestoreTask = nil
        }
        .onChange(of: appKitDetailRevision) { _, _ in
            if let detail = displayedDetail {
                updateCachedDisplayEntries(for: detail)
            }
            restoreMissingHistoryAnchorIfNeeded()
        }
        .onReceive(backendClient.sessionSelectionController.$selectedSessionID) { selectedSessionID in
            if renderInputs == nil, selectedSessionID == sessionId { restoreMissingHistoryAnchorIfNeeded() }
        }
        .onReceive(backendClient.$isLoadingDetail) { isLoading in
            guard renderInputs == nil, backendClient.selectedSession?.id == sessionId else { return }
            displaysLoadingDetail = isLoading
        }
        .onReceive(timelineHistory.$earlierHistoryLoadStateBySessionID, perform: receiveHistoryState)
        .onChange(of: renderInputs?.historyState) { _, next in
            guard acceptsPresentationUpdates, let next else { return }
            applyHistoryState(next)
        }
        .onReceive(backendClient.supplementaryDataController.$workspaceRecoveryStatus) { status in
            guard renderInputs == nil, backendClient.selectedSession?.id == sessionId else { return }
            displayedWorkspaceRecoveryStatus = status
        }
        .task(id: displayedSearchTarget?.token) { await applySearchTargetIfNeeded() }
        .onChange(of: appKitDetailRevision) { _, _ in
            Task { await applySearchTargetIfNeeded() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .scrollSessionTimelineToTurn)) { notification in
            guard allowsPageActions, notification.userInfo?["sessionId"] as? String == sessionId,
                  let turnID = notification.userInfo?["turnId"] as? String else { return }
            scrollTargetTurnID = turnID
            scrollTargetTurnRevision &+= 1
        }
    }

    private func receiveHistoryState(_ states: [String: EarlierHistoryLoadState]) {
        guard renderInputs == nil else { return }
        applyHistoryState(states[sessionId] ?? .idle)
    }
    private func applyHistoryState(_ nextState: EarlierHistoryLoadState) {
        let previousState = earlierHistoryLoadState
        earlierHistoryLoadState = nextState
        let finishedWithoutStructuralAdvance = previousState == .loading && nextState == .idle
        if case .failed = nextState, nextState != previousState {
            historyRequestEpoch &+= 1
        } else if finishedWithoutStructuralAdvance {
            historyRequestEpoch &+= 1
        }
    }

    private var conversationLayout: some View {
        VStack(alignment: .leading, spacing: presentation == .workspaceCard ? 6 : 12) {
            // The native viewport fills the conversation. Its document reserves
            // the actual top and bottom chrome intersections, so messages pass
            // behind glass while both scroll endpoints remain unobscured.
            Group {
                switch contentPhase {
                case .live:
                    if let detail = displayedDetail {
                        Group {
                            if showsWelcome {
                                Color.clear
                            } else if shouldRenderDetailMessages {
                                appKitCachedDetailMessages()
                            } else {
                                DetailMessagesPlaceholder()
                            }
                        }
                        .onAppear {
                            updateCachedDisplayEntries(for: detail)
                        }
                    }
                case .cached:
                    // Preserve cached messages during SSE reconnects.
                    if shouldRenderDetailMessages {
                        appKitCachedDetailMessages()
                    } else {
                        DetailMessagesPlaceholder()
                    }
                case .loading:
                    VStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        Text(L10n("Loading Codex thread"))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                case .failed:
                    SessionMessageLoadFailureView(
                        error: displayedLoadError
                            ?? displayedLastError
                            ?? L10n("No detail is available for this task."),
                        retry: {
                            Task { await backendClient.reloadSelectedSessionMessages() }
                        }
                    )
                case .empty:
                    VStack(spacing: 10) {
                        ProgressView()
                            .controlSize(.small)
                        DetailMessagesPlaceholder()
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
            .background {
                conversationChromeFrame(.viewport)
            }
            .overlay(alignment: .top) {
                VStack(alignment: .leading, spacing: presentation == .workspaceCard ? 6 : 12) {
                    if showsHeader {
                        conversationHeader
                    }
                    backendConnectionBanner
                    if let recovery = pageWorkspaceRecovery,
                       recovery.orphaned {
                        OrphanedWorkspaceRecoveryView(status: recovery)
                    }
                }
                .background { conversationChromeFrame(.header) }
            }
            .overlay(alignment: .bottomTrailing) {
                jumpToLatestButton
                    .padding(.trailing, 10)
                    .padding(.bottom, composerClearance + 10)
            }
            .overlay(alignment: .bottom) {
                // One editor at one structural position: placement changes must
                // not recreate the native text view, attachments or draft owner.
                VStack(spacing: 24) {
                    if showsWelcome {
                        ConversationWelcomeView(
                            isAssistant: selectedSession?.resolvedSessionKind == .assistantChat
                        )
                    }
                    VStack(spacing: 6) {
                        if let session = selectedSession {
                            if let page = renderInputs { SessionSendFailureSurface(message: page.sendFailure) }
                            else { SessionSendFailureView(sessionID: session.id) }
                        }
                        sessionReadinessNotice
                        sessionComposer
                    }
                    .padding(.bottom, 4)
                    .background { conversationChromeFrame(.composer) }
                }
                .frame(maxWidth: showsWelcome ? 720 : .infinity)
                .padding(.horizontal, showsWelcome ? 24 : 0)
                .frame(maxWidth: .infinity, maxHeight: showsWelcome ? .infinity : nil)
                .padding(.top, showsWelcome ? headerClearance : 0)
            }
            .coordinateSpace(name: ConversationChromeFramePreferenceKey.coordinateSpace)
            .onPreferenceChange(ConversationChromeFramePreferenceKey.self) { frames in
                guard let clearances = ConversationChromeClearances(frames: frames) else { return }
                if abs(headerClearance - clearances.top) >= 0.5 {
                    headerClearance = clearances.top
                }
                if abs(composerClearance - clearances.bottom) >= 0.5 {
                    composerClearance = clearances.bottom
                }
            }
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        }
        .padding(1)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.001))
        )
    }

    private func appKitCachedDetailMessages() -> some View {
        appKitDetailMessages(displayEntries: currentSessionDisplayEntries)
    }

    @ViewBuilder private var conversationHeader: some View {
        if let renderInputs {
            SessionConversationHeaderSurface(session: renderInputs.session, historicalWorkspacePath: displayedDetail?.cwd,
                backendClient: backendClient, projectStatus: renderInputs.projectStatus,
                showsHistoricalThread: renderInputs.historicalThreadID != nil,
                hasPendingScheduledWake: renderInputs.tasks.first { $0.id == renderInputs.session.taskId }?.hasPendingScheduledWake == true,
                providers: renderInputs.providers, renderInputs: renderInputs)
        } else {
            DetailHeaderView(session: selectedSession, historicalWorkspacePath: displayedDetail?.cwd)
        }
    }

    private var currentSessionDisplayEntries: [ChatDisplayEntry] {
        guard cachedSessionId == sessionId else {
            return cachedDisplayProjection?.displayEntries ?? []
        }
        return cachedDisplayEntries
    }

    private func appKitDetailMessages(
        displayEntries: [ChatDisplayEntry]
    ) -> some View {
        let rows = cachedSessionId == sessionId && cachedAppKitRows.count == displayEntries.count
            ? cachedAppKitRows
            : preparedAppKitRows(displayEntries, cache: cachedDisplayProjection)
        return VStack(alignment: .leading, spacing: 6) {
            AppKitChatTimelineView(
                sessionID: sessionId,
                rows: rows,
                scrollToBottomRevision: appKitScrollToBottomRevision,
                contentRevision: cachedSessionId == sessionId && cachedAppKitRows.count == displayEntries.count ? cachedRowsRevision : nil,
                renderInputs: renderInputs,
                baseDirectory: displayedDetail?.cwd,
                canAdvanceProcessClock: displayedOnline && (renderInputs?.activity.isActive ?? true)
                    && selectedSession?.executionTaskStatus == .running,
                followsLatest: followsLatestBinding,
                onToggleExpansion: toggleNativeProcessExpansion,
                onAction: performNativeTimelineAction,
                onNearTop: loadEarlierMessagesIfNeeded,
                hasMoreHistory: selectedSession != nil && displayedDetail?.hasMoreHistory == true,
                onUnderfilledHistory: loadEarlierMessagesForUnderfilledViewport,
                initialPosition: effectiveInitialTimelinePosition,
                onPositionChange: { position in
                    guard acceptsPresentationUpdates else { onTimelinePositionChange(position); return }
                    let hadRestorationAnchor = requestedRestorationAnchorRowID != nil
                    timelineRestorationIntent.observeViewport(position)
                    if hadRestorationAnchor && requestedRestorationAnchorRowID == nil {
                        refreshAfterRestorationAnchorRelinquished()
                    }
                    onTimelinePositionChange(position)
                },
                searchRowID: searchRowID,
                searchRowRevision: searchRowRevision,
                scrollToTurnID: scrollTargetTurnID,
                scrollToTurnRevision: scrollTargetTurnRevision,
                historyRequestEpoch: historyRequestEpoch,
                topClearance: max(headerClearance, topChromeClearance),
                bottomClearance: composerClearance
            )
            .sheet(item: $pendingFork) { selection in
                SessionForkSheet(selection: selection, backendClient: backendClient)
            }
            .onChange(of: selectedSession?.actions?.fork?.available) { _, _ in
                guard cachedSessionId == sessionId else { return }
                let entries = Dictionary(
                    cachedDisplayEntries.map { ($0.id, $0) },
                    uniquingKeysWith: { _, latest in latest }
                )
                cachedAppKitRows = cachedAppKitRows.map { old in
                    guard let entry = entries[old.id] else { return old }
                    let itemID = forkItemID(for: entry)
                    let unavailableReason = nativeRowBuilder.forkUnavailableReason(for: entry)
                    guard old.forkItemID != itemID || old.forkUnavailableReason != unavailableReason else { return old }
                    var row = old
                    row.forkItemID = itemID
                    row.forkUnavailableReason = unavailableReason
                    row.contentRevision = appKitContentRevision(entry, expandedTurnIds: expandedProcessTurnIds)
                    return row
                }
            }
            .onAppear {
                if let currentDetail = displayedDetail {
                    updateCachedDisplayEntries(for: currentDetail)
                }
            }
            .onChange(of: appKitDetailRevision) { _, _ in
                if let currentDetail = displayedDetail {
                    updateCachedDisplayEntries(for: currentDetail)
                }
            }
            .onChange(of: locale.identifier, initial: true) { _, _ in
                // Rebuild localized event presentation on the rare language change,
                // preserving message identity and the current viewport.
                cachedAppKitRows = preparedAppKitRows(cachedDisplayEntries, cache: cachedDisplayProjection)
                let language = AppLanguageController.shared.languageCode
                guard cachedAppKitRows.contains(where: {
                    $0.nativeStyle == .process && $0.processLanguageCode != language
                }) else { return }
                // Language changes are rare. Invalidate only process labels;
                // do not reproject history or install a per-row observer.
                cachedAppKitRows = cachedAppKitRows.map { old in
                    guard old.nativeStyle == .process, old.processLanguageCode != language else { return old }
                    var row = old
                    row.processLanguageCode = language
                    var revision = Hasher()
                    revision.combine(old.contentRevision)
                    revision.combine(language)
                    row.contentRevision = revision.finalize()
                    return row
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .sessionTimelineSubmissionAccepted)) { notification in
                guard notification.object as? String == sessionId else { return }
                if viewportState.followsLatest {
                    timelineRestorationIntent.clearAnchor()
                    refreshAfterRestorationAnchorRelinquished()
                }
            }
            .onChange(of: latestTimelineContentRevision) { _, _ in
                _ = viewportState.timelineTailDidChange()
            }
            .onChange(of: viewportState.followsLatest) { _, followsLatest in
                if followsLatest {
                    relinquishRestorationAnchorIfNeeded()
                }
            }
        }
    }

    @ViewBuilder
    private var jumpToLatestButton: some View {
        if viewportState.showsJumpToLatest {
            Button {
                timelineRestorationIntent.clearAnchor()
                viewportState.jumpToLatest()
                if let currentDetail = displayedDetail {
                    updateCachedDisplayEntries(for: currentDetail)
                }
                appKitScrollToBottomRevision &+= 1
            } label: {
                Image(systemName: "arrow.down")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(JumpToLatestButtonStyle(highlightsUnread: viewportState.hasNewMessagesBelow))
            .help(L10n("Jump to latest message"))
        }
    }

    private var appKitDetailRevision: String {
        guard let detail = displayedDetail else { return "none" }
        return detailSourceSignature(for: detail)
    }

    private var followsLatestBinding: Binding<Bool> {
        Binding(
            get: { viewportState.followsLatest },
            set: { viewportState.setFollowsLatest($0) }
        )
    }

    private var effectiveInitialTimelinePosition: AppKitChatTimelinePosition? {
        guard let restorationTimelinePosition,
              !restorationTimelinePosition.followsLatest,
              currentSessionDisplayEntries.contains(where: { $0.id == restorationTimelinePosition.rowID }) else {
            return nil
        }
        return restorationTimelinePosition
    }

    /// Only tail mutations represent content arriving below the reader. A
    /// history prepend changes the full detail revision but leaves this value
    /// unchanged, so loading older messages does not create a false unread cue.
    private var latestTimelineContentRevision: String {
        guard let detail = displayedDetail else { return "none" }
        return timelineTailContentRevision(for: detail.items)
    }

    private func appKitRow(
        _ entry: ChatDisplayEntry,
        expansionSnapshot: Set<String>? = nil,
        builder: ConversationNativeRowBuilder? = nil
    ) -> AppKitChatTimelineRow {
        let trace = SessionSwitchTrace.shared.start(.rowMapping, sessionID: sessionId)
        defer { SessionSwitchTrace.shared.finish(trace) }
        let expandedTurnIds = expansionSnapshot ?? expandedProcessTurnIds
        var row = (builder ?? nativeRowBuilder).nativeAppKitRow(entry, expandedTurnIds: expandedTurnIds)
        row.isWorkspaceCard = presentation == .workspaceCard
        row.sessionID = sessionId
        return row
    }

    /// All warm restore/body consumers share the same bounded value projection.
    /// This mutates no SwiftUI state and stores no View, coordinator or callback.
    private func preparedAppKitRows(_ entries: [ChatDisplayEntry], cache: DetailDisplayCache?,
                                   expansionSnapshot: Set<String>? = nil) -> [AppKitChatTimelineRow] {
        let builder = nativeRowBuilder
        let expanded = expansionSnapshot ?? expandedProcessTurnIds
        let context = PreparedRowsContext(
            signature: cache?.signature ?? cachedItemsSignature,
            sourceSignature: cache?.sourceSignature ?? cachedDetailSourceSignature,
            entryIDs: entries.map(\.id), entryItems: entries.map { entry in
                switch entry.kind {
                case .message(let item): return [item]
                case .process(_, let items): return items
                }
            }, expandedTurnIDs: expanded,
            localeID: locale.identifier, languageCode: AppLanguageController.shared.languageCode,
            isWorkspaceCard: presentation == .workspaceCard,
            sessionTitle: builder.sessionTitle, workingDirectory: builder.workingDirectory,
            allowsFork: builder.allowsFork, forkUnavailableReason: builder.forkUnavailableReason)
        if let rows = presentationCache.preparedRows(for: sessionId, context: context) { return rows }
        let rows = entries.map { appKitRow($0, expansionSnapshot: expanded, builder: builder) }
        // No source means a transitional projection: render it, but never
        // retain it under a source identity belonging to another Session.
        if let cache, cache.sessionId == sessionId, cache.displayEntries.map(\.id) == context.entryIDs {
            presentationCache.storePreparedRows(rows, for: sessionId, context: context, sourceItems: cache.displayItems)
        }
        return rows
    }

    private var nativeRowBuilder: ConversationNativeRowBuilder {
        ConversationNativeRowBuilder(
            sessionTitle: displayedDetail?.title ?? selectedSession?.title,
            workingDirectory: displayedDetail?.cwd,
            allowsFork: selectedSession?.actions?.fork?.available == true,
            forkUnavailableReason: forkUnavailableReason,
            imageURL: { [backendClient, sessionId] path in
                backendClient.chatImageURL(sessionID: sessionId, managedPath: path)
            }
        )
    }

    private var forkUnavailableReason: String? {
        guard let action = selectedSession?.actions?.fork, action.available == false else { return nil }
        switch action.reason {
        case "SESSION_KIND_UNSUPPORTED": return L10n("Work Chat does not support conversation branching.")
        case "CAPABILITY_UNSUPPORTED": return L10n("The current Provider does not support native conversation branching.")
        case "SESSION_BUSY": return L10n("Wait for the current turn to finish before creating a branch.")
        default: return nil
        }
    }

    private func nativeAppKitRow(
        _ entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> AppKitChatTimelineRow {
        nativeRowBuilder.nativeAppKitRow(entry, expandedTurnIds: expandedTurnIds)
    }

    private func forkItemID(for entry: ChatDisplayEntry) -> String? {
        nativeRowBuilder.forkItemID(for: entry)
    }

    private func processExpansionMetadata(
        for entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> (turnId: String?, isExpanded: Bool) {
        switch entry.kind {
        case .process(let turnId, _):
            return (turnId, expandedTurnIds.contains(turnId))
        case .message:
            return (nil, false)
        }
    }

    private func toggleNativeProcessExpansion(_ turnId: String) {
        // AppKit owns the row geometry. A SwiftUI transition would put hosted
        // content and the enclosing row on different layout clocks.
        setProcessExpansion(!expandedProcessTurnIds.contains(turnId), for: turnId)
    }


    private func performNativeTimelineAction(_ action: AppKitChatTimelineRow.Action) {
        guard allowsPageActions else { return }
        switch action.kind {
        case .deleteUnreceivedMessage(let messageID):
            let alert = NSAlert()
            alert.messageText = "删除这条消息？"
            alert.informativeText = "仅能删除确认未交给模型的消息。删除后所有设备都会移除，无法恢复。"
            alert.addButton(withTitle: "删除")
            alert.addButton(withTitle: "取消")
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            Task {
                do { try await backendClient.deleteUnreceivedMessage(sessionID: sessionId, messageID: messageID) }
                catch { backendClient.presentChatImageError(error) }
                await backendClient.reloadSelectedSessionMessages()
            }
        case .cancelQueuedMessage(let taskID):
            Task {
                do {
                    try await backendClient.cancelQueuedMessage(sessionID: sessionId, taskID: taskID)
                } catch {
                    backendClient.presentChatImageError(error)
                }
                await backendClient.reloadSelectedSessionMessages()
            }
        case .forkMessage(let itemID):
            pendingFork = SessionForkSelection(sessionID: sessionId, itemID: itemID)
        case .codexApproval(let option):
            backendClient.respondToCodexApproval(option: option)
        case .ptyChoice(let option, let choiceID):
            backendClient.respondToPtyChoice(option: option, choiceId: choiceID)
        case .sendMessage(let message):
            guard let selectedSession else { return }
            _ = backendClient.sendMessage(message, to: selectedSession)
        case .collaborationConfirmation(let id, let approve):
            backendClient.respondToCollaborationConfirmation(confirmationId: id, approve: approve)
        case .reviewChanges(let turnID):
            Task { _ = await backendClient.reviewTurnChanges(sessionId: sessionId, turnId: turnID) }
        case .undoChanges(let turnID):
            Task { _ = await backendClient.undoTurnChanges(sessionId: sessionId, turnId: turnID) }
        }
    }

    func appKitContentRevision(
        _ entry: ChatDisplayEntry,
        expandedTurnIds: Set<String>
    ) -> Int {
        nativeRowBuilder.appKitContentRevision(entry, expandedTurnIds: expandedTurnIds)
    }

    private func setProcessExpansion(_ isExpanded: Bool, for turnId: String) {
        let wasExpanded = expandedProcessTurnIds.contains(turnId)
        guard wasExpanded != isExpanded else { return }
        var nextExpandedTurnIds = expandedProcessTurnIds
        if isExpanded {
            nextExpandedTurnIds.insert(turnId)
        } else {
            nextExpandedTurnIds.remove(turnId)
        }
        expandedProcessTurnIds = nextExpandedTurnIds

        // Rebuild the immutable native row projection with a new content
        // revision so NSTableView remeasures only the expanded process row.
        cachedAppKitRows = preparedAppKitRows(cachedDisplayEntries,
            cache: cachedDisplayProjection, expansionSnapshot: nextExpandedTurnIds)
    }

    // 微信/Discord 式「上滑到顶自动加载」：先展开已加载窗口，窗口耗尽后再补拉。
    private func loadEarlierMessagesIfNeeded() {
        loadEarlierMessages(preservingLatestFollow: false)
    }

    private func loadEarlierMessagesForUnderfilledViewport() {
        loadEarlierMessages(preservingLatestFollow: true)
    }

    private func loadEarlierMessages(preservingLatestFollow: Bool) {
        guard let detail = displayedDetail,
              let session = selectedSession else { return }
        let visibleWeight = cachedDisplayEntries.reduce(0) { $0 + $1.displayWeight }
        let hiddenCount = max(0, cachedTotalDisplayEntryCount - visibleWeight)
        viewportState.prepareForHistoryPrepend(preservingLatestFollow: preservingLatestFollow)
        if hiddenCount > 0 {
            ChatPerformanceRecorder.shared.increment(.historyPrepends)
            ChatPerformanceTrace.event("timeline.history.prepend", value: min(100, hiddenCount))
            visibleMessageLimit += 100
            updateCachedDisplayEntries(for: detail)
        } else if detail.hasMoreHistory == true {
            // Reserve a presentation page before awaiting the request. A
            // merged detail can publish while a scrollbar mouse-down is
            // still active; the old bounded tail would otherwise keep the
            // prepended rows hidden until a Session switch rebuilt it.
            let previousVisibleMessageLimit = visibleMessageLimit
            visibleMessageLimit += 100
            Task { @MainActor in
                let selectionGeneration = backendClient.selectionGenerationToken(for: sessionId)
                let result = await backendClient.loadEarlierMessages(
                    for: session,
                    expectedSelectionGeneration: selectionGeneration
                )
                if case .failed = result {
                    visibleMessageLimit = previousVisibleMessageLimit
                    if let current = displayedDetail {
                        updateCachedDisplayEntries(for: current)
                    }
                }
            }
        }
    }

    private func applySearchTargetIfNeeded() async {
        guard acceptsPresentationUpdates, let target = displayedSearchTarget, target.sessionID == sessionId,
              appliedSearchToken != target.token, loadingSearchToken == nil,
              let session = backendClient.selectedSession, session.id == sessionId,
              displayedDetail != nil,
              let generation = backendClient.selectionGenerationToken(for: sessionId) else { return }
        loadingSearchToken = target.token
        defer {
            loadingSearchToken = nil
            if searchNavigation.target?.token != target.token {
                Task { await applySearchTargetIfNeeded() }
            }
        }
        let rowID = "message:" + target.messageID
        let result = await backendClient.loadTimelineWindow(for: session, anchorRowID: rowID,
                                                            expectedSelectionGeneration: generation)
        guard !Task.isCancelled, searchNavigation.target == target,
              backendClient.selectedSession?.id == sessionId else { return }
        appliedSearchToken = target.token
        guard result == .found, let detail = displayedDetail else {
            searchNavigation.error = L10n(result == .missing ? "This message no longer exists." : "Could not locate this message. Try again.")
            return
        }
        let position = AppKitChatTimelinePosition(rowID: rowID, offset: 0, absoluteScrollY: 0, followsLatest: false)
        timelineRestorationIntent.reset(initialPosition: position)
        updateCachedDisplayEntries(for: detail)
        searchRowID = rowID
        searchRowRevision &+= 1
    }

    private func restoreMissingHistoryAnchorIfNeeded() {
        guard acceptsPresentationUpdates else { return }
        guard historyAnchorRestoreTask == nil,
              let anchorRowID = requestedRestorationAnchorRowID,
              !cachedDisplayEntries.contains(where: { $0.id == anchorRowID }),
              let detail = displayedDetail else { return }

        if timelineContains(rowID: anchorRowID, in: detail.items) {
            updateCachedDisplayEntries(for: detail)
            return
        }
        guard detail.hasMoreHistory == true,
              let session = selectedSession else {
            // A deleted/invalid anchor degrades directly to latest. Reusing
            // the old absolute Y against a different row set is what caused
            // the visible jump to unrelated historical content.
            timelineRestorationIntent.clearAnchor()
            updateCachedDisplayEntries(for: detail)
            return
        }

        let pageGeneration = renderInputs?.activity.generation
        historyAnchorRestoreTask = Task { @MainActor in
            defer { historyAnchorRestoreTask = nil }
            let selectionGeneration = backendClient.selectionGenerationToken(for: sessionId)
            let result = await backendClient.loadTimelineWindow(
                for: session,
                anchorRowID: anchorRowID,
                expectedSelectionGeneration: selectionGeneration
            )
            guard !Task.isCancelled, acceptsPresentationUpdates,
                  pageGeneration == nil || renderInputs?.actionSession(generation: pageGeneration!) != nil,
                  selectedSession.map({ SessionTimelineBindingReconciler.sameRoute($0, session) }) == true,
                  let current = displayedDetail else { return }
            if result != .found || !timelineContains(rowID: anchorRowID, in: current.items) {
                timelineRestorationIntent.clearAnchor()
            }
            updateCachedDisplayEntries(for: current)
        }
    }

    private func relinquishRestorationAnchorIfNeeded() {
        guard requestedRestorationAnchorRowID != nil else { return }
        timelineRestorationIntent.clearAnchor()
        refreshAfterRestorationAnchorRelinquished()
    }

    private func refreshAfterRestorationAnchorRelinquished() {
        historyAnchorRestoreTask?.cancel()
        historyAnchorRestoreTask = nil
        if let detail = displayedDetail {
            updateCachedDisplayEntries(for: detail)
        }
    }

    private func timelineContains(rowID: String, in items: [CodexThreadItem]) -> Bool {
        if rowID.hasPrefix("message:") {
            let itemID = String(rowID.dropFirst("message:".count))
            return items.contains { $0.id == itemID }
        }
        if rowID.hasPrefix("process:") {
            let turnID = String(rowID.dropFirst("process:".count))
            return items.contains { $0.turnId == turnID }
        }
        return false
    }

    private func updateCachedDisplayEntries(for detail: CodexThreadDetail) {
        guard acceptsPresentationUpdates else { return }
        let sourceSignature = detailSourceSignature(for: detail)
        guard cachedSessionId != sessionId || sourceSignature != cachedDetailSourceSignature else {
            return
        }
        PerfStopwatch.event("会话切换.updateCachedDisplayEntries", value: detail.items.count)
        if let incremental = makeIncrementalTailDisplay(for: detail) {
            displayProjectionTask?.cancel()
            displayProjectionTask = nil
            pendingProjectionSourceSignature = nil
            commitDisplayCache(DetailDisplayCache(
                sessionId: sessionId,
                displayItems: incremental.displayItems,
                displayEntries: incremental.visibleEntries,
                totalDisplayEntryCount: incremental.totalCount,
                visibleMessageLimit: visibleMessageLimit,
                signature: incremental.signature,
                sourceSignature: incremental.sourceSignature
            ))
            return
        }

        scheduleFullDisplayProjection(for: detail, sourceSignature: sourceSignature)
    }

    private func scheduleFullDisplayProjection(
        for detail: CodexThreadDetail,
        sourceSignature: String
    ) {
        guard pendingProjectionSourceSignature != sourceSignature else { return }
        if displayProjectionTask != nil {
            ChatPerformanceRecorder.shared.increment(.displayProjectionCancellations)
        }
        displayProjectionTask?.cancel()
        displayProjectionGeneration &+= 1
        let requestedSessionID = sessionId
        let requestedLimit = visibleMessageLimit
        let requestedAnchorRowID = requestedRestorationAnchorRowID
        pendingProjectionSourceSignature = sourceSignature
        let request = SessionDisplayProjectionRequest(
            sessionID: requestedSessionID,
            sourceSignature: sourceSignature,
            generation: displayProjectionGeneration
        )
        ChatPerformanceRecorder.shared.increment(.displayProjectionRequests)

        displayProjectionTask = Task { @MainActor in
            let cache = await Task.detached(priority: .userInitiated) {
                ChatPerformanceTrace.measure("timeline.display.project.background") {
                    makeDetailDisplayCache(
                        for: detail,
                        sessionId: requestedSessionID,
                        visibleMessageLimit: requestedLimit,
                        restorationAnchorRowID: requestedAnchorRowID
                    )
                }
            }.value
            guard request.isCurrent(
                sessionID: sessionId,
                sourceSignature: cache.sourceSignature,
                generation: displayProjectionGeneration,
                isCancelled: Task.isCancelled
            ) else {
                ChatPerformanceRecorder.shared.increment(.displayProjectionCancellations)
                return
            }
            pendingProjectionSourceSignature = nil
            displayProjectionTask = nil
            ChatPerformanceRecorder.shared.increment(.displayProjectionCommits)
            commitDisplayCache(cache)
        }
    }

    private func commitDisplayCache(_ preparedDisplay: DetailDisplayCache) {
        guard acceptsPresentationUpdates else { return }
        ChatPerformanceRecorder.shared.increment(.displayRebuilds)
        let uniqueEntries = uniquedChatDisplayEntries(preparedDisplay.displayEntries)
        let removedDisplayWeight = preparedDisplay.displayEntries.reduce(0) { $0 + $1.displayWeight }
            - uniqueEntries.reduce(0) { $0 + $1.displayWeight }
        let preparedDisplay = uniqueEntries.count == preparedDisplay.displayEntries.count
            ? preparedDisplay
            : DetailDisplayCache(
                sessionId: preparedDisplay.sessionId,
                displayItems: preparedDisplay.displayItems,
                displayEntries: uniqueEntries,
                totalDisplayEntryCount: max(
                    uniqueEntries.reduce(0) { $0 + $1.displayWeight },
                    preparedDisplay.totalDisplayEntryCount - removedDisplayWeight
                ),
                visibleMessageLimit: preparedDisplay.visibleMessageLimit,
                signature: preparedDisplay.signature,
                sourceSignature: preparedDisplay.sourceSignature,
                restorationAnchorRowID: preparedDisplay.restorationAnchorRowID
            )
        var transaction = Transaction()
        transaction.disablesAnimations = true
        let nextAppKitRows = PerfStopwatch.measure("会话切换.makeCachedAppKitRows") {
            makeCachedAppKitRows(
                previousEntries: cachedDisplayEntries,
                previousRows: cachedAppKitRows,
                nextEntries: preparedDisplay.displayEntries
            )
        }
        withTransaction(transaction) {
            cachedDetailSourceSignature = preparedDisplay.sourceSignature
            cachedItemsSignature = preparedDisplay.signature
            cachedSessionId = sessionId
            updateCachedSourceTail(from: preparedDisplay.displayItems)
            cachedTotalDisplayEntryCount = preparedDisplay.totalDisplayEntryCount
            cachedVisibleMessageLimit = preparedDisplay.visibleMessageLimit
            cachedDisplayEntries = preparedDisplay.displayEntries
            cachedAppKitRows = nextAppKitRows
            presentationCache.store(preparedDisplay)
        }
    }

    private func makeCachedAppKitRows(
        previousEntries: [ChatDisplayEntry],
        previousRows: [AppKitChatTimelineRow],
        nextEntries: [ChatDisplayEntry]
    ) -> [AppKitChatTimelineRow] {
        guard previousEntries.count == previousRows.count else {
            return nextEntries.map { appKitRow($0) }
        }
        let previousIdentities = previousRows.map {
            AppKitChatRowReuseIdentity(id: $0.id, contentRevision: $0.contentRevision)
        }
        let nextIdentities = nextEntries.map {
            AppKitChatRowReuseIdentity(
                id: $0.id,
                contentRevision: appKitContentRevision($0, expandedTurnIds: expandedProcessTurnIds)
            )
        }
        let commonPrefixCount = AppKitChatRowReusePolicy.commonPrefixCount(
            previous: previousIdentities,
            next: nextIdentities
        )
        if commonPrefixCount == previousEntries.count,
           nextEntries.count >= previousEntries.count {
            return previousRows + nextEntries.dropFirst(commonPrefixCount).map { appKitRow($0) }
        }
        guard
              let nextTailTurnId = nextEntries.last.map(chatDisplayEntryTurnId),
              let nextTailStart = nextEntries.firstIndex(where: { chatDisplayEntryTurnId($0) == nextTailTurnId }),
              let previousTailStart = previousEntries.firstIndex(where: { chatDisplayEntryTurnId($0) == nextTailTurnId }),
              nextTailStart == previousTailStart,
              zip(nextIdentities[..<nextTailStart], previousIdentities[..<previousTailStart]).allSatisfy(==) else {
            return nextEntries.map { appKitRow($0) }
        }
        return Array(previousRows[..<previousTailStart]) + nextEntries[nextTailStart...].map { appKitRow($0) }
    }

    private func makeIncrementalTailDisplay(
        for detail: CodexThreadDetail
    ) -> (displayItems: [CodexThreadItem], visibleEntries: [ChatDisplayEntry], totalCount: Int, signature: String, sourceSignature: String)? {
        DetailIncrementalProjection(
            cachedSessionId: cachedSessionId,
            cachedSourceItemCount: cachedSourceItemCount,
            cachedSourcePenultimateItemId: cachedSourcePenultimateItemId,
            cachedSourceTailItem: cachedSourceTailItem,
            cachedDisplayEntries: cachedDisplayEntries,
            cachedTotalDisplayEntryCount: cachedTotalDisplayEntryCount,
            cachedVisibleMessageLimit: cachedVisibleMessageLimit,
            cachedItemsSignature: cachedItemsSignature
        ).project(for: detail, sessionId: sessionId, visibleMessageLimit: visibleMessageLimit,
                  requestedRestorationAnchorRowID: requestedRestorationAnchorRowID)
    }

    private func updateCachedSourceTail(from items: [CodexThreadItem]) {
        cachedSourceItemCount = items.count
        cachedSourcePenultimateItemId = items.dropLast().last?.id
        cachedSourceTailItem = items.last
    }

    private var shouldRenderDetailMessages: Bool {
        if let anchorRowID = requestedRestorationAnchorRowID,
           !cachedDisplayEntries.contains(where: { $0.id == anchorRowID }) {
            return false
        }
        if hasPreparedDisplayCacheForCurrentSession {
            return true
        }
        if hasPreheatedDisplayCacheForCurrentSession {
            return true
        }
        let canRender = renderInputs?.acceptsPresentationUpdates ?? legacyCanRenderMessages
        if !canRender {
            PerfStopwatch.event("会话切换.shouldRender=false.placeholder", value: 1)
        }
        return canRender
    }

    private var hasPreparedDisplayCacheForCurrentSession: Bool {
        cachedSessionId == sessionId
    }

    private var hasPreheatedDisplayCacheForCurrentSession: Bool {
        cachedDisplayProjection?.sessionId == sessionId && cachedDisplayProjection?.displayEntries.isEmpty == false
    }

    private func restoreCachedProjectionDisplayCacheIfNeeded() {
        guard acceptsPresentationUpdates else { return }
        let trace = SessionSwitchTrace.shared.start(.restoreProjection, sessionID: sessionId)
        defer { SessionSwitchTrace.shared.finish(trace) }
        guard let cachedDisplayProjection,
              cachedDisplayProjection.sessionId == sessionId else {
            return
        }
        if hasPreparedDisplayCacheForCurrentSession {
            // DetailView is intentionally recreated when switching Sessions.
            // Its immutable display entries survive in presentationCache, but
            // native rows are renderer state. Materialize them once on mount
            // instead of rebuilding them from body on every publication.
            if cachedAppKitRows.count != cachedDisplayEntries.count {
                cachedAppKitRows = PerfStopwatch.measure("会话切换.appKitRow恢复") {
                    preparedAppKitRows(cachedDisplayEntries, cache: cachedDisplayProjection)
                }
            }
            return
        }
        PerfStopwatch.event("会话切换.restoreCachedProjection", value: cachedDisplayProjection.displayEntries.count)
        cachedSessionId = sessionId
        updateCachedSourceTail(from: cachedDisplayProjection.displayItems)
        cachedDisplayEntries = cachedDisplayProjection.displayEntries
        cachedAppKitRows = PerfStopwatch.measure("会话切换.appKitRow重建") {
            preparedAppKitRows(cachedDisplayProjection.displayEntries, cache: cachedDisplayProjection)
        }
        cachedTotalDisplayEntryCount = cachedDisplayProjection.totalDisplayEntryCount
        cachedVisibleMessageLimit = cachedDisplayProjection.visibleMessageLimit
        visibleMessageLimit = cachedDisplayProjection.visibleMessageLimit
        cachedItemsSignature = cachedDisplayProjection.signature
        cachedDetailSourceSignature = cachedDisplayProjection.sourceSignature
        presentationCache.store(cachedDisplayProjection)
    }

    private func restoreDisplayCacheForCurrentSession() {
        let trace = SessionSwitchTrace.shared.start(.restoreDisplay, sessionID: sessionId)
        defer { SessionSwitchTrace.shared.finish(trace) }
        if let cache = presentationState.cache {
            SessionSwitchTrace.shared.mark(.displayCacheHit, sessionID: sessionId)
            cachedSessionId = sessionId
            updateCachedSourceTail(from: cache.displayItems)
            cachedDisplayEntries = cache.displayEntries
            cachedAppKitRows = preparedAppKitRows(cache.displayEntries, cache: cache)
            cachedTotalDisplayEntryCount = cache.totalDisplayEntryCount
            cachedVisibleMessageLimit = cache.visibleMessageLimit
            visibleMessageLimit = cache.visibleMessageLimit
            cachedItemsSignature = cache.signature
            cachedDetailSourceSignature = cache.sourceSignature
            return
        }
        // 切会话时内部字典未命中，直接绑定活跃同步链路维护的 display 缓存，
        // 避免先清空再等 onAppear 填充导致的空态闪动或滚动条跳变。
        if let cachedDisplayProjection,
           cachedDisplayProjection.sessionId == sessionId,
           !cachedDisplayProjection.displayEntries.isEmpty {
            cachedSessionId = sessionId
            updateCachedSourceTail(from: cachedDisplayProjection.displayItems)
            cachedDisplayEntries = cachedDisplayProjection.displayEntries
            cachedAppKitRows = preparedAppKitRows(cachedDisplayProjection.displayEntries, cache: cachedDisplayProjection)
            cachedTotalDisplayEntryCount = cachedDisplayProjection.totalDisplayEntryCount
            cachedVisibleMessageLimit = cachedDisplayProjection.visibleMessageLimit
            visibleMessageLimit = cachedDisplayProjection.visibleMessageLimit
            cachedItemsSignature = cachedDisplayProjection.signature
            cachedDetailSourceSignature = cachedDisplayProjection.sourceSignature
            presentationCache.store(cachedDisplayProjection)
            return
        }
        SessionSwitchTrace.shared.mark(.displayCacheMiss, sessionID: sessionId)
        cachedSessionId = ""
        cachedSourceItemCount = 0
        cachedSourcePenultimateItemId = nil
        cachedSourceTailItem = nil
        cachedDisplayEntries = []
        cachedAppKitRows = []
        cachedTotalDisplayEntryCount = 0
        cachedVisibleMessageLimit = 0
        cachedItemsSignature = ""
        cachedDetailSourceSignature = ""
    }

    private func detailSourceSignature(for detail: CodexThreadDetail) -> String {
        makeDetailSourceSignature(
            for: detail,
            visibleMessageLimit: visibleMessageLimit,
            restorationAnchorRowID: requestedRestorationAnchorRowID
        )
    }


}

enum ConversationChromeElement: Hashable {
    case viewport
    case header
    case composer
}

struct ConversationChromeFramePreferenceKey: PreferenceKey {
    static let coordinateSpace = "conversation.chrome"
    static let defaultValue: [ConversationChromeElement: CGRect] = [:]

    static func reduce(
        value: inout [ConversationChromeElement: CGRect],
        nextValue: () -> [ConversationChromeElement: CGRect]
    ) {
        value.merge(nextValue()) { _, next in next }
    }
}

struct ConversationChromeClearances {
    let top: CGFloat
    let bottom: CGFloat

    init?(frames: [ConversationChromeElement: CGRect]) {
        guard let viewport = frames[.viewport] else { return nil }
        let headerOverlap = frames[.header].map { max(0, $0.maxY - viewport.minY) } ?? 0
        let composerOverlap = frames[.composer].map { max(0, viewport.maxY - $0.minY) } ?? 0
        top = headerOverlap > 0 ? headerOverlap + 10 : 0
        bottom = composerOverlap > 0 ? composerOverlap + 10 : 0
    }
}

private extension SessionConversationSurface {
    func conversationChromeFrame(_ element: ConversationChromeElement) -> some View {
        GeometryReader { geometry in
            Color.clear.preference(
                key: ConversationChromeFramePreferenceKey.self,
                value: [element: geometry.frame(in: .named(ConversationChromeFramePreferenceKey.coordinateSpace))]
            )
        }
    }
}
