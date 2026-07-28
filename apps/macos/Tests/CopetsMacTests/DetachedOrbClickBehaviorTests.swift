import XCTest
@testable import CorptieMac

final class DetachedOrbClickBehaviorTests: XCTestCase {
    func testSingleClickImmediatelyPerformsThePrimaryQuickReplyAction() {
        XCTAssertEqual(
            DetachedOrbClickBehavior.action(clickCount: 1, didDrag: false),
            .primary
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
