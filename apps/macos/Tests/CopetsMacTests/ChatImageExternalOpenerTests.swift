import AppKit
import XCTest
@testable import CorptieMac

final class ChatImageExternalOpenerTests: XCTestCase {
    func testOriginalBytesAndFileAssociationExtensionArePreserved() throws {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = try ChatImageExternalOpener.materialize(data, directory: directory)
        XCTAssertEqual(file.pathExtension, "png")
        XCTAssertEqual(try Data(contentsOf: file), data)
        XCTAssertEqual(try ChatImageExternalOpener.materialize(data, directory: directory), file)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1)
        XCTAssertThrowsError(try ChatImageExternalOpener.materialize(Data("not an image".utf8), directory: directory))
    }
}
