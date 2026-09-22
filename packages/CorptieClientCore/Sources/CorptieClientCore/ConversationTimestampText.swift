import Foundation

/// Timeline timestamp strings shared by the desktop message action bar and the
/// iPad message card, so both render identical labels for the same `createdAt`.
public enum ConversationTimestampText {
    /// `MM/dd HH:mm:ss` in the current locale; empty when the value is absent or unparsable.
    public static func messageLabel(createdAt: String?) -> String {
        guard let createdAt, let date = parser.date(from: createdAt) else { return "" }
        return date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute().second())
    }

    /// `MM/dd HH:mm` variant used by collaboration and system cards.
    public static func shortLabel(createdAt: String?) -> String {
        guard let createdAt, let date = parser.date(from: createdAt) else { return "" }
        return date.formatted(.dateTime.month(.twoDigits).day(.twoDigits).hour().minute())
    }

    public static func date(from createdAt: String) -> Date? { parser.date(from: createdAt) }

    private static let parser = TimestampParser()
}

/// ISO-8601 with or without fractional seconds; formatters are reused under a lock
/// because projection runs on background queues as well as the main actor.
private final class TimestampParser: @unchecked Sendable {
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
