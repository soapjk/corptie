import Foundation
import CorptieClientCore
import CorptieClientSecurity
import OSLog

extension PadWorkspace {
    private static let realtimeLog = Logger(subsystem: "com.corptie.connection", category: "MobileRealtime")
    /// Capabilities can arrive before the timeline snapshot. They describe
    /// permission, not whether the selected conversation has any message data.
    var selectedTimelineReady: Bool {
        lastTimelineRevision != nil || !messages.isEmpty
            || (capabilities != nil && !isLoadingDetail)
    }

    func waitForRealtimeTimelineOrFallback(
        _ connection: PadConnection,
        after revision: Int? = nil,
        graceAttempts: Int = 30
    ) async {
        for _ in 0..<graceAttempts {
            if Task.isCancelled { return }
            if let revision {
                if (lastTimelineRevision ?? 0) > revision { return }
            } else if selectedTimelineReady {
                return
            }
            try? await Task.sleep(for: .milliseconds(100))
        }
        guard !Task.isCancelled else { return }
        await load(connection)
    }

    /// Start a fresh foreground recovery without presenting an old background failure.
    func prepareForegroundRealtime() {
        realtimeGeneration = UUID()
        realtimeConnected = false
        realtimeReconnectFailed = false
        realtimePausedAt = nil
    }

    /// Owned by the scene. Cancellation closes the stream and pending refreshes.
    func runRealtime(_ connection: PadConnection) async {
        let generation = UUID()
        let connectionRevision = connection.recoveryRevision
        refreshWorker?.cancel(); refreshWorker = nil
        realtimeGeneration = generation
        realtimeConnected = false
        realtimeReconnectFailed = false
        realtimePausedAt = nil
        defer {
            if realtimeGeneration == generation {
                refreshWorker?.cancel()
                refreshWorker = nil
                liveStatus = "实时更新已暂停"
                realtimeConnected = false
                realtimePausedAt = Date()
            }
        }
        var failures = connection.recoveryRevision > 0 ? 1 : 0
        var receivedV2Ready = false
        while !Task.isCancelled && connection.connected && connection.networkAvailable
            && connection.recoveryBlockedMessage == nil && realtimeGeneration == generation
            && connection.recoveryRevision == connectionRevision {
            do {
                liveStatus = "正在连接实时更新"
                realtimeConnected = false
                let api = ClientEvents(transport: try await connection.transport())
                Self.realtimeLog.info("Subscribe attempt: generation=\(generation, privacy: .public) recoveryRevision=\(connectionRevision) failures=\(failures)")
                // The v2 stream pushes resident snapshots and subsequent
                // deltas for every active Session. Keep it global so changing
                // the visible Task remains a local projection operation.
                for try await update in api.subscribeRealtime(
                    sessionId: nil,
                    stateRevision: realtimeStateRevision,
                    timelineRevision: 0
                ) {
                    try Task.checkCancellation()
                    guard realtimeGeneration == generation, connection.recoveryRevision == connectionRevision else { return }
                    failures = 0
                    switch update {
                    case .ready:
                        Self.realtimeLog.info("Realtime ready: generation=\(generation, privacy: .public)")
                        receivedV2Ready = true
                        realtimeConnected = true
                        realtimeReconnectFailed = false
                        lastRealtimePulseAt = Date()
                        realtimePausedAt = nil
                        liveStatus = hasReceivedRealtimeState ? "实时连接正常" : "实时连接已建立，正在同步数据"
                        scheduleInitialStateRecovery(connection)
                    case .state(let snapshot):
                        applyRealtimeState(snapshot)
                        liveStatus = "实时连接正常"
                    case .control(let snapshot):
                        directControlSnapshot = snapshot
                        controlRevision += 1
                    case .timelineSnapshot(let snapshot):
                        applyRealtimeTimeline(snapshot)
                    case .timelineDelta(let delta):
                        if !applyRealtimeTimeline(delta) {
                            // A verified revision gap is one of the few allowed
                            // fallback reads; normal updates never reach this path.
                            if isSelectedTimeline(delta.sessionId) {
                                messagesDirty = true
                                scheduleRefresh(connection)
                            } else {
                                await repairBackgroundTimeline(connection, sessionID: delta.sessionId)
                            }
                        }
                    case .receipt(let receipt):
                        pushedReceipt = receipt
                        pushedReceiptRevision += 1
                        if pending?.requestID == receipt.requestId { settle(receipt) }
                    case .heartbeat:
                        realtimeConnected = true
                        realtimeReconnectFailed = false
                        lastRealtimePulseAt = Date()
                        realtimePausedAt = nil
                        liveStatus = hasReceivedRealtimeState ? "实时连接正常" : "实时连接已建立，正在同步数据"
                    }
                }
                Self.realtimeLog.info("Realtime stream ended: generation=\(generation, privacy: .public) reason=end-of-stream")
            } catch {
                guard !Task.isCancelled, realtimeGeneration == generation,
                      connection.recoveryRevision == connectionRevision else { return }
                Self.realtimeLog.error("Realtime failed: generation=\(generation, privacy: .public) reason=\(ConnectionDiagnostic.failure(error), privacy: .public) pulseAgeSeconds=\(self.lastRealtimePulseAt.map { Date().timeIntervalSince($0) } ?? -1) networkAvailable=\(connection.networkAvailable)")
                realtimeConnected = false
                realtimePausedAt = Date()
                if connection.stopRecoveryIfUnauthorized(error) {
                    realtimeReconnectFailed = true
                    return
                }
                if !receivedV2Ready && Self.needsLegacyRealtime(error) {
                    // The initial stream is preferred, but a transport-level
                    // failure must never leave a newly opened client empty.
                    // This is one finite bootstrap read, not polling.
                    await inventory(connection)
                    guard !Task.isCancelled, connection.recoveryRevision == connectionRevision else { return }
                    await runLegacyRealtime(connection, generation: generation, initialFailures: 1)
                    return
                }
            }
            failures = min(failures + 1, 5)
            connection.invalidateRealtimeTransport()
            Self.realtimeLog.info("Recovery scheduled: generation=\(generation, privacy: .public) failures=\(failures) rebuildChannel=true")
            // The first interruption is recovery, not a user-facing failure.
            if failures >= 2 { realtimeReconnectFailed = true }
            liveStatus = "连接中断，正在自动重连"
            realtimeConnected = false
            realtimePausedAt = Date()
            do { try await Task.sleep(for: PadConnection.recoveryDelay(failures: failures, jitter: .random(in: 0.85...1.15))) } catch { return }
        }
    }

    private func runLegacyRealtime(_ connection: PadConnection, generation: UUID, initialFailures: Int) async {
        let connectionRevision = connection.recoveryRevision
        var failures = initialFailures
        while !Task.isCancelled && connection.connected && connection.networkAvailable
            && connection.recoveryBlockedMessage == nil && realtimeGeneration == generation
            && connection.recoveryRevision == connectionRevision {
            do {
                liveStatus = "正在连接兼容模式实时更新"
                realtimeConnected = false
                let api = ClientEvents(transport: try await connection.transport())
                for try await update in api.subscribe() {
                    try Task.checkCancellation()
                    guard realtimeGeneration == generation, connection.recoveryRevision == connectionRevision else { return }
                    failures = 0
                    liveStatus = "兼容模式实时连接正常"
                    realtimeConnected = true
                    realtimeReconnectFailed = false
                    lastRealtimePulseAt = Date()
                    realtimePausedAt = nil
                    if update.control == true { controlRevision += 1 }
                    inventoryDirty = inventoryDirty || update.inventory
                    messagesDirty = messagesDirty || sessionMatchesUpdate(update)
                    scheduleRefresh(connection)
                }
            } catch {
                guard !Task.isCancelled, realtimeGeneration == generation,
                      connection.recoveryRevision == connectionRevision else { return }
                if connection.stopRecoveryIfUnauthorized(error) {
                    realtimeReconnectFailed = true
                    return
                }
            }
            failures = min(failures + 1, 5)
            connection.invalidateRealtimeTransport()
            if failures >= 2 { realtimeReconnectFailed = true }
            liveStatus = "兼容模式连接中断，正在自动重连"
            realtimeConnected = false
            realtimePausedAt = Date()
            do { try await Task.sleep(for: PadConnection.recoveryDelay(failures: failures, jitter: .random(in: 0.85...1.15))) } catch { return }
        }
    }

    private static func needsLegacyRealtime(_ error: Error) -> Bool {
        // Offline/relay failures are not evidence that the server lacks v2.
        if let error = error as? ClientConnectionError {
            return error == .invalidResponse || error == .httpStatus(404)
        }
        return false
    }

    private func sessionMatchesUpdate(_ update: ClientInvalidation) -> Bool {
        if update.allSessions { return true }
        guard !update.sessions.isEmpty else { return false }

        var targetSet: Set<String> = []
        func addCandidate(_ id: String?) {
            guard let raw = id?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return }
            targetSet.insert(raw)
            let stripped = stripSessionPrefix(raw)
            targetSet.insert(stripped)
            targetSet.insert("session:\(stripped)")
            targetSet.insert("codex:\(stripped)")
            targetSet.insert("logical:\(stripped)")
        }

        addCandidate(selection)
        addCandidate(capabilities?.sessionId)
        guard !targetSet.isEmpty else { return false }

        for eventSession in update.sessions {
            if targetSet.contains(eventSession) { return true }
            let strippedEvent = stripSessionPrefix(eventSession)
            if targetSet.contains(strippedEvent) { return true }
        }
        return false
    }

    private func stripSessionPrefix(_ id: String) -> String {
        for prefix in ["codex:", "logical:", "session:", "pty:", "task:"] {
            if id.hasPrefix(prefix) {
                return String(id.dropFirst(prefix.count))
            }
        }
        return id
    }

    func scheduleRefresh(_ connection: PadConnection) {
        guard refreshWorker == nil, inventoryDirty || messagesDirty else { return }
        let generation = realtimeGeneration
        refreshWorker = Task { @MainActor in
            defer { if realtimeGeneration == generation { refreshWorker = nil } }
            while !Task.isCancelled && connection.connected && (inventoryDirty || messagesDirty) {
                do {
                    // Collapse event bursts; inventory pages wait for pagination, timeline-only refreshes respond promptly.
                    let delayMs: Int
                    if inventoryDirty {
                        let pages = max(1, (works.count + 49) / 50) + max(1, (tasks.count + 49) / 50) + max(1, (sessions.count + 49) / 50)
                        delayMs = max(500, (pages + 2) * 150)
                    } else {
                        delayMs = 60
                    }
                    try await Task.sleep(for: .milliseconds(delayMs))
                    if connection.busy { continue }
                    let inventory = inventoryDirty, timeline = messagesDirty
                    inventoryDirty = false; messagesDirty = false
                    do {
                        try await refreshRealtime(connection, inventory: inventory, timeline: timeline || inventory)
                    } catch {
                        inventoryDirty = inventoryDirty || inventory
                        messagesDirty = messagesDirty || timeline || inventory
                        throw error
                    }
                } catch {
                    if Task.isCancelled { return }
                    liveStatus = "同步暂未完成，正在自动重试"
                    do { try await Task.sleep(for: .seconds(3)) } catch { return }
                }
            }
        }
    }

    func refreshRealtime(_ connection: PadConnection, inventory: Bool, timeline: Bool) async throws {
        let transport = try await connection.transport()
        if inventory {
            inventoryGeneration += 1
            let generation = inventoryGeneration
            let api = ClientInventory(transport: transport)
            // Re-read the loaded prefix, preserving pagination coverage and applying deletions.
            var newWorks: [ClientWork] = [], newTasks: [ClientTask] = [], newSessions: [ClientSession] = []
            var wc: String?, tc: String?, sc: String?
            var requests = 0
            let workBudget = max(1, (works.count + 49) / 50) + 2
            let taskBudget = max(1, (tasks.count + 49) / 50) + 2
            let sessionBudget = max(1, (sessions.count + 49) / 50) + 2
            repeat {
                requests += 1; guard requests <= workBudget else { throw ClientConnectionError.invalidResponse }
                let page = try await api.works(cursor: wc); newWorks = Self.merge(newWorks, page.items); wc = page.nextCursor
            }
            while wc != nil && newWorks.count < max(50, works.count)
            requests = 0
            repeat {
                requests += 1; guard requests <= taskBudget else { throw ClientConnectionError.invalidResponse }
                let page = try await api.tasks(cursor: tc); newTasks = Self.merge(newTasks, page.items); tc = page.nextCursor
            }
            while tc != nil && newTasks.count < max(50, tasks.count)
            requests = 0
            repeat {
                requests += 1; guard requests <= sessionBudget else { throw ClientConnectionError.invalidResponse }
                let page = try await api.sessions(cursor: sc); newSessions = Self.merge(newSessions, page.items); sc = page.nextCursor
            }
            while sc != nil && newSessions.count < max(50, sessions.count)
            try Task.checkCancellation()
            guard generation == inventoryGeneration else { inventoryDirty = true; messagesDirty = true; return }
            let changed = works != newWorks || tasks != newTasks || sessions != newSessions
            if works != newWorks { works = newWorks }
            if tasks != newTasks { tasks = newTasks }
            if sessions != newSessions { sessions = newSessions }
            workCursor = wc; taskCursor = tc; sessionCursor = sc
            if changed { rebuildGroups() }
            // Never change selection in response to another Session's events.
        }
        guard timeline, let id = selection else { return }
        timelineGeneration += 1
        let generation = timelineGeneration
        let api = ClientSessionAPI(transport: transport)
        do {
            let caps = try await api.capabilities(sessionId: id)
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            capabilities = caps
            guard caps.readMessages else { messages = []; return }
            let page = try await api.messages(sessionId: caps.sessionId)
            var latest = page.items, cursor = page.nextBefore
            let previousTail = messages.last?.id
            // Recover a disconnected gap; do not splice unrelated history onto the newest page.
            var pages = 1
            while let old = previousTail, !latest.contains(where: { $0.id == old }), let next = cursor, pages < 25 {
                let earlier = try await api.messages(sessionId: caps.sessionId, before: next)
                latest = Self.merge(earlier.items, latest)
                cursor = earlier.nextBefore
                pages += 1
            }
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            applyLatestWindow(latest, cursor: cursor, revision: page.revision)
            await loadUsage(api, sessionID: id, routedID: caps.sessionId, generation: generation)
            guard !Task.isCancelled, selection == id, generation == timelineGeneration else { return }
            if caps.composer == true, composerConfiguration == nil
                || (caps.currentModel != nil && caps.currentModel != composerConfiguration?.currentModel)
                || (caps.currentReasoningLevel != nil && caps.currentReasoningLevel != composerConfiguration?.currentReasoningLevel) {
                await configureComposer(connection)
            }
        } catch ClientConnectionError.httpStatus(404) {
            guard selection == id, generation == timelineGeneration else { return }
            clearSelectionState()
            conversationNotice = "无法同步这个会话。列表可能已过期，请刷新后重试。"
        } catch let error as ClientServiceFailure where error.code == "SESSION_NOT_AVAILABLE" {
            guard selection == id, generation == timelineGeneration else { return }
            clearSelectionState()
            conversationNotice = "无法同步这个会话。列表可能已过期，请刷新后重试。"
        }
    }
}
