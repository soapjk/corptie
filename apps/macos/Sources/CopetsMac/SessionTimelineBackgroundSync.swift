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
    private var available: Int
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(limit: Int = 4) {
        available = max(1, limit)
    }

    func acquire() async {
        if available > 0 {
            available -= 1
            return
        }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func release() {
        if waiters.isEmpty {
            available += 1
        } else {
            waiters.removeFirst().resume()
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
    private let localRevision: (String) -> Int
    private let synchronize: (TaskSession, Int) async -> Bool

    init(
        concurrencyLimit: Int = 4,
        localRevision: @escaping (String) -> Int,
        synchronize: @escaping (TaskSession, Int) async -> Bool
    ) {
        permits = SessionTimelineNetworkPermitPool(limit: concurrencyLimit)
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
            await permits.acquire()
            if Task.isCancelled {
                await permits.release()
                return
            }
            let succeeded = await synchronize(job.session, revision)
            await permits.release()
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
