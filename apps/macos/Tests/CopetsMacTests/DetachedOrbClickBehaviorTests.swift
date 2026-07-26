import XCTest
@testable import CorptieMac

final class DetachedOrbClickBehaviorTests: XCTestCase {
    func testSingleClickSchedulesThePrimaryQuickReplyAction() {
        XCTAssertEqual(
            DetachedOrbClickBehavior.action(clickCount: 1, didDrag: false),
            .schedulePrimary
        )
    }

    func testDoubleClickOpensTheSession() {
        XCTAssertEqual(
            DetachedOrbClickBehavior.action(clickCount: 2, didDrag: false),
            .openSession
        )
    }

    func testDraggingNeverTriggersAClickAction() {
        XCTAssertEqual(
            DetachedOrbClickBehavior.action(clickCount: 1, didDrag: true),
            .none
        )
        XCTAssertEqual(
            DetachedOrbClickBehavior.action(clickCount: 2, didDrag: true),
            .none
        )
    }
}
