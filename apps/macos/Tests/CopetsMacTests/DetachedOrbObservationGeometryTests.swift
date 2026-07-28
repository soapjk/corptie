import CoreGraphics
import XCTest
@testable import CorptieMac

final class DetachedOrbObservationGeometryTests: XCTestCase {
    func testSearchRectExpandsAroundOrbAndClipsToVisibleFrame() {
        XCTAssertEqual(
            DetachedOrbObservationGeometry.searchRect(
                around: CGRect(x: 1_336, y: 796, width: 88, height: 88),
                visibleFrame: CGRect(x: 0, y: 0, width: 1_440, height: 900)
            ),
            CGRect(x: 1_156, y: 616, width: 284, height: 284)
        )
    }

    func testPrimaryDisplayTopRightConvertsFromAppKitToTopLeftSourceCoordinates() {
        XCTAssertEqual(
            DetachedOrbObservationGeometry.sourceRect(
                for: CGRect(x: 1_336, y: 796, width: 88, height: 88),
                in: CGRect(x: 0, y: 0, width: 1_440, height: 900)
            ),
            CGRect(x: 1_336, y: 16, width: 88, height: 88)
        )
    }

    func testOffsetDisplayUsesDisplayLocalCoordinates() {
        XCTAssertEqual(
            DetachedOrbObservationGeometry.sourceRect(
                for: CGRect(x: -104, y: 1_096, width: 88, height: 88),
                in: CGRect(x: -1_920, y: 120, width: 1_920, height: 1_080)
            ),
            CGRect(x: 1_816, y: 16, width: 88, height: 88)
        )
    }

    func testSourceRectClipsAtDisplayBoundaryBeforeConvertingCoordinates() {
        XCTAssertEqual(
            DetachedOrbObservationGeometry.sourceRect(
                for: CGRect(x: -20, y: -10, width: 100, height: 100),
                in: CGRect(x: 0, y: 0, width: 1_440, height: 900)
            ),
            CGRect(x: 0, y: 810, width: 80, height: 90)
        )
    }

    func testNonIntersectingRectReturnsNil() {
        XCTAssertNil(
            DetachedOrbObservationGeometry.sourceRect(
                for: CGRect(x: 2_000, y: 2_000, width: 88, height: 88),
                in: CGRect(x: 0, y: 0, width: 1_440, height: 900)
            )
        )
    }
}
