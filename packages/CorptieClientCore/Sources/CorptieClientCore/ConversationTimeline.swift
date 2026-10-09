import Foundation

/// Provider-neutral input to the shared desktop/mobile timeline projection.
/// Platform adapters retain their own payloads; the projector never erases data.
public protocol ConversationTimelineItem: Sendable {
    var id: String { get }
    var timelineTurnID: String { get }
    var timelineTurnStatus: String { get }
    var type: String { get }
    var text: String { get }
    var createdAt: String? { get }
    var presentationRole: String? { get }
    var collaborationDirection: String? { get }
    var processStartedAt: String? { get set }
    var processEndedAt: String? { get set }
    var timelineHasImages: Bool { get }
}

public extension ConversationTimelineItem {
    var collaborationDirection: String? { nil }
    var timelineHasImages: Bool { false }
}

public struct ConversationEntry<Item: ConversationTimelineItem>: Identifiable, Sendable {
    public enum Kind: Sendable {
        case message(Item)
        case process(turnId: String, items: [Item])
    }

    public let kind: Kind
    public init(kind: Kind) { self.kind = kind }

    public var id: String {
        switch kind {
        case .message(let item):
            return "message:\(item.id)"
        case .process(let turnId, _):
            return "process:\(turnId)"
        }
    }

    public var isProcessGroup: Bool {
        switch kind {
        case .message:
            return false
        case .process:
            return true
        }
    }

    public var displayWeight: Int {
        // The window budget represents visible conversation messages, not
        // disclosure rows. A process card can contain hundreds of tool events
        // and long-running turns can be split into multiple process segments;
        // counting those rows evicted the actual user/assistant conversation
        // from the initial viewport.
        isProcessGroup ? 0 : 1
    }
}

public enum ConversationTimeline {
    private struct TurnBucket<Item: ConversationTimelineItem> {
        let sourceTurnId: String
        var items: [Item] = []
        var hasNonUserMessage: Bool = false
        var isTerminal: Bool = false
        var hasFinalReply: Bool = false
    }

public static func makeEntries<Item: ConversationTimelineItem>(from items: [Item]) -> [ConversationEntry<Item>] {
    let ordered = orderedItems(items)
    guard !ordered.isEmpty else { return [] }

    var buckets: [TurnBucket<Item>] = []
    var openBucketIndexByTurnId: [String: Int] = [:]
    var activeConversationBucketIndex: Int?

    for item in ordered {
        let turnId = item.timelineTurnID
        let kind = ConversationPresentationKind.resolve(type: item.type, presentationRole: item.presentationRole)
        let isOutboundCollaboration = kind == .collaborationMessage
            && item.collaborationDirection?.lowercased() == "outbound"
        if isOutboundCollaboration || kind == .collaborationConfirmation {
            // Product-owned collaboration cards have their own turn/status.
            // Insert them into the active conversation without letting their
            // completed delivery status complete the Provider's execution.
            let matchingIndex = openBucketIndexByTurnId[turnId].flatMap {
                buckets[$0].hasFinalReply ? nil : $0
            }
            let activeIndex = activeConversationBucketIndex.flatMap {
                buckets[$0].hasFinalReply ? nil : $0
            }
            if let index = matchingIndex ?? activeIndex {
                buckets[index].items.append(item)
            } else {
                buckets.append(TurnBucket(sourceTurnId: turnId, items: [item],
                                          hasNonUserMessage: true, isTerminal: true))
            }
            continue
        }
        let isUserMessage = item.type == "userMessage"
        let isTerminalItem = isTerminalTurnStatus(item.timelineTurnStatus)
            || item.presentationRole?.lowercased() == "final_answer"
        // Completed history marks *all* turn items terminal, including steps
        // preceding a collaboration card. Only an actual reply closes its
        // chronological insertion window.
        let isFinalReply = item.presentationRole?.lowercased() == "final_answer"
            || (item.type == "agentMessage" && isTerminalItem
                && !ConversationPresentationKind.isCommentary(type: item.type, presentationRole: item.presentationRole))

        if isUserMessage {
            // A new user message starts a new conversational turn if:
            // 1. turnId is empty, OR
            // 2. The active bucket for this turnId already emitted non-user content or reached terminal state.
            if !turnId.isEmpty,
               let bucketIndex = openBucketIndexByTurnId[turnId],
               !buckets[bucketIndex].hasNonUserMessage,
               !buckets[bucketIndex].isTerminal {
                buckets[bucketIndex].items.append(item)
            } else {
                let newIndex = buckets.count
                buckets.append(TurnBucket(
                    sourceTurnId: turnId,
                    items: [item],
                    hasNonUserMessage: false,
                    isTerminal: isTerminalItem
                ))
                if !turnId.isEmpty {
                    openBucketIndexByTurnId[turnId] = newIndex
                }
                if activeConversationBucketIndex.map({ buckets[$0].hasFinalReply }) ?? true {
                    activeConversationBucketIndex = newIndex
                }
            }
        } else {
            // Non-user item (agent message, tool call, plan, interaction, etc.)
            if !turnId.isEmpty, let bucketIndex = openBucketIndexByTurnId[turnId] {
                activeConversationBucketIndex = bucketIndex
                buckets[bucketIndex].items.append(item)
                buckets[bucketIndex].hasNonUserMessage = true
                buckets[bucketIndex].hasFinalReply = buckets[bucketIndex].hasFinalReply || isFinalReply
                if isTerminalItem {
                    buckets[bucketIndex].isTerminal = true
                }
            } else if let lastIndex = buckets.indices.last, turnId.isEmpty || buckets[lastIndex].sourceTurnId.isEmpty {
                activeConversationBucketIndex = lastIndex
                // Item without turnId, or matching empty turnId of last bucket
                buckets[lastIndex].items.append(item)
                buckets[lastIndex].hasNonUserMessage = true
                buckets[lastIndex].hasFinalReply = buckets[lastIndex].hasFinalReply || isFinalReply
                if isTerminalItem {
                    buckets[lastIndex].isTerminal = true
                }
            } else {
                // Orphan non-user item with unseen turnId: start a new bucket
                let newIndex = buckets.count
                activeConversationBucketIndex = newIndex
                buckets.append(TurnBucket(
                    sourceTurnId: turnId,
                    items: [item],
                    hasNonUserMessage: true,
                    isTerminal: isTerminalItem,
                    hasFinalReply: isFinalReply
                ))
                if !turnId.isEmpty {
                    openBucketIndexByTurnId[turnId] = newIndex
                }
            }
        }
    }

    var entries: [ConversationEntry<Item>] = []
    var segmentCountsByTurnId: [String: Int] = [:]
    for bucket in buckets {
        let sourceTurnId = bucket.sourceTurnId
        let segmentIndex = segmentCountsByTurnId[sourceTurnId, default: 0]
        segmentCountsByTurnId[sourceTurnId] = segmentIndex + 1
        let displayTurnId = segmentIndex == 0
            ? (sourceTurnId.isEmpty ? nil : sourceTurnId)
            : "\(sourceTurnId):display-segment:\(segmentIndex)"
        entries.append(contentsOf: entriesForTurn(
            bucket.items,
            displayTurnId: displayTurnId
        ))
    }
    return entries
}

/// Orders a fully timestamped provider timeline chronologically while retaining
/// source order for ties. A partial or malformed timestamp set stays untouched:
/// provider order is safer than inventing positions for undated process items.
public static func orderedItems<Item: ConversationTimelineItem>(_ items: [Item]) -> [Item] {
    guard let firstTimestamp = items.first?.createdAt else { return items }
    let fixedTimestampLength = firstTimestamp.utf8.count
    var previousTimestamp: String?
    var fixedUTCRequiresSorting = false
    var hasUniformTimestampWidth = true

    for item in items {
        guard let timestamp = item.createdAt else { return items }
        if timestamp.utf8.count != fixedTimestampLength {
            hasUniformTimestampWidth = false
        }
        if let previousTimestamp, previousTimestamp > timestamp {
            fixedUTCRequiresSorting = true
        }
        previousTimestamp = timestamp
    }

    // An already monotonic, uniform-width sequence needs no interpretation:
    // returning provider order is correct even when a provider supplied a
    // malformed value. Strict timestamp validation is only necessary before
    // we actively reorder anything.
    if hasUniformTimestampWidth, !fixedUTCRequiresSorting {
        return items
    }

    // Provider timelines overwhelmingly use one fixed-width UTC ISO-8601
    // representation. In that form lexical and chronological order are
    // identical, avoiding thousands of formatter calls when sorting is needed.
    if hasUniformTimestampWidth,
       items.allSatisfy({ item in
           item.createdAt.map { isFixedUTCISO8601Timestamp($0, length: fixedTimestampLength) } == true
       }) {
        return items.enumerated().sorted { left, right in
            guard let leftTimestamp = left.element.createdAt,
                  let rightTimestamp = right.element.createdAt else { return left.offset < right.offset }
            guard leftTimestamp != rightTimestamp else { return left.offset < right.offset }
            return leftTimestamp < rightTimestamp
        }.map(\.element)
    }

    var datedItems: [(index: Int, item: Item, date: Date)] = []
    datedItems.reserveCapacity(items.count)
    var previousDate: Date?
    var requiresSorting = false
    let fractionalFormatter = ISO8601DateFormatter()
    fractionalFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let standardFormatter = ISO8601DateFormatter()
    standardFormatter.formatOptions = [.withInternetDateTime]

    for (index, item) in items.enumerated() {
        guard let createdAt = item.createdAt,
              let date = fractionalFormatter.date(from: createdAt) ?? standardFormatter.date(from: createdAt) else {
            return items
        }
        if let previousDate, previousDate > date {
            requiresSorting = true
        }
        datedItems.append((index: index, item: item, date: date))
        previousDate = date
    }
    guard requiresSorting else { return items }
    return datedItems.sorted { left, right in
        guard left.date != right.date else {
            return left.index < right.index
        }
        return left.date < right.date
    }.map(\.item)
}

private static func isFixedUTCISO8601Timestamp(_ value: String, length: Int) -> Bool {
    guard value.utf8.count == length,
          length == 20 || length >= 22 else { return false }
    var month = 0
    var day = 0
    var hour = 0
    var minute = 0
    var second = 0
    for (index, byte) in value.utf8.enumerated() {
        switch index {
        case 4, 7:
            guard byte == 45 else { return false } // -
        case 10:
            guard byte == 84 else { return false } // T
        case 13, 16:
            guard byte == 58 else { return false } // :
        case 19 where length == 20:
            guard byte == 90 else { return false } // Z
        case 19:
            guard byte == 46 else { return false } // .
        case length - 1:
            guard byte == 90 else { return false } // Z
        default:
            guard byte >= 48, byte <= 57 else { return false }
            let digit = Int(byte - 48)
            switch index {
            case 5: month = digit * 10
            case 6: month += digit
            case 8: day = digit * 10
            case 9: day += digit
            case 11: hour = digit * 10
            case 12: hour += digit
            case 14: minute = digit * 10
            case 15: minute += digit
            case 17: second = digit * 10
            case 18: second += digit
            default: break
            }
        }
    }
    guard (1...12).contains(month),
          (1...31).contains(day),
          (0...23).contains(hour),
          (0...59).contains(minute),
          (0...60).contains(second) else { return false }
    return true
}

public static func entriesForTurn<Item: ConversationTimelineItem>(
    _ items: [Item],
    displayTurnId: String? = nil
) -> [ConversationEntry<Item>] {
    let userMessages = items.filter {
        ConversationPresentationKind.resolve(type: $0.type, presentationRole: $0.presentationRole) == .userMessage
    }

    var entries: [ConversationEntry<Item>] = []
    var processBuffer: [Item] = []
    var processSegmentIndex = 0

    let baseTurnId = displayTurnId ?? items.first?.timelineTurnID ?? ""
    let turnStartedAt = userMessages.compactMap(\.createdAt).first
        ?? items.compactMap(\.createdAt).first
    let isTerminalTurn = items.contains(where: {
        let kind = ConversationPresentationKind.resolve(type: $0.type, presentationRole: $0.presentationRole)
        return kind != .collaborationMessage && kind != .collaborationConfirmation
            && isTerminalTurnStatus($0.timelineTurnStatus)
    })
    let turnEndedAt = items.reversed().compactMap(\.createdAt).first
    let lastProcessIndex = items.lastIndex(where: { isDetailProcessItem($0) })

    func flushProcessBuffer(isLastInTurn: Bool) {
        guard !processBuffer.isEmpty else { return }
        var segmentItems = processBuffer
        processBuffer.removeAll(keepingCapacity: true)

        let segmentTurnId = processSegmentIndex == 0
            ? baseTurnId
            : "\(baseTurnId):process-segment:\(processSegmentIndex)"
        processSegmentIndex += 1

        let segStartedAt = (processSegmentIndex == 1)
            ? turnStartedAt
            : segmentItems.compactMap(\.createdAt).first
        segmentItems[0].processStartedAt = segStartedAt

        if isTerminalTurn {
            segmentItems[0].processEndedAt = isLastInTurn
                ? turnEndedAt
                : (segmentItems.reversed().compactMap(\.createdAt).first ?? turnEndedAt)
        } else if !isLastInTurn {
            segmentItems[0].processEndedAt = segmentItems.reversed().compactMap(\.createdAt).first
        }

        entries.append(ConversationEntry<Item>(
            kind: .process(turnId: segmentTurnId, items: segmentItems)
        ))
    }

    for (index, item) in items.enumerated() {
        if isDetailProcessItem(item) {
            processBuffer.append(item)
        } else if item.type == "agentMessage" {
            if item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               ConversationPresentationKind.resolve(type: item.type, presentationRole: item.presentationRole) == .agentMessage {
                continue
            }
            let hasMoreProcessItems = lastProcessIndex.map { $0 > index } ?? false
            flushProcessBuffer(isLastInTurn: !hasMoreProcessItems)
            entries.append(ConversationEntry<Item>(kind: .message(item)))
        } else {
            // userMessage, plan, executionPlan, userInput, choice, approval, etc.
            let hasMoreProcessItems = lastProcessIndex.map { $0 > index } ?? false
            flushProcessBuffer(isLastInTurn: !hasMoreProcessItems)
            entries.append(ConversationEntry<Item>(kind: .message(item)))
        }
    }
    flushProcessBuffer(isLastInTurn: true)
    return entries
}

private static func isTerminalTurnStatus(_ status: String) -> Bool {
    switch status.lowercased() {
    case "completed", "complete", "failed", "cancelled", "canceled", "interrupted":
        return true
    default:
        return false
    }
}

private static func isDetailProcessItem<Item: ConversationTimelineItem>(_ item: Item) -> Bool {
    // Materialized image output must be directly visible, not hidden inside
    // an execution disclosure. The same shared rule governs every client.
    if item.type == "imageView", item.timelineHasImages { return false }
    let kind = ConversationPresentationKind.resolve(type: item.type, presentationRole: item.presentationRole)
    if kind == .collaborationMessage || kind == .collaborationConfirmation { return false }
    switch item.type {
    // These are provider execution events, not authored conversation replies.
    // Keep the mapping explicit: an unfamiliar event (or an interaction/error)
    // must remain visible until its presentation semantics are understood.
    case "reasoning", "commandExecution", "fileChange",
         "mcpToolCall", "dynamicToolCall", "webSearch", "warning", "contextCompaction",
         "sleep", "imageView", "collabAgentToolCall", "collabToolCall",
         "functionCallOutput", "enteredReviewMode", "exitedReviewMode":
        return true
    default:
        return false
    }
}
}
