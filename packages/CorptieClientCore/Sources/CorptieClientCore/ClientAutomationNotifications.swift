import Foundation

public struct ClientAutomationNotification: Codable, Sendable, Equatable {
    public let eventId: String
    public let sequence: Int
    public let automationId: String
    public let runId: String?
    public let logicalSessionId: String?
    public let name: String
    public let kind: String
    public let occurredAt: String
    public let scheduleType: String?
}

public struct ClientAutomationNotificationBatch: Codable, Sendable {
    public let schemaVersion: Int
    public let cursor: String
    public let reset: Bool
    public let recovery: Bool
    public let hasMore: Bool
    public let events: [ClientAutomationNotification]

    public func validated() throws -> Self {
        guard schemaVersion == 1, !cursor.isEmpty, cursor.count <= 512, events.count <= 128,
              !reset || events.isEmpty else { throw ClientConnectionError.invalidResponse }
        var previous = 0
        for event in events {
            guard event.sequence > previous, !event.eventId.isEmpty, event.eventId.count <= 256,
                  !event.automationId.isEmpty, event.automationId.count <= 512,
                  event.name.utf8.count <= 4096,
                  ["completed", "failed", "cancelled", "expired"].contains(event.kind),
                  Self.date(event.occurredAt) != nil else { throw ClientConnectionError.invalidResponse }
            previous = event.sequence
        }
        return self
    }

    public static func date(_ text: String) -> Date? {
        (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)))
            ?? (try? Date(text, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: false)))
    }
}

/// Cursor and bounded pending deliveries are committed as one value. This is
/// separate from list/view state and survives process death and >256 events.
public struct ClientAutomationNotificationLedger: Codable, Sendable {
    public private(set) var cursor: String?
    public private(set) var sequence = 0
    public private(set) var pending: [ClientAutomationNotification] = []
    public private(set) var pendingCount = 0
    public private(set) var recovered = false
    private var pendingDeadline: Date?

    public init() {}

    public mutating func consume(_ batch: ClientAutomationNotificationBatch, enabled: Bool, now: Date = Date()) {
        discardExpired(now: now)
        if batch.reset {
            sequence = 0; pending = []; pendingCount = 0; recovered = false
        } else {
            for event in batch.events where event.sequence > sequence {
                sequence = event.sequence
                guard enabled, let date = ClientAutomationNotificationBatch.date(event.occurredAt),
                      now.timeIntervalSince(date) <= 900, date.timeIntervalSince(now) <= 60 else { continue }
                pendingCount += 1
                pendingDeadline = min(pendingDeadline ?? date.addingTimeInterval(900), date.addingTimeInterval(900))
                recovered = recovered || batch.recovery
                // One sample per Automation, at most eight previews. The count
                // preserves the full burst while memory remains constant.
                pending.removeAll { $0.automationId == event.automationId }
                pending.append(event)
                if pending.count > 8 { pending.removeFirst() }
            }
        }
        cursor = batch.cursor
        if !enabled { clearPending() }
    }

    public mutating func clearPending() { pending = []; pendingCount = 0; recovered = false; pendingDeadline = nil }

    public mutating func discardExpired(now: Date = Date()) {
        if let pendingDeadline, pendingDeadline < now { clearPending() }
    }

    public mutating func acknowledge(through sequence: Int, count: Int) {
        pending.removeAll { $0.sequence <= sequence }
        pendingCount = max(0, pendingCount - count)
        if pendingCount == 0 { recovered = false; pendingDeadline = nil }
    }
}
