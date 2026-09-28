import Foundation

private struct SessionTimelineRevisionIndex: Decodable {
    let sessions: [Entry]
    struct Entry: Decodable {
        let sessionId: String
        let timelineRevision: Int
    }
}

/// Owns revision wakes, route-scoped sync tasks, and the single active Timeline transport.
@MainActor
final class SessionTimelineSyncController {
    private var routeTimelineSyncTasks: [String: Task<Void, Never>] = [:]
    private var knownTimelineRevisionBySessionID: [String: Int] = [:]
    private let baseURL: URL
    private let appState: AppStateStore
    private let timelineDeltaProcessor: SessionTimelineDeltaProcessor
    private let timelineReadAPI: SessionTimelineReadAPI
    private let activeSessions: () -> [TaskSession]
    private let currentSession: (String) -> TaskSession?
    private let currentSelectedSession: () -> TaskSession?
    private let mergePending: (CodexThreadDetail) -> CodexThreadDetail
    private let storeDetail: (CodexThreadDetail, String, Int) -> Void
    private let reportSelectedLoadError: (String) -> Void
    private let clearSelectedLoadError: () -> Void

    private var sessions: [TaskSession] { activeSessions() }
    private var selectedSession: TaskSession? { currentSelectedSession() }
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

    init(baseURL: URL, appState: AppStateStore,
         timelineDeltaProcessor: SessionTimelineDeltaProcessor,
         timelineReadAPI: SessionTimelineReadAPI,
         activeSessions: @escaping () -> [TaskSession],
         currentSession: @escaping (String) -> TaskSession?,
         currentSelectedSession: @escaping () -> TaskSession?,
         mergePending: @escaping (CodexThreadDetail) -> CodexThreadDetail,
         storeDetail: @escaping (CodexThreadDetail, String, Int) -> Void,
         reportSelectedLoadError: @escaping (String) -> Void,
         clearSelectedLoadError: @escaping () -> Void) {
        self.baseURL = baseURL
        self.appState = appState
        self.timelineDeltaProcessor = timelineDeltaProcessor
        self.timelineReadAPI = timelineReadAPI
        self.activeSessions = activeSessions
        self.currentSession = currentSession
        self.currentSelectedSession = currentSelectedSession
        self.mergePending = mergePending
        self.storeDetail = storeDetail
        self.reportSelectedLoadError = reportSelectedLoadError
        self.clearSelectedLoadError = clearSelectedLoadError
    }

    func resetRouteTasks() {
        routeTimelineSyncTasks.values.forEach { $0.cancel() }
        routeTimelineSyncTasks.removeAll()
    }
    func stop() {
        resetRouteTasks()
        activeTimelineSyncEngine.stop()
        knownTimelineRevisionBySessionID.removeAll()
    }
    func retainActiveSessions(_ ids: Set<String>) {
        activeTimelineSyncEngine.retainActiveSessions(ids)
    }
    func pruneKnownRevisions(keeping ids: Set<String>) -> [String] {
        let removed = knownTimelineRevisionBySessionID.keys.filter { !ids.contains($0) }
        for id in removed { knownTimelineRevisionBySessionID[id] = nil }
        return removed
    }
    func noteSessionRevision(_ session: TaskSession) {
        let revision = session.timelineRevision ?? 0
        knownTimelineRevisionBySessionID[session.id] = max(
            knownTimelineRevisionBySessionID[session.id] ?? 0, revision
        )
    }

    func reconcileTimelineRevisionIndex() async {
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

    func applyTimelineRevisionAdvance(sessionId: String, revision: Int) {
        guard revision > 0 else { return }
        let previous = knownTimelineRevisionBySessionID[sessionId] ?? 0
        knownTimelineRevisionBySessionID[sessionId] = max(previous, revision)
        // State patches and Timeline wake events race. Always let the sync
        // engine compare this desired revision with resident authority instead
        // of dropping a wake because another channel observed it first.
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return }
        scheduleBackgroundTimelineSync(for: session, desiredRevision: revision)
    }

    func scheduleBackgroundTimelineSync(
        for session: TaskSession,
        desiredRevision: Int
    ) {
        activeTimelineSyncEngine.schedule(session, desiredRevision: desiredRevision)
    }

    func synchronizeStoredTimeline(
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
                let reconciledDetail = mergePending(detail)
                storeDetail(reconciledDetail, session.id, revision)
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
                reportSelectedLoadError(L10nFormat(
                    "Could not load session messages: %@",
                    error.localizedDescription
                ))
            }
            return false
        }
        guard sessionRouteIsCurrent(session) else { return false }
        let reconciledDetail = mergePending(snapshot.detail)
        storeDetail(reconciledDetail, session.id, snapshot.timelineRevision)
        await warmPresentationCache(reconciledDetail, for: session.id)
        if selectedSession?.id == session.id {
            clearSelectedLoadError()
        }
        return true
    }

    private func sessionRouteIsCurrent(_ requested: TaskSession) -> Bool {
        let current = currentSession(requested.id)
        guard let current else { return false }
        return SessionTimelineBindingReconciler.sameRoute(requested, current)
    }

    func acceptCommittedSessionRoute(_ committed: TaskSession) {
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
        for session: TaskSession, after revision: Int
    ) async -> SessionTimelineChangeEnvelope? {
        await timelineReadAPI.fetchTimelineChanges(for: session, after: revision)
    }

    func fetchStoredDetail(
        for session: TaskSession
    ) async -> Result<(detail: CodexThreadDetail, timelineRevision: Int), Error> {
        await timelineReadAPI.fetchStoredDetail(for: session)
    }
}
