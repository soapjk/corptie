import Foundation
import XCTest
import AppKit
import CorptieConversation
import CorptieClientCore
@testable import CorptieMac

final class ChatImageModelTests: XCTestCase {
    @MainActor func testRichImageRepliesUseSharedGeometryAndDiscardStaleLayouts() throws {
        func row(_ geometry: MessageImageGeometry?) -> AppKitChatTimelineRow {
            AppKitChatTimelineRow(id: "rich-image", contentRevision: 1,
                nativeText: "| A | B |\n|---|---|\n|One|Two|", copyText: "Table", nativeStyle: .agent,
                title: "", metadata: "", expandableTurnId: nil, isExpanded: false, showsHeader: false,
                images: [ChatTimelineImage(managedPath: "image", displayURL: nil, originalPath: nil, geometry: geometry)])
        }
        let portrait = row(MessageImageGeometry(pixelWidth: 900, pixelHeight: 1600))
        XCTAssertTrue(MacSharedMessageTextCard.supports(portrait))
        let layout = NativeTimelineLayoutCache.shared.layout(for: portrait, columnWidth: 500)
        XCTAssertEqual(layout.imageLayout.size, CGSize(width:146.25,height:260))
        let cell = AppKitSharedMessageTextCell(identifier: .init("rich-image"))
        cell.setContent(portrait, availableWidth: 500, onToggleExpansion: { _ in })
        XCTAssertTrue(cell.updateLayoutIfContentUnchanged(portrait, availableWidth: 500))
        XCTAssertFalse(cell.updateLayoutIfContentUnchanged(row(nil), availableWidth: 500))
    }
    @MainActor func testUserAndModelImageGeometryDrivesBubbleCanvasAndRowHeightTogether() throws {
        for type in ["userMessage", "imageView"] {
            let item = try JSONDecoder().decode(CodexThreadItem.self, from: Data("""
                {"id":"\(type)","turnId":"turn","turnStatus":"complete","type":"\(type)","title":"image","text":"[localImage]",
                 "images":[{"managedPath":"chat-resources/\(type).png","pixelWidth":900,"pixelHeight":1600}]}
                """.utf8))
            let builder = ConversationNativeRowBuilder(sessionTitle: nil, workingDirectory: nil,
                allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in nil })
            let row = builder.nativeAppKitRow(.init(kind: .message(item)), expandedTurnIds: [])
            let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 500)
            XCTAssertEqual(layout.cardWidth, 166.25, accuracy: 0.01)
            XCTAssertEqual(layout.imageLayout.size, CGSize(width:146.25,height:260))
            XCTAssertEqual(layout.textHeight, 0)
            XCTAssertEqual(layout.cardHeight, layout.imageLayout.size.height + 20, accuracy: 0.01)
            XCTAssertEqual(layout.rowHeight, layout.cardHeight + 2, accuracy: 0.01)
            let cell = AppKitChatNativeTextCell(identifier: .init(type))
            cell.frame = .init(x: 0, y: 0, width: 500, height: layout.rowHeight)
            cell.setContent(row, availableWidth: 500, onToggleExpansion: { _ in })
            cell.layoutSubtreeIfNeeded()
            func images(_ view: NSView) -> [NSButton] {
                view.subviews.flatMap { child -> [NSButton] in
                    if let button = child as? NSButton, button.accessibilityLabel()?.hasPrefix("Attached image") == true { return [button] }
                    return images(child)
                }
            }
            let button = try XCTUnwrap(images(cell).first)
            XCTAssertEqual(button.frame.size, layout.imageLayout.size)
            let rect = button.convert(button.bounds, to: cell)
            XCTAssertEqual(rect.minY - cell.bounds.minY, 11, accuracy: 0.6)
            XCTAssertEqual(cell.bounds.maxY - rect.maxY, 11, accuracy: 0.6)
            XCTAssertTrue(cell.updateLayoutIfContentUnchanged(row, availableWidth: 120))
            XCTAssertLessThanOrEqual(button.frame.width, 96)
        }
    }
    @MainActor func testImageViewUsesSharedMediaRuleWithoutHeaderOrHostPath() throws {
        let data = Data(#"{"id":"qr","turnId":"turn","turnStatus":"complete","type":"imageView","title":"imageView","text":"/tmp/qr.png","images":[{"managedPath":"chat-resources/qr.png"}]}"#.utf8)
        let item = try JSONDecoder().decode(CodexThreadItem.self, from: data)
        XCTAssertTrue(item.isStandaloneImage)
        let entries = makeChatDisplayEntries(from: [item])
        XCTAssertEqual(entries.count, 1)
        let builder = ConversationNativeRowBuilder(sessionTitle: nil, workingDirectory: nil,
            allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in URL(fileURLWithPath: "/tmp/qr.png") })
        let row = builder.nativeAppKitRow(try XCTUnwrap(entries.first), expandedTurnIds: [])
        XCTAssertEqual(row.images.count, 1)
        XCTAssertEqual(row.nativeText, "")
        XCTAssertFalse(row.showsHeader)
    }

    @MainActor func testImageCardUsesSharedGalleryHeightAndSuppressesProviderPlaceholder() throws {
        let data = Data(#"{"id":"image","turnId":"turn","turnStatus":"complete","type":"userMessage","title":"User","text":"[localImage]","status":"accepted","images":[{"managedPath":"chat-resources/image.png"}]}"#.utf8)
        let item = try JSONDecoder().decode(CodexThreadItem.self, from: data)
        let builder = ConversationNativeRowBuilder(sessionTitle: nil, workingDirectory: nil,
            allowsFork: false, forkUnavailableReason: nil, imageURL: { _ in URL(fileURLWithPath: "/tmp/image.png") })
        let row = builder.nativeAppKitRow(.init(kind: .message(item)), expandedTurnIds: [])
        XCTAssertEqual(row.images.count, 1)
        XCTAssertEqual(row.nativeText, "")
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 400)
        XCTAssertEqual(layout.cardWidth, 108)
        XCTAssertGreaterThanOrEqual(layout.rowHeight,
            88 + 20)
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
        XCTAssertEqual(ChatTimelineImageLoader.shared.geometry(for: url), MessageImageGeometry(pixelWidth: 4096, pixelHeight: 64))
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
