import XCTest
@testable import CorptieMac

@MainActor
final class SessionPresentationStoreTests: XCTestCase {
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

        let store = SessionPresentationStore()
        XCTAssertEqual(store.cacheRevision, 0)
        store.store(cache)
        XCTAssertEqual(store.cacheRevision, 1)
        XCTAssertEqual(store.cache(for: fixture.session.id)?.displayEntries.count, 7)

        store.store(cache)
        XCTAssertEqual(store.cacheRevision, 1, "An identical projection must not invalidate the Session surface")
    }

    func testViewportAndProjectionShareSessionScopedLifetime() {
        let store = SessionPresentationStore()
        let position = AppKitChatTimelinePosition(
            rowID: "message-42",
            offset: 8,
            absoluteScrollY: 420,
            followsLatest: false
        )
        store.store(position, for: "session-a")

        XCTAssertEqual(store.position(for: "session-a"), position)
        store.prune(to: ["session-b"])
        XCTAssertNil(store.position(for: "session-a"))
        XCTAssertNil(store.cache(for: "session-a"))
    }

    func testProjectionCacheUsesBoundedLRUEviction() {
        let store = SessionPresentationStore(cacheCapacity: 2)
        store.store(cache(sessionID: "a"))
        store.store(cache(sessionID: "b"))
        _ = store.cache(for: "a")
        store.store(cache(sessionID: "c"))

        XCTAssertNotNil(store.cache(for: "a"))
        XCTAssertNil(store.cache(for: "b"))
        XCTAssertNotNil(store.cache(for: "c"))
    }

    func testCompleteHostPoolKeepsRecentSessionsInLRUOrder() {
        let store = SessionPresentationStore(hostCapacity: 3)
        store.activateHost(for: "a")
        store.activateHost(for: "b")
        store.activateHost(for: "c")
        store.activateHost(for: "a")
        store.activateHost(for: "d")

        XCTAssertEqual(store.hostedSessionIDs, ["c", "a", "d"])
        store.prune(to: ["a", "d"])
        XCTAssertEqual(store.hostedSessionIDs, ["a", "d"])
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
