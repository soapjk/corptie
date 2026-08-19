import XCTest
@testable import CorptieMac

@MainActor
final class SessionTimelineRepositoryTests: XCTestCase {
    func testSessionStatesAreStableAndReceiveOnlyTheirOwnTimeline() {
        let repository = SessionTimelineRepository()
        let stateA = repository.state(for: "a")
        let stateB = repository.state(for: "b")
        XCTAssertTrue(stateA === repository.state(for: "a"))

        repository.publish(detail(id: "a"), for: "a")

        XCTAssertEqual(stateA.detail?.id, "a")
        XCTAssertNil(stateB.detail)
    }

    func testPruneDropsRepositoryOwnershipOfClosedSessions() {
        let repository = SessionTimelineRepository()
        let oldState = repository.state(for: "old")
        repository.publish(detail(id: "old"), for: "old")
        repository.prune(to: ["current"])

        XCTAssertFalse(oldState === repository.state(for: "old"))
    }

    func testLRUEvictionNeverDropsPinnedWarmHosts() {
        let repository = SessionTimelineRepository(capacity: 2)
        let pinned = repository.state(for: "pinned")
        repository.pin(["pinned"])
        repository.publish(detail(id: "pinned"), for: "pinned")
        repository.publish(detail(id: "old"), for: "old")
        repository.publish(detail(id: "new"), for: "new")

        XCTAssertTrue(pinned === repository.state(for: "pinned"))
        XCTAssertNil(repository.detail(for: "old"))
        XCTAssertEqual(repository.detail(for: "new")?.id, "new")
    }

    func testSessionKeyDoesNotHaveToMatchProviderThreadID() {
        let repository = SessionTimelineRepository()
        let state = repository.state(for: "product-session")

        repository.publish(detail(id: "provider-thread"), for: "product-session")

        XCTAssertEqual(state.detail?.id, "provider-thread")
        XCTAssertEqual(repository.detail(for: "product-session")?.id, "provider-thread")
        XCTAssertNil(repository.detail(for: "provider-thread"))
    }

    private func detail(id: String) -> CodexThreadDetail {
        CodexThreadDetail(
            id: id,
            title: "Session \(id)",
            status: .complete,
            source: nil,
            connectionStatus: nil,
            currentModel: nil,
            currentReasoningLevel: nil,
            activityStatus: nil,
            cwd: "/tmp",
            createdAt: "2026-08-19T00:00:00Z",
            updatedAt: "2026-08-19T00:00:00Z",
            canSend: true,
            sendUnavailableReason: nil,
            capabilities: nil,
            turnCount: 0,
            items: []
        )
    }
}
