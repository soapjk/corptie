import XCTest
@testable import CorptieMac

final class DetachedOrbObservationCadenceTests: XCTestCase {
    func testStableSafePositionGraduallyBacksOffToSixSeconds() {
        var cadence = DetachedOrbObservationCadence()

        XCTAssertEqual(cadence.nextDelay(after: .currentPositionIsSafe), 2)
        XCTAssertEqual(cadence.nextDelay(after: .currentPositionIsSafe), 4)
        XCTAssertEqual(cadence.nextDelay(after: .currentPositionIsSafe), 6)
        XCTAssertEqual(cadence.nextDelay(after: .currentPositionIsSafe), 6)
    }

    func testRiskyOrUncertainResultRestoresActiveCadence() {
        var cadence = DetachedOrbObservationCadence()
        _ = cadence.nextDelay(after: .currentPositionIsSafe)
        _ = cadence.nextDelay(after: .currentPositionIsSafe)

        XCTAssertEqual(cadence.nextDelay(after: .noSafeCandidate), 2)
        XCTAssertEqual(cadence.nextDelay(after: .currentPositionIsSafe), 2)
    }

    func testCandidateConfirmationRemainsFast() {
        var cadence = DetachedOrbObservationCadence()

        XCTAssertEqual(cadence.nextDelay(after: .awaitingConfirmation), 0.65)
    }

    func testResetRestoresInitialSafeInterval() {
        var cadence = DetachedOrbObservationCadence()
        _ = cadence.nextDelay(after: .currentPositionIsSafe)
        _ = cadence.nextDelay(after: .currentPositionIsSafe)
        cadence.reset()

        XCTAssertEqual(cadence.nextDelay(after: .currentPositionIsSafe), 2)
    }
}
