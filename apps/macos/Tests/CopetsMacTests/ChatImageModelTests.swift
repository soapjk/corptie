import Foundation
import XCTest
import AppKit
import CorptieConversation
@testable import CorptieMac

final class ChatImageModelTests: XCTestCase {
    @MainActor func testImageCardUsesSharedGalleryHeightAndSuppressesProviderPlaceholder() throws {
        let data = Data(#"{"id":"image","turnId":"turn","turnStatus":"complete","type":"userMessage","title":"User","text":"[localImage]","status":"accepted","images":[{"managedPath":"chat-resources/image.png"}]}"#.utf8)
        let item = try JSONDecoder().decode(CodexThreadItem.self, from: data)
        let builder = ConversationNativeRowBuilder(sessionTitle: nil, workingDirectory: nil,
            allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in URL(fileURLWithPath: "/tmp/image.png") })
        let row = builder.nativeAppKitRow(.init(kind: .message(item)), expandedTurnIds: [])
        XCTAssertEqual(row.images.count, 1)
        XCTAssertEqual(row.nativeText, "")
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 400)
        XCTAssertEqual(layout.cardWidth, 360)
        XCTAssertGreaterThanOrEqual(layout.rowHeight,
            MessageImageGalleryLayout.height(count: 1, width: 340) + 20)
    }

    @MainActor func testImageLoaderDownsamplesAndReusesDecodedBitmap() async throws {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 4096, pixelsHigh: 64,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let data = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("gallery-test-\(UUID()).png")
        try data.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let image = await withCheckedContinuation { continuation in
            ChatTimelineImageLoader.shared.load(url) { continuation.resume(returning: $0) }
        }
        let decoded = try XCTUnwrap(image)
        let cg = try XCTUnwrap(decoded.cgImage(forProposedRect: nil, context: nil, hints: nil))
        XCTAssertLessThanOrEqual(cg.width, 1024)
        let cached = await withCheckedContinuation { continuation in
            ChatTimelineImageLoader.shared.load(url) { continuation.resume(returning: $0) }
        }
        XCTAssertTrue(cached === decoded)
    }
    func testTimelineItemDecodesManagedAndOriginalImagePaths() throws {
        let data = Data(#"""
        {
          "id":"message:image","turnId":"turn:one","turnStatus":"complete",
          "type":"userMessage","title":"User","text":"",
          "options":null,"status":"accepted","createdAt":"2026-09-03T00:00:00.000Z",
          "images":[{
            "managedPath":"chat-resources/tasks/task_one/session_one/images/a.png",
            "originalPath":"/Users/example/Desktop/a.png"
          }]
        }
        """#.utf8)

        let item = try JSONDecoder().decode(CodexThreadItem.self, from: data)
        XCTAssertEqual(item.images?.first?.managedPath, "chat-resources/tasks/task_one/session_one/images/a.png")
        XCTAssertEqual(item.images?.first?.originalPath, "/Users/example/Desktop/a.png")
    }
}
