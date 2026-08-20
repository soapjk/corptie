import Foundation

struct ChatTimelineSnapshotHeader: Decodable, Sendable {
    let protocolVersion: Int?
    let revision: Int?
}

struct ChatTimelineDeltaEnvelope: Decodable, Sendable {
    let protocolVersion: Int
    let baseRevision: Int
    let revision: Int
    let metadata: ChatTimelineMetadata
    let items: [CodexThreadItem]?
    let index: Int?
    let item: CodexThreadItem?
}

struct ChatTimelineMetadata: Decodable, Sendable {
    let title: String
    let status: TaskStatus
    let source: String?
    let connectionStatus: String?
    let currentModel: String?
    let currentReasoningLevel: String?
    let activityStatus: String?
    let cwd: String?
    let createdAt: String
    let updatedAt: String
    let canSend: Bool?
    let sendUnavailableReason: String?
    let capabilities: SessionCapabilities?
    let turnCount: Int
    let actions: SessionActions?
    var lastAgentMessageSequence: Int? = nil
}

enum ChatTimelineDeltaKind: String, Sendable {
    case itemsAppended = "items.appended"
    case itemUpdated = "item.updated"
    case metadataUpdated = "metadata.updated"
}

enum ChatTimelineDeltaMergeResult: Equatable, Sendable {
    case applied(detail: CodexThreadDetail, revision: Int)
    case duplicate
    case requiresSnapshot
}

enum ChatTimelineDeltaMerger {
    static func merge(
        kind: ChatTimelineDeltaKind,
        envelope: ChatTimelineDeltaEnvelope,
        currentDetail: CodexThreadDetail?,
        currentRevision: Int?,
        preferredCwd: String? = nil
    ) -> ChatTimelineDeltaMergeResult {
        guard envelope.protocolVersion == 1,
              let currentDetail,
              let currentRevision else { return .requiresSnapshot }
        if envelope.revision <= currentRevision { return .duplicate }
        guard envelope.baseRevision == currentRevision,
              envelope.revision == currentRevision + 1 else { return .requiresSnapshot }

        var items = currentDetail.items
        switch kind {
        case .itemsAppended:
            guard let appended = envelope.items, !appended.isEmpty,
                  Set(items.map(\.id)).isDisjoint(with: appended.map(\.id)),
                  Set(appended.map(\.id)).count == appended.count else {
                return .requiresSnapshot
            }
            items.append(contentsOf: appended)
        case .itemUpdated:
            guard let index = envelope.index,
                  items.indices.contains(index),
                  let item = envelope.item,
                  items[index].id == item.id else { return .requiresSnapshot }
            items[index] = item
        case .metadataUpdated:
            guard envelope.items == nil, envelope.item == nil, envelope.index == nil else {
                return .requiresSnapshot
            }
        }

        return .applied(
            detail: detail(
                metadata: envelope.metadata,
                preservingIDFrom: currentDetail,
                items: items,
                preferredCwd: preferredCwd
            ),
            revision: envelope.revision
        )
    }

    private static func detail(
        metadata: ChatTimelineMetadata,
        preservingIDFrom current: CodexThreadDetail,
        items: [CodexThreadItem],
        preferredCwd: String?
    ) -> CodexThreadDetail {
        CodexThreadDetail(
            id: current.id,
            title: metadata.title,
            status: metadata.status,
            source: metadata.source,
            connectionStatus: metadata.connectionStatus,
            currentModel: metadata.currentModel,
            currentReasoningLevel: metadata.currentReasoningLevel,
            activityStatus: metadata.activityStatus,
            cwd: preferredCwd ?? metadata.cwd ?? current.cwd,
            createdAt: metadata.createdAt,
            updatedAt: metadata.updatedAt,
            canSend: metadata.canSend,
            sendUnavailableReason: metadata.sendUnavailableReason,
            capabilities: metadata.capabilities,
            turnCount: metadata.turnCount,
            items: items,
            lastAgentMessageSequence: metadata.lastAgentMessageSequence,
            actions: metadata.actions
        )
    }
}

enum ChatTimelineDeltaDecoder {
    static func snapshotHeader(from data: Data) async throws -> ChatTimelineSnapshotHeader {
        try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(ChatTimelineSnapshotHeader.self, from: data)
        }.value
    }

    static func delta(from data: Data) async throws -> ChatTimelineDeltaEnvelope {
        try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(ChatTimelineDeltaEnvelope.self, from: data)
        }.value
    }
}
