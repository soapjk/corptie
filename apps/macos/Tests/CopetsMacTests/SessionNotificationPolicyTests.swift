import XCTest
@testable import CorptieMac

final class SessionNotificationPolicyTests: XCTestCase {
    private let aggregateOnly = SessionNotificationConfiguration(
        notifyOnComplete: false,
        notifyOnBlocked: false,
        notifyOnFailed: false,
        notifyWhenAllSessionsWaiting: true
    )

    func testInitialSnapshotOnlyEstablishesBaseline() {
        var reducer = SessionNotificationReducer()

        XCTAssertEqual(reducer.events(
            for: [snapshot("one", .complete)],
            configuration: aggregateOnly
        ), [])
    }

    func testDefaultAggregateNotificationWaitsUntilEverySessionStopsRunning() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(
            for: [snapshot("one", .running), snapshot("two", .running)],
            configuration: aggregateOnly
        )

        XCTAssertEqual(reducer.events(
            for: [snapshot("one", .complete), snapshot("two", .running)],
            configuration: aggregateOnly
        ), [])

        let events = reducer.events(
            for: [snapshot("one", .complete), snapshot("two", .blocked)],
            configuration: aggregateOnly
        )
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.kind, .allSessionsWaiting)
        XCTAssertEqual(events.first?.counts, SessionNotificationCounts(completed: 1, blocked: 1, failed: 0))
    }

    func testAggregateNotificationReplacesFinalIndividualNotification() {
        var reducer = SessionNotificationReducer()
        let allEnabled = SessionNotificationConfiguration(
            notifyOnComplete: true,
            notifyOnBlocked: true,
            notifyOnFailed: true,
            notifyWhenAllSessionsWaiting: true
        )
        _ = reducer.events(for: [snapshot("one", .running)], configuration: allEnabled)

        let events = reducer.events(for: [snapshot("one", .failed)], configuration: allEnabled)

        XCTAssertEqual(events.map(\.kind), [.allSessionsWaiting])
    }

    func testIndividualNotificationsFollowCheckboxesWhenAggregateIsDisabled() {
        var reducer = SessionNotificationReducer()
        let failedOnly = SessionNotificationConfiguration(
            notifyOnComplete: false,
            notifyOnBlocked: false,
            notifyOnFailed: true,
            notifyWhenAllSessionsWaiting: false
        )
        _ = reducer.events(
            for: [snapshot("complete", .running), snapshot("failed", .running)],
            configuration: failedOnly
        )

        let events = reducer.events(
            for: [snapshot("complete", .complete), snapshot("failed", .failed)],
            configuration: failedOnly
        )

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.kind, .failed)
        XCTAssertEqual(events.first?.session?.id, "failed")
    }

    func testEachIndividualTerminalNotificationFollowsItsCheckbox() {
        let cases: [(TaskStatus, SessionNotificationKind)] = [
            (.complete, .completed),
            (.blocked, .blocked),
            (.failed, .failed)
        ]

        for (status, expectedKind) in cases {
            var reducer = SessionNotificationReducer()
            let configuration = SessionNotificationConfiguration(
                notifyOnComplete: status == .complete,
                notifyOnBlocked: status == .blocked,
                notifyOnFailed: status == .failed,
                notifyWhenAllSessionsWaiting: false
            )
            _ = reducer.events(for: [snapshot("one", .running)], configuration: configuration)

            XCTAssertEqual(
                reducer.events(for: [snapshot("one", status)], configuration: configuration).map(\.kind),
                [expectedKind]
            )
        }
    }

    func testRepeatedTerminalSnapshotDoesNotNotifyAgain() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(for: [snapshot("one", .running)], configuration: aggregateOnly)
        XCTAssertEqual(
            reducer.events(for: [snapshot("one", .complete)], configuration: aggregateOnly).count,
            1
        )

        XCTAssertEqual(
            reducer.events(for: [snapshot("one", .complete)], configuration: aggregateOnly),
            []
        )
    }

    func testCancelledFinalSessionDoesNotProduceAllWaitingNotification() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(for: [snapshot("one", .running)], configuration: aggregateOnly)

        XCTAssertEqual(
            reducer.events(for: [snapshot("one", .cancelled)], configuration: aggregateOnly),
            []
        )
    }

    func testCancelledSessionPreventsAllSessionsWaitingNotification() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(
            for: [snapshot("one", .running), snapshot("two", .cancelled)],
            configuration: aggregateOnly
        )

        XCTAssertEqual(
            reducer.events(
                for: [snapshot("one", .complete), snapshot("two", .cancelled)],
                configuration: aggregateOnly
            ),
            []
        )
    }

    func testAResumedSessionCanProduceANewCompletionEvent() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(for: [snapshot("one", .running, updatedAt: "1")], configuration: aggregateOnly)
        let first = reducer.events(for: [snapshot("one", .complete, updatedAt: "2")], configuration: aggregateOnly)
        _ = reducer.events(for: [snapshot("one", .running, updatedAt: "3")], configuration: aggregateOnly)
        let second = reducer.events(for: [snapshot("one", .complete, updatedAt: "4")], configuration: aggregateOnly)

        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(second.count, 1)
        XCTAssertNotEqual(first.first?.id, second.first?.id)
    }

    func testNotificationNavigationTargetsSessionOrOverview() {
        XCTAssertEqual(
            SessionNotificationNavigation.destination(for: ["sessionId": "session-one"]),
            .session("session-one")
        )
        XCTAssertEqual(
            SessionNotificationNavigation.destination(for: ["destination": "overview"]),
            .overview
        )
    }

    private func snapshot(
        _ id: String,
        _ status: TaskStatus,
        updatedAt: String = "2026-08-20T00:00:00Z"
    ) -> SessionNotificationSnapshot {
        SessionNotificationSnapshot(
            id: id,
            title: "Session \(id)",
            agent: "Agent",
            status: status,
            summary: "Summary",
            updatedAt: updatedAt
        )
    }
}

final class SessionCompletionSoundTransitionTrackerTests: XCTestCase {
    func testLegacySoundTransitionsRemainIndependentOfSystemNotificationPreferences() {
        var tracker = SessionCompletionSoundTransitionTracker()
        XCTAssertEqual(tracker.completedSessionIDs(for: [snapshot("one", .running)]), [])
        XCTAssertEqual(tracker.completedSessionIDs(for: [snapshot("one", .complete)]), ["one"])

        _ = tracker.completedSessionIDs(for: [snapshot("one", .running)])
        XCTAssertEqual(tracker.completedSessionIDs(for: [snapshot("one", .blocked)]), ["one"])

        _ = tracker.completedSessionIDs(for: [snapshot("one", .running)])
        XCTAssertEqual(tracker.completedSessionIDs(for: [snapshot("one", .failed)]), [])
    }

    private func snapshot(_ id: String, _ status: TaskStatus) -> SessionNotificationSnapshot {
        SessionNotificationSnapshot(
            id: id,
            title: "Session \(id)",
            agent: "Agent",
            status: status,
            summary: "Summary",
            updatedAt: "2026-08-20T00:00:00Z"
        )
    }
}

@MainActor
final class SessionNotificationPreferencesTests: XCTestCase {
    func testDefaultsEnableOnlyAllSessionsWaiting() {
        let defaults = makeDefaults()
        let preferences = SessionNotificationPreferences(defaults: defaults)

        XCTAssertEqual(preferences.configuration, SessionNotificationConfiguration(
            notifyOnComplete: false,
            notifyOnBlocked: false,
            notifyOnFailed: false,
            notifyWhenAllSessionsWaiting: true
        ))
    }

    func testCheckboxChangesPersist() {
        let defaults = makeDefaults()
        let preferences = SessionNotificationPreferences(defaults: defaults)
        preferences.notifyOnFailed = true
        preferences.notifyWhenAllSessionsWaiting = false

        let reloaded = SessionNotificationPreferences(defaults: defaults)
        XCTAssertTrue(reloaded.notifyOnFailed)
        XCTAssertFalse(reloaded.notifyWhenAllSessionsWaiting)
    }

    private func makeDefaults() -> UserDefaults {
        let suite = "SessionNotificationPreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }
}

final class SystemNotificationCenterTests: XCTestCase {
    func testDirectSwiftPMTestProcessDoesNotCreateAUserNotificationCenter() {
        XCTAssertFalse(SystemNotificationCenter.isAvailable)
        XCTAssertNil(SystemNotificationCenter.currentIfAvailable())
    }
}

final class SessionNotificationDeliveryHistoryTests: XCTestCase {
    func testClaimPersistsAndRejectsDuplicateAcrossInstances() {
        let suite = "SessionNotificationDeliveryHistoryTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        var history = SessionNotificationDeliveryHistory(defaults: defaults)

        XCTAssertTrue(history.claim("event-one"))
        XCTAssertFalse(history.claim("event-one"))

        var reloaded = SessionNotificationDeliveryHistory(defaults: defaults)
        XCTAssertFalse(reloaded.claim("event-one"))
        XCTAssertTrue(reloaded.claim("event-two"))
    }
}
