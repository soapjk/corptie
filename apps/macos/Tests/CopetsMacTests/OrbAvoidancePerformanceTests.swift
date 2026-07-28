import Foundation
import XCTest
@testable import CorptieMac

final class OrbAvoidancePerformanceTests: XCTestCase {
    func testTypicalCandidateBatchCompletesWithinBackgroundBudget() {
        let size = 256
        var bytes: [UInt8] = []
        bytes.reserveCapacity(size * size * 4)
        for y in 0..<size {
            for x in 0..<size {
                bytes.append(UInt8((x * 13 + y * 7) % 256))
                bytes.append(UInt8((x * 3 + y * 17) % 256))
                bytes.append(UInt8((x * 11 + y * 5) % 256))
                bytes.append(255)
            }
        }
        let frame = OrbContentPixelFrame(
            width: size,
            height: size,
            rgbaBytes: bytes
        )
        let masks = (0..<112).map { index in
            let column = index % 16
            let row = index / 16
            return OrbCircularMask(
                centerX: 12 + Double(column) * 15,
                centerY: 18 + Double(row) * 34,
                radius: 11
            )
        }

        let startedAt = ProcessInfo.processInfo.systemUptime
        let analyses = masks.map {
            OrbContentRiskAnalyzer.analyze(frame: frame, mask: $0)
        }
        let elapsed = ProcessInfo.processInfo.systemUptime - startedAt

        XCTAssertEqual(analyses.count, masks.count)
        XCTAssertTrue(analyses.allSatisfy { $0.risk != nil })
        XCTAssertLessThan(
            elapsed,
            2,
            "112-candidate analysis took \(elapsed)s; it runs off the main actor but should remain bounded"
        )
    }
}
