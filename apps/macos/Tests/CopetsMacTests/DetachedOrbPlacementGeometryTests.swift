import CoreGraphics
import XCTest
@testable import CorptieMac

final class DetachedOrbPlacementGeometryTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 0, width: 1_440, height: 900)
    private let orb = CGSize(width: 88, height: 88)

    func testFirstOrbStartsAtTopRightInsideVisibleFrame() {
        XCTAssertEqual(
            DetachedOrbPlacementGeometry.origin(
                visibleFrame: screen,
                windowSize: orb,
                occupiedFrames: []
            ),
            CGPoint(x: 1_336, y: 796)
        )
    }

    func testAdditionalOrbsStackDownwardWithoutOverlap() {
        let first = CGRect(x: 1_336, y: 796, width: 88, height: 88)
        let secondOrigin = DetachedOrbPlacementGeometry.origin(
            visibleFrame: screen,
            windowSize: orb,
            occupiedFrames: [first]
        )
        let second = CGRect(origin: secondOrigin, size: orb)

        XCTAssertEqual(secondOrigin, CGPoint(x: 1_336, y: 696))
        XCTAssertFalse(first.intersects(second))
    }

    func testPlacementSkipsAUserMovedOrbOccupyingALaterSlot() {
        let first = CGRect(x: 1_336, y: 796, width: 88, height: 88)
        let thirdSlot = CGRect(x: 1_336, y: 596, width: 88, height: 88)

        XCTAssertEqual(
            DetachedOrbPlacementGeometry.origin(
                visibleFrame: screen,
                windowSize: orb,
                occupiedFrames: [first, thirdSlot]
            ),
            CGPoint(x: 1_336, y: 696)
        )
    }

    func testPlacementMovesLeftAfterTheRightColumnIsFull() {
        let occupied = (0..<8).map { row in
            CGRect(x: 1_336, y: 796 - CGFloat(row) * 100, width: 88, height: 88)
        }

        XCTAssertEqual(
            DetachedOrbPlacementGeometry.origin(
                visibleFrame: screen,
                windowSize: orb,
                occupiedFrames: occupied
            ),
            CGPoint(x: 1_236, y: 796)
        )
    }

    func testPlacementUsesOffsetScreenCoordinates() {
        XCTAssertEqual(
            DetachedOrbPlacementGeometry.origin(
                visibleFrame: CGRect(x: -1_920, y: 120, width: 1_920, height: 1_080),
                windowSize: orb,
                occupiedFrames: []
            ),
            CGPoint(x: -104, y: 1_096)
        )
    }

    func testAutomaticPlacementNeverLeavesTheRightThird() {
        let occupied = (0..<31).map { index in
            let column = index / 8
            let row = index % 8
            return CGRect(
                x: 1_336 - CGFloat(column) * 100,
                y: 796 - CGFloat(row) * 100,
                width: 88,
                height: 88
            )
        }
        let origin = DetachedOrbPlacementGeometry.origin(
            visibleFrame: screen,
            windowSize: orb,
            occupiedFrames: occupied
        )

        XCTAssertTrue(
            DetachedOrbPlacementRegion.rightThird(of: screen)
                .contains(CGRect(origin: origin, size: orb))
        )
    }

    func testAutomaticAvoidanceAlwaysUsesTheRightThird() {
        XCTAssertEqual(
            DetachedOrbPlacementRegion.automaticPlacementFrame(in: screen),
            CGRect(x: 960, y: 0, width: 480, height: 900)
        )
    }
}
