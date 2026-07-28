import CoreGraphics
import XCTest
@testable import CorptieMac

final class DetachedOrbInteractionRecoveryTests: XCTestCase {
    private let frame = CGRect(x: 100, y: 100, width: 88, height: 88)

    func testLostMouseUpClearsStalePointerDownState() {
        XCTAssertEqual(
            DetachedOrbInteractionRecovery.reconcile(
                reportedPointerDown: true,
                reportedPointerHovering: false,
                pressedMouseButtons: 0,
                mouseLocation: CGPoint(x: 20, y: 20),
                windowFrame: frame
            ),
            DetachedOrbPointerInteractionState(
                isPointerDown: false,
                isPointerHovering: false
            )
        )
    }

    func testMissingMouseExitClearsHoverWhenPointerIsOutsideWindow() {
        XCTAssertEqual(
            DetachedOrbInteractionRecovery.reconcile(
                reportedPointerDown: false,
                reportedPointerHovering: true,
                pressedMouseButtons: 0,
                mouseLocation: CGPoint(x: 20, y: 20),
                windowFrame: frame
            ),
            DetachedOrbPointerInteractionState(
                isPointerDown: false,
                isPointerHovering: false
            )
        )
    }

    func testRealInteractionRemainsFrozen() {
        XCTAssertEqual(
            DetachedOrbInteractionRecovery.reconcile(
                reportedPointerDown: true,
                reportedPointerHovering: true,
                pressedMouseButtons: 1,
                mouseLocation: CGPoint(x: 140, y: 140),
                windowFrame: frame
            ),
            DetachedOrbPointerInteractionState(
                isPointerDown: true,
                isPointerHovering: true
            )
        )
    }
}
