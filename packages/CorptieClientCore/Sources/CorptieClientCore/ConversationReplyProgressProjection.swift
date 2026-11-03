import Foundation

/// Retains source payloads while presenting one live explanation and archiving
/// older explanations alongside the original tool/process steps.
public enum ConversationReplyProgressProjection {
    public static func entries<Item: ConversationTimelineItem>(_ entries: [ConversationEntry<Item>]) -> [ConversationEntry<Item>] {
        var result: [ConversationEntry<Item>] = []
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
                return item.timelineMessageOrigin != "scheduled_task" && !item.timelineHasImages
                    && !item.timelineTurnID.isEmpty
                    && ConversationPresentationKind.isCommentary(type: item.type, presentationRole: item.presentationRole)
            }
        }
        func replyStatus(_ index: Int) -> String? {
            switch entries[index].kind {
            case .process(_, let items):
                switch entries[index].processReplyState {
                case .running: return "running"
                case .completed: return "completed"
                case .failed: return "failed"
                case .cancelled: return "cancelled"
                case nil: return items.last?.timelineTurnStatus
                }
            case .message(let item):
                guard item.timelineMessageOrigin != "scheduled_task",
                      ConversationPresentationKind.resolve(type: item.type, presentationRole: item.presentationRole) == .agentMessage else { return nil }
                return item.timelineTurnStatus.isEmpty && item.presentationRole?.lowercased() == "final_answer"
                    ? "completed" : item.timelineTurnStatus
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
                    let candidate = Self.turnID(for: entries[index])
                    if !candidate.isEmpty {
                        if let turnID, candidate != turnID { break }
                        turnID = candidate
                    }
                    if !status.isEmpty { lastStatus = status.lowercased() }
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
            var archived: [Item] = []
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
            if let archiveID = processID ?? archived.first.map({ "commentary:" + $0.id }) {
                result.append(.init(kind: .process(turnId: archiveID, items: archived),
                    processReplyCompleted: completed, processReplyState: {
                        if completed { return .completed }
                        switch lastStatus?.lowercased() {
                        case "failed", "error": return .failed
                        case "cancelled", "canceled", "interrupted": return .cancelled
                        case .some: return .running
                        case nil: return intermediate.compactMap { entries[$0].processReplyState }.last
                            ?? ConversationProcessPresentation.state(for: archived)
                        }
                    }()))
            }
            if let latest { result.append(entries[latest]) }
            for remaining in segment where !isIntermediate(remaining) && (remaining >= first || isQuestion(remaining)) {
                result.append(entries[remaining])
            }
        }
        return result
    }

    public static func archivedProcess<Item: ConversationTimelineItem>(forRowID rowID: String, in entries: [ConversationEntry<Item>]) -> ConversationEntry<Item>? {
        guard rowID.hasPrefix("message:") else { return nil }
        let itemID = String(rowID.dropFirst("message:".count))
        return entries.first { entry in
            if case .process(_, let items) = entry.kind { return items.contains { $0.id == itemID } }
            return false
        }
    }

    private static func turnID<Item: ConversationTimelineItem>(for entry: ConversationEntry<Item>) -> String {
        switch entry.kind {
        case .message(let item): return item.timelineTurnID
        case .process(let id, let items): return items.first?.timelineTurnID ?? id
        }
    }

    public struct ReplyBounds: Equatable, Sendable {
        public let startedAt: Date?
        public let endedAt: Date?
    }

    public struct Result<Item: ConversationTimelineItem>: Sendable {
        public let entries: [ConversationEntry<Item>]
        public let rowIDsBySourceID: [String: String]
        public let boundsByRowID: [String: ReplyBounds]
        public func resolveRowID(_ rowID: String) -> String? { rowIDsBySourceID[rowID] }
    }

    /// Builds bounded identity aliases without mutating any source payload.
    public static func project<Item: ConversationTimelineItem>(_ source: [ConversationEntry<Item>]) -> Result<Item> {
        let projected = entries(source)
        var aliases: [String: String] = [:]
        aliases.reserveCapacity(source.count * 2)
        var bounds: [String: ReplyBounds] = [:]
        var processStates: [String: ConversationProcessState] = [:]
        for entry in projected {
            aliases[entry.id] = entry.id
            let items: [Item]
            switch entry.kind {
            case .message(let item): items = entry.mediaItems.isEmpty ? [item] : entry.mediaItems
            case .process(_, let value):
                items = value
                processStates[entry.id] = entry.processReplyState ?? ConversationProcessPresentation.state(for: value)
            }
            for item in items { aliases["message:" + item.id] = entry.id }
        }
        // Old process segments can merge; map them by retained source identity.
        for entry in source {
            if case .process(_, let items) = entry.kind,
               let target = items.lazy.compactMap({ aliases["message:" + $0.id] }).first {
                aliases[entry.id] = target
            }
        }
        // Accumulate dates per conversational segment, not raw turn ID: old
        // providers can reuse a turn ID after a new user instruction.
        var segmentTurnID: String?
        var segmentRows: Set<String> = []
        var startedAt: Date?
        var endedAt: Date?
        // Value-style parsing avoids ISO8601DateFormatter's lock/ICU cost per
        // event. Cache repeated whole-reply bounds only for this projection.
        let standardDate = Date.ISO8601FormatStyle()
        let fractionalDate = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        var parsedDates: [String: Date] = [:]
        func parseDate(_ value: String) -> Date? {
            if let cached = parsedDates[value] { return cached }
            let date = (try? standardDate.parse(value)) ?? (try? fractionalDate.parse(value))
                ?? ConversationTimestampText.date(from: value)
            if let date { parsedDates[value] = date }
            return date
        }
        func flushBounds() {
            for row in segmentRows {
                bounds[row] = ReplyBounds(startedAt: startedAt,
                    endedAt: processStates[row] == .running ? nil : endedAt)
            }
            segmentRows.removeAll(keepingCapacity: true)
            startedAt = nil; endedAt = nil; segmentTurnID = nil
        }
        for entry in source {
            let items: [Item]
            switch entry.kind {
            case .message(let item):
                let kind = ConversationPresentationKind.resolve(type: item.type, presentationRole: item.presentationRole)
                if kind == .userMessage { flushBounds() }
                guard item.timelineMessageOrigin != "scheduled_task",
                      kind == .agentMessage || kind == .userMessage else { continue }
                items = [item]
            case .process(_, let value): items = value
            }
            if let turn = items.first?.timelineTurnID, !turn.isEmpty {
                if let segmentTurnID, turn != segmentTurnID { flushBounds() }
                segmentTurnID = turn
            }
            for item in items {
                if let row = aliases["message:" + item.id], processStates[row] != nil { segmentRows.insert(row) }
                // Missing dates require no formatter calls or temporary arrays.
                if let value = item.createdAt, let date = parseDate(value) {
                    if startedAt == nil || date < startedAt! { startedAt = date }
                    if endedAt == nil || date > endedAt! { endedAt = date }
                }
                if let value = item.processStartedAt, let date = parseDate(value),
                   startedAt == nil || date < startedAt! { startedAt = date }
            }
        }
        flushBounds()
        return Result(entries: projected, rowIDsBySourceID: aliases, boundsByRowID: bounds)
    }
}

