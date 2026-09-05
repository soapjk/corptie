import XCTest
@testable import CorptieMac

@MainActor
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
        XCTAssertEqual(events.first?.counts, SessionNotificationCounts(
            completed: 1,
            blocked: 1,
            failed: 0,
            pendingUserAttention: 1
        ))
    }

    func testFreshTerminalTransitionNeedsAttentionAfterMessageCursorAdvances() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(for: [snapshot("fresh", .running)], configuration: aggregateOnly)

        let event = reducer.events(
            for: [snapshot("fresh", .complete)],
            configuration: aggregateOnly
        ).first

        XCTAssertEqual(event?.counts?.pendingUserAttention, 1)
    }

    func testAggregatePendingCountCoversZeroOneAndMultipleUnreadSessions() {
        let cases: [([SessionNotificationSnapshot], Int)] = [
            ([
                snapshot("read", .complete, lastAgentMessageSequence: 4, lastReadMessageSequence: 4)
            ], 0),
            ([
                snapshot("read", .complete, lastAgentMessageSequence: 4, lastReadMessageSequence: 4),
                snapshot("unread", .complete, lastAgentMessageSequence: 5, lastReadMessageSequence: 4)
            ], 1),
            ([
                snapshot("unread-one", .complete, lastAgentMessageSequence: 5, lastReadMessageSequence: 4),
                snapshot("unread-two", .complete, lastAgentMessageSequence: 9, lastReadMessageSequence: 3),
                snapshot("failed-unread", .failed, lastAgentMessageSequence: 8, lastReadMessageSequence: 1)
            ], 2)
        ]

        for (terminalSessions, expectedCount) in cases {
            var reducer = SessionNotificationReducer()
            let runningSessions = terminalSessions.map {
                snapshot(
                    $0.id,
                    .running,
                    lastAgentMessageSequence: $0.lastAgentMessageSequence,
                    lastReadMessageSequence: $0.lastReadMessageSequence
                )
            }
            _ = reducer.events(for: runningSessions, configuration: aggregateOnly)

            let events = reducer.events(for: terminalSessions, configuration: aggregateOnly)

            if expectedCount == 0 {
                XCTAssertEqual(events, [])
            } else {
                XCTAssertEqual(events.count, 1)
                XCTAssertEqual(events.first?.counts?.pendingUserAttention, expectedCount)
            }
        }
    }

    func testMultipleUnreadMessagesInOneSessionCountOnce() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(
            for: [snapshot("one", .running, lastAgentMessageSequence: 3, lastReadMessageSequence: 3)],
            configuration: aggregateOnly
        )

        let events = reducer.events(
            for: [snapshot("one", .complete, lastAgentMessageSequence: 12, lastReadMessageSequence: 3)],
            configuration: aggregateOnly
        )

        XCTAssertEqual(events.first?.counts?.pendingUserAttention, 1)
    }

    func testPendingCountUsesUnreadPredicateAcrossExistingAndFreshCompletions() {
        var reducer = SessionNotificationReducer()
        let initialSessions = [
            snapshot("completed-unread", .complete, lastAgentMessageSequence: 2, lastReadMessageSequence: 1),
            snapshot("completed-read", .complete, lastAgentMessageSequence: 2, lastReadMessageSequence: 2),
            snapshot("completed-without-message", .complete, lastAgentMessageSequence: 0),
            snapshot("blocked-unread", .blocked, lastAgentMessageSequence: 4, lastReadMessageSequence: 1),
            snapshot("failed-unread", .failed, lastAgentMessageSequence: 4, lastReadMessageSequence: 1),
            snapshot("fresh", .running, lastAgentMessageSequence: 2, lastReadMessageSequence: 1)
        ]
        _ = reducer.events(for: initialSessions, configuration: aggregateOnly)
        var terminalSessions = initialSessions
        terminalSessions[5] = snapshot(
            "fresh",
            .complete,
            lastAgentMessageSequence: 2,
            lastReadMessageSequence: 1
        )

        let event = reducer.events(for: terminalSessions, configuration: aggregateOnly).first

        XCTAssertEqual(event?.counts?.pendingUserAttention, 2)
        XCTAssertTrue(terminalSessions[0].needsUserAttention)
        XCTAssertFalse(terminalSessions[1].needsUserAttention)
        XCTAssertFalse(terminalSessions[2].needsUserAttention)
        XCTAssertFalse(terminalSessions[3].needsUserAttention)
        XCTAssertFalse(terminalSessions[4].needsUserAttention)
        XCTAssertTrue(terminalSessions[5].needsUserAttention)
    }

    func testAggregateNotificationBodyStatesCompletionAndPendingSessionCount() {
        let previousLanguage = AppLanguageController.shared.selection
        AppLanguageController.shared.selection = .english
        defer { AppLanguageController.shared.selection = previousLanguage }
        let event = SessionNotificationEvent(
            id: "aggregate",
            kind: .allSessionsWaiting,
            session: nil,
            counts: SessionNotificationCounts(
                completed: 2,
                blocked: 0,
                failed: 0,
                pendingUserAttention: 1
            )
        )

        XCTAssertEqual(
            SessionNotificationContent.title(for: event),
            "All Sessions Have Finished Processing"
        )
        XCTAssertEqual(
            SessionNotificationContent.body(for: event),
            "All sessions have finished processing. Sessions needing your attention: 1."
        )
        XCTAssertTrue(SessionNotificationContent.playsSystemSound(for: event))
    }

    func testIndividualNotificationPreservesPerSessionSoundPreference() {
        let event = SessionNotificationEvent(
            id: "completed",
            kind: .completed,
            session: snapshot("completed", .complete, lastAgentMessageSequence: 2),
            counts: nil
        )

        XCTAssertFalse(SessionNotificationContent.playsSystemSound(for: event))
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

    func testCompletedStatusWithoutDurableFinalReplyDoesNotNotify() {
        var reducer = SessionNotificationReducer()
        let configuration = SessionNotificationConfiguration(
            notifyOnComplete: true,
            notifyOnBlocked: false,
            notifyOnFailed: false,
            notifyWhenAllSessionsWaiting: false
        )
        _ = reducer.events(for: [snapshot("one", .running)], configuration: configuration)

        XCTAssertEqual(
            reducer.events(
                for: [snapshot("one", .complete, lastAgentMessageSequence: 0)],
                configuration: configuration
            ),
            []
        )
    }

    func testLateFinalReplyCursorNotifiesAfterCompletedStatusWasAlreadyObserved() {
        var reducer = SessionNotificationReducer()
        let configuration = SessionNotificationConfiguration(
            notifyOnComplete: true,
            notifyOnBlocked: false,
            notifyOnFailed: false,
            notifyWhenAllSessionsWaiting: false
        )
        _ = reducer.events(for: [snapshot("one", .running)], configuration: configuration)
        XCTAssertEqual(reducer.events(
            for: [snapshot("one", .complete, lastAgentMessageSequence: 0)],
            configuration: configuration
        ), [])

        XCTAssertEqual(reducer.events(
            for: [snapshot("one", .complete, lastAgentMessageSequence: 4)],
            configuration: configuration
        ).map(\.kind), [.completed])
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

    func testAlreadyCancelledSessionDoesNotPreventAllSessionsWaitingNotification() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(
            for: [snapshot("one", .running), snapshot("two", .cancelled)],
            configuration: aggregateOnly
        )

        let events = reducer.events(
            for: [snapshot("one", .complete), snapshot("two", .cancelled)],
            configuration: aggregateOnly
        )

        XCTAssertEqual(events.map(\.kind), [.allSessionsWaiting])
    }

    func testAResumedSessionCanProduceANewCompletionEvent() {
        var reducer = SessionNotificationReducer()
        _ = reducer.events(for: [snapshot("one", .running, updatedAt: "1")], configuration: aggregateOnly)
        let first = reducer.events(for: [
            snapshot("one", .complete, updatedAt: "2", lastAgentMessageSequence: 1)
        ], configuration: aggregateOnly)
        _ = reducer.events(for: [
            snapshot("one", .running, updatedAt: "3", lastAgentMessageSequence: 1)
        ], configuration: aggregateOnly)
        let second = reducer.events(for: [
            snapshot("one", .complete, updatedAt: "4", lastAgentMessageSequence: 2)
        ], configuration: aggregateOnly)

        XCTAssertEqual(first.count, 1)
        XCTAssertEqual(second.count, 1)
        XCTAssertNotEqual(first.first?.id, second.first?.id)
    }

    func testAggregateIdentifierIsBoundedAndStableForLargeSessionCollections() {
        let sessions = (0..<2_000).map {
            snapshot("session-\($0)-\(String(repeating: "x", count: 80))", .complete)
        }

        let first = SessionNotificationEventIdentity.allSessionsWaiting(for: sessions)
        let reordered = SessionNotificationEventIdentity.allSessionsWaiting(for: Array(sessions.reversed()))

        XCTAssertEqual(first, reordered)
        XCTAssertLessThan(first.utf8.count, 64)
        XCTAssertTrue(first.hasPrefix("all-sessions-waiting:v2:"))
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
        updatedAt: String = "2026-08-20T00:00:00Z",
        lastAgentMessageSequence: Int? = nil,
        lastReadMessageSequence: Int = 0
    ) -> SessionNotificationSnapshot {
        SessionNotificationSnapshot(
            id: id,
            title: "Session \(id)",
            agent: "Agent",
            status: status,
            summary: "Summary",
            updatedAt: updatedAt,
            lastAgentMessageSequence: lastAgentMessageSequence ?? (status == .complete ? 1 : 0),
            lastReadMessageSequence: lastReadMessageSequence
        )
    }
}

final class SessionCompletionSoundTransitionTrackerTests: XCTestCase {
    func testAgentReplyCompletionTriggersSoundTransition() {
        var tracker = SessionCompletionSoundTransitionTracker()
        XCTAssertEqual(tracker.completedSessionIDs(for: [snapshot("one", .running, sequence: 4)]), [])
        XCTAssertEqual(tracker.completedSessionIDs(for: [snapshot("one", .complete, sequence: 5)]), ["one"])

        _ = tracker.completedSessionIDs(for: [snapshot("one", .running, sequence: 5)])
        XCTAssertEqual(tracker.completedSessionIDs(for: [snapshot("one", .blocked, sequence: 6)]), ["one"])

        _ = tracker.completedSessionIDs(for: [snapshot("one", .running, sequence: 6)])
        XCTAssertEqual(tracker.completedSessionIDs(for: [snapshot("one", .failed, sequence: 7)]), [])
    }

    func testSendingMessageDoesNotTriggerSoundWithoutAnAgentReply() {
        var tracker = SessionCompletionSoundTransitionTracker()
        _ = tracker.completedSessionIDs(for: [snapshot("one", .complete, sequence: 8)])

        XCTAssertEqual(
            tracker.completedSessionIDs(for: [snapshot("one", .running, sequence: 8)]),
            []
        )
        XCTAssertEqual(
            tracker.completedSessionIDs(for: [snapshot("one", .blocked, sequence: 8)]),
            []
        )
    }

    func testReplySequenceMayAdvanceBeforeTheTerminalStatusUpdate() {
        var tracker = SessionCompletionSoundTransitionTracker()
        _ = tracker.completedSessionIDs(for: [snapshot("one", .complete, sequence: 8)])
        _ = tracker.completedSessionIDs(for: [snapshot("one", .running, sequence: 8)])
        _ = tracker.completedSessionIDs(for: [snapshot("one", .running, sequence: 9)])

        XCTAssertEqual(
            tracker.completedSessionIDs(for: [snapshot("one", .complete, sequence: 9)]),
            ["one"]
        )
    }

    private func snapshot(
        _ id: String,
        _ status: TaskStatus,
        sequence: Int
    ) -> SessionNotificationSnapshot {
        SessionNotificationSnapshot(
            id: id,
            title: "Session \(id)",
            agent: "Agent",
            status: status,
            summary: "Summary",
            updatedAt: "2026-08-20T00:00:00Z",
            lastAgentMessageSequence: sequence
        )
    }
}

@MainActor
final class SessionCompletionSoundPreferencesTests: XCTestCase {
    func testMissingPreferenceDefaultsToOff() {
        let defaults = makeDefaults()

        XCTAssertEqual(
            SessionCompletionSoundManager.selectedSoundId(for: "new-session", defaults: defaults),
            SessionCompletionSoundManager.noneSoundId
        )
        XCTAssertNil(
            SessionCompletionSoundManager.enabledSoundId(for: "new-session", defaults: defaults)
        )
    }

    func testExplicitEnabledPreferencePersistsAcrossReloads() {
        let defaults = makeDefaults()
        SessionCompletionSoundManager.setSelectedSoundId(
            "ping",
            for: "existing-session",
            defaults: defaults
        )

        XCTAssertEqual(
            SessionCompletionSoundManager.selectedSoundId(for: "existing-session", defaults: defaults),
            "ping"
        )
        XCTAssertEqual(
            SessionCompletionSoundManager.enabledSoundId(for: "existing-session", defaults: defaults),
            "ping"
        )
    }

    func testExplicitEnabledPreferenceAllowsAnAgentReplyCompletionToPlay() {
        let defaults = makeDefaults()
        SessionCompletionSoundManager.setSelectedSoundId(
            "ping",
            for: "existing-session",
            defaults: defaults
        )
        var tracker = SessionCompletionSoundTransitionTracker()
        _ = tracker.completedSessionIDs(for: [snapshot(status: .running, sequence: 20)])

        let completedSessionIDs = tracker.completedSessionIDs(
            for: [snapshot(status: .complete, sequence: 21)]
        )
        let enabledSounds = completedSessionIDs.compactMap {
            SessionCompletionSoundManager.enabledSoundId(for: $0, defaults: defaults)
        }

        XCTAssertEqual(enabledSounds, ["ping"])
    }

    func testExplicitDefaultSoundIsPersistedInsteadOfBecomingAnUnsetPreference() {
        let defaults = makeDefaults()
        SessionCompletionSoundManager.setSelectedSoundId(
            SessionCompletionSoundManager.defaultSoundId,
            for: "existing-session",
            defaults: defaults
        )

        XCTAssertEqual(
            SessionCompletionSoundManager.selectedSoundId(for: "existing-session", defaults: defaults),
            SessionCompletionSoundManager.defaultSoundId
        )
    }

    func testExplicitOffPreferencePersistsAcrossReloads() {
        let defaults = makeDefaults()
        SessionCompletionSoundManager.setSelectedSoundId(
            SessionCompletionSoundManager.noneSoundId,
            for: "existing-session",
            defaults: defaults
        )

        XCTAssertEqual(
            SessionCompletionSoundManager.selectedSoundId(for: "existing-session", defaults: defaults),
            SessionCompletionSoundManager.noneSoundId
        )
        XCTAssertNil(
            SessionCompletionSoundManager.enabledSoundId(for: "existing-session", defaults: defaults)
        )
    }

    private func makeDefaults() -> UserDefaults {
        let suite = "SessionCompletionSoundPreferencesTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    private func snapshot(status: TaskStatus, sequence: Int) -> SessionNotificationSnapshot {
        SessionNotificationSnapshot(
            id: "existing-session",
            title: "Session",
            agent: "Agent",
            status: status,
            summary: "Summary",
            updatedAt: "2026-08-22T00:00:00Z",
            lastAgentMessageSequence: sequence
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
    func testDeliveredEventPersistsAcrossInstances() {
        let suite = "SessionNotificationDeliveryHistoryTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        var history = SessionNotificationDeliveryHistory(defaults: defaults)

        XCTAssertFalse(history.contains("event-one"))
        history.recordDelivered("event-one")
        XCTAssertTrue(history.contains("event-one"))

        let reloaded = SessionNotificationDeliveryHistory(defaults: defaults)
        XCTAssertTrue(reloaded.contains("event-one"))
        XCTAssertFalse(reloaded.contains("event-two"))
    }

    @MainActor
    func testCoordinatorRecordsOnlySuccessfulDeliveryAndRetriesAfterFailure() async {
        let suite = "SessionNotificationDeliveryCoordinatorTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        var attempts = 0
        let coordinator = SessionNotificationDeliveryCoordinator(defaults: defaults) { _ in
            attempts += 1
            if attempts == 1 {
                throw TestDeliveryError.rejected
            }
        }
        let event = SessionNotificationEvent(
            id: "all-sessions-waiting:v2:test",
            kind: .allSessionsWaiting,
            session: nil,
            counts: SessionNotificationCounts(completed: 1, blocked: 0, failed: 0, pendingUserAttention: 0)
        )

        let failedOutcome = await coordinator.deliver(event)
        XCTAssertEqual(failedOutcome, .failed("rejected"))
        XCTAssertFalse(coordinator.hasDelivered(event.id))
        let deliveredOutcome = await coordinator.deliver(event)
        XCTAssertEqual(deliveredOutcome, .delivered)
        XCTAssertTrue(coordinator.hasDelivered(event.id))
        let duplicateOutcome = await coordinator.deliver(event)
        XCTAssertEqual(duplicateOutcome, .skippedPreviouslyDelivered)
        XCTAssertEqual(attempts, 2)
    }
}

private enum TestDeliveryError: LocalizedError {
    case rejected

    var errorDescription: String? { "rejected" }
}
