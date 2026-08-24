import XCTest
@testable import CorptieMac

final class SessionHistoryPageMergerTests: XCTestCase {
    func testRapidSessionSwitchRejectsOldAndABAHistoryResults() {
        XCTAssertFalse(BackendClient.historyPageRequestIsCurrent(
            sessionID: "session-a",
            expectedSelectionGeneration: 10,
            currentSessionID: "session-c",
            currentSelectionGeneration: 12
        ))
        XCTAssertFalse(BackendClient.historyPageRequestIsCurrent(
            sessionID: "session-a",
            expectedSelectionGeneration: 10,
            currentSessionID: "session-a",
            currentSelectionGeneration: 13
        ))
        XCTAssertTrue(BackendClient.historyPageRequestIsCurrent(
            sessionID: "session-a",
            expectedSelectionGeneration: 13,
            currentSessionID: "session-a",
            currentSelectionGeneration: 13
        ))
    }
    func testPrependsAUniquePageInProviderOrder() throws {
        let current = [item("current-1"), item("current-2")]
        let merged = try XCTUnwrap(SessionHistoryPageMerger.prepend(
            pageItems: [item("older-1"), item("older-2")],
            to: current,
            requestedBeforeID: "current-1"
        ))

        XCTAssertEqual(merged.map(\.id), ["older-1", "older-2", "current-1", "current-2"])
    }

    func testRepeatedResponseForAnAdvancedCursorIsIgnored() throws {
        let initial = [item("current-1"), item("current-2")]
        let page = [item("older-1"), item("older-2")]
        let first = try XCTUnwrap(SessionHistoryPageMerger.prepend(
            pageItems: page,
            to: initial,
            requestedBeforeID: "current-1"
        ))

        XCTAssertNil(SessionHistoryPageMerger.prepend(
            pageItems: page,
            to: first,
            requestedBeforeID: "current-1"
        ))
    }

    func testOverlappingAndInternallyDuplicatedItemsAreIdempotent() throws {
        let merged = try XCTUnwrap(SessionHistoryPageMerger.prepend(
            pageItems: [item("older"), item("older"), item("current-1")],
            to: [item("current-1"), item("current-2"), item("current-2")],
            requestedBeforeID: "current-1"
        ))

        XCTAssertEqual(merged.map(\.id), ["older", "current-1", "current-2"])
    }

    func testAnchorWindowMergesBeforeCachedTailAndRemovesOverlap() {
        let merged = SessionHistoryPageMerger.mergeAnchorWindow(
            [item("anchor"), item("overlap")],
            with: [item("overlap"), item("latest")]
        )

        XCTAssertEqual(merged.map(\.id), ["anchor", "overlap", "latest"])
    }

    private func item(_ id: String) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: "turn:\(id)",
            turnStatus: "complete",
            type: "agentMessage",
            title: "Agent",
            text: id,
            options: nil,
            status: nil,
            createdAt: "2026-08-19T00:00:00Z"
        )
    }
}
