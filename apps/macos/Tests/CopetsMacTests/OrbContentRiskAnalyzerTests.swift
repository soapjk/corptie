import XCTest
@testable import CorptieMac

final class OrbContentRiskAnalyzerTests: XCTestCase {
    func testOpaqueSolidTonesAreLowRisk() throws {
        let black = try knownRisk(analyzing: solidFrame(red: 0, green: 0, blue: 0))
        let white = try knownRisk(analyzing: solidFrame(red: 255, green: 255, blue: 255))
        let gray = try knownRisk(analyzing: solidFrame(red: 128, green: 128, blue: 128))

        XCTAssertLessThanOrEqual(black.totalRisk, 0.02)
        XCTAssertLessThanOrEqual(white.totalRisk, 0.02)
        XCTAssertLessThanOrEqual(gray.totalRisk, 0.02)
        XCTAssertEqual(black.extremeToneBonus, 1)
        XCTAssertEqual(white.extremeToneBonus, 1)
        XCTAssertEqual(gray.extremeToneBonus, 0)
    }

    func testTextGridAndPhotoLikeContentAreRiskierThanSolidColor() throws {
        let solid = try knownRisk(analyzing: solidFrame(red: 245, green: 245, blue: 245))
        let text = try knownRisk(analyzing: textFrame())
        let grid = try knownRisk(analyzing: gridFrame())
        let photo = try knownRisk(analyzing: photoLikeFrame())

        XCTAssertGreaterThan(text.totalRisk, solid.totalRisk + 0.12)
        XCTAssertGreaterThan(grid.totalRisk, solid.totalRisk + 0.20)
        XCTAssertGreaterThan(photo.totalRisk, solid.totalRisk + 0.20)
    }

    func testSmoothGradientRemainsSaferThanText() throws {
        let gradient = try knownRisk(analyzing: gradientFrame())
        let text = try knownRisk(analyzing: textFrame())

        XCTAssertLessThan(gradient.edgeDensity, 0.10)
        XCTAssertLessThan(gradient.totalRisk, text.totalRisk)
    }

    func testScoreIsStableAcrossSampleDimensions() throws {
        let small = try knownRisk(analyzing: gridFrame(size: 48))
        let large = try knownRisk(analyzing: gridFrame(size: 96))

        XCTAssertEqual(small.totalRisk, large.totalRisk, accuracy: 0.08)
        XCTAssertEqual(small.edgeDensity, large.edgeDensity, accuracy: 0.08)
    }

    func testLowContrastTextIsNotClassifiedLikeBlankSpace() throws {
        let blank = try knownRisk(analyzing: solidFrame(red: 225, green: 225, blue: 225))
        let lowContrastText = try knownRisk(analyzing: textFrame(
            background: (225, 225, 225),
            foreground: (205, 205, 205)
        ))

        XCTAssertGreaterThan(lowContrastText.edgeDensity, 0.04)
        XCTAssertGreaterThan(lowContrastText.totalRisk, blank.totalRisk + 0.025)
    }

    func testWhiteTextOnLightBackgroundReachesAvoidanceTrigger() throws {
        let blank = try knownRisk(analyzing: solidFrame(red: 235, green: 235, blue: 235))
        let whiteText = try knownRisk(analyzing: textFrame(
            background: (235, 235, 235),
            foreground: (255, 255, 255)
        ))

        XCTAssertGreaterThan(whiteText.localContrastSalience, 0.70)
        XCTAssertGreaterThanOrEqual(whiteText.totalRisk, 0.26)
        XCTAssertLessThan(blank.totalRisk, 0.18)
    }

    func testSubtleSmoothLightGradientDoesNotReachAvoidanceTrigger() throws {
        let gradient = try knownRisk(analyzing: frame(size: 64) { x, _ in
            let tone = UInt8(225 + x / 4)
            return (tone, tone, tone)
        })

        XCTAssertLessThan(gradient.localContrastSalience, 0.20)
        XCTAssertLessThan(gradient.totalRisk, 0.26)
    }

    func testRegionalBoundaryIsRiskierThanBlankSpace() throws {
        let blank = try knownRisk(analyzing: solidFrame(red: 255, green: 255, blue: 255))
        let split = try knownRisk(analyzing: splitFrame())

        XCTAssertGreaterThan(split.regionalDifference, 0.25)
        XCTAssertGreaterThan(split.totalRisk, blank.totalRisk + 0.15)
    }

    func testChangedFrameHasMoreTemporalRiskThanStaticFrame() throws {
        let firstAnalysis = OrbContentRiskAnalyzer.analyze(frame: textFrame())
        let signature = try knownSignature(from: firstAnalysis)
        let staticRisk = try knownRisk(analyzing: textFrame(), previousSignature: signature)
        let changedRisk = try knownRisk(analyzing: invertedTextFrame(), previousSignature: signature)

        XCTAssertEqual(staticRisk.temporalChange, 0, accuracy: 0.001)
        XCTAssertGreaterThan(changedRisk.temporalChange, 0.5)
        XCTAssertGreaterThan(changedRisk.totalRisk, staticRisk.totalRisk + 0.07)
    }

    func testAllZeroCaptureIsUnknownButOpaqueBlackIsValid() {
        let zeroFrame = OrbContentPixelFrame(
            width: 32,
            height: 32,
            rgbaBytes: Array(repeating: 0, count: 32 * 32 * 4)
        )

        XCTAssertEqual(
            OrbContentRiskAnalyzer.analyze(frame: zeroFrame),
            .unknown(.zeroOrTransparentCapture)
        )
        XCTAssertNotNil(OrbContentRiskAnalyzer.analyze(
            frame: solidFrame(red: 0, green: 0, blue: 0)
        ).risk)
    }

    func testInvalidDimensionsAndStorageAreUnknown() {
        XCTAssertEqual(
            OrbContentRiskAnalyzer.analyze(
                frame: OrbContentPixelFrame(width: 2, height: 2, rgbaBytes: [])
            ),
            .unknown(.invalidDimensions)
        )
        XCTAssertEqual(
            OrbContentRiskAnalyzer.analyze(
                frame: OrbContentPixelFrame(width: 16, height: 16, rgbaBytes: [0, 0, 0, 255])
            ),
            .unknown(.invalidPixelData)
        )
    }

    func testCircularMaskIgnoresComplexCorners() throws {
        let frame = frame(size: 48) { x, y in
            let inHorizontalCorner = x < 8 || x >= 40
            let inVerticalCorner = y < 8 || y >= 40
            guard inHorizontalCorner && inVerticalCorner else {
                return (250, 250, 250)
            }
            return (x + y).isMultiple(of: 2) ? (0, 0, 0) : (255, 0, 200)
        }

        let circular = try knownRisk(analyzing: frame)
        let cornerMask = OrbCircularMask(centerX: 5, centerY: 5, radius: 5)
        let corner = try knownRisk(analyzing: frame, mask: cornerMask)

        XCTAssertLessThan(circular.totalRisk, corner.totalRisk)
    }

    private func knownRisk(
        analyzing frame: OrbContentPixelFrame,
        mask: OrbCircularMask? = nil,
        previousSignature: OrbLuminanceSignature? = nil
    ) throws -> OrbContentRisk {
        let analysis = OrbContentRiskAnalyzer.analyze(
            frame: frame,
            mask: mask,
            previousSignature: previousSignature
        )
        guard case let .known(risk, _) = analysis else {
            return try XCTUnwrap(nil, "Expected known content analysis, got \(analysis)")
        }
        return risk
    }

    private func knownSignature(from analysis: OrbContentAnalysis) throws -> OrbLuminanceSignature {
        guard case let .known(_, signature) = analysis else {
            return try XCTUnwrap(nil, "Expected known content analysis, got \(analysis)")
        }
        return signature
    }

    private func solidFrame(
        red: UInt8,
        green: UInt8,
        blue: UInt8,
        size: Int = 64
    ) -> OrbContentPixelFrame {
        frame(size: size) { _, _ in (red, green, blue) }
    }

    private func textFrame(
        background: (UInt8, UInt8, UInt8) = (250, 250, 250),
        foreground: (UInt8, UInt8, UInt8) = (30, 30, 30)
    ) -> OrbContentPixelFrame {
        frame(size: 64) { x, y in
            let line = y >= 12 && y < 52 && (y - 12).isMultiple(of: 8)
            let withinGlyphRun = x >= 8 && x < 56
            let glyphGap = ((x - 8) % 7) >= 5
            return line && withinGlyphRun && !glyphGap ? foreground : background
        }
    }

    private func invertedTextFrame() -> OrbContentPixelFrame {
        textFrame(
            background: (30, 30, 30),
            foreground: (250, 250, 250)
        )
    }

    private func gridFrame(size: Int = 64) -> OrbContentPixelFrame {
        frame(size: size) { x, y in
            (x.isMultiple(of: 6) || y.isMultiple(of: 6))
                ? (20, 20, 20)
                : (245, 245, 245)
        }
    }

    private func gradientFrame() -> OrbContentPixelFrame {
        frame(size: 64) { x, _ in
            let tone = UInt8(80 + x * 2)
            return (tone, tone, tone)
        }
    }

    private func photoLikeFrame() -> OrbContentPixelFrame {
        frame(size: 64) { x, y in
            let red = UInt8((x * 37 + y * 17) % 256)
            let green = UInt8((x * 11 + y * 43) % 256)
            let blue = UInt8((x * 29 + y * 7) % 256)
            return (red, green, blue)
        }
    }

    private func splitFrame() -> OrbContentPixelFrame {
        frame(size: 64) { x, y in
            if x < 32 {
                return (255, 255, 255)
            }
            return (x.isMultiple(of: 4) || y.isMultiple(of: 5))
                ? (20, 20, 20)
                : (160, 170, 200)
        }
    }

    private func frame(
        size: Int,
        color: (Int, Int) -> (UInt8, UInt8, UInt8)
    ) -> OrbContentPixelFrame {
        var bytes: [UInt8] = []
        bytes.reserveCapacity(size * size * 4)
        for y in 0..<size {
            for x in 0..<size {
                let pixel = color(x, y)
                bytes.append(pixel.0)
                bytes.append(pixel.1)
                bytes.append(pixel.2)
                bytes.append(255)
            }
        }
        return OrbContentPixelFrame(width: size, height: size, rgbaBytes: bytes)
    }
}
