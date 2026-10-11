import XCTest
import UIKit
@testable import CorptieMobile

@MainActor final class ComposerPlaceholderTests: XCTestCase {
    private func makeEditor() -> PadComposerTextView.SubmitTextView {
        let view = PadComposerTextView.SubmitTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 40))
        view.placeholder = "Send instruction"
        return view
    }

    private func placeholder(_ view: UITextView) throws -> UILabel {
        try XCTUnwrap(view.subviews.compactMap { $0 as? UILabel }.first)
    }

    func testRestoredDraftAndClearingSynchronizeWithoutDelegate() throws {
        let view = makeEditor()
        XCTAssertFalse(try placeholder(view).isHidden)
        view.text = "恢复的草稿"
        XCTAssertTrue(try placeholder(view).isHidden)
        view.text = ""
        XCTAssertFalse(try placeholder(view).isHidden)
    }

    func testAttributedDraftAndWhitespaceAreNotEmpty() throws {
        let view = makeEditor()
        view.attributedText = NSAttributedString(string: " \n")
        XCTAssertTrue(try placeholder(view).isHidden)
        view.attributedText = NSAttributedString(string: "")
        XCTAssertFalse(try placeholder(view).isHidden)
    }

    func testInsertionAndDeletionWithoutDelegate() throws {
        let view = makeEditor()
        view.insertText("a")
        XCTAssertTrue(try placeholder(view).isHidden)
        view.deleteBackward()
        XCTAssertFalse(try placeholder(view).isHidden)
    }

    func testMarkedTextIsAlreadyVisibleContent() throws {
        let view = makeEditor()
        view.setMarkedText("ni", selectedRange: NSRange(location: 2, length: 0))
        XCTAssertTrue(try placeholder(view).isHidden)
        view.unmarkText()
        XCTAssertTrue(try placeholder(view).isHidden)
        view.text = ""
        XCTAssertFalse(try placeholder(view).isHidden)
    }

    func testMentionReplacementWithoutCoordinator() throws {
        let view = makeEditor()
        let range = try XCTUnwrap(view.textRange(from: view.beginningOfDocument, to: view.endOfDocument))
        view.replace(range, withText: "@task")
        XCTAssertTrue(try placeholder(view).isHidden)
        let all = try XCTUnwrap(view.textRange(from: view.beginningOfDocument, to: view.endOfDocument))
        view.replace(all, withText: "")
        XCTAssertFalse(try placeholder(view).isHidden)
    }

    func testLayoutReconcilesDirectStorageChangesWithoutDraftCallbacks() throws {
        let view = makeEditor()
        var changes = 0
        view.onContentChange = { _ in changes += 1 }
        view.textStorage.replaceCharacters(in: NSRange(location: 0, length: 0), with: "dictation")
        view.layoutSubviews()
        XCTAssertTrue(try placeholder(view).isHidden)
        view.textStorage.replaceCharacters(in: NSRange(location: 0, length: view.textStorage.length), with: "")
        view.layoutSubviews()
        XCTAssertFalse(try placeholder(view).isHidden)
        XCTAssertEqual(changes, 0, "Placeholder updates must not invalidate the SwiftUI draft")
    }
}
