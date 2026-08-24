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
        return isSelected || hasResidentDetail || isUnread
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
        var expectedRevision = localRevision
        for change in changes {
            guard change.revision == expectedRevision + 1 else { return .requiresSnapshot }
            expectedRevision = change.revision
            switch change.operation {
            case "upsert":
                guard let item = change.item, item.id == change.itemId else {
                    return .requiresSnapshot
                }
                itemsByID[item.id] = item
            case "delete":
                itemsByID[change.itemId] = nil
            default:
                return .requiresSnapshot
            }
        }
        guard expectedRevision == revision else { return .requiresSnapshot }
        let ordered = itemsByID.values.sorted(by: timelineItemPrecedes)
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
