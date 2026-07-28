import Foundation
import XCTest
@testable import CorptieMac

final class OrbAvoidancePerformanceTests: XCTestCase {
    func testTypicalSparseCandidateBatchReusesPreparedFrameWithinBackgroundBudget() throws {
        let size = 384
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
        let masks = (0..<38).map { index in
            let column = index % 8
            let row = index / 8
            return OrbCircularMask(
                centerX: 24 + Double(column) * 46,
                centerY: 32 + Double(row) * 76,
                radius: 20
            )
        }

        let startedAt = ProcessInfo.processInfo.systemUptime
        let preparedFrame = try XCTUnwrap(OrbContentRiskAnalyzer.prepare(frame: frame))
        let analyses = masks.map {
            OrbContentRiskAnalyzer.analyze(preparedFrame: preparedFrame, mask: $0)
        }
        let elapsed = ProcessInfo.processInfo.systemUptime - startedAt

        XCTAssertEqual(analyses.count, masks.count)
        XCTAssertTrue(analyses.allSatisfy { $0.risk != nil })
        XCTAssertLessThan(
            elapsed,
            0.5,
            "38-candidate shared-frame analysis took \(elapsed)s; Accelerate or Metal may be needed"
        )
    }

    func testTenOrbSharedCaptureAnalysisRemainsBounded() throws {
        let size = 1_024
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
        let masks = (0..<(10 * 38)).map { index in
            let column = index % 20
            let row = index / 20
            return OrbCircularMask(
                centerX: 20 + Double(column) * 51,
                centerY: 20 + Double(row) * 52,
                radius: 12
            )
        }

        let startedAt = ProcessInfo.processInfo.systemUptime
        let preparedFrame = try XCTUnwrap(OrbContentRiskAnalyzer.prepare(frame: frame))
        let analyses = masks.map {
            OrbContentRiskAnalyzer.analyze(preparedFrame: preparedFrame, mask: $0)
        }
        let elapsed = ProcessInfo.processInfo.systemUptime - startedAt

        XCTAssertEqual(analyses.count, masks.count)
        XCTAssertTrue(analyses.allSatisfy { $0.risk != nil })
        XCTAssertLessThan(
            elapsed,
            1.5,
            "Ten-orb shared analysis took \(elapsed)s; profile Accelerate or Metal before shipping"
        )
    }
}
