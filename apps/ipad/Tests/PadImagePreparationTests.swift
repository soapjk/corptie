import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Testing
@testable import CorptieMobileState

@Suite struct PadImagePreparationTests {
    private func png(width: Int, height: Int) throws -> Data {
        let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let image = try #require(context.makeImage())
        let data = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))
        return data as Data
    }
    @Test func smallPNGRemainsByteIdentical() throws {
        let original = try png(width: 8, height: 8)
        #expect(try PadImagePreparation.prepare(original, fileName: "small.png").data == original)
    }
    @Test func oversizedTransparentImageIsBoundedWithoutLosingAlpha() throws {
        let result = try PadImagePreparation.prepare(png(width: 4096, height: 16), fileName: "transparent.png")
        let source = try #require(CGImageSourceCreateWithData(result.data as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        #expect(image.width <= 3072)
        #expect(CGImageSourceGetType(source) as String? == UTType.png.identifier)
        #expect([CGImageAlphaInfo.first, .last, .premultipliedFirst, .premultipliedLast].contains(image.alphaInfo))
    }
    @Test func invalidBytesAreRejectedBeforeEnqueue() {
        #expect(throws: PadImagePreparation.Failure.invalid) {
            try PadImagePreparation.prepare(Data([1, 2, 3]), fileName: "fake.png")
        }
    }
}
