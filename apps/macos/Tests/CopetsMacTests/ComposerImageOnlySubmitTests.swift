import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class ComposerImageOnlySubmitTests: XCTestCase {
    private func key(_ code: UInt16 = 36, modifiers: NSEvent.ModifierFlags = []) throws -> NSEvent {
        try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: modifiers,
            timestamp: 0, windowNumber: 0, context: nil, characters: "\r",
            charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: code))
    }

    private func coordinator(_ controller: ComposerEditorController,
                             submit: @escaping (ComposerDraftBuffer.Submission) -> Void)
        -> ComposerInputTextView.Coordinator {
        .init(controller: controller, onFocusChange: { _ in }, onSendableTextChange: { _ in },
            onContentHeightChange: { _ in }, onMentionQueryChange: { _ in },
            onMentionAnchorChange: { _ in }, onMentionCommand: { _ in false }, onSubmit: submit)
    }

    func testReturnAndKeypadEnterSubmitImageOnlyDraftAndRejectAnEmptyDraft() throws {
        _ = NSApplication.shared
        let draft = ComposerDraftBuffer()
        let controller = ComposerEditorController(draft: draft)
        let text = ComposerInputTextView.ComposerSubmitTextView()
        var submissions: [ComposerDraftBuffer.Submission] = []
        let bridge = coordinator(controller) { submissions.append($0) }
        controller.attach(text)
        bridge.attach(text)
        text.keyDown(with: try key())
        XCTAssertTrue(submissions.isEmpty)

        draft.images = [.init(managedPath: "test-screenshot.png", originalPath: nil)]
        text.keyDown(with: try key())
        text.keyDown(with: try key(76))
        XCTAssertEqual(submissions.count, 2)
        XCTAssertEqual(submissions.first?.text, "")
        XCTAssertEqual(submissions.first, controller.submission(allowingImageOnly: true))
        XCTAssertNil(controller.submission(), "Text-only operations retain their original semantics")

        controller.suspendPresentation()
        text.keyDown(with: try key())
        XCTAssertEqual(submissions.count, 2)
    }

    func testShiftReturnDoesNotSubmitAndMarkedTextCannotProduceAnImageOnlySubmission() throws {
        let draft = ComposerDraftBuffer()
        draft.images = [.init(managedPath: "test-screenshot.png", originalPath: nil)]
        let controller = ComposerEditorController(draft: draft)
        let text = ComposerInputTextView.ComposerSubmitTextView()
        var count = 0
        let bridge = coordinator(controller) { _ in count += 1 }
        controller.attach(text)
        bridge.attach(text)
        text.keyDown(with: try key(modifiers: .shift))
        XCTAssertEqual(count, 0)
        let marked = ComposerInputTextView.ComposerSubmitTextView()
        controller.attach(marked)
        marked.setMarkedText("拼", selectedRange: NSRange(location: 1, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(marked.hasMarkedText())
        XCTAssertNil(controller.submission(allowingImageOnly: true))
    }
}
