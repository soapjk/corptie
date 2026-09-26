import Foundation
import Testing
@testable import CorptieMobileState
import CorptieClientCore

@Suite("iPad notification parity")
struct PadNotificationTests {
    private let allEnabled = PadSessionNotificationConfiguration(
        notifyOnComplete: true,
        notifyOnBlocked: true,
        notifyOnFailed: true,
        notifyWhenAllSessionsWaiting: false
    )

    @Test func initialSnapshotNeverNotifies() {
        var reducer = PadSessionNotificationReducer()
        let events = reducer.events(
            for: [snapshot("one", status: .complete, agent: 2, read: 1)],
            configuration: allEnabled
        )
        #expect(events.isEmpty)
    }

    @Test func completionWaitsForDurableUnreadAgentReply() {
        var reducer = PadSessionNotificationReducer()
        _ = reducer.events(
            for: [snapshot("one", status: .running, agent: 1, read: 1)],
            configuration: allEnabled
        )
        #expect(reducer.events(
            for: [snapshot("one", status: .complete, agent: 1, read: 1)],
            configuration: allEnabled
        ).isEmpty)

        let events = reducer.events(
            for: [snapshot("one", status: .complete, agent: 2, read: 1)],
            configuration: allEnabled
        )
        #expect(events.map(\.kind) == [.completed])
        #expect(events.first?.id == "session:one:complete:2")
    }

    @Test func finalTransitionUsesOneAggregateNotification() {
        var reducer = PadSessionNotificationReducer()
        let configuration = PadSessionNotificationConfiguration(
            notifyOnComplete: true,
            notifyOnBlocked: true,
            notifyOnFailed: true,
            notifyWhenAllSessionsWaiting: true
        )
        _ = reducer.events(
            for: [
                snapshot("one", status: .running, agent: 1, read: 1),
                snapshot("two", status: .blocked)
            ],
            configuration: configuration
        )

        let events = reducer.events(
            for: [
                snapshot("one", status: .complete, agent: 2, read: 1),
                snapshot("two", status: .blocked)
            ],
            configuration: configuration
        )
        #expect(events.count == 1)
        #expect(events.first?.kind == .allSessionsWaiting)
        #expect(events.first?.counts?.pendingUserAttention == 1)
    }

    @Test func deliveryHistoryPersistsAndBoundsIdentifiers() throws {
        let suite = "PadNotificationTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var history = PadNotificationDeliveryHistory(defaults: defaults, key: "events", limit: 2)
        history.record("one")
        history.record("two")
        history.record("three")

        let reloaded = PadNotificationDeliveryHistory(defaults: defaults, key: "events", limit: 2)
        #expect(!reloaded.contains("one"))
        #expect(reloaded.contains("two"))
        #expect(reloaded.contains("three"))
    }

    @Test @MainActor func preferencesMatchMacDefaultsAndPersist() throws {
        let suite = "PadNotificationPreferencesTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = PadNotificationPreferences(defaults: defaults)
        #expect(!preferences.notifyOnComplete)
        #expect(!preferences.notifyOnBlocked)
        #expect(!preferences.notifyOnFailed)
        #expect(preferences.notifyWhenAllSessionsWaiting)
        #expect(preferences.notifyOnAutomations)
        #expect(preferences.waitingSoundEnabled)

        preferences.notifyOnFailed = true
        preferences.waitingSoundEnabled = false
        let reloaded = PadNotificationPreferences(defaults: defaults)
        #expect(reloaded.notifyOnFailed)
        #expect(!reloaded.waitingSoundEnabled)
    }

    private func snapshot(
        _ id: String,
        status: SessionExecutionState,
        agent: Int = 0,
        read: Int = 0
    ) -> PadSessionNotificationSnapshot {
        PadSessionNotificationSnapshot(
            id: id,
            title: id,
            status: status,
            updatedAt: "revision-\(agent)-\(status.rawValue)",
            lastAgentMessageSequence: agent,
            lastReadMessageSequence: read
        )
    }
}
