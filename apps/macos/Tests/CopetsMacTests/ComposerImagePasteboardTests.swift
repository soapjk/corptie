import AppKit
import ImageIO
import Testing
import UniformTypeIdentifiers
@testable import CorptieMac

@MainActor
struct ComposerImagePasteboardTests {
    private func image(_ type: NSBitmapImageRep.FileType = .png, width: Int = 16, height: Int = 8) throws -> Data {
        let bitmap = try #require(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        bitmap.bitmapData?.initialize(repeating: 127, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
        return try #require(bitmap.representation(using: type, properties: [:]))
    }

    private func prepare(_ board: NSPasteboard, capacity: Int = 8) async throws -> ComposerImagePasteboard.Batch {
        let snapshot = try #require(ComposerImagePasteboard.capture(board))
        return await ComposerImagePreparation.shared.prepare(snapshot, capacity: capacity)
    }

    @Test func jpegWithTextAndHTMLKeepsOriginalBytesAndDoesNotDuplicate() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let bytes = try image(.jpeg)
        let item = NSPasteboardItem()
        item.setData(bytes, forType: NSPasteboard.PasteboardType(UTType.jpeg.identifier))
        item.setData(try image(.tiff), forType: .tiff)
        item.setString("description that must not enter the editor", forType: .string)
        item.setString("<img src='https://invalid.example/image.png'>", forType: .html)
        board.writeObjects([item])
        let batch = try await prepare(board)
        defer { batch.cleanup() }
        #expect(batch.images.count == 1)
        #expect(batch.failed == 0)
        #expect(try Data(contentsOf: batch.images[0].url) == bytes)
        #expect(batch.images[0].url.pathExtension == "jpeg" || batch.images[0].url.pathExtension == "jpg")
    }

    @Test func brokenFileAndBrokenPreferredDataFallBackToValidBitmap() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let item = NSPasteboardItem()
        item.setString("file:///nonexistent/copied-picture.png", forType: .fileURL)
        item.setData(Data([1, 2]), forType: .png)
        item.setData(try image(.tiff), forType: .tiff)
        board.writeObjects([item])
        let batch = try await prepare(board)
        defer { batch.cleanup() }
        #expect(batch.images.count == 1)
        #expect(batch.failed == 0)
        let source = try #require(CGImageSourceCreateWithURL(batch.images[0].url as CFURL, nil))
        #expect(CGImageSourceGetType(source) as String? == UTType.png.identifier)
    }

    @Test func multipleItemsKeepOrderAndReportCapacity() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let first = NSPasteboardItem(), second = NSPasteboardItem()
        first.setData(try image(.jpeg), forType: .init(UTType.jpeg.identifier))
        second.setData(try image(), forType: .png)
        board.writeObjects([first, second])
        let batch = try await prepare(board, capacity: 1)
        defer { batch.cleanup() }
        #expect(batch.images.count == 1)
        #expect(batch.truncated)
        #expect(batch.failed == 0)
        #expect(batch.images[0].url.pathExtension != "png")
    }

    @Test func corruptedImageIsAnExplicitFailure() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setData(Data([0, 1, 2, 3]), forType: .png)
        let batch = try await prepare(board)
        #expect(batch.images.isEmpty)
        #expect(batch.failed == 1)
    }

    @Test func oversizedEncodedDataIsRejectedBeforePreparation() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setData(Data(repeating: 0, count: ComposerImagePasteboard.maximumBytes + 1), forType: .png)
        let batch = try await prepare(board)
        #expect(batch.images.isEmpty)
        #expect(batch.failed == 1)
    }

    @Test func pureTextAndRemoteHTMLRemainNativeTextWithoutNetwork() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setString("https://example.invalid/picture.png", forType: .string)
        #expect(ComposerImagePasteboard.capture(board) == nil)
        board.setString("<img src='https://example.invalid/picture.png'>", forType: .html)
        #expect(ComposerImagePasteboard.capture(board) == nil)
        board.setString("<img src='file:///private/not-a-granted-file.png'>", forType: .html)
        #expect(ComposerImagePasteboard.capture(board) == nil)
    }

    @Test func embeddedHTMLImageIsReadWithoutLoadingOtherSources() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let bytes = try image()
        board.setString("<img src='https://example.invalid/private'><img src=\"data:image/png;base64,\(bytes.base64EncodedString())\">", forType: .html)
        let batch = try await prepare(board)
        defer { batch.cleanup() }
        #expect(batch.images.count == 1)
        #expect(try Data(contentsOf: batch.images[0].url) == bytes)
    }

    @Test func imageFileSurvivesCleanupButOwnedTemporaryFileDoesNot() async throws {
        let original = FileManager.default.temporaryDirectory.appendingPathComponent("clipboard-test-\(UUID()).png")
        try image().write(to: original)
        defer { try? FileManager.default.removeItem(at: original) }
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.writeObjects([original as NSURL])
        let batch = try await prepare(board)
        #expect(batch.images.count == 1)
        #expect(batch.images[0].url == original)
        #expect(!batch.images[0].temporary)
        batch.cleanup()
        #expect(FileManager.default.fileExists(atPath: original.path))
        board.clearContents()
        board.setData(try image(), forType: .png)
        let temporary = try await prepare(board)
        let path = try #require(temporary.images.first?.url.path)
        #expect(FileManager.default.fileExists(atPath: path))
        temporary.cleanup()
        #expect(!FileManager.default.fileExists(atPath: path))
    }

    @Test func nonImageFileDoesNotHijackPaste() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.writeObjects([URL(fileURLWithPath: "/nonexistent/document.txt") as NSURL])
        #expect(ComposerImagePasteboard.capture(board) == nil)
    }

    @Test func legacyFileListIsRecognizedWithoutTreatingTextPathsAsFiles() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setPropertyList(["/nonexistent/old-app-picture.png", "/nonexistent/document.txt"],
                              forType: ComposerImagePasteboard.legacyFileType)
        let snapshot = try #require(ComposerImagePasteboard.capture(board))
        #expect(snapshot.items.count == 1)
    }

    @Test func explicitStringReadOfMixedClipboardDoesNotImportTheImage() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let item = NSPasteboardItem()
        item.setData(try image(), forType: .png)
        item.setString("plain text", forType: .string)
        board.writeObjects([item])
        let view = TestPasteTextView(board: board)
        view.isRichText = false
        view.onPasteImages = { _ in Issue.record("Explicit text must not import images"); return true }
        #expect(view.readSelection(from: board, type: .string))
        #expect(view.string == "plain text")
    }

    @Test func malformedHTMLWithRepeatedOpenTagsIsNotRepeatedlyRescanned() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setString(String(repeating: "<img ", count: 50_000), forType: .html)
        #expect(ComposerImagePasteboard.capture(board) == nil)
    }

    @Test func embeddedRTFDAttachmentIsImportedWithoutContentHeading() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let attachment = NSTextAttachment()
        attachment.fileWrapper = FileWrapper(regularFileWithContents: try image())
        attachment.fileWrapper?.preferredFilename = "picture.png"
        let document = NSAttributedString(attachment: attachment)
        let data = try document.data(from: NSRange(location: 0, length: document.length),
            documentAttributes: [.documentType: NSAttributedString.DocumentType.rtfd])
        board.setData(data, forType: .rtfd)
        let batch = try await prepare(board)
        defer { batch.cleanup() }
        #expect(batch.images.count == 1)
        #expect(batch.failed == 0)
    }

    @Test func partiallyCorruptMultiItemPasteStillImportsTheOtherImage() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let broken = NSPasteboardItem(), valid = NSPasteboardItem()
        broken.setData(Data([0, 1]), forType: .png)
        valid.setData(try image(), forType: .png)
        board.writeObjects([broken, valid])
        let batch = try await prepare(board)
        defer { batch.cleanup() }
        #expect(batch.images.count == 1)
        #expect(batch.failed == 1)
    }

    @Test func truncatedImageBodyCannotBeImportedJustBecauseItHasDimensions() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setData(try image().prefix(40), forType: .png)
        let batch = try await prepare(board)
        defer { batch.cleanup() }
        #expect(batch.images.isEmpty)
        #expect(batch.failed == 1)
    }

    @Test func clipboardSnapshotIsIndependentOfLaterCopyOperations() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let original = try image()
        board.setData(original, forType: .png)
        let snapshot = try #require(ComposerImagePasteboard.capture(board))
        board.clearContents()
        board.setString("new unrelated clipboard text", forType: .string)
        let batch = await ComposerImagePreparation.shared.prepare(snapshot, capacity: 8)
        defer { batch.cleanup() }
        #expect(batch.images.count == 1)
        #expect(try Data(contentsOf: batch.images[0].url) == original)
    }

    @Test func sixMegapixelTIFFOverAttachmentByteLimitCanStillBeConverted() async throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let bytes = try image(.tiff, width: 3_000, height: 2_000)
        #expect(bytes.count > ComposerImagePasteboard.maximumBytes)
        board.setData(bytes, forType: .tiff)
        let start = ContinuousClock.now
        let snapshot = try #require(ComposerImagePasteboard.capture(board))
        let captured = ContinuousClock.now
        let batch = await ComposerImagePreparation.shared.prepare(snapshot, capacity: 8)
        let completed = ContinuousClock.now
        defer { batch.cleanup() }
        #expect(batch.images.count == 1)
        let source = try #require(CGImageSourceCreateWithURL(batch.images[0].url as CFURL, nil))
        let properties = try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
        #expect(properties[kCGImagePropertyPixelWidth] as? Int == 3_000)
        #expect(properties[kCGImagePropertyPixelHeight] as? Int == 2_000)
        #expect(properties[kCGImagePropertyHasAlpha] as? Bool == true)
        print("clipboard 6MP TIFF: capture=\(start.duration(to: captured)), prepare=\(captured.duration(to: completed))")
    }

    @Test func realPasteActionImportsExactlyOnceWithoutInsertingCaption() throws {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let item = NSPasteboardItem()
        item.setData(try image(.jpeg), forType: .init(UTType.jpeg.identifier))
        item.setString("caption", forType: .string)
        board.writeObjects([item])
        let view = TestPasteTextView(board: board)
        view.isRichText = false
        view.string = "existing draft"
        #expect(view.string == "existing draft")
        var imports = 0
        view.onPasteImages = { supplied in
            #expect(ComposerImagePasteboard.capture(supplied)?.items.count == 1)
            imports += 1
            return true
        }
        // Dispatch the actual AppKit action, not readSelection's test shortcut.
        #expect(NSApplication.shared.sendAction(#selector(NSText.paste(_:)), to: view, from: nil))
        #expect(imports == 1)
        #expect(view.string == "existing draft")
        view.isEditable = false
        view.paste(nil)
        #expect(imports == 1)
    }

    @Test func importLifetimeRejectsOverlapAndLatePublicationAcrossReopen() throws {
        let state = ComposerImageImportState()
        let old = try #require(state.begin())
        #expect(state.busy)
        #expect(state.begin() == nil)
        state.invalidate()
        #expect(!state.accepts(old))
        #expect(!state.busy)
        state.activate()
        let next = try #require(state.begin())
        state.finish(old)
        #expect(state.busy)
        #expect(state.accepts(next))
        state.finish(next)
        #expect(!state.busy)
    }

    @Test func cancelledPreparationDoesNotLeaveTemporaryFiles() async throws {
        let snapshot = ComposerImagePasteboard.Snapshot(items: [[.data(try image())]])
        let task = Task {
            try? await Task.sleep(for: .milliseconds(30))
            return await ComposerImagePreparation.shared.prepare(snapshot, capacity: 8)
        }
        task.cancel()
        let batch = await task.value
        #expect(batch.images.isEmpty)
    }
}

@MainActor
private final class TestPasteTextView: ComposerPasteTextView {
    private let board: NSPasteboard
    private let storage: NSTextStorage
    override var imagePasteboard: NSPasteboard { board }
    init(board: NSPasteboard) {
        self.board = board
        let storage = NSTextStorage()
        let manager = NSLayoutManager()
        let container = NSTextContainer(size: NSSize(width: 300, height: 100))
        storage.addLayoutManager(manager)
        manager.addTextContainer(container)
        self.storage = storage
        super.init(frame: NSRect(x: 0, y: 0, width: 300, height: 100), textContainer: container)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
}
