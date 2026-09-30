import CoreGraphics
import Foundation
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import CorptieConversation

@MainActor
struct LocalWallpaperTests {
    @Test
    func importingAndResettingWallpaperOnlyChangesTheLocalAppSupportFile() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("corptie-wallpaper-test-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let wallpaper = LocalWallpaperStore(directory: directory)
        #expect(!wallpaper.hasWallpaper)

        let context = try #require(CGContext(
            data: nil, width: 2, height: 2, bitsPerComponent: 8,
            bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.3, green: 0.5, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        let image = try #require(context.makeImage())
        let bytes = NSMutableData()
        let destination = try #require(CGImageDestinationCreateWithData(
            bytes, UTType.png.identifier as CFString, 1, nil
        ))
        CGImageDestinationAddImage(destination, image, nil)
        #expect(CGImageDestinationFinalize(destination))

        await wallpaper.importImageData(bytes as Data)
        #expect(wallpaper.hasWallpaper)
        #expect(wallpaper.image?.width == 2)
        #expect(FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("appearance/wallpaper.jpg").path
        ))
        #expect(LocalWallpaperStore(directory: directory).hasWallpaper)

        wallpaper.restoreDefault()
        #expect(!wallpaper.hasWallpaper)
        #expect(!FileManager.default.fileExists(
            atPath: directory.appendingPathComponent("appearance/wallpaper.jpg").path
        ))
    }
}
