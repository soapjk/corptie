import Foundation

extension ConversationProcessPresentation {
public static func durationText<Item: ConversationTimelineItem>(
    for items: [Item],
    now: Date = Date()
) -> String? {
    let itemDates = items.compactMap { item in
        item.createdAt.flatMap(dateParser.date(from:))
    }
    let projectedStart = items.lazy.compactMap(\.processStartedAt).first
        .flatMap(dateParser.date(from:))
    let projectedEnd = items.lazy.compactMap(\.processEndedAt).first
        .flatMap(dateParser.date(from:))
    guard let start = projectedStart ?? itemDates.min() else { return nil }
    let end: Date?
    if let projectedEnd {
        end = projectedEnd
    } else if state(for: items) == .running {
        end = now
    } else {
        end = itemDates.max()
    }
    guard let end else { return nil }
    return durationText(startedAt: start, endingAt: end)
}

public static func startedAt<Item: ConversationTimelineItem>(for items: [Item]) -> Date? {
    items.lazy.compactMap(\.processStartedAt).first.flatMap(dateParser.date(from:))
        ?? items.compactMap { $0.createdAt.flatMap(dateParser.date(from:)) }.min()
}

public static func durationText(startedAt start: Date, endingAt end: Date, showSeconds: Bool = false) -> String? {
    let duration = end.timeIntervalSince(start)
    guard duration > 0.05 else { return nil }
    if duration < 10 { return String(format: "%.1fs", duration) }
    let seconds = Int(duration.rounded())
    if seconds < 60 { return "\(seconds)s" }
    let minutes = seconds / 60
    let remainder = seconds % 60
    if minutes < 60 {
        return showSeconds || remainder != 0 ? "\(minutes)m \(remainder)s" : "\(minutes)m"
    }
    let hours = minutes / 60
    let minuteRemainder = minutes % 60
    if showSeconds { return "\(hours)h \(minuteRemainder)m \(remainder)s" }
    return minuteRemainder == 0 ? "\(hours)h" : "\(hours)h \(minuteRemainder)m"
}
    private static let dateParser = ProcessDateParser()
}

/// Reuses immutable formatter configuration. Lock protects formatter calls when
/// desktop background projection and UI projection overlap.
private final class ProcessDateParser: @unchecked Sendable {
    private let lock = NSLock()
    private let fractional = ISO8601DateFormatter()
    private let standard = ISO8601DateFormatter()
    init() {
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        standard.formatOptions = [.withInternetDateTime]
    }
    func date(from value: String) -> Date? {
        lock.lock()
        defer { lock.unlock() }
        return fractional.date(from: value) ?? standard.date(from: value)
    }
}
