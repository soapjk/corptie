import XCTest
@testable import CorptieMac

final class DetachedSessionReplacementLogicTests: XCTestCase {
    func testRebindsFloatingSessionWhenClearCreatesReplacementId() {
        XCTAssertTrue(DetachedSessionReplacementLogic.shouldRebind(
            previousSessionId: "codex:old",
            replacementSessionId: "codex:new",
            floatingSessionIds: ["codex:old", "codex:other"]
        ))
    }

    func testIgnoresReplacementWhenPreviousSessionIsNotFloating() {
        XCTAssertFalse(DetachedSessionReplacementLogic.shouldRebind(
            previousSessionId: "codex:old",
            replacementSessionId: "codex:new",
            floatingSessionIds: ["codex:other"]
        ))
    }

    func testIgnoresNoOpReplacementWithSameSessionId() {
        XCTAssertFalse(DetachedSessionReplacementLogic.shouldRebind(
            previousSessionId: "codex:same",
            replacementSessionId: "codex:same",
            floatingSessionIds: ["codex:same"]
        ))
    }
}
