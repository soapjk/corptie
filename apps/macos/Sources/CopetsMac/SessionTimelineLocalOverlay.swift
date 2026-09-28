import Foundation

/// Per-client local acknowledgement overlay, not a second timeline cache.
/// Authoritative snapshots and observable publication remain in
/// SessionTimelineRepository. This owner retains only the temporary inputs
/// needed to reconcile delayed server snapshots, with the existing lifetime.
@MainActor
final class SessionTimelineLocalOverlay {
    private var pendingUserMessagesBySessionID: [String: [CodexThreadItem]] = [:]
    private var handledChoiceIds = Set<String>()

    func acknowledge(
        _ text: String,
        images: [ChatImageReference] = [],
        messageID: String,
        deliveryID: String,
        to session: TaskSession,
        residentDetail: CodexThreadDetail?,
        now: String
    ) -> CodexThreadDetail {
        let threadId = session.external?.threadId ?? session.id
        let item = CodexThreadItem(
            id: messageID,
            turnId: "delivery:\(deliveryID)",
            turnStatus: "running",
            type: "userMessage",
            title: "User",
            text: text,
            options: nil,
            status: "queued",
            createdAt: now,
            images: images
        )
        pendingUserMessagesBySessionID[session.id, default: []].append(item)

        guard let residentDetail else {
            return optimisticDetail(for: session, threadId: threadId, now: now)
        }
        let detail = SessionTimelineBindingReconciler.rebind(residentDetail, to: session)
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
            updatedAt: now,
            canSend: detail.canSend,
            sendUnavailableReason: detail.sendUnavailableReason,
            capabilities: detail.capabilities,
            turnCount: detail.turnCount,
            items: mergedItems(serverItems: detail.items, pendingItems: pendingUserMessagesBySessionID[session.id] ?? []),
            lastAgentMessageSequence: detail.lastAgentMessageSequence,
            hasMoreHistory: detail.hasMoreHistory,
            historyItemsCount: detail.historyItemsCount,
            actions: detail.actions
        )
    }

    private func optimisticDetail(for session: TaskSession, threadId: String, now: String) -> CodexThreadDetail {
        CodexThreadDetail(
            id: threadId,
            title: session.title,
            status: session.executionTaskStatus,
            source: session.external?.source,
            connectionStatus: session.external?.connectionStatus,
            currentModel: session.external?.currentModel,
            currentReasoningLevel: session.external?.currentReasoningLevel,
            activityStatus: session.activityStatus,
            cwd: session.external?.cwd,
            createdAt: session.updatedAt,
            updatedAt: now,
            canSend: true,
            sendUnavailableReason: nil,
            capabilities: session.capabilities,
            turnCount: 0,
            items: pendingUserMessagesBySessionID[session.id] ?? [],
            lastAgentMessageSequence: session.lastAgentMessageSequence
        )
    }

    func markChoiceHandled(choiceId: String, selectedOptionId: String, in detail: CodexThreadDetail?) -> CodexThreadDetail? {
        handledChoiceIds.insert(choiceId)
        guard let detail else { return nil }
        return Self.detailReplacingItems(detail) { item in
            guard item.id == choiceId, item.type == "choice" else {
                return item
            }
            return CodexThreadItem(
                id: item.id,
                turnId: item.turnId,
                turnStatus: item.turnStatus,
                type: item.type,
                title: item.title,
                text: item.text,
                options: item.options?.map { option in
                    CodexApprovalOption(
                        id: option.id,
                        label: option.label,
                        role: option.role,
                        index: option.index,
                        selected: option.id == selectedOptionId
                    )
                },
                status: "selected",
                createdAt: item.createdAt,
                fileChanges: item.fileChanges,
                turnDiff: item.turnDiff
            )
        }
    }

    func applyingHandledChoices(to detail: CodexThreadDetail) -> CodexThreadDetail {
        guard detail.items.contains(where: { handledChoiceIds.contains($0.id) && $0.status != "selected" }) else {
            return detail
        }
        return Self.detailReplacingItems(detail) { item in
            guard handledChoiceIds.contains(item.id), item.type == "choice", item.status != "selected" else {
                return item
            }
            return CodexThreadItem(
                id: item.id,
                turnId: item.turnId,
                turnStatus: item.turnStatus,
                type: item.type,
                title: item.title,
                text: item.text,
                options: item.options,
                status: "selected",
                createdAt: item.createdAt,
                fileChanges: item.fileChanges,
                turnDiff: item.turnDiff
            )
        }
    }

    static func detailReplacingItems(_ detail: CodexThreadDetail, transform: (CodexThreadItem) -> CodexThreadItem) -> CodexThreadDetail {
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
            items: detail.items.map(transform),
            lastAgentMessageSequence: detail.lastAgentMessageSequence,
            hasMoreHistory: detail.hasMoreHistory,
            historyItemsCount: detail.historyItemsCount,
            actions: detail.actions
        )
    }

    func reconcile(_ detail: CodexThreadDetail, for sessionID: String) -> CodexThreadDetail {
        let pending = pendingUserMessagesBySessionID[sessionID] ?? []
        let merged = mergedItems(serverItems: detail.items, pendingItems: pending)
        pendingUserMessagesBySessionID[sessionID] = remainingPendingItems(
            afterMerging: detail.items,
            pendingItems: pending
        )

        guard merged != detail.items else {
            return detail
        }

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
            items: merged,
            lastAgentMessageSequence: detail.lastAgentMessageSequence,
            hasMoreHistory: detail.hasMoreHistory,
            historyItemsCount: detail.historyItemsCount,
            actions: detail.actions
        )
    }

    private func mergedItems(serverItems: [CodexThreadItem], pendingItems: [CodexThreadItem]) -> [CodexThreadItem] {
        var items = serverItems
        var matchedServerIndexes = Set<Int>()
        for pendingItem in pendingItems {
            if let index = firstMatchingServerUserIndex(for: pendingItem, in: items, excluding: matchedServerIndexes) {
                matchedServerIndexes.insert(index)
            } else {
                items.append(pendingItem)
            }
        }
        return items
    }

    private func remainingPendingItems(afterMerging serverItems: [CodexThreadItem], pendingItems: [CodexThreadItem]) -> [CodexThreadItem] {
        var matchedServerIndexes = Set<Int>()
        return pendingItems.filter { pendingItem in
            if let index = firstMatchingServerUserIndex(for: pendingItem, in: serverItems, excluding: matchedServerIndexes) {
                matchedServerIndexes.insert(index)
                return false
            }
            return true
        }
    }

    private func firstMatchingServerUserIndex(for pendingItem: CodexThreadItem, in serverItems: [CodexThreadItem], excluding matchedIndexes: Set<Int>) -> Int? {
        return serverItems.indices.first { index in
            !matchedIndexes.contains(index)
                && serverItems[index].type == "userMessage"
                && serverItems[index].id == pendingItem.id
        }
    }
}

