import Foundation

enum SessionTimelineBackgroundSyncPolicy {
    static func shouldSchedule(
        previousServerRevision: Int?,
        desiredServerRevision: Int,
        localRevision: Int,
        isSelected: Bool,
        hasResidentDetail: Bool,
        isUnread: Bool
    ) -> Bool {
        guard desiredServerRevision > localRevision else { return false }
        if let previousServerRevision {
            // Timeline freshness is independent of the final-answer unread
            // cursor. Any advance must synchronize an unopened Session too.
            return desiredServerRevision > previousServerRevision || isSelected
        }
        // The first authoritative index hydrates every active Session, not a
        // correctness sample around the current selection. Archived Sessions
        // are excluded before this policy is called and remain on-demand.
        return true
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

        var itemsByID = Dictionary(detail.items.map { ($0.id, $0) }, uniquingKeysWith: { _, latest in latest })
        var canonicalUserIDByFingerprint = Dictionary(
            uniqueKeysWithValues: canonicalSessionTimelineItems(detail.items).compactMap { item in
                sessionTimelineUserFingerprint(item).map { ($0, item.id) }
            }
        )
        var expectedRevision = localRevision
        for change in changes {
            guard change.revision == expectedRevision + 1 else { return .requiresSnapshot }
            expectedRevision = change.revision
            switch change.operation {
            case "upsert":
                guard let item = change.item, item.id == change.itemId else {
                    return .requiresSnapshot
                }
                if let fingerprint = sessionTimelineUserFingerprint(item),
                   let canonicalID = canonicalUserIDByFingerprint[fingerprint],
                   canonicalID != item.id {
                    // Keep the already-present row identity. The backend's
                    // semantic projection will emit a delete for this alias;
                    // replacing the row here would disturb viewport anchors.
                    itemsByID[item.id] = nil
                    continue
                }
                itemsByID[item.id] = item
                if let fingerprint = sessionTimelineUserFingerprint(item) {
                    canonicalUserIDByFingerprint[fingerprint] = item.id
                }
            case "delete":
                if let removed = itemsByID[change.itemId],
                   let fingerprint = sessionTimelineUserFingerprint(removed),
                   canonicalUserIDByFingerprint[fingerprint] == change.itemId {
                    canonicalUserIDByFingerprint[fingerprint] = nil
                }
                itemsByID[change.itemId] = nil
            default:
                return .requiresSnapshot
            }
        }
        guard expectedRevision == revision else { return .requiresSnapshot }
        let ordered = canonicalSessionTimelineItems(
            itemsByID.values.sorted(by: timelineItemPrecedes)
        )
        return .applied(
            detail: replacingItems(in: detail, with: ordered),
            revision: revision
        )
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

/// Provider item ids are transport identities, not always stable message
/// identities. Reconnect/compaction may replay one prompt under a new id. A
/// turn has one user prompt, so identical normalized user text in that turn is
/// one UI message. Keep Provider order and leave every other item type intact.
func canonicalSessionTimelineItems(_ items: [CodexThreadItem]) -> [CodexThreadItem] {
    var userFingerprints = Set<String>()
    var result: [CodexThreadItem] = []
    result.reserveCapacity(items.count)
    for item in items {
        guard item.type == "userMessage" else {
            result.append(item)
            continue
        }
        guard let fingerprint = sessionTimelineUserFingerprint(item) else {
            result.append(item)
            continue
        }
        guard userFingerprints.insert(fingerprint).inserted else { continue }
        result.append(item)
    }
    return result
}

private func sessionTimelineUserFingerprint(_ item: CodexThreadItem) -> String? {
    guard item.type == "userMessage" else { return nil }
    let normalized = item.text
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .components(separatedBy: .whitespacesAndNewlines)
        .filter { !$0.isEmpty }
        .joined(separator: " ")
    guard !normalized.isEmpty else { return nil }
    return "\(item.turnId)\u{0}\(normalized)"
}

func canonicalSessionTimelineDetail(_ detail: CodexThreadDetail) -> CodexThreadDetail {
    let items = canonicalSessionTimelineItems(detail.items)
    guard items != detail.items else { return detail }
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
        items: items,
        lastAgentMessageSequence: detail.lastAgentMessageSequence,
        hasMoreHistory: detail.hasMoreHistory,
        historyItemsCount: detail.historyItemsCount,
        actions: detail.actions
    )
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
