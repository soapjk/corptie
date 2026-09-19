import Foundation
import CorptieClientCore

extension PadWorkspace {
    /// Owned by the foreground scene. Cancellation closes the stream and pending refreshes.
    func runRealtime(_ connection: PadConnection) async {
        let generation = UUID()
        refreshWorker?.cancel(); refreshWorker = nil
        realtimeGeneration = generation
        defer {
            if realtimeGeneration == generation {
                refreshWorker?.cancel()
                refreshWorker = nil
                liveStatus = "实时更新已暂停"
            }
        }
        var failures = 0
        while !Task.isCancelled && connection.connected {
            do {
                liveStatus = "正在连接实时更新"
                let api = ClientEvents(transport: try await connection.transport())
                for try await update in api.subscribe() {
                    try Task.checkCancellation()
                    guard realtimeGeneration == generation else { return }
                    failures = 0
                    liveStatus = "实时连接正常"
                    if update.control == true { controlRevision += 1 }
                    inventoryDirty = inventoryDirty || update.inventory
                    let routedSelection = capabilities?.sessionId ?? selection
                    messagesDirty = messagesDirty || update.allSessions
                        || (routedSelection.map { update.sessions.contains($0) } ?? false)
                    scheduleRefresh(connection)
                }
            } catch {
                if Task.isCancelled { return }
            }
            failures = min(failures + 1, 5)
            liveStatus = "连接中断，正在自动重连"
            do { try await Task.sleep(for: .seconds(min(30, 1 << failures))) } catch { return }
        }
    }

    func scheduleRefresh(_ connection: PadConnection) {
        guard refreshWorker == nil, inventoryDirty || messagesDirty else { return }
        let generation = realtimeGeneration
        refreshWorker = Task { @MainActor in
            defer { if realtimeGeneration == generation { refreshWorker = nil } }
            while !Task.isCancelled && connection.connected && (inventoryDirty || messagesDirty) {
                do {
                    // Collapse event bursts; no polling or reads when nothing changed.
                    let pages = max(1, (works.count + 49) / 50) + max(1, (tasks.count + 49) / 50) + max(1, (sessions.count + 49) / 50)
                    try await Task.sleep(for: .milliseconds(max(500, (pages + 2) * 150)))
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
