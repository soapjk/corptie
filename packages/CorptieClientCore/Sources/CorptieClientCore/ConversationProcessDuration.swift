import Foundation

extension ConversationProcessPresentation {
/// Cadence for the live "working for Ns" elapsed label. The label reads the
/// real clock on every fire (never a sum of ticks), so one update per second
/// is enough to keep the current turn duration live and independent of
/// provider events. The macOS timer is registered in the default RunLoop
/// mode, which keeps it out of NSEventTrackingRunLoopMode during window drag
/// and live resize. Never bring this back to a sub-second main-thread timer:
/// a 100 Hz repeating timer in .common was the cause of the drag jank.
public static let elapsedRefreshInterval: TimeInterval = 1.0
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

public static func durationText(startedAt start: Date, endingAt end: Date, showSeconds: Bool = false,
                                fractionDigits: Int = 0) -> String? {
    let duration = end.timeIntervalSince(start)
    guard duration.isFinite, duration >= 0, duration > 0 || showSeconds,
          duration * 100 < Double(Int.max) else { return nil }
    // Round before splitting so 59.999s becomes 1m 0s, not 60s. The live
    // elapsed label and frozen outcomes both default to whole seconds.
    // This only rounds the display; source timestamps retain their precision.
    let scale = fractionDigits <= 0 ? 1 : 100
    let units = Int((duration * Double(scale)).rounded())
    let seconds = units / scale
    let secondText: String
    if scale == 1 {
        secondText = "\(seconds % 60)s"
    } else {
        let fraction = units % scale
        secondText = "\(seconds % 60).\(fraction < 10 ? "0" : "")\(fraction)s"
    }
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
