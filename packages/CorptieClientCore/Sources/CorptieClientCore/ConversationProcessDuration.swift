import Foundation

extension ConversationProcessPresentation {
// Read the actual elapsed time at hundredth-second cadence; never count ticks.
public static let elapsedRefreshInterval: TimeInterval = 1.0 / 100.0
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
    return durationText(startedAt: start, endingAt: end, showSeconds: state(for: items) == .running)
}

public static func startedAt<Item: ConversationTimelineItem>(for items: [Item]) -> Date? {
    items.lazy.compactMap(\.processStartedAt).first.flatMap(dateParser.date(from:))
        ?? items.compactMap { $0.createdAt.flatMap(dateParser.date(from:)) }.min()
}

public static func durationText(startedAt start: Date, endingAt end: Date, showSeconds: Bool = false) -> String? {
    let duration = end.timeIntervalSince(start)
    guard duration.isFinite, duration >= 0, duration > 0 || showSeconds,
          duration * 100 < Double(Int.max) else { return nil }
    // Round before splitting so 59.999s becomes 1m 0.00s, not 60.00s.
    let hundredths = Int((duration * 100).rounded())
    let seconds = hundredths / 100
    let fraction = hundredths % 100
    let secondText = "\(seconds % 60).\(fraction < 10 ? "0" : "")\(fraction)s"
    if seconds < 60 { return secondText }
    let minutes = seconds / 60
    if minutes < 60 {
        return "\(minutes)m \(secondText)"
    }
    let hours = minutes / 60
    let minuteRemainder = minutes % 60
    return "\(hours)h \(minuteRemainder)m \(secondText)"
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
