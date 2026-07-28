import CoreGraphics
import XCTest
@testable import CorptieMac

final class OrbSafeRegionHistoryTests: XCTestCase {
    func testFirstScreenshotCreatesTrackedRectanglesWithOneObservation() {
        let frames = (0..<3).map {
            CGRect(x: CGFloat($0 * 100), y: 100, width: 72, height: 72)
        }
        var history = OrbSafeRegionHistory()

        history.record(frames: frames)

        XCTAssertEqual(history.regions.map(\.frame), frames)
        XCTAssertEqual(history.regions.map(\.overlapCount), [1, 1, 1])
    }

    func testNewScreenshotStoresIntersectionAndIncrementsOverlapCount() {
        let first = CGRect(x: 100, y: 100, width: 72, height: 72)
        let second = CGRect(x: 112, y: 108, width: 72, height: 72)
        var history = OrbSafeRegionHistory()

        history.record(frames: [first])
        history.record(frames: [second])

        XCTAssertEqual(history.regions.count, 1)
        XCTAssertEqual(history.regions.first?.frame, first.intersection(second))
        XCTAssertEqual(history.regions.first?.overlapCount, 2)
    }

    func testEveryScreenshotIntersectsTheExistingTrackAgain() {
        let first = CGRect(x: 100, y: 100, width: 72, height: 72)
        let second = CGRect(x: 108, y: 104, width: 72, height: 72)
        let third = CGRect(x: 112, y: 110, width: 72, height: 72)
        var history = OrbSafeRegionHistory()

        history.record(frames: [first])
        history.record(frames: [second])
        history.record(frames: [third])

        XCTAssertEqual(history.regions.count, 1)
        XCTAssertEqual(
            history.regions.first?.frame,
            first.intersection(second).intersection(third)
        )
        XCTAssertEqual(history.regions.first?.overlapCount, 3)
    }

    func testNonOverlappingLatestRegionStartsANewTrack() {
        let old = CGRect(x: 100, y: 100, width: 72, height: 72)
        let latest = CGRect(x: 500, y: 500, width: 72, height: 72)
        var history = OrbSafeRegionHistory()

        history.record(frames: [old])
        history.record(frames: [latest])

        XCTAssertEqual(history.regions.count, 1)
        XCTAssertEqual(history.regions.first?.frame, latest)
        XCTAssertEqual(history.regions.first?.overlapCount, 1)
    }

    func testOnlyTenHighestCountRectanglesAreRetained() {
        let frames = (0..<14).map {
            CGRect(x: CGFloat($0 * 80), y: 100, width: 72, height: 72)
        }
        var history = OrbSafeRegionHistory()

        history.record(frames: frames)

        XCTAssertEqual(history.regions.count, 10)
        XCTAssertEqual(history.regions.map(\.frame), Array(frames.prefix(10)))
    }

    func testMatchReturnsHighestOverlapCountThenCoverage() {
        let stable = CGRect(x: 100, y: 100, width: 72, height: 72)
        let shifted = CGRect(x: 112, y: 100, width: 72, height: 72)
        var history = OrbSafeRegionHistory()
        history.record(frames: [stable])
        history.record(frames: [shifted])

        let match = history.match(for: shifted)

        XCTAssertEqual(match.overlapCount, 2)
        XCTAssertEqual(match.coverage, 60.0 / 72.0, accuracy: 0.001)
    }

    func testEmptyScreenshotClearsTrackedRegions() {
        var history = OrbSafeRegionHistory()
        history.record(frames: [CGRect(x: 100, y: 100, width: 72, height: 72)])

        history.record(frames: [])

        XCTAssertTrue(history.regions.isEmpty)
    }
}
