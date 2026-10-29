import AppKit
import CorptieClientCore

/// An outer disclosure over existing rows. Hidden children keep their original
/// payloads and inner expansion state, but never enter native list measurement.
@MainActor
enum ConversationReplyActivityProjection {
    static let prefix = "reply-activity:"

    static func rows(_ rows: [AppKitChatTimelineRow], entries: [ChatDisplayEntry],
                     expandedIDs: Set<String>, revealingRowID: String? = nil) -> [AppKitChatTimelineRow] {
        guard rows.count == entries.count else { return rows }
        var result: [AppKitChatTimelineRow] = []
        result.reserveCapacity(rows.count)
        var index = 0
        func isIntermediate(_ index: Int) -> Bool {
            let row = rows[index]
            return (row.nativeStyle == .process || row.isCommentary)
                && !row.isCollaboration && row.collaborationRoute == nil
                && row.userInput == nil && row.scheduledMessageSource == nil
        }
        while index < rows.count {
            guard isIntermediate(index) else {
                result.append(rows[index]); index += 1; continue
            }
            let start = index
            let turnID = chatDisplayEntryTurnId(entries[start])
            repeat { index += 1 } while index < rows.count && isIntermediate(index)
                && chatDisplayEntryTurnId(entries[index]) == turnID
            let children = rows[start..<index]
            let id = prefix + rows[start].id
            let expanded = expandedIDs.contains(id)
                || (revealingRowID != nil && children.contains { $0.id == revealingRowID })
            let commentaryCount = children.filter(\.isCommentary).count
            let processCount = children.count - commentaryCount
            let title = L10nFormat("回复过程 · %lld 项", Int64(children.count))
            var header = AppKitChatTimelineRow(id: id, contentRevision: rows[start].contentRevision,
                nativeText: "", copyText: "", nativeStyle: .process, title: title, metadata: "",
                expandableTurnId: id, isExpanded: false, processCount: 0,
                showsHeader: false)
            header.replyActivity = .init(isExpanded: expanded, commentaryCount: commentaryCount, processCount: processCount)
            header.replyIdentity = rows[start].replyIdentity
            header.timeSeparatorText = rows[start].timeSeparatorText
            header.sessionID = rows[start].sessionID
            result.append(header)
            if expanded {
                for child in children {
                    var child = child
                    if child.id == rows[start].id {
                        child.replyIdentity = nil
                        child.timeSeparatorText = nil
                    }
                    result.append(child)
                }
            }
        }
        return result
    }
}
