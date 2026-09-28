import Foundation

extension BackendClient {
    func select(session: TaskSession, focusComposer: Bool = false) {
        PerfStopwatch.event("会话切换.select", value: 1)
        coldTimelineLoadTask?.cancel()
        coldTimelineLoadTask = nil
        deferredDetailPublishTask?.cancel()
        deferredDetailPublishTask = nil
        viewingHistoricalThreadId = nil
        selectedHistoricalDetail = nil
        let generation = sessionSelectionController.select(session.id)
        if focusComposer && session.resolvedSessionKind == .worker {
            ComposerDraftRepository.requestUserFocus(for: session.id)
        }
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
        usageController.publishCachedUsage(for: session.id)
        selectedContextReferences = []
        usageController.stopRefreshing()
        selectedProjectWorktreeStatus = nil
        selectedProjectIntegrationStatus = nil
        projectWorktreeLoadError = nil
        workspaceStatusController.invalidateRequests()
        workspaceRecoveryStatus = nil
        workspaceStatusController.stopRefreshing()
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
            self.usageController.startRefreshing(for: session.id)
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

    func verifyProviderBinding(
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
}
