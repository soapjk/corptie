import XCTest
@testable import CorptieMac

final class DetachedOrbBatchCoordinatorLogicTests: XCTestCase {
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
}
