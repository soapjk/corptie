import CoreGraphics
import XCTest
@testable import CorptieMac

final class OrbSafeRegionHistoryTests: XCTestCase {
    func testRepeatedSafeRectangleBuildsMaximumPersistence() {
        let frame = CGRect(x: 100, y: 100, width: 72, height: 72)
        var history = OrbSafeRegionHistory()
        let now = Date()

        history.record(frames: [frame], at: now.addingTimeInterval(-4))
        history.record(frames: [frame], at: now.addingTimeInterval(-2))
        history.record(frames: [frame], at: now)

        XCTAssertEqual(history.persistenceScore(for: frame), 1, accuracy: 0.001)
    }

    func testPersistenceCountsAtMostOneOverlapPerScreenshot() {
        let frame = CGRect(x: 100, y: 100, width: 72, height: 72)
        var history = OrbSafeRegionHistory()
        let now = Date()

        history.record(frames: [frame, frame, frame], at: now.addingTimeInterval(-2))
        history.record(frames: [], at: now)

        XCTAssertEqual(history.persistenceScore(for: frame), 0.5, accuracy: 0.001)
    }

    func testOverlappingHistoricalRectanglesProvidePartialPersistence() {
        let frame = CGRect(x: 100, y: 100, width: 72, height: 72)
        var history = OrbSafeRegionHistory()

        history.record(frames: [
            CGRect(x: 136, y: 100, width: 72, height: 72)
        ])

        XCTAssertEqual(history.persistenceScore(for: frame), 0.5, accuracy: 0.001)
    }

    func testExpiredAndExcessSnapshotsAreDiscarded() {
        var history = OrbSafeRegionHistory(maximumAge: 10, maximumSnapshotCount: 2)
        let frame = CGRect(x: 100, y: 100, width: 72, height: 72)
        let now = Date()

        history.record(frames: [frame], at: now.addingTimeInterval(-20))
        history.record(frames: [frame], at: now.addingTimeInterval(-2))
        history.record(frames: [frame], at: now.addingTimeInterval(-1))
        history.record(frames: [], at: now)

        XCTAssertEqual(history.snapshots.count, 2)
        XCTAssertEqual(history.persistenceScore(for: frame), 0.5, accuracy: 0.001)
    }
}
