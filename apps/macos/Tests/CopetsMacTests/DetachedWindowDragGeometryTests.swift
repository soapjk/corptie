import CoreGraphics
import XCTest
@testable import CorptieMac

final class DetachedWindowDragGeometryTests: XCTestCase {
    func testWindowOriginTracksTheScreenMouseDelta() {
        XCTAssertEqual(
            DetachedWindowDragGeometry.windowOrigin(
                initialWindowOrigin: CGPoint(x: 100, y: 200),
                initialMouseScreenPoint: CGPoint(x: 150, y: 250),
                currentMouseScreenPoint: CGPoint(x: 175, y: 220)
            ),
            CGPoint(x: 125, y: 170)
        )
    }

    func testSuccessiveUpdatesNeverAccumulateThePreviousWindowOrigin() {
        let initialOrigin = CGPoint(x: 100, y: 200)
        let initialMouse = CGPoint(x: 150, y: 250)

        XCTAssertEqual(
            DetachedWindowDragGeometry.windowOrigin(
                initialWindowOrigin: initialOrigin,
                initialMouseScreenPoint: initialMouse,
                currentMouseScreenPoint: CGPoint(x: 160, y: 260)
            ),
            CGPoint(x: 110, y: 210)
        )
        XCTAssertEqual(
            DetachedWindowDragGeometry.windowOrigin(
                initialWindowOrigin: initialOrigin,
                initialMouseScreenPoint: initialMouse,
                currentMouseScreenPoint: CGPoint(x: 170, y: 270)
            ),
            CGPoint(x: 120, y: 220)
        )
    }
}
