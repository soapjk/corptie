import XCTest
@testable import CorptieMac

final class DetachedSessionCloseBehaviorTests: XCTestCase {
    func testRunningSessionCreatesAnOrbWhenNoneExists() {
        XCTAssertTrue(
            DetachedSessionCloseBehavior.shouldCreateOrb(
                status: .running,
                isAlreadyFloating: false
            )
        )
    }

    func testExistingOrbIsNeverTouchedWhenClosingTheMainWindow() {
        XCTAssertFalse(
            DetachedSessionCloseBehavior.shouldCreateOrb(
                status: .running,
                isAlreadyFloating: true
            )
        )
    }

    func testNonRunningSessionsDoNotCreateAnOrb() {
        for status in [TaskStatus.blocked, .complete, .failed, .cancelled] {
            XCTAssertFalse(
                DetachedSessionCloseBehavior.shouldCreateOrb(
                    status: status,
                    isAlreadyFloating: false
                ),
                "Unexpected orb for \(status)"
            )
        }
    }
}
