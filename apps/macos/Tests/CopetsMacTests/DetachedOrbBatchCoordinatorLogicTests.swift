import XCTest
@testable import CorptieMac

final class DetachedOrbBatchCoordinatorLogicTests: XCTestCase {
    func testCadenceBacksOffOnlyAfterThreeStableBatches() {
        var cadence = DetachedOrbObservationCadence()

        XCTAssertEqual(cadence.nextInterval(after: .stable), 2)
        XCTAssertEqual(cadence.nextInterval(after: .stable), 2)
        XCTAssertEqual(cadence.nextInterval(after: .stable), 5)
        XCTAssertEqual(cadence.nextInterval(after: .stable), 5)
        XCTAssertEqual(cadence.nextInterval(after: .active), 2)
        XCTAssertEqual(cadence.nextInterval(after: .stable), 2)
    }

    func testCadenceExponentiallyBacksOffCaptureFailures() {
        var cadence = DetachedOrbObservationCadence()

        XCTAssertEqual(cadence.nextInterval(after: .captureFailure), 5)
        XCTAssertEqual(cadence.nextInterval(after: .captureFailure), 10)
        XCTAssertEqual(cadence.nextInterval(after: .captureFailure), 20)
        XCTAssertEqual(cadence.nextInterval(after: .captureFailure), 20)
        XCTAssertEqual(cadence.nextInterval(after: .active), 2)
        XCTAssertEqual(cadence.nextInterval(after: .captureFailure), 5)
    }

    func testEveryOrbAppearsOnceInRiskPriorityOrder() {
        let priorities = [
            DetachedOrbBatchPriority(identifier: "orb-b", currentRisk: 0.7),
            DetachedOrbBatchPriority(identifier: "orb-c", currentRisk: 0.2),
            DetachedOrbBatchPriority(identifier: "orb-a", currentRisk: 0.7)
        ]

        XCTAssertEqual(
            DetachedOrbBatchCoordinatorLogic.orderedIdentifiers(priorities),
            ["orb-a", "orb-b", "orb-c"]
        )
    }

    func testBatchDurationIsDeductedFromFiveSecondInterval() {
        XCTAssertEqual(
            DetachedOrbBatchCoordinatorLogic.nextDelay(
                interval: 5,
                batchDuration: 1.25
            ),
            3.75
        )
        XCTAssertEqual(
            DetachedOrbBatchCoordinatorLogic.nextDelay(
                interval: 5,
                batchDuration: 7
            ),
            0
        )
    }

    func testSharedCapturePreservesIndividualSamplingDensityWithinCap() {
        let individual = [
            CGRect(x: 0, y: 0, width: 800, height: 600),
            CGRect(x: 800, y: 0, width: 800, height: 600)
        ]

        XCTAssertEqual(
            DetachedOrbBatchCoordinatorLogic.sharedCaptureMaximumDimension(
                sharedSampleRect: CGRect(x: 0, y: 0, width: 1_600, height: 600),
                individualSampleRects: individual
            ),
            768
        )
        XCTAssertEqual(
            DetachedOrbBatchCoordinatorLogic.sharedCaptureMaximumDimension(
                sharedSampleRect: CGRect(x: 0, y: 0, width: 3_840, height: 2_160),
                individualSampleRects: individual
            ),
            1_024
        )
    }

    func testBatchCommitsOnlyWhenEveryRequestedOrbHasAnEvaluation() {
        XCTAssertTrue(
            DetachedOrbBatchCoordinatorLogic.canCommitBatch(
                evaluatedCount: 3,
                expectedCount: 3,
                hasIncompleteEvaluation: false
            )
        )
        XCTAssertFalse(
            DetachedOrbBatchCoordinatorLogic.canCommitBatch(
                evaluatedCount: 2,
                expectedCount: 3,
                hasIncompleteEvaluation: true
            )
        )
        XCTAssertFalse(
            DetachedOrbBatchCoordinatorLogic.canCommitBatch(
                evaluatedCount: 0,
                expectedCount: 0,
                hasIncompleteEvaluation: false
            )
        )
    }
}
