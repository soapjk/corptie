import CorptieClientCore

/// Retains source payloads while presenting one live explanation and archiving
/// older explanations alongside the original tool/process steps.
enum ConversationReplyProgressProjection {
    static func entries(_ entries: [ChatDisplayEntry]) -> [ChatDisplayEntry] {
        var result: [ChatDisplayEntry] = []
        result.reserveCapacity(entries.count)
        func isUser(_ index: Int) -> Bool {
            if case .message(let item) = entries[index].kind {
                return ConversationPresentationKind.resolve(type: item.type, presentationRole: item.presentationRole) == .userMessage
            }
            return false
        }
        func isIntermediate(_ index: Int) -> Bool {
            switch entries[index].kind {
            case .process: return true
            case .message(let item):
                return item.messageOrigin != "scheduled_task"
                    && ConversationPresentationKind.isCommentary(type: item.type, presentationRole: item.presentationRole)
            }
        }
        func replyStatus(_ index: Int) -> String? {
            switch entries[index].kind {
            case .process(_, let items): return items.last?.turnStatus
            case .message(let item):
                guard item.messageOrigin != "scheduled_task",
                      ConversationPresentationKind.resolve(type: item.type, presentationRole: item.presentationRole) == .agentMessage else { return nil }
                return item.turnStatus
            }
        }
        var index = 0
        while index < entries.count {
            if isUser(index) { result.append(entries[index]); index += 1; continue }
            let start = index
            var turnID: String?
            var lastStatus: String?
            while index < entries.count && !isUser(index) {
                if let status = replyStatus(index) {
                    let candidate = chatDisplayEntryTurnId(entries[index])
                    if !candidate.isEmpty {
                        if let turnID, candidate != turnID { break }
                        turnID = candidate
                    }
                    if !status.isEmpty { lastStatus = status }
                }
                index += 1
            }
            let segment = start..<index
            let intermediate = segment.filter(isIntermediate)
            guard let first = intermediate.first else { result.append(contentsOf: entries[segment]); continue }
            let completed = ["complete", "completed"].contains(lastStatus ?? "")
                || intermediate.contains { entries[$0].processReplyCompleted }
            let ended = completed || ["failed", "error", "cancelled", "canceled", "interrupted"].contains(lastStatus ?? "")
            let latest = ended ? nil : intermediate.last { if case .message = entries[$0].kind { return true }; return false }
            var archived: [CodexThreadItem] = []
            var processID: String?
            for child in intermediate where child != latest {
                switch entries[child].kind {
                case .message(let item): archived.append(item)
                case .process(let id, let items):
                    if processID == nil { processID = id }
                    archived.append(contentsOf: items)
                }
            }
            func isQuestion(_ index: Int) -> Bool {
                if case .message(let item) = entries[index].kind {
                    return item.type == "userInput" || item.type == "approval" || item.type == "choice"
                }
                return false
            }
            for preceding in start..<first where !isQuestion(preceding) { result.append(entries[preceding]) }
            if let archivedFirst = archived.first {
                result.append(.init(kind: .process(turnId: processID ?? "commentary:" + archivedFirst.id, items: archived),
                    processReplyCompleted: completed))
            }
            if let latest { result.append(entries[latest]) }
            for remaining in segment where !isIntermediate(remaining) && (remaining >= first || isQuestion(remaining)) {
                result.append(entries[remaining])
            }
        }
        return result
    }

    static func archivedProcess(forRowID rowID: String, in entries: [ChatDisplayEntry]) -> ChatDisplayEntry? {
        guard rowID.hasPrefix("message:") else { return nil }
        let itemID = String(rowID.dropFirst("message:".count))
        return entries.first { entry in
            if case .process(_, let items) = entry.kind { return items.contains { $0.id == itemID } }
            return false
        }
    }
}

extension DetailDisplayCache {
    func projectingReplyProgress() -> Self {
        let projected = ConversationReplyProgressProjection.entries(displayEntries)
        let removedWeight = displayEntries.reduce(0) { $0 + $1.displayWeight }
            - projected.reduce(0) { $0 + $1.displayWeight }
        let anchor = restorationAnchorRowID.map { rowID in
            ConversationReplyProgressProjection.archivedProcess(forRowID: rowID, in: projected)?.id ?? rowID
        }
        return .init(sessionId: sessionId, displayItems: displayItems, displayEntries: projected,
            totalDisplayEntryCount: max(0, totalDisplayEntryCount - removedWeight),
            visibleMessageLimit: visibleMessageLimit, signature: signature, sourceSignature: sourceSignature,
            restorationAnchorRowID: anchor)
    }
}
