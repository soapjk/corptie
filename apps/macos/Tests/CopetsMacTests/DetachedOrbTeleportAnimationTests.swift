import XCTest
@testable import CorptieMac

final class DetachedOrbTeleportAnimationTests: XCTestCase {
    func testStandardAnimationUsesCollapseAndGentleOvershoot() {
        let animation = DetachedOrbTeleportAnimation.configuration(reduceMotion: false)

        XCTAssertEqual(animation.disappearDuration, 0.12)
        XCTAssertEqual(animation.appearDuration, 0.13)
        XCTAssertEqual(animation.settleDuration, 0.05)
        XCTAssertEqual(animation.collapsedScale, 0.78)
        XCTAssertEqual(animation.overshootScale, 1.04)
        XCTAssertEqual(animation.totalDuration, 0.30, accuracy: 0.000_1)
    }

    func testReducedMotionUsesOnlyShortCrossFade() {
        let animation = DetachedOrbTeleportAnimation.configuration(reduceMotion: true)

        XCTAssertEqual(animation.disappearDuration, 0.08)
        XCTAssertEqual(animation.appearDuration, 0.08)
        XCTAssertEqual(animation.settleDuration, 0)
        XCTAssertEqual(animation.collapsedScale, 1)
        XCTAssertEqual(animation.overshootScale, 1)
        XCTAssertEqual(animation.totalDuration, 0.16, accuracy: 0.000_1)
    }
}
