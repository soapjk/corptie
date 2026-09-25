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

    func testOverlappingHistoryAndAnchorWindowsNeverRollBackAPlanRevision() throws {
        let older = try planItem(revision: 1)
        let newer = try planItem(revision: 2)
        let prepended = try XCTUnwrap(SessionHistoryPageMerger.prepend(
            pageItems: [item("older"), older],
            to: [newer, item("latest")],
            requestedBeforeID: newer.id
        ))
        XCTAssertEqual(prepended.map(\.id), ["older", newer.id, "latest"])
        XCTAssertEqual(prepended[1].executionPlan?.revision, 2)

        let anchored = SessionHistoryPageMerger.mergeAnchorWindow(
            [item("anchor"), older], with: [newer, item("latest")]
        )
        XCTAssertEqual(anchored.map(\.id), ["anchor", newer.id, "latest"])
        XCTAssertEqual(anchored[1].executionPlan?.revision, 2)

        let newerPage = try XCTUnwrap(SessionHistoryPageMerger.prepend(
            pageItems: [item("older"), newer],
            to: [older, item("latest")],
            requestedBeforeID: older.id
        ))
        XCTAssertEqual(newerPage[1].executionPlan?.revision, 2)
    }

    private func planItem(revision: Int) throws -> CodexThreadItem {
        let source: [String: Any] = [
            "id": "plan:one", "turnId": "turn:plan", "turnStatus": "inProgress",
            "type": "executionPlan", "title": "Execution plan", "text": "Plan update",
            "executionPlan": [
                "schemaVersion": 1, "planId": "plan:one", "revision": revision,
                "lifecycle": "active", "updatedAt": "2026-09-24T00:00:00Z",
                "steps": [["stepId": "step:one", "ordinal": 0,
                           "text": "Inspect", "status": revision == 1 ? "pending" : "completed"]]
            ]
        ]
        return try JSONDecoder().decode(CodexThreadItem.self,
            from: JSONSerialization.data(withJSONObject: source))
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
