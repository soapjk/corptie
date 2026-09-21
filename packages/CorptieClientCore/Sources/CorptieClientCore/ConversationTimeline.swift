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
    var processStartedAt: String? { get set }
    var processEndedAt: String? { get set }
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
public static func makeEntries<Item: ConversationTimelineItem>(from items: [Item]) -> [ConversationEntry<Item>] {
    var entries: [ConversationEntry<Item>] = []
    var currentItems: [Item] = []
    var currentSegmentHasNonUserMessage = false
    var segmentCountsByTurnId: [String: Int] = [:]
    let orderedItems = orderedItems(items)
    func appendCurrentSegment() {
        guard let sourceTurnId = currentItems.first?.timelineTurnID else { return }
        let segmentIndex = segmentCountsByTurnId[sourceTurnId, default: 0]
        segmentCountsByTurnId[sourceTurnId] = segmentIndex + 1
        let displayTurnId = segmentIndex == 0
            ? sourceTurnId
            : "\(sourceTurnId):display-segment:\(segmentIndex)"
        entries.append(contentsOf: entriesForTurn(
            currentItems,
            displayTurnId: displayTurnId
        ))
        currentItems.removeAll(keepingCapacity: true)
        currentSegmentHasNonUserMessage = false
    }

    for item in orderedItems {
        let startsNewSourceTurn = currentItems.last.map { $0.timelineTurnID != item.timelineTurnID } ?? false
        // Some provider histories omit turn_id or reuse one value for the
        // complete Session. Once a turn has emitted non-user content, the next
        // authored user message is the only reliable boundary. Segmenting here
        // preserves provider order and prevents all user cards from being
        // projected ahead of every assistant/process card in the Session.
        let startsRecoveredTurn = item.type == "userMessage"
            && currentSegmentHasNonUserMessage
        if startsNewSourceTurn || startsRecoveredTurn {
            appendCurrentSegment()
        }
        currentItems.append(item)
        currentSegmentHasNonUserMessage = currentSegmentHasNonUserMessage || item.type != "userMessage"
    }
    appendCurrentSegment()
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
    let userMessages = items.filter { $0.type == "userMessage" }
    if let confirmation = items.last(where: { $0.type == "collaborationConfirmation" }) {
        return userMessages.map { ConversationEntry<Item>(kind: .message($0)) }
            + [ConversationEntry<Item>(kind: .message(confirmation))]
    }
    let agentMessages = items.filter {
        $0.type == "agentMessage" && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
    let presentedAgentMessage = preferredPresentedAgentMessage(from: agentMessages)
    // An unclassified Assistant item is not execution progress. Keep it as a
    // visible message so an Adapter contract defect cannot hide the model's
    // response inside the process disclosure. New Provider events are expected
    // to carry commentary/final_answer explicitly.
    let unclassifiedAgentMessages = agentMessages.filter {
        $0.presentationRole?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
    }
    let separatelyPresentedAgentIDs = Set(
        unclassifiedAgentMessages.map(\.id) + [presentedAgentMessage?.id].compactMap { $0 }
    )
    let progressAgentMessages = agentMessages.filter { !separatelyPresentedAgentIDs.contains($0.id) }
    let progressAgentMessageIds = Set(progressAgentMessages.map(\.id))
    var processItems = items.filter { item in
        isDetailProcessItem(item) || progressAgentMessageIds.contains(item.id)
    }
    let trailingItems = items.filter { item in
        item.type != "userMessage" && item.type != "agentMessage" && !isDetailProcessItem(item)
    }

    var entries = userMessages.map { ConversationEntry<Item>(kind: .message($0)) }
    if !processItems.isEmpty,
       let sourceTurnId = items.first?.timelineTurnID {
        let turnStartedAt = userMessages.compactMap(\.createdAt).first
            ?? items.compactMap(\.createdAt).first
        let turnEndedAt = items.reversed().compactMap(\.createdAt).first
        processItems[0].processStartedAt = turnStartedAt
        if items.contains(where: { isTerminalTurnStatus($0.timelineTurnStatus) }) {
            processItems[0].processEndedAt = turnEndedAt
        }
        // Keep execution lifecycle independent from the user's authored message.
        // The process row owns its disclosure state and remains a separate bubble
        // even for the common one-message turn.
        entries.append(ConversationEntry<Item>(kind: .process(
            turnId: displayTurnId ?? sourceTurnId,
            items: processItems
        )))
    }
    entries.append(contentsOf: unclassifiedAgentMessages.map { ConversationEntry<Item>(kind: .message($0)) })
    if let presentedAgentMessage,
       !unclassifiedAgentMessages.contains(where: { $0.id == presentedAgentMessage.id }) {
        entries.append(ConversationEntry<Item>(kind: .message(presentedAgentMessage)))
    }
    entries.append(contentsOf: trailingItems.map { ConversationEntry<Item>(kind: .message($0)) })
    return entries
}

private static func preferredPresentedAgentMessage<Item: ConversationTimelineItem>(from messages: [Item]) -> Item? {
    messages.last(where: {
        $0.presentationRole?.lowercased() == "final_answer"
    })
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
    switch item.type {
    case "reasoning", "plan", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "warning", "contextCompaction":
        return true
    default:
        return false
    }
}
}
