import Foundation
import Testing
@testable import CorptieMac

@Suite("Automation terminal notifications")
struct AutomationNotificationTests {
    @Test func terminalEventsDecodeAndRetryableFailuresAreSuppressed() throws {
        let completed = try #require(AutomationTerminalNotificationEvent.decode(
            eventName: "ScheduledSessionRunCompleted",
            data: envelope(eventID: "event:completed", scheduleType: "once")
        ))
        #expect(completed.kind == .completed)
        #expect(completed.name == "Nightly review")
        #expect(completed.message == "Review the latest state")

        #expect(AutomationTerminalNotificationEvent.decode(
            eventName: "ScheduledSessionRunFailed",
            data: envelope(eventID: "event:retry", scheduleType: "once", willRetry: true)
        ) == nil)

        let failed = try #require(AutomationTerminalNotificationEvent.decode(
            eventName: "ScheduledSessionRunFailed",
            data: envelope(eventID: "event:failed", scheduleType: "once", willRetry: false)
        ))
        #expect(failed.kind == .failed)

        let cancelled = try #require(AutomationTerminalNotificationEvent.decode(
            eventName: "ScheduledSessionTaskCancelled",
            data: envelope(eventID: "event:cancelled", scheduleType: "once")
        ))
        let expired = try #require(AutomationTerminalNotificationEvent.decode(
            eventName: "ScheduledSessionTaskExpired",
            data: envelope(eventID: "event:expired", scheduleType: "once")
        ))
        #expect(cancelled.kind == .cancelled)
        #expect(expired.kind == .expired)
    }

    @Test func recurringCompletionUsesOneReplacementIdentifierButDistinctDeliveryEvents() throws {
        let first = try #require(AutomationTerminalNotificationEvent.decode(
            eventName: "ScheduledSessionRunCompleted",
            data: envelope(eventID: "event:first", scheduleType: "interval")
        ))
        let second = try #require(AutomationTerminalNotificationEvent.decode(
            eventName: "ScheduledSessionRunCompleted",
            data: envelope(eventID: "event:second", scheduleType: "interval")
        ))
        #expect(first.eventID != second.eventID)
        #expect(first.notificationIdentifier == second.notificationIdentifier)
    }

    @Test @MainActor func notificationPreferenceDefaultsOnAndPersistsOff() throws {
        let suite = "AutomationNotificationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let initial = SessionNotificationPreferences(defaults: defaults)
        #expect(initial.notifyOnAutomations)
        initial.notifyOnAutomations = false
        let restored = SessionNotificationPreferences(defaults: defaults)
        #expect(!restored.notifyOnAutomations)
    }

    @Test @MainActor func notificationNavigationTargetsTheCorrespondingAutomation() {
        let router = AppTabRouter()
        router.openAutomation("scheduled_task:target")
        #expect(router.selectedTab == .automations)
        #expect(router.pendingAutomationId == "scheduled_task:target")
        router.consumeAutomation("scheduled_task:target")
        #expect(router.pendingAutomationId == nil)
    }

    private func envelope(eventID: String, scheduleType: String, willRetry: Bool? = nil) -> String {
        var payload: [String: Any] = [
            "task": [
                "taskId": "scheduled_task:one",
                "logicalSessionId": "session:one",
                "name": "Nightly review",
                "message": ["text": "Review the latest state"],
                "scheduleType": scheduleType
            ],
            "event": ["eventId": eventID]
        ]
        if let willRetry { payload["willRetry"] = willRetry }
        let data = try! JSONSerialization.data(withJSONObject: ["id": "global:\(eventID)", "payload": payload])
        return String(decoding: data, as: UTF8.self)
    }
}
