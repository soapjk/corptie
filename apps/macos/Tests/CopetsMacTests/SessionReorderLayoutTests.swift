import CoreGraphics
import XCTest
@testable import CorptieMac

final class SessionReorderLayoutTests: XCTestCase {
    func testStableContainerGestureResolvesTheSessionAtMouseDown() {
        let frames = [
            "first": CGRect(x: 10, y: 20, width: 200, height: 80),
            "second": CGRect(x: 10, y: 110, width: 200, height: 80)
        ]

        XCTAssertEqual(
            SessionReorderLayout.sessionId(
                at: CGPoint(x: 100, y: 145),
                using: frames,
                eligibleIds: ["first", "second"]
            ),
            "second"
        )
        XCTAssertNil(
            SessionReorderLayout.sessionId(
                at: CGPoint(x: 100, y: 105),
                using: frames,
                eligibleIds: ["first", "second"]
            )
        )
    }

    func testDraggedPositionDependsOnlyOnInitialFrameAndStableMouseDelta() {
        XCTAssertEqual(
            SessionReorderLayout.draggedTopY(
                initialTopY: 20,
                mouseDeltaY: 185
            ),
            205
        )
        XCTAssertEqual(
            SessionReorderLayout.draggedCenterY(
                initialCenterY: 60,
                mouseDeltaY: 185
            ),
            245
        )
    }

    func testDraggedPositionDoesNotRebaseWhenSourceRowMoves() {
        let initialCenterY: CGFloat = 81
        let mouseDeltaY: CGFloat = 145

        XCTAssertEqual(
            SessionReorderLayout.draggedCenterY(
                initialCenterY: initialCenterY,
                mouseDeltaY: mouseDeltaY
            ),
            226
        )
    }

    func testTargetUsesVisualFrameOrderInsteadOfMutableModelOrder() {
        let frames = [
            "session-c": CGRect(x: 0, y: 220, width: 300, height: 80),
            "session-a": CGRect(x: 0, y: 20, width: 300, height: 80),
            "session-b": CGRect(x: 0, y: 120, width: 300, height: 80)
        ]

        XCTAssertEqual(
            SessionReorderLayout.insertionTargetSessionId(
                forDraggedCenterY: 155,
                excluding: "session-a",
                using: frames,
                eligibleIds: ["session-a", "session-b", "session-c"]
            ),
            "session-b"
        )
    }

    func testTargetIgnoresDraggedAndIneligibleSessions() {
        let frames = [
            "pinned": CGRect(x: 0, y: 20, width: 300, height: 80),
            "dragged": CGRect(x: 0, y: 120, width: 300, height: 80),
            "regular": CGRect(x: 0, y: 220, width: 300, height: 80)
        ]

        XCTAssertEqual(
            SessionReorderLayout.insertionTargetSessionId(
                forDraggedCenterY: 0,
                excluding: "dragged",
                using: frames,
                eligibleIds: ["dragged", "regular"]
            ),
            "regular"
        )
    }

    func testTargetIsNilAfterLastEligibleSession() {
        let frames = [
            "dragged": CGRect(x: 0, y: 20, width: 300, height: 80),
            "last": CGRect(x: 0, y: 120, width: 300, height: 80)
        ]

        XCTAssertNil(
            SessionReorderLayout.insertionTargetSessionId(
                forDraggedCenterY: 500,
                excluding: "dragged",
                using: frames,
                eligibleIds: ["dragged", "last"]
            )
        )
    }

    func testDraggedCenterTriggersMoveRegardlessOfGrabPoint() {
        let frames = [
            "dragged": CGRect(x: 0, y: 20, width: 300, height: 100),
            "next": CGRect(x: 0, y: 140, width: 300, height: 100),
            "last": CGRect(x: 0, y: 260, width: 300, height: 100)
        ]

        XCTAssertEqual(
            SessionReorderLayout.insertionTargetSessionId(
                forDraggedCenterY: 191,
                excluding: "dragged",
                using: frames,
                eligibleIds: ["dragged", "next", "last"]
            ),
            "last"
        )
    }
}
