import XCTest
@testable import CorptieMac

final class ProcessStateProjectionTests: XCTestCase {
    func testFailedCommandDoesNotOverrideRunningTurn() {
        XCTAssertEqual(
            projectedProcessState(for: [item(turnStatus: "inProgress", itemStatus: "failed")]),
            .running
        )
    }

    func testRecoveredCommandFailureDoesNotOverrideCompletedTurn() {
        XCTAssertEqual(
            projectedProcessState(for: [
                item(id: "failed-command", turnStatus: "completed", itemStatus: "failed"),
                item(id: "successful-command", turnStatus: "completed", itemStatus: "completed")
            ]),
            .completed
        )
    }

    func testTurnFailureStillMarksExecutionFailed() {
        XCTAssertEqual(
            projectedProcessState(for: [item(turnStatus: "failed", itemStatus: "completed")]),
            .failed
        )
    }

    func testLatestTurnLifecycleWinsDuringIncrementalUpdates() {
        XCTAssertEqual(
            projectedProcessState(for: [
                item(id: "earlier-error", turnStatus: "failed", itemStatus: "failed"),
                item(id: "retry", turnStatus: "inProgress", itemStatus: "inProgress")
            ]),
            .running
        )
    }

    func testInterruptedTurnIsStopped() {
        XCTAssertEqual(
            projectedProcessState(for: [item(turnStatus: "interrupted", itemStatus: nil)]),
            .cancelled
        )
    }

    private func item(
        id: String = "step",
        turnStatus: String,
        itemStatus: String?
    ) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: "turn",
            turnStatus: turnStatus,
            type: "commandExecution",
            title: "Command",
            text: "output",
            options: nil,
            status: itemStatus,
            createdAt: nil
        )
    }
}
