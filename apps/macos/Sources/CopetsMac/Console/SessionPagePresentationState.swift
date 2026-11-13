import AppKit
import Combine
import Observation
import CorptieClientCore
import CorptieConversation

@MainActor protocol SessionPagePresenting: AnyObject {
    var settledSessionID: String? { get }
    @discardableResult
    func presentOpeningPage(sessionID: String, title: String,
                            activate: @escaping @MainActor () -> Void) -> Bool
    func cancelPendingPresentation()
}

extension SessionPagePresenting { var settledSessionID: String? { nil } }

/// Window-local presentation scheduling, not a second business selection authority.
/// Presentation scheduling must not replace available content with a loading screen.
@MainActor final class SessionPagePresentationState {
    weak var presenter: (any SessionPagePresenting)?
    private(set) var generation: UInt64 = 0
    var settledSessionID: String? { presenter?.settledSessionID }
    private var requestedSessionID: String?

    @discardableResult
    func request(sessionID: String, title: String, activate: @escaping @MainActor () -> Void) -> Bool {
        generation &+= 1
        requestedSessionID = sessionID
        let request = generation
        guard let presenter else { return false }
        return presenter.presentOpeningPage(sessionID: sessionID, title: title) { [weak self] in
            guard let self, self.generation == request else { return }
            activate()
        }
    }

    func cancel() {
        generation &+= 1
        requestedSessionID = nil
        presenter?.cancelPendingPresentation()
    }

    func businessSelectionWillChange(to sessionID: String?) {
        if let requestedSessionID, requestedSessionID != sessionID { cancel() }
    }
}

/// Typed inputs for one retained page. This is presentation state, not a
/// BackendClient proxy or an alternative owner of commands and business data.
/// The native page controller resumes it when the target page is selected.
@MainActor @Observable
final class SessionPageRenderInputs {
    let scope: ClientDetailBusinessScope
    let activity = ConversationDetailPresentationActivity()
    private(set) var session: TaskSession
    private(set) var detail: CodexThreadDetail?
    private(set) var detailPresentationRevision: UInt64 = 0
    private(set) var detailTailContentRevision = "none"
    private(set) var displayCache: DetailDisplayCache?
    private(set) var online = false
    private(set) var loading = false
    private(set) var loadError: String?
    private(set) var lastError: String?
    private(set) var historyState: EarlierHistoryLoadState = .idle
    private(set) var historicalThreadID: String?
    private(set) var workspaceRecovery: WorkspaceRecoveryStatus?
    private(set) var projectStatus: ProjectWorktreeStatusResponse?
    private(set) var usage: SessionUsageResponse?
    private(set) var usageLoadState: UsageLoadState = .loading
    private(set) var restart: SessionRestartActivity?
    private(set) var providers: [AgentProviderDescriptor] = []
    private(set) var models: [CodexModel] = []
    private(set) var defaultModel: String?
    private(set) var defaultReasoning: String?
    private(set) var loadingModels = false
    private(set) var switchingModel = false
    private(set) var switchingReasoning = false
    private(set) var sendingMessage = false
    private(set) var sendFailure: String?
    private(set) var restarting = false
    private(set) var verifyingBinding = false
    private(set) var tasks: [CorptieTask] = []
    private(set) var works: [Work] = []
    private(set) var workName: String?
    private(set) var roles: [Role] = []
    private(set) var mentionSessions: [TaskSession] = []
    private(set) var mentionCatalogRevision: UInt64 = 0
    private(set) var searchTarget: UnifiedSearchNavigation.Target?
    private(set) var searchMatches: [UnifiedSearchHit] = []
    private(set) var searchError: String?
    private(set) var retired = false

    private struct Binding: Equatable {
        let provider: String?; let thread: String?; let logical: String?; let routing: Int?; let cwd: String?; let workspace: String?
        init(_ session: TaskSession) {
            provider = session.external?.provider; thread = session.external?.threadId
            logical = session.external?.logicalSessionId; routing = session.external?.routingVersion
            cwd = session.external?.cwd; workspace = session.external?.workspace?.path
        }
    }
    @ObservationIgnored private let businessHandle: ClientDetailBusinessHandle
    @ObservationIgnored private let binding: Binding
    @ObservationIgnored private let backend: BackendClient
    @ObservationIgnored private let sourceState: AppStateStore
    @ObservationIgnored private let timeline: SessionTimelineState
    @ObservationIgnored private let projection: SessionPresentationState
    @ObservationIgnored private let entities: EntityAPIClient
    @ObservationIgnored private let search: UnifiedSearchNavigation
    @ObservationIgnored private var subscriptions: [AnyCancellable] = []
    @ObservationIgnored private var subscriptionGeneration: UInt64 = 0
    @ObservationIgnored private var pending: Changes = .all
    @ObservationIgnored private var active = false
    @ObservationIgnored private var scheduled = false
    @ObservationIgnored private(set) var refreshCount = 0
    @ObservationIgnored private var cacheKey: CacheKey?
    @ObservationIgnored var suspendNativePresentation: (() -> Void)?
    @ObservationIgnored var resumeNativePresentation: (() -> Void)?
    @ObservationIgnored private var retainedEditor: ComposerEditorController?
    @ObservationIgnored private var needsQuickMessageRefresh = false
    private(set) var quickMessageRevision = 0

    private struct Changes: OptionSet {
        let rawValue: UInt16
        static let metadata = Self(rawValue: 1 << 0)
        static let timeline = Self(rawValue: 1 << 1)
        static let projection = Self(rawValue: 1 << 2)
        static let backend = Self(rawValue: 1 << 3)
        static let supplementary = Self(rawValue: 1 << 4)
        static let commands = Self(rawValue: 1 << 5)
        static let catalog = Self(rawValue: 1 << 6)
        static let entities = Self(rawValue: 1 << 7)
        static let search = Self(rawValue: 1 << 8)
        static let restart = Self(rawValue: 1 << 9)
        static let history = Self(rawValue: 1 << 10)
        static let all: Self = [.metadata, .timeline, .projection, .backend, .supplementary,
            .commands, .catalog, .entities, .search, .restart, .history]
    }
    private struct CacheKey: Equatable {
        let sessionID: String
        let signature: String
        let sourceSignature: String
        let limit: Int
        let count: Int
        let anchor: String?
        init(_ value: DetailDisplayCache) {
            sessionID = value.sessionId; signature = value.signature; sourceSignature = value.sourceSignature
            limit = value.visibleMessageLimit; count = value.totalDisplayEntryCount; anchor = value.restorationAnchorRowID
        }
    }

    init(session: TaskSession, scope: ClientDetailBusinessScope, backend: BackendClient,
         timeline: SessionTimelineState, projection: SessionPresentationState,
         entities: EntityAPIClient = .shared, search: UnifiedSearchNavigation = .shared,
         sourceState: AppStateStore? = nil) {
        self.session = session; self.scope = scope; self.backend = backend; self.binding = Binding(session)
        self.businessHandle = backend.detailBusinessRepository.entry(for: scope)
        self.sourceState = sourceState ?? backend.appState
        self.timeline = timeline; self.projection = projection; self.entities = entities; self.search = search
    }

    /// Hidden pages retain their view/editor values, not upstream subscriptions.
    private func subscribe() {
        guard subscriptions.isEmpty else { return }
        observe(sourceState.objectWillChange, .metadata)
        observe(backend.archivedSessionController.objectWillChange, .metadata)
        observe(timeline.objectWillChange, .timeline)
        observe(projection.objectWillChange, .projection)
        observe(backend.objectWillChange, .backend)
        observe(backend.supplementaryDataController.objectWillChange, .supplementary)
        observe(backend.sessionCommandController.objectWillChange, .commands)
        observe(backend.modelCatalog.objectWillChange, .catalog)
        observe(entities.sessionGroupingDidChange, .entities)
        observe(search.objectWillChange, .search)
        observe(backend.sessionRestartActivityController.objectWillChange, .restart)
        observe(backend.timelineHistoryController.objectWillChange, .history)
        observe(backend.sessionSelectionController.$selectedSessionID.map { _ in () }, [.backend, .supplementary])
    }
    private func stopSubscriptions() {
        subscriptionGeneration &+= 1
        subscriptions.removeAll()
        scheduled = false
        pending = []
    }
    var subscriptionCount: Int { subscriptions.count }

    var acceptsPresentationUpdates: Bool { active && !retired }
    var acceptsScopeResults: Bool { !retired && validBinding() }
    func hasValidBinding() -> Bool { !retired && validBinding() }
    func editorController(for drafts: ComposerDraftRepository) -> ComposerEditorController {
        if let retainedEditor { return retainedEditor }
        let draft = drafts.draft(for: scope.sessionID); draft.sessionId = scope.sessionID
        let editor = ComposerEditorController(draft: draft)
        editor.permitsFocus = { [weak self] in
            guard let self else { return false }
            return self.actionSession(generation: self.activity.generation) != nil
        }
        editor.permitsDraftUpdates = { [weak self] in self?.acceptsScopeResults ?? false }
        if !active { editor.suspendPresentation() }
        retainedEditor = editor
        return editor
    }
    func finishEditingForSwitch() -> Bool { retainedEditor?.finishEditingForSessionSwitch() ?? true }
    func suspendEditorPresentation() { retainedEditor?.suspendPresentation() }
    func didSendMessage() {
        if active { quickMessageRevision &+= 1 } else { needsQuickMessageRefresh = true }
    }
    func suspendActions() { active = false; stopSubscriptions(); activity.suspendActions(); suspendNativePresentation?() }
    func freeze() {
        guard active || activity.isActive else { return }
        active = false; stopSubscriptions(); suspendNativePresentation?(); retainedEditor?.suspendPresentation(); activity.deactivate()
    }
    func resume() {
        guard !retired else { return }
        guard validBinding() else { retire(); return }
        let trace = SessionSwitchTrace.shared.start(.pageResume, sessionID: scope.sessionID)
        defer { SessionSwitchTrace.shared.finish(trace) }
        guard !active else { flush(); return }
        active = true
        pending = .all
        subscribe()
        flush()
        if needsQuickMessageRefresh { needsQuickMessageRefresh = false; quickMessageRevision &+= 1 }
        activity.activate()
        retainedEditor?.resumePresentation()
        resumeNativePresentation?()
    }
    func retire() {
        guard !retired else { return }
        SessionSwitchTrace.shared.recordCache(sessionID: scope.sessionID, layer: "page-inputs", reason: businessHandle.retired ? "business-retired" : "retired", count: 0)
        active = false; retired = true; activity.deactivate()
        retainedEditor?.suspendPresentation(); suspendNativePresentation?()
        stopSubscriptions(); pending = []
        detail = nil; displayCache = nil; cacheKey = nil
        workspaceRecovery = nil; projectStatus = nil; usage = nil
    }
    /// Display values never authorize an operation. Re-read the exact binding.
    func actionSession(generation: UInt64) -> TaskSession? {
        guard !retired, active, validBinding(), activity.allows(generation: generation),
              scope.serverID == backend.baseURL.absoluteString, scope.ownerID == backend.detailBusinessOwnerID,
              backend.sessionSelectionController.selectedSessionID == scope.sessionID,
              let current = latestSession(), current.archived != true,
              current.taskId == scope.taskID, current.workId == scope.workID else { return nil }
        return current
    }
    private func latestSession() -> TaskSession? {
        sourceState.session(scope.sessionID) ?? backend.archivedSessions.first { $0.id == scope.sessionID }
    }
    private func validBinding() -> Bool {
        guard !businessHandle.retired, let current = latestSession(), current.hasValidProductClassification else { return false }
        return current.id == scope.sessionID && current.taskId == scope.taskID && current.workId == scope.workID
            && scope.serverID == backend.baseURL.absoluteString && scope.ownerID == backend.detailBusinessOwnerID
            && Binding(current) == binding
    }
    private func observe<P: Publisher>(_ publisher: P, _ change: Changes) where P.Failure == Never {
        let generation = subscriptionGeneration
        publisher.receive(on: DispatchQueue.main).sink { [weak self] _ in
            guard let self, self.active, !self.retired, self.subscriptionGeneration == generation else { return }
            self.pending.formUnion(change)
            // Binding/permission invalidation is an intentional exception to
            // freezing: an invalid cached surface must become unusable at once.
            if !change.intersection([.metadata, .backend]).isEmpty, !self.validBinding() { self.retire(); return }
            guard self.active, !self.scheduled else { return }
            self.scheduled = true
            DispatchQueue.main.async { [weak self] in
                guard let self, self.subscriptionGeneration == generation else { return }
                self.scheduled = false
                if self.active { self.flush() }
            }
        }.store(in: &subscriptions)
    }
    private func flush() {
        guard active, !pending.isEmpty, !retired else { return }
        let trace = SessionSwitchTrace.shared.start(.pageFlush, sessionID: scope.sessionID)
        defer { SessionSwitchTrace.shared.finish(trace) }
        var changes = pending; pending = []; refreshCount += 1
        if changes.contains(.metadata) { mentionSessions = sourceState.sessions }
        if changes.contains(.metadata), let value = latestSession(), session != value {
            if session.external?.provider != value.external?.provider { changes.insert(.catalog) }
            session = value
        }
        // A shared projection may be published while this page is resuming or
        // from another window. Reconcile the source before exposing that cache
        // so its revision gate never compares against stale page inputs.
        let timelineChanged = changes.contains(.timeline)
            && (detailPresentationRevision != timeline.presentationRevision || detail != timeline.presentationDetail)
        let projectionSourceAdvanced = changes.contains(.projection)
            && detailPresentationRevision != timeline.presentationRevision
        if timelineChanged || projectionSourceAdvanced {
            detail = timeline.presentationDetail
            detailPresentationRevision = timeline.presentationRevision
            detailTailContentRevision = timeline.tailContentRevision
        }
        if changes.contains(.projection) {
            let next = projection.cache.map(CacheKey.init)
            if cacheKey != next { cacheKey = next; displayCache = projection.cache }
        }
        let ownsSelection = backend.sessionSelectionController.selectedSessionID == scope.sessionID
        if changes.contains(.backend) {
            online = backend.isOnline
            loading = ownsSelection ? backend.isLoadingDetail : detail == nil
            loadError = ownsSelection ? backend.selectedTimelineLoadError : nil
            lastError = ownsSelection ? backend.lastError : nil
            historicalThreadID = ownsSelection ? backend.viewingHistoricalThreadId : nil
            verifyingBinding = backend.bindingVerificationSessionIDs.contains(scope.sessionID)
        }
        if changes.contains(.supplementary), ownsSelection {
            let source = backend.supplementaryDataController
            workspaceRecovery = source.workspaceRecoveryStatus; projectStatus = source.selectedProjectWorktreeStatus
            usage = source.selectedSessionUsage
            usageLoadState = source.usageLoadState
        }
        if changes.contains(.commands) {
            let source = backend.sessionCommandController
            switchingModel = source.isSwitchingModel; switchingReasoning = source.isSwitchingReasoning
            sendingMessage = source.isSendingMessage; sendFailure = source.sendFailures[scope.sessionID]
            restarting = source.restartingSessionIds.contains(scope.sessionID)
        }
        if changes.contains(.catalog) {
            let source = backend.modelCatalog, provider = session.external?.provider
            providers = source.agentProviders; models = source.models(for: provider)
            defaultModel = source.defaultModel(for: provider); defaultReasoning = source.defaultReasoning(for: provider)
            loadingModels = source.isLoadingCodexModels
        }
        if changes.contains(.entities) {
            tasks = entities.tasks; works = entities.works; roles = entities.roles
            mentionSessions = backend.sessions
        }
        if changes.contains(.entities) || changes.contains(.metadata) {
            mentionCatalogRevision &+= 1
            workName = session.workId.flatMap { sourceState.work($0)?.name }
        }
        if changes.contains(.search) {
            searchTarget = search.target?.sessionID == scope.sessionID ? search.target : nil
            searchMatches = search.matches.filter { $0.sessionId == scope.sessionID }
            searchError = searchTarget == nil ? nil : search.error
        }
        if changes.contains(.restart) { restart = backend.sessionRestartActivityController.activityBySessionID[scope.sessionID] }
        if changes.contains(.history) { historyState = backend.earlierHistoryLoadState(for: scope.sessionID) }
    }
}

/// Switching to Empty cancels the upstream subscription while keeping view state.
extension Publisher where Failure == Never {
    func whilePresented(_ active: Bool) -> AnyPublisher<Output, Never> {
        active ? eraseToAnyPublisher() : Empty(completeImmediately: false).eraseToAnyPublisher()
    }
}
