import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct SessionConversationContent: View {
    @ObservedObject private var backendClient: BackendClient
    @ObservedObject private var timelineHistory = BackendClient.shared.timelineHistoryController
    @ObservedObject private var archivedSessionState = BackendClient.shared.archivedSessionController
    @ObservedObject private var selectionController: SessionSelectionController
    @EnvironmentObject private var panelLayoutState: PanelLayoutState
    @MainActor
    static var initialVisibleMessageLimit: Int {
        ChatTimelineFeatureFlags.current.initialDisplayWeight
    }
    @State private var visibleMessageLimit: Int
    @State private var cachedSourceItemCount = 0
    @State private var cachedSourcePenultimateItemId: String?
    @State private var cachedSourceTailItem: CodexThreadItem?
    @State private var cachedDisplayEntries: [ChatDisplayEntry] = []
    @State private var cachedAppKitRows: [AppKitChatTimelineRow] = []
    @State private var cachedTotalDisplayEntryCount = 0
    @State private var cachedVisibleMessageLimit = 0
    @State private var cachedItemsSignature = ""
    @State private var cachedDetailSourceSignature = ""
    @State private var cachedSessionId = ""
    @ObservedObject var presentationCache: SessionPresentationCache
    @ObservedObject private var presentationState: SessionPresentationState
    @State private var expandedProcessTurnIds: Set<String> = []
    @State private var viewportState = ConversationViewportState()
    @State private var appKitScrollToBottomRevision = 0
    @State private var displayProjectionTask: Task<Void, Never>?
    @State private var displayProjectionGeneration = 0
    @State private var pendingProjectionSourceSignature: String?
    @State private var timelineRestorationIntent: TimelineRestorationIntent
    @State private var historyAnchorRestoreTask: Task<Void, Never>?
    @State private var earlierHistoryLoadState: EarlierHistoryLoadState
    @State private var historyRequestEpoch = 0
    @ObservedObject private var timelineState: SessionTimelineState
    @State private var displaysLoadingDetail: Bool
    @State private var displayedWorkspaceRecoveryStatus: WorkspaceRecoveryStatus?
    @State private var scrollTargetTurnID: String?
    @State private var scrollTargetTurnRevision = 0
    @State private var pendingFork: SessionForkSelection?
    let sessionId: String
    let composerDraftRepository: ComposerDraftRepository
    let initialTimelinePosition: AppKitChatTimelinePosition?
    let onTimelinePositionChange: (AppKitChatTimelinePosition) -> Void
    let showsHeader: Bool
    let allowsModelSwitch: Bool
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
        presentation: SessionConversationPresentation = .standard
    ) {
        self.sessionId = sessionId
        self.presentationCache = presentationCache
        self.composerDraftRepository = composerDraftRepository
        _backendClient = ObservedObject(wrappedValue: backendClient)
        _selectionController = ObservedObject(
            wrappedValue: backendClient.sessionSelectionController
        )
        self.initialTimelinePosition = initialTimelinePosition
        self.onTimelinePositionChange = onTimelinePositionChange
        self.showsHeader = showsHeader
        self.allowsModelSwitch = allowsModelSwitch
        self.presentation = presentation
        let presentationState = presentationCache.state(for: sessionId)
        _presentationState = ObservedObject(wrappedValue: presentationState)
        let timelineState = SessionTimelineRepository.shared.state(for: sessionId)
        _timelineState = ObservedObject(wrappedValue: timelineState)
        let initialCache = presentationState.cache
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
            initialValue: backendClient.selectedSession?.id == sessionId && backendClient.isLoadingDetail
        )
        _displayedWorkspaceRecoveryStatus = State(
            initialValue: backendClient.selectedSession?.id == sessionId
                ? backendClient.workspaceRecoveryStatus
                : nil
        )
        PerfStopwatch.event("会话切换.DetailView.init", value: 1)
    }

    private var cachedDisplayProjection: DetailDisplayCache? {
        presentationState.cache
    }

    private var restorationTimelinePosition: AppKitChatTimelinePosition? {
        initialTimelinePosition
    }

    private var requestedRestorationAnchorRowID: String? {
        timelineRestorationIntent.requestedAnchorRowID
    }

    private var displayedDetail: CodexThreadDetail? {
        timelineState.detail
    }

    private var selectedSession: TaskSession? {
        backendClient.sessions.first(where: { $0.id == sessionId })
            ?? backendClient.archivedSessions.first(where: { $0.id == sessionId })
    }

    private var contentPhase: SessionDetailContentPhase {
        sessionDetailContentPhase(
            hasLiveDetail: displayedDetail != nil,
            cachedSessionID: hasPreparedDisplayCacheForCurrentSession ? cachedSessionId : nil,
            selectedSessionID: sessionId,
            isLoading: displaysLoadingDetail,
            hasError: backendClient.selectedTimelineLoadError != nil || backendClient.lastError != nil
        )
    }

    @ViewBuilder
    private var backendConnectionBanner: some View {
        if !backendClient.isOnline {
            BackendDisconnectedSessionView(
                wasExecuting: selectedSession?.executionTaskStatus == .running
            )
        }
    }

    @ViewBuilder
    private var sessionComposer: some View {
        if !backendClient.isOnline {
            ReadOnlyComposer(reason: backendDisconnectedSessionMessage(
                wasExecuting: selectedSession?.executionTaskStatus == .running
            ), isRecovering: false)
        } else if let recovery = displayedWorkspaceRecoveryStatus,
                  recovery.blocksSessionInput {
            WorkspaceMissingComposer(status: recovery)
        } else {
            // Keep the editor identity stable across transient Provider and
            // Binding readiness changes. MessageComposer gates submission from
            // the authoritative Session projection; readiness must not destroy
            // the text view, its focus, or the user's draft.
            MessageComposer(
                sessionId: sessionId,
                draftRepository: composerDraftRepository,
                modelCatalog: backendClient.modelCatalog,
                allowsModelSwitch: allowsModelSwitch,
                status: selectedSession?.executionTaskStatus ?? displayedDetail?.status,
                isReady: selectedSession?.isReady ?? displayedDetail?.isReady ?? true,
                notReadyReason: selectedSession?.notReadyReason ?? displayedDetail?.notReadyReason,
                activityStatus: selectedSession?.activityStatus ?? displayedDetail?.activityStatus
            )
            .id(sessionId)
        }
    }

    @ViewBuilder
    private var sessionReadinessNotice: some View {
        if backendClient.isOnline,
           displayedWorkspaceRecoveryStatus?.blocksSessionInput != true,
           let session = selectedSession,
           session.readiness == .notReady,
           let reason = session.notReadyReason {
            SessionNotReadyComposerNotice(session: session, reason: reason)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: presentation == .workspaceCard ? 6 : 12) {
            if showsHeader {
                DetailHeaderView()
            }

            backendConnectionBanner

            if let recovery = displayedWorkspaceRecoveryStatus,
               recovery.orphaned {
                OrphanedWorkspaceRecoveryView(status: recovery)
            }

            // Match iPad: the composer owns a real bottom safe-area inset so
            // AppKit's viewport ends above it without a measured spacer.
            Group {
                switch contentPhase {
                case .live:
                    if let detail = displayedDetail {
                        Group {
                            if shouldRenderDetailMessages {
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
                        error: backendClient.selectedTimelineLoadError
                            ?? backendClient.lastError
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
            .overlay(alignment: .bottomTrailing) {
                jumpToLatestButton.padding(10)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 6) {
                    if let session = selectedSession {
                        SessionSendFailureView(sessionID: session.id)
                    }
                    sessionReadinessNotice
                    sessionComposer
                }
                .padding(.bottom, 4)
            }
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
        }
        .padding(1)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.001))
        )
        .onAppear {
            restoreCachedProjectionDisplayCacheIfNeeded()
            restoreMissingHistoryAnchorIfNeeded()
        }
        .onChange(of: cachedDisplayProjection?.signature) { _, _ in
            restoreCachedProjectionDisplayCacheIfNeeded()
            restoreMissingHistoryAnchorIfNeeded()
        }
        .onChange(of: sessionId) { _, _ in
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
            guard selectedSessionID == sessionId else {
                historyAnchorRestoreTask?.cancel()
                historyAnchorRestoreTask = nil
                return
            }
            restoreMissingHistoryAnchorIfNeeded()
        }
        .onReceive(backendClient.$isLoadingDetail) { isLoading in
            guard backendClient.selectedSession?.id == sessionId else { return }
            displaysLoadingDetail = isLoading
        }
        .onReceive(timelineHistory.$earlierHistoryLoadStateBySessionID) { states in
            let nextState = states[sessionId] ?? .idle
            let previousState = earlierHistoryLoadState
            earlierHistoryLoadState = nextState
            let finishedWithoutStructuralAdvance = previousState == .loading && nextState == .idle
            if case .failed = nextState, nextState != previousState {
                historyRequestEpoch &+= 1
            } else if finishedWithoutStructuralAdvance {
                historyRequestEpoch &+= 1
            }
        }
        .onReceive(backendClient.supplementaryDataController.$workspaceRecoveryStatus) { status in
            guard backendClient.selectedSession?.id == sessionId else { return }
            displayedWorkspaceRecoveryStatus = status
        }
        .onReceive(NotificationCenter.default.publisher(for: .scrollSessionTimelineToTurn)) { notification in
            guard notification.userInfo?["sessionId"] as? String == sessionId,
                  let turnID = notification.userInfo?["turnId"] as? String else { return }
            scrollTargetTurnID = turnID
            scrollTargetTurnRevision &+= 1
        }
    }

    private func appKitCachedDetailMessages() -> some View {
        appKitDetailMessages(displayEntries: currentSessionDisplayEntries)
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
            : displayEntries.map { appKitRow($0) }
        return VStack(alignment: .leading, spacing: 6) {
            AppKitChatTimelineView(
                sessionID: sessionId,
                rows: rows,
                scrollToBottomRevision: appKitScrollToBottomRevision,
                baseDirectory: displayedDetail?.cwd,
                canAdvanceProcessClock: backendClient.isOnline
                    && selectedSession?.executionTaskStatus == .running,
                followsLatest: followsLatestBinding,
                onToggleExpansion: toggleNativeProcessExpansion,
                onAction: performNativeTimelineAction,
                onNearTop: loadEarlierMessagesIfNeeded,
                hasMoreHistory: selectedSession != nil && displayedDetail?.hasMoreHistory == true,
                onUnderfilledHistory: loadEarlierMessagesForUnderfilledViewport,
                initialPosition: effectiveInitialTimelinePosition,
                onPositionChange: { position in
                    let hadRestorationAnchor = requestedRestorationAnchorRowID != nil
                    timelineRestorationIntent.observeViewport(position)
                    if hadRestorationAnchor && requestedRestorationAnchorRowID == nil {
                        refreshAfterRestorationAnchorRelinquished()
                    }
                    onTimelinePositionChange(position)
                },
                scrollToTurnID: scrollTargetTurnID,
                scrollToTurnRevision: scrollTargetTurnRevision,
                historyRequestEpoch: historyRequestEpoch
            )
            .sheet(item: $pendingFork) { selection in
                SessionForkSheet(selection: selection, backendClient: backendClient)
            }
            .onChange(of: selectedSession?.actions?.fork?.available) { _, _ in
                guard cachedSessionId == sessionId else { return }
                let entries = Dictionary(uniqueKeysWithValues: cachedDisplayEntries.map { ($0.id, $0) })
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
        expansionSnapshot: Set<String>? = nil
    ) -> AppKitChatTimelineRow {
        let expandedTurnIds = expansionSnapshot ?? expandedProcessTurnIds
        var row = nativeAppKitRow(entry, expandedTurnIds: expandedTurnIds)
        row.isWorkspaceCard = presentation == .workspaceCard
        row.sessionID = sessionId
        return row
    }

    private var nativeRowBuilder: ConversationNativeRowBuilder {
        ConversationNativeRowBuilder(
            sessionTitle: displayedDetail?.title ?? backendClient.selectedSession?.title,
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
        switch action.kind {
        case .forkMessage(let itemID):
            pendingFork = SessionForkSelection(sessionID: sessionId, itemID: itemID)
        case .codexApproval(let option):
            backendClient.respondToCodexApproval(option: option)
        case .ptyChoice(let option, let choiceID):
            backendClient.respondToPtyChoice(option: option, choiceId: choiceID)
        case .sendMessage(let message):
            backendClient.sendMessage(message)
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
        cachedAppKitRows = cachedDisplayEntries.map {
            appKitRow($0, expansionSnapshot: nextExpandedTurnIds)
        }
    }

    // 微信/Discord 式「上滑到顶自动加载」：先展开已加载窗口，窗口耗尽后再补拉。
    private func loadEarlierMessagesIfNeeded() {
        loadEarlierMessages(preservingLatestFollow: false)
    }

    private func loadEarlierMessagesForUnderfilledViewport() {
        loadEarlierMessages(preservingLatestFollow: true)
    }

    private func loadEarlierMessages(preservingLatestFollow: Bool) {
        guard backendClient.selectedSession?.id == sessionId,
              let detail = displayedDetail else { return }
        let visibleWeight = cachedDisplayEntries.reduce(0) { $0 + $1.displayWeight }
        let hiddenCount = max(0, cachedTotalDisplayEntryCount - visibleWeight)
        viewportState.prepareForHistoryPrepend(preservingLatestFollow: preservingLatestFollow)
        if hiddenCount > 0 {
            ChatPerformanceRecorder.shared.increment(.historyPrepends)
            ChatPerformanceTrace.event("timeline.history.prepend", value: min(100, hiddenCount))
            visibleMessageLimit += 100
            updateCachedDisplayEntries(for: detail)
        } else if detail.hasMoreHistory == true {
            if let session = backendClient.selectedSession, session.id == sessionId {
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
                    if case .failed = result,
                       backendClient.selectedSession?.id == sessionId {
                        visibleMessageLimit = previousVisibleMessageLimit
                        if let current = displayedDetail {
                            updateCachedDisplayEntries(for: current)
                        }
                    }
                }
            }
        }
    }

    private func restoreMissingHistoryAnchorIfNeeded() {
        guard historyAnchorRestoreTask == nil,
              backendClient.selectedSession?.id == sessionId,
              let anchorRowID = requestedRestorationAnchorRowID,
              !cachedDisplayEntries.contains(where: { $0.id == anchorRowID }),
              let detail = displayedDetail else { return }

        if timelineContains(rowID: anchorRowID, in: detail.items) {
            updateCachedDisplayEntries(for: detail)
            return
        }
        guard detail.hasMoreHistory == true,
              let session = backendClient.selectedSession else {
            // A deleted/invalid anchor degrades directly to latest. Reusing
            // the old absolute Y against a different row set is what caused
            // the visible jump to unrelated historical content.
            timelineRestorationIntent.clearAnchor()
            updateCachedDisplayEntries(for: detail)
            return
        }

        historyAnchorRestoreTask = Task { @MainActor in
            defer { historyAnchorRestoreTask = nil }
            guard let selectionGeneration = backendClient.selectionGenerationToken(for: sessionId) else { return }
            let result = await backendClient.loadTimelineWindow(
                for: session,
                anchorRowID: anchorRowID,
                expectedSelectionGeneration: selectionGeneration
            )
            guard !Task.isCancelled,
                  backendClient.selectedSession?.id == sessionId,
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
        ChatPerformanceRecorder.shared.increment(.displayRebuilds)
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
        let nextDisplayItems = detail.items.filter { !isLowSignalDetailProcessItem($0) }
        guard requestedRestorationAnchorRowID == nil,
              cachedSessionId == sessionId,
              DetailTimelineIncrementalEligibility.canReuseCachedWindow(
                cachedVisibleMessageLimit: cachedVisibleMessageLimit,
                requestedVisibleMessageLimit: visibleMessageLimit
              ),
              cachedSourceItemCount > 0,
              nextDisplayItems.count >= cachedSourceItemCount,
              let cachedLast = cachedSourceTailItem,
              nextDisplayItems[cachedSourceItemCount - 1].id == cachedLast.id,
              nextDisplayItems[cachedSourceItemCount - 1].turnId == cachedLast.turnId,
              (cachedSourceItemCount < 2
                || nextDisplayItems[cachedSourceItemCount - 2].id == cachedSourcePenultimateItemId) else {
            return nil
        }

        let appendedItems = nextDisplayItems.dropFirst(cachedSourceItemCount)
        if let firstAppended = appendedItems.first,
           firstAppended.turnId != cachedLast.turnId {
            // A new source turn is independent from the cached tail. Project
            // only the appended delta; the bounded visible window may discard
            // old rows without revisiting the rest of the Session history.
            guard appendedItems.allSatisfy({ $0.turnId != cachedLast.turnId }) else { return nil }
            let appendedEntries = makeChatDisplayEntries(from: Array(appendedItems))
            let combined = cachedDisplayEntries + appendedEntries
            return (
                displayItems: nextDisplayItems,
                visibleEntries: visibleDetailEntries(from: combined, limit: visibleMessageLimit),
                totalCount: cachedTotalDisplayEntryCount
                    + appendedEntries.reduce(0) { $0 + $1.displayWeight },
                signature: incrementalDisplaySignature(
                    previousSignature: cachedItemsSignature,
                    tailEntries: appendedEntries
                ),
                sourceSignature: detailSourceSignature(for: detail)
            )
        }

        guard let nextLast = nextDisplayItems.last,
              nextLast.turnId == cachedLast.turnId else { return nil }
        let tailItems = nextDisplayItems.reversed().prefix { $0.turnId == nextLast.turnId }.reversed()
        // Reused or missing provider turn IDs need the full ordered projection
        // so user-message boundaries can be recovered. The tail-only fast path
        // would otherwise collapse those recovered turns back into one group.
        guard tailItems.lazy.filter({ $0.type == "userMessage" }).prefix(2).count < 2 else {
            return nil
        }
        let nextTailEntries = makeChatDisplayEntriesForTurn(
            stableChronologicalChatItems(Array(tailItems))
        )
        guard let oldTailStart = cachedDisplayEntries.firstIndex(where: {
            chatDisplayEntryTurnId($0) == nextLast.turnId
        }) else {
            return nil
        }
        let oldTailEntries = cachedDisplayEntries[oldTailStart...]
        guard oldTailEntries.allSatisfy({ chatDisplayEntryTurnId($0) == nextLast.turnId }) else {
            return nil
        }

        let oldTailWeight = oldTailEntries.reduce(0) { $0 + $1.displayWeight }
        let nextTailWeight = nextTailEntries.reduce(0) { $0 + $1.displayWeight }
        let combined = Array(cachedDisplayEntries[..<oldTailStart]) + nextTailEntries
        let visibleEntries = visibleDetailEntries(from: combined, limit: visibleMessageLimit)
        let totalCount = max(0, cachedTotalDisplayEntryCount - oldTailWeight + nextTailWeight)
        return (
            displayItems: nextDisplayItems,
            visibleEntries: visibleEntries,
            totalCount: totalCount,
            signature: incrementalDisplaySignature(
                previousSignature: cachedItemsSignature,
                tailEntries: nextTailEntries
            ),
            sourceSignature: detailSourceSignature(for: detail)
        )
    }

    private func updateCachedSourceTail(from items: [CodexThreadItem]) {
        cachedSourceItemCount = items.count
        cachedSourcePenultimateItemId = items.dropLast().last?.id
        cachedSourceTailItem = items.last
    }

    private func incrementalDisplaySignature(
        previousSignature: String,
        tailEntries: [ChatDisplayEntry]
    ) -> String {
        let tailSignature = tailEntries.map { entry in
            switch entry.kind {
            case .message(let item): return detailItemSignature(item)
            case .process(let turnId, let items):
                return turnId + ":" + items.suffix(1).map(detailItemSignature).joined()
            }
        }.joined(separator: "|")
        return "\(previousSignature.hashValue):\(tailSignature)"
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
        let canRender = panelLayoutState.canRenderDetailMessages
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
                    cachedDisplayEntries.map { appKitRow($0) }
                }
            }
            return
        }
        PerfStopwatch.event("会话切换.restoreCachedProjection", value: cachedDisplayProjection.displayEntries.count)
        cachedSessionId = sessionId
        updateCachedSourceTail(from: cachedDisplayProjection.displayItems)
        cachedDisplayEntries = cachedDisplayProjection.displayEntries
        cachedAppKitRows = PerfStopwatch.measure("会话切换.appKitRow重建") {
            cachedDisplayProjection.displayEntries.map { appKitRow($0) }
        }
        cachedTotalDisplayEntryCount = cachedDisplayProjection.totalDisplayEntryCount
        cachedVisibleMessageLimit = cachedDisplayProjection.visibleMessageLimit
        visibleMessageLimit = cachedDisplayProjection.visibleMessageLimit
        cachedItemsSignature = cachedDisplayProjection.signature
        cachedDetailSourceSignature = cachedDisplayProjection.sourceSignature
        presentationCache.store(cachedDisplayProjection)
    }

    private func restoreDisplayCacheForCurrentSession() {
        if let cache = presentationState.cache {
            cachedSessionId = sessionId
            updateCachedSourceTail(from: cache.displayItems)
            cachedDisplayEntries = cache.displayEntries
            cachedAppKitRows = cache.displayEntries.map { appKitRow($0) }
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
            cachedAppKitRows = cachedDisplayProjection.displayEntries.map { appKitRow($0) }
            cachedTotalDisplayEntryCount = cachedDisplayProjection.totalDisplayEntryCount
            cachedVisibleMessageLimit = cachedDisplayProjection.visibleMessageLimit
            visibleMessageLimit = cachedDisplayProjection.visibleMessageLimit
            cachedItemsSignature = cachedDisplayProjection.signature
            cachedDetailSourceSignature = cachedDisplayProjection.sourceSignature
            presentationCache.store(cachedDisplayProjection)
            return
        }
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
