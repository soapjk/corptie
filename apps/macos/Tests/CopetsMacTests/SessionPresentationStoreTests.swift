import Combine
import XCTest
@testable import CorptieMac

@MainActor
final class SessionPresentationCacheTests: XCTestCase {
    func testCachedTimelineWinsOverTransportLoadingForTheFirstFrame() {
        XCTAssertEqual(
            sessionDetailContentPhase(
                hasLiveDetail: false,
                cachedSessionID: "session-a",
                selectedSessionID: "session-a",
                isLoading: true,
                hasError: false
            ),
            .cached
        )
        XCTAssertEqual(
            sessionDetailContentPhase(
                hasLiveDetail: true,
                cachedSessionID: "session-a",
                selectedSessionID: "session-a",
                isLoading: true,
                hasError: false
            ),
            .live
        )
    }

    func testDefaultProjectionCacheRetainsNormalSessionBrowsingSet() {
        let store = SessionPresentationCache()
        for index in 0..<32 {
            store.store(cache(sessionID: "session-\(index)"))
        }

        XCTAssertNotNil(store.cache(for: "session-0"))
        XCTAssertNotNil(store.cache(for: "session-31"))
    }

    func testProjectionCanRunOffMainActorAndStorePublishesOnlyMeaningfulChanges() async {
        let fixture = ChatPerformanceFixture.make(configuration: .init(
            turnCount: 12,
            rawItemCount: 240,
            longMessageCharacters: 200
        ))
        let cache = await Task.detached(priority: .userInitiated) {
            makeDetailDisplayCache(
                for: fixture.detail,
                sessionId: fixture.session.id,
                visibleMessageLimit: 7
            )
        }.value

        let store = SessionPresentationCache()
        XCTAssertEqual(store.cacheRevision, 0)
        store.store(cache)
        XCTAssertEqual(store.cacheRevision, 1)
        XCTAssertEqual(store.cache(for: fixture.session.id)?.displayEntries.count, 7)

        store.store(cache)
        XCTAssertEqual(store.cacheRevision, 1, "An identical projection must not invalidate the Session surface")
    }

    func testViewportPersistsAcrossControllerRecreation() throws {
        let suiteName = "SessionPresentationCacheTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let position = AppKitChatTimelinePosition(
            rowID: "message:persisted-42",
            offset: 7,
            absoluteScrollY: 912,
            followsLatest: false
        )

        let writer = SessionViewportController(
            defaults: defaults,
            defaultsKey: "positions"
        )
        writer.store(position, for: "session-a")
        writer.persistNow()

        let reader = SessionViewportController(
            defaults: defaults,
            defaultsKey: "positions"
        )
        XCTAssertEqual(reader.position(for: "session-a"), position)
    }

    func testTerminationPhaseSynchronouslyPersistsFinalCompatibilityPosition() throws {
        let suiteName = "SessionPresentationCacheTests.termination.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let position = AppKitChatTimelinePosition(
            rowID: "message:final",
            offset: 9,
            absoluteScrollY: 999,
            followsLatest: false
        )
        let writer = SessionViewportController(
            defaults: defaults,
            defaultsKey: "termination"
        )
        writer.store(position, for: "session-final")

        NotificationCenter.default.post(name: .persistSessionTimelinePositions, object: nil)

        let reader = SessionViewportController(
            defaults: defaults,
            defaultsKey: "termination"
        )
        XCTAssertEqual(reader.position(for: "session-final"), position)
    }

    func testPersistedViewportLRUIsBounded() throws {
        let suiteName = "SessionPresentationCacheTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let store = SessionViewportController(
            hotCapacity: 2,
            defaults: defaults,
            defaultsKey: "bounded"
        )
        for id in ["a", "b", "c"] {
            store.store(.init(rowID: "message:\(id)", offset: 0, absoluteScrollY: 0, followsLatest: false), for: id)
        }
        store.persistNow()

        let restored = SessionViewportController(
            hotCapacity: 2,
            defaults: defaults,
            defaultsKey: "bounded"
        )
        XCTAssertNil(restored.position(for: "a"))
        XCTAssertNotNil(restored.position(for: "b"))
        XCTAssertNotNil(restored.position(for: "c"))
    }

    func testGestureViewportStoresDoNotInvalidateSwiftUITree() {
        let controller = SessionViewportController(defaults: nil, repository: nil)
        var invalidations = 0
        let cancellable = controller.objectWillChange.sink { invalidations += 1 }

        for index in 0..<1_000 {
            controller.store(
                .init(
                    rowID: "message:\(index)",
                    offset: Double(index % 11),
                    absoluteScrollY: Double(index),
                    followsLatest: false
                ),
                for: "session-a"
            )
        }

        XCTAssertEqual(invalidations, 0)
        withExtendedLifetime(cancellable) {}
    }

    func testSelectionSupplementaryAndCommandInvalidationsAreIndependent() {
        let selection = SessionSelectionController()
        let supplementary = SessionSupplementaryDataController()
        let commands = SessionCommandController()
        var selectionInvalidations = 0
        var supplementaryInvalidations = 0
        var commandInvalidations = 0
        var cancellables = Set<AnyCancellable>()
        selection.objectWillChange.sink { selectionInvalidations += 1 }.store(in: &cancellables)
        supplementary.objectWillChange.sink { supplementaryInvalidations += 1 }.store(in: &cancellables)
        commands.objectWillChange.sink { commandInvalidations += 1 }.store(in: &cancellables)

        selection.select("session-a")
        supplementary.select("session-a")
        supplementary.update("session-a") { $0.isLoading = true }
        commands.begin(sessionID: "session-a", command: "send")

        XCTAssertEqual(selectionInvalidations, 1)
        XCTAssertEqual(supplementaryInvalidations, 2)
        XCTAssertEqual(commandInvalidations, 1)
    }

    func testConcreteSupplementaryAndCommandUpdatesDoNotInvalidateIndexOrTimeline() {
        let index = SessionIndexStore()
        let timeline = SessionTimelineState(sessionID: "session-a")
        let supplementary = SessionSupplementaryDataController()
        let commands = SessionCommandController()
        var indexInvalidations = 0
        var timelineInvalidations = 0
        var supplementaryInvalidations = 0
        var commandInvalidations = 0
        var cancellables = Set<AnyCancellable>()
        index.objectWillChange.sink { indexInvalidations += 1 }.store(in: &cancellables)
        timeline.objectWillChange.sink { timelineInvalidations += 1 }.store(in: &cancellables)
        supplementary.objectWillChange.sink { supplementaryInvalidations += 1 }.store(in: &cancellables)
        commands.objectWillChange.sink { commandInvalidations += 1 }.store(in: &cancellables)

        supplementary.isLoadingContextReferences = true
        supplementary.isLoadingProjectWorktrees = true
        supplementary.isLoadingScheduledTasks = true
        commands.isSendingMessage = true
        commands.scheduledTaskMutationIds.insert("task-a")

        XCTAssertEqual(indexInvalidations, 0)
        XCTAssertEqual(timelineInvalidations, 0)
        XCTAssertEqual(supplementaryInvalidations, 3)
        XCTAssertEqual(commandInvalidations, 2)
    }

    func testProjectionCacheUsesBoundedLRUEviction() {
        let store = SessionPresentationCache(capacity: 2)
        store.store(cache(sessionID: "a"))
        store.store(cache(sessionID: "b"))
        _ = store.cache(for: "a")
        store.store(cache(sessionID: "c"))

        XCTAssertNotNil(store.cache(for: "a"))
        XCTAssertNil(store.cache(for: "b"))
        XCTAssertNotNil(store.cache(for: "c"))
    }

    func testEveryActivePresentationRemainsResidentWhileArchivedEntriesEvict() {
        let store = SessionPresentationCache(capacity: 2)
        store.pin(["active-a", "active-b", "active-c"])
        for id in ["active-a", "active-b", "active-c"] {
            store.store(cache(sessionID: id))
        }

        XCTAssertNotNil(store.cache(for: "active-a"))
        XCTAssertNotNil(store.cache(for: "active-b"))
        XCTAssertNotNil(store.cache(for: "active-c"))

        store.pin(["active-c"])
        store.store(cache(sessionID: "archived-on-demand"))
        XCTAssertNil(store.cache(for: "active-a"))
        XCTAssertNil(store.cache(for: "active-b"))
        XCTAssertNotNil(store.cache(for: "active-c"))
        XCTAssertNotNil(store.cache(for: "archived-on-demand"))
    }

    func testProjectionPublicationInvalidatesOnlyItsSessionState() {
        let store = SessionPresentationCache()
        let stateA = store.state(for: "a")
        let stateB = store.state(for: "b")
        var storeInvalidations = 0
        var stateAInvalidations = 0
        var stateBInvalidations = 0
        var cancellables = Set<AnyCancellable>()
        store.objectWillChange.sink { storeInvalidations += 1 }.store(in: &cancellables)
        stateA.objectWillChange.sink { stateAInvalidations += 1 }.store(in: &cancellables)
        stateB.objectWillChange.sink { stateBInvalidations += 1 }.store(in: &cancellables)

        store.store(cache(sessionID: "a"))

        XCTAssertEqual(storeInvalidations, 0)
        XCTAssertEqual(stateAInvalidations, 1)
        XCTAssertEqual(stateBInvalidations, 0)
        XCTAssertEqual(stateA.cache?.sessionId, "a")
    }

    func testABAProjectionCannotCommitAnOlderGeneration() {
        let oldA = SessionDisplayProjectionRequest(
            sessionID: "a",
            sourceSignature: "revision-a",
            generation: 1
        )
        let latestA = SessionDisplayProjectionRequest(
            sessionID: "a",
            sourceSignature: "revision-a",
            generation: 3
        )

        XCTAssertFalse(oldA.isCurrent(
            sessionID: "a",
            sourceSignature: "revision-a",
            generation: 3,
            isCancelled: false
        ))
        XCTAssertTrue(latestA.isCurrent(
            sessionID: "a",
            sourceSignature: "revision-a",
            generation: 3,
            isCancelled: false
        ))
        XCTAssertFalse(latestA.isCurrent(
            sessionID: "a",
            sourceSignature: "revision-a",
            generation: 3,
            isCancelled: true
        ))
    }

    private func cache(sessionID: String) -> DetailDisplayCache {
        DetailDisplayCache(
            sessionId: sessionID,
            displayItems: [],
            displayEntries: [],
            totalDisplayEntryCount: 0,
            visibleMessageLimit: 7,
            signature: sessionID,
            sourceSignature: sessionID
        )
    }
}
