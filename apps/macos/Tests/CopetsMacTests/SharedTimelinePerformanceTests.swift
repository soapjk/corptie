import Foundation
import XCTest
@testable import CorptieMac

@MainActor
final class SharedTimelinePerformanceTests: XCTestCase {
    func testProjectionMatchesFrozenDesktopOutputAndPerformance() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_TIMELINE_AB"] == "1" else {
            throw XCTSkip("Opt-in 10k-row extraction performance comparison")
        }
        let items = ChatPerformanceFixture.make().detail.items
        let expected = FrozenDesktopProjection.makeChatDisplayEntries(from: items)
        let actual = makeChatDisplayEntries(from: items)
        XCTAssertEqual(actual.count, expected.count)
        for (a, b) in zip(actual, expected) {
            switch (a.kind, b.kind) {
            case let (.message(left), .message(right)): XCTAssertEqual(left, right)
            case let (.process(leftID, left), .process(rightID, right)):
                XCTAssertEqual(leftID, rightID)
                XCTAssertEqual(left, right)
            default: XCTFail("Changed message/process classification")
            }
        }
        var oldTimes: [Double] = [], sharedTimes: [Double] = []
        func measure(_ work: () -> Int) -> Double {
            let start = ProcessInfo.processInfo.systemUptime
            XCTAssertEqual(work(), expected.count)
            return (ProcessInfo.processInfo.systemUptime - start) * 1_000
        }
        for iteration in 0..<35 {
            let old = { FrozenDesktopProjection.makeChatDisplayEntries(from: items).count }
            let shared = { makeChatDisplayEntries(from: items).count }
            let times = iteration.isMultiple(of: 2)
                ? (measure(old), measure(shared))
                : { let s = measure(shared); return (measure(old), s) }()
            if iteration >= 5 { oldTimes.append(times.0); sharedTimes.append(times.1) }
        }
        oldTimes.sort(); sharedTimes.sort()
        print("TIMELINE_AB old_p50=\(oldTimes[15]) shared_p50=\(sharedTimes[15]) old_p95=\(oldTimes[28]) shared_p95=\(sharedTimes[28])")
        XCTAssertLessThanOrEqual(sharedTimes[15], oldTimes[15] * 1.20 + 2)
        XCTAssertLessThanOrEqual(sharedTimes[28], oldTimes[28] * 1.25 + 2)
    }
}

/// Frozen pre-extraction implementation; never call this from product code.
private enum FrozenDesktopProjection {
    struct FrozenEntry {
        enum Kind { case message(CodexThreadItem); case process(turnId: String, items: [CodexThreadItem]) }
        let kind: Kind
    }
static func makeChatDisplayEntries(from items: [CodexThreadItem]) -> [FrozenEntry] {
    var entries: [FrozenEntry] = []
    var currentItems: [CodexThreadItem] = []
    var currentSegmentHasNonUserMessage = false
    var segmentCountsByTurnId: [String: Int] = [:]
    let orderedItems = stableChronologicalChatItems(items)
    func appendCurrentSegment() {
        guard let sourceTurnId = currentItems.first?.turnId else { return }
        let segmentIndex = segmentCountsByTurnId[sourceTurnId, default: 0]
        segmentCountsByTurnId[sourceTurnId] = segmentIndex + 1
        let displayTurnId = segmentIndex == 0
            ? sourceTurnId
            : "\(sourceTurnId):display-segment:\(segmentIndex)"
        entries.append(contentsOf: makeChatDisplayEntriesForTurn(
            currentItems,
            displayTurnId: displayTurnId
        ))
        currentItems.removeAll(keepingCapacity: true)
        currentSegmentHasNonUserMessage = false
    }

    for item in orderedItems {
        let startsNewSourceTurn = currentItems.last.map { $0.turnId != item.turnId } ?? false
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
static func stableChronologicalChatItems(_ items: [CodexThreadItem]) -> [CodexThreadItem] {
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

    var datedItems: [(index: Int, item: CodexThreadItem, date: Date)] = []
    datedItems.reserveCapacity(items.count)
    var previousDate: Date?
    var requiresSorting = false

    for (index, item) in items.enumerated() {
        guard let createdAt = item.createdAt,
              let date = parseDate(createdAt) else {
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

static func makeChatDisplayEntriesForTurn(
    _ items: [CodexThreadItem],
    displayTurnId: String? = nil
) -> [FrozenEntry] {
    let userMessages = items.filter { $0.type == "userMessage" }
    if let confirmation = items.last(where: { $0.type == "collaborationConfirmation" }) {
        return userMessages.map { FrozenEntry(kind: .message($0)) }
            + [FrozenEntry(kind: .message(confirmation))]
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

    var entries = userMessages.map { FrozenEntry(kind: .message($0)) }
    if !processItems.isEmpty,
       let sourceTurnId = items.first?.turnId {
        let turnStartedAt = userMessages.compactMap(\.createdAt).first
            ?? items.compactMap(\.createdAt).first
        let turnEndedAt = items.reversed().compactMap(\.createdAt).first
        processItems[0].processStartedAt = turnStartedAt
        if items.contains(where: { isTerminalTurnStatus($0.turnStatus) }) {
            processItems[0].processEndedAt = turnEndedAt
        }
        // Keep execution lifecycle independent from the user's authored message.
        // The process row owns its disclosure state and remains a separate bubble
        // even for the common one-message turn.
        entries.append(FrozenEntry(kind: .process(
            turnId: displayTurnId ?? sourceTurnId,
            items: processItems
        )))
    }
    entries.append(contentsOf: unclassifiedAgentMessages.map { FrozenEntry(kind: .message($0)) })
    if let presentedAgentMessage,
       !unclassifiedAgentMessages.contains(where: { $0.id == presentedAgentMessage.id }) {
        entries.append(FrozenEntry(kind: .message(presentedAgentMessage)))
    }
    entries.append(contentsOf: trailingItems.map { FrozenEntry(kind: .message($0)) })
    return entries
}

private static func preferredPresentedAgentMessage(from messages: [CodexThreadItem]) -> CodexThreadItem? {
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
    private static func isDetailProcessItem(_ item: CodexThreadItem) -> Bool {
        switch item.type {
        case "reasoning", "plan", "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "webSearch", "warning", "contextCompaction": true
        default: false
        }
    }
    nonisolated(unsafe) private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    nonisolated(unsafe) private static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
    private static func parseDate(_ value: String) -> Date? {
        fractional.date(from: value) ?? standard.date(from: value)
    }
}

