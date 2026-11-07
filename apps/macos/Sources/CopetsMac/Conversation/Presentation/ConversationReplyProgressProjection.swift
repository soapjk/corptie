import CorptieClientCore

/// Desktop compatibility facade; all grouping is shared with mobile.
enum ConversationReplyProgressProjection {
    static func entries(_ entries: [ChatDisplayEntry]) -> [ChatDisplayEntry] {
        CorptieClientCore.ConversationReplyProgressProjection.entries(entries)
    }
    static func archivedProcess(forRowID rowID: String, in entries: [ChatDisplayEntry]) -> ChatDisplayEntry? {
        CorptieClientCore.ConversationReplyProgressProjection.archivedProcess(forRowID: rowID, in: entries)
    }
}

extension DetailDisplayCache {
    func projectingReplyProgress() -> Self {
        guard !isPresentationPrepared else { return self }
        let projected = uniquedChatDisplayEntries(ConversationReplyProgressProjection.entries(displayEntries))
        let removedWeight = displayEntries.reduce(0) { $0 + $1.displayWeight }
            - projected.reduce(0) { $0 + $1.displayWeight }
        let anchor = restorationAnchorRowID.map { rowID in
            ConversationReplyProgressProjection.archivedProcess(forRowID: rowID, in: projected)?.id ?? rowID
        }
        return .init(sessionId: sessionId, displayItems: displayItems, displayEntries: projected,
            totalDisplayEntryCount: max(0, totalDisplayEntryCount - removedWeight),
            visibleMessageLimit: visibleMessageLimit, signature: signature, sourceSignature: sourceSignature,
            restorationAnchorRowID: anchor, isPresentationPrepared: true)
    }
}
