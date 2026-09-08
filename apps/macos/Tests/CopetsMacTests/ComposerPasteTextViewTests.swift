import AppKit
import Testing
@testable import CorptieMac

@MainActor
struct ComposerPasteTextViewTests {
    @Test func plainEditorAdvertisesScreenshotTypes() {
        let view = ComposerPasteTextView()
        view.isRichText = false
        #expect(view.readablePasteboardTypes.contains(.png))
        #expect(view.readablePasteboardTypes.contains(.tiff))
        #expect(view.readablePasteboardTypes.contains(.fileURL))
    }

    @Test func imageAvailabilityDoesNotDecodeOrImport() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setData(Data([1, 2, 3]), forType: .png)
        let view = ComposerPasteTextView()
        view.isRichText = false
        var calls = 0
        view.onPasteImages = { _ in calls += 1; return true }
        #expect(view.canImportImages(from: board))
        #expect(calls == 0)
        view.isEditable = false
        #expect(!view.canImportImages(from: board))
    }

    @Test func nativeReadRoutesTheSuppliedPasteboardExactlyOnce() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setData(Data([1]), forType: .tiff)
        let view = ComposerPasteTextView()
        view.isRichText = false
        var calls = 0
        view.onPasteImages = { supplied in
            #expect(supplied.name == board.name)
            calls += 1
            return true
        }
        #expect(view.readSelection(from: board))
        #expect(calls == 1)
        #expect(view.string.isEmpty)
    }

    @Test func plainTextStaysOnTheNativeTextPath() {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        board.setString("synthetic text", forType: .string)
        let view = ComposerPasteTextView()
        view.isRichText = false
        view.onPasteImages = { _ in Issue.record("Text must not be imported as an attachment"); return false }
        #expect(view.readSelection(from: board))
        #expect(view.string == "synthetic text")
    }

    @Test func explicitPlainTextRestrictionIsRespected() {
        let view = ComposerPasteTextView()
        view.onPasteImages = { _ in true }
        #expect(view.preferredPasteboardType(from: [.png, .tiff], restrictedToTypesFrom: nil) == .png)
        #expect(view.preferredPasteboardType(from: [.png, .string], restrictedToTypesFrom: [.string]) != .png)
    }
}
