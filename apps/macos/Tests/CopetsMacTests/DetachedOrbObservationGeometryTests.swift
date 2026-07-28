import CoreGraphics
import XCTest
@testable import CorptieMac

final class DetachedOrbObservationGeometryTests: XCTestCase {
    func testCurrentOriginIsAlwaysAnalyzedEvenWhenPlacementFilteringRemovedIt() {
        let current = CGPoint(x: 400, y: 300)
        let candidates = [
            CGPoint(x: 500, y: 300),
            CGPoint(x: 600, y: 300)
        ]

        XCTAssertEqual(
            DetachedOrbObservationGeometry.analysisOrigins(
                currentOrigin: current,
                candidateOrigins: candidates
            ),
            [current] + candidates
        )
        XCTAssertEqual(
            DetachedOrbObservationGeometry.analysisOrigins(
                currentOrigin: current,
                candidateOrigins: [current] + candidates
            ),
            [current] + candidates
        )
    }

    func testSearchRectExpandsAroundOrbAndClipsToVisibleFrame() {
        XCTAssertEqual(
            DetachedOrbObservationGeometry.searchRect(
                around: CGRect(x: 1_336, y: 796, width: 88, height: 88),
                visibleFrame: CGRect(x: 0, y: 0, width: 1_440, height: 900)
            ),
            CGRect(x: 976, y: 436, width: 464, height: 464)
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

    func testAnalysisOutputPreservesSourceAspectRatio() {
        XCTAssertEqual(
            ScreenContentAnalysisGeometry.outputPixelSize(
                for: CGRect(x: 0, y: 0, width: 400, height: 200),
                maximumDimension: 256
            ),
            CGSize(width: 256, height: 128)
        )
        XCTAssertEqual(
            ScreenContentAnalysisGeometry.outputPixelSize(
                for: CGRect(x: 0, y: 0, width: 100, height: 300),
                maximumDimension: 256
            ),
            CGSize(width: 85, height: 256)
        )
    }

    func testAnalysisMaskMapsAppKitCoordinatesToTopLeftPixels() {
        let mask = ScreenContentAnalysisGeometry.mask(
            for: CGRect(x: 180, y: 320, width: 40, height: 40),
            in: CGRect(x: 100, y: 200, width: 400, height: 200),
            pixelWidth: 400,
            pixelHeight: 200
        )

        XCTAssertEqual(mask?.centerX, 100)
        XCTAssertEqual(mask?.centerY, 60)
        XCTAssertEqual(mask?.radius, 20)
    }

    func testPixelConversionKeepsTopScanlineFirst() throws {
        let sourceBytes: [UInt8] = [
            255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255,
            0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255,
            0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255
        ]
        let data = Data(sourceBytes) as CFData
        let provider = try XCTUnwrap(CGDataProvider(data: data))
        let image = try XCTUnwrap(CGImage(
            width: 3,
            height: 3,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: 12,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        ))

        let frame = try XCTUnwrap(ScreenContentPixelConverter.pixelFrame(from: image))

        XCTAssertEqual(Array(frame.rgbaBytes[0..<4]), [255, 0, 0, 255])
        XCTAssertEqual(Array(frame.rgbaBytes[24..<28]), [0, 0, 255, 255])
    }
}
