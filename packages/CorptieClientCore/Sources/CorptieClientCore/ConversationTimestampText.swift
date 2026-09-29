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

/// A centered timeline label for an ordinary message following a long gap.
/// Call from the timeline projection, so scrolling does not parse or format dates.
@MainActor
public enum ConversationTimeSeparatorText {
    public static let minimumGap: TimeInterval = 5 * 60

    private struct FormatterKey: Hashable {
        let localeIdentifier: String
        let calendarIdentifier: String
        let timeZoneIdentifier: String
        let includesDate: Bool
    }

    private static var formatters: [FormatterKey: DateFormatter] = [:]

    public static func label(
        for date: Date,
        after previousDate: Date?,
        now: Date = Date(),
        calendar: Calendar = .current,
        locale: Locale = .current
    ) -> String? {
        guard let previousDate, date.timeIntervalSince(previousDate) >= minimumGap else { return nil }
        let includesDate = !calendar.isDate(date, inSameDayAs: previousDate)
            || !calendar.isDate(date, inSameDayAs: now)
        let key = FormatterKey(
            localeIdentifier: locale.identifier,
            calendarIdentifier: String(describing: calendar.identifier),
            timeZoneIdentifier: calendar.timeZone.identifier,
            includesDate: includesDate
        )
        if let formatter = formatters[key] { return formatter.string(from: date) }
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.timeStyle = .short
        formatter.dateStyle = includesDate ? .medium : .none
        formatters[key] = formatter
        return formatter.string(from: date)
    }
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
