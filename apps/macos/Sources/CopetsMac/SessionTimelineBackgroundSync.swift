import Foundation
import CorptieClientCore

enum SessionTimelineBackgroundSyncPolicy {
    static func shouldSchedule(
        previousServerRevision: Int?,
        desiredServerRevision: Int,
        localRevision: Int
    ) -> Bool {
        _ = previousServerRevision
        // Wake notifications and Session collection patches can arrive in
        // either order. The resident Timeline revision is the only freshness
        // authority; deduplicating against the last observed server revision
        // can otherwise suppress the fetch that would reconcile local state.
        return desiredServerRevision > localRevision
    }
}

struct SessionTimelineChangeEnvelope: Decodable, Sendable {
    let snapshotRequired: Bool
    let baseRevision: Int?
    let revision: Int?
    let currentRevision: Int
    let hasMore: Bool?
    let changes: [SessionTimelineItemChange]?
}

struct SessionTimelineItemChange: Decodable, Sendable {
    let revision: Int
    let itemId: String
    let operation: String
    let item: CodexThreadItem?
}

struct StoredSessionTimelineSnapshotHeader: Decodable, Sendable {
    let timelineRevision: Int
}

enum SessionTimelineChangeMergeResult: Equatable, Sendable {
    case applied(detail: CodexThreadDetail, revision: Int)
    case duplicate
    case requiresSnapshot
}

enum SessionTimelineChangeMerger {
    static func merge(
        _ envelope: SessionTimelineChangeEnvelope,
        into detail: CodexThreadDetail?,
        localRevision: Int
    ) -> SessionTimelineChangeMergeResult {
        guard envelope.snapshotRequired == false,
              let baseRevision = envelope.baseRevision,
              let revision = envelope.revision,
              let changes = envelope.changes,
              let detail else { return .requiresSnapshot }
        if revision <= localRevision { return .duplicate }
        guard baseRevision == localRevision else { return .requiresSnapshot }

        let sharedChanges = changes.map {
            TimelineRevisionChange(
                revision: $0.revision,
                itemID: $0.itemId,
                operation: $0.operation,
                item: $0.item
            )
        }
        switch TimelineRevisionMerger.merge(
            currentItems: detail.items,
            localRevision: localRevision,
            baseRevision: baseRevision,
            revision: revision,
            changes: sharedChanges,
            itemID: { $0.id },
            precedes: timelineItemPrecedes
        ) {
        case .applied(let items, let revision):
            return .applied(
                detail: replacingItems(in: detail, with: items),
                revision: revision
            )
        case .duplicate:
            return .duplicate
        case .requiresSnapshot:
            return .requiresSnapshot
        }
    }

    private static func timelineItemPrecedes(_ left: CodexThreadItem, _ right: CodexThreadItem) -> Bool {
        let leftCreatedAt = left.createdAt ?? ""
        let rightCreatedAt = right.createdAt ?? ""
        if leftCreatedAt != rightCreatedAt { return leftCreatedAt < rightCreatedAt }
        return left.id < right.id
    }

    private static func replacingItems(
        in detail: CodexThreadDetail,
        with items: [CodexThreadItem]
    ) -> CodexThreadDetail {
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
            items: items,
            lastAgentMessageSequence: detail.lastAgentMessageSequence,
            hasMoreHistory: detail.hasMoreHistory,
            historyItemsCount: detail.historyItemsCount,
            actions: detail.actions
        )
    }
}

/// Serial background executor for Timeline delta decoding and projection.
/// BackendClient is MainActor-isolated, so keeping these O(n) operations in a
/// separate actor makes the ownership boundary explicit and testable rather
/// than relying on individual callers to remember a detached task.
actor SessionTimelineDeltaProcessor {
    func decode(_ data: Data) throws -> SessionTimelineChangeEnvelope {
        try JSONDecoder().decode(SessionTimelineChangeEnvelope.self, from: data)
    }

    func merge(
        _ envelope: SessionTimelineChangeEnvelope,
        into detail: CodexThreadDetail?,
        localRevision: Int
    ) -> SessionTimelineChangeMergeResult {
        SessionTimelineChangeMerger.merge(
            envelope,
            into: detail,
            localRevision: localRevision
        )
    }
}

actor SessionTimelineNetworkPermitPool {
    private struct Waiter {
        let id: UUID
        let sessionID: String?
        let continuation: CheckedContinuation<Bool, Never>
    }
    private let limit: Int
    private var active: [String?] = []
    private var waiters: [Waiter] = []
    private var foregroundID: String?

    init(limit: Int = 4) { self.limit = max(1, limit) }

    func setForegroundSession(_ id: String?) {
        foregroundID = id
        drain()
    }

    @discardableResult
    func acquire(sessionID: String? = nil) async -> Bool {
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                guard !Task.isCancelled else { continuation.resume(returning: false); return }
                waiters.append(Waiter(id: id, sessionID: sessionID, continuation: continuation))
                drain()
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    func release(sessionID: String? = nil) {
        guard let index = active.firstIndex(where: { $0 == sessionID }) else { return }
        active.remove(at: index)
        drain()
    }

    private func cancel(_ id: UUID) {
        guard let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        waiters.remove(at: index).continuation.resume(returning: false)
    }

    private func drain() {
        while active.count < limit {
            let foreground = waiters.firstIndex { $0.sessionID == nil || $0.sessionID == foregroundID }
            let backgroundCount = active.filter { $0 != nil && $0 != foregroundID }.count
            // Keep one slot available to visible work even during cold-start hydration.
            let backgroundLimit = max(1, limit - 1)
            guard let index = foreground ?? (backgroundCount < backgroundLimit ? waiters.indices.first : nil) else { return }
            let waiter = waiters.remove(at: index)
            active.append(waiter.sessionID)
            waiter.continuation.resume(returning: true)
        }
    }
}

/// Owns the complete lifecycle of active Timeline synchronization. BackendClient
/// only forwards authoritative index revisions; selection never starts, stops,
/// or waits for these jobs.
@MainActor
final class ActiveTimelineSyncEngine {
    private struct Job {
        let generation: UUID
        var session: TaskSession
        var desiredRevision: Int
        var task: Task<Void, Never>?
    }

    private var jobs: [String: Job] = [:]
    private let permits: SessionTimelineNetworkPermitPool
    private let foregroundSessionID: () -> String?
    private var lastForegroundID: String?
    private let localRevision: (String) -> Int
    private let synchronize: (TaskSession, Int) async -> Bool

    init(
        concurrencyLimit: Int = 4,
        foregroundSessionID: @escaping () -> String? = { nil },
        localRevision: @escaping (String) -> Int,
        synchronize: @escaping (TaskSession, Int) async -> Bool
    ) {
        permits = SessionTimelineNetworkPermitPool(limit: concurrencyLimit)
        self.foregroundSessionID = foregroundSessionID
        self.localRevision = localRevision
        self.synchronize = synchronize
    }

    func retainActiveSessions(_ activeSessionIDs: Set<String>) {
        for sessionID in jobs.keys where !activeSessionIDs.contains(sessionID) {
            jobs[sessionID]?.task?.cancel()
            jobs[sessionID] = nil
        }
    }

    func schedule(_ session: TaskSession, desiredRevision: Int) {
        guard desiredRevision > localRevision(session.id) else { return }
        ChatPerformanceTrace.timelineStage("scheduled", sessionID: session.id, revision: desiredRevision)
        var job = jobs[session.id] ?? Job(
            generation: UUID(),
            session: session,
            desiredRevision: desiredRevision,
            task: nil
        )
        job.session = session
        job.desiredRevision = max(job.desiredRevision, desiredRevision)
        guard job.task == nil else {
            jobs[session.id] = job
            return
        }
        let generation = job.generation
        job.task = Task { @MainActor [weak self] in
            await self?.run(sessionID: session.id, generation: generation)
        }
        jobs[session.id] = job
    }

    func foregroundDidChange() async {
        let current = foregroundSessionID()
        let previous = lastForegroundID
        lastForegroundID = current
        // A read for the old foreground must not occupy the reserved slot after navigation.
        if let previous, previous != current, let old = jobs[previous] {
            old.task?.cancel()
            jobs[previous] = nil
            schedule(old.session, desiredRevision: old.desiredRevision)
        }
        await permits.setForegroundSession(current)
    }

    func stop() {
        jobs.values.forEach { $0.task?.cancel() }
        jobs.removeAll()
    }

    var scheduledSessionCount: Int { jobs.count }

    private func run(sessionID: String, generation: UUID) async {
        defer {
            if jobs[sessionID]?.generation == generation {
                jobs[sessionID] = nil
            }
        }
        var failureCount = 0
        while !Task.isCancelled,
              let job = jobs[sessionID],
              job.generation == generation {
            let revision = localRevision(sessionID)
            if revision >= job.desiredRevision { return }
            lastForegroundID = foregroundSessionID()
            await permits.setForegroundSession(lastForegroundID)
            guard await permits.acquire(sessionID: sessionID) else { return }
            if Task.isCancelled {
                await permits.release(sessionID: sessionID)
                return
            }
            ChatPerformanceTrace.timelineStage("fetch-started", sessionID: sessionID, revision: revision)
            let succeeded = await synchronize(job.session, revision)
            ChatPerformanceTrace.timelineStage("fetch-finished", sessionID: sessionID, revision: localRevision(sessionID))
            await permits.release(sessionID: sessionID)
            if succeeded, localRevision(sessionID) > revision {
                failureCount = 0
            } else {
                // A duplicate/empty response that reports success without
                // advancing local authority must not become a main-actor spin.
                failureCount += 1
                let delay = min(30, 1 << min(failureCount, 4))
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }
}
