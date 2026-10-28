import AppKit
import SwiftUI
import XCTest
import CorptieConversation

@MainActor
final class ConversationSkinInputIdentityTests: XCTestCase {
    func testComposerSkinChangeRetainsEditorDraftSelectionAndMarkedText() throws {
        _ = NSApplication.shared
        let probe = SkinEditorProbeState()
        func root(_ skin: ConversationSkin) -> some View {
            ConversationComposerChrome(header: { EmptyView() }, content: { SkinEditorProbe(state: probe) })
                .environment(\.conversationSkin, skin)
        }
        let host = NSHostingView(rootView: root(.classic))
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 100)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        defer { window.contentView = nil }
        host.layoutSubtreeIfNeeded()
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
        let editor = try XCTUnwrap(probe.editor)
        window.makeFirstResponder(editor)
        editor.string = "Draft "
        editor.setSelectedRange(NSRange(location: 6, length: 0))
        editor.setMarkedText("输入", selectedRange: NSRange(location: 2, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        XCTAssertTrue(editor.hasMarkedText())
        let draft = editor.string
        let selected = editor.selectedRange()
        let marked = editor.markedRange()
        for skin in [ConversationSkin.codexFlat, .classic] {
            host.rootView = root(skin)
            host.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
            XCTAssertEqual(probe.creations, 1)
            XCTAssertTrue(probe.editor === editor)
            XCTAssertTrue(window.firstResponder === editor)
            XCTAssertEqual(editor.string, draft)
            XCTAssertEqual(editor.selectedRange(), selected)
            XCTAssertEqual(editor.markedRange(), marked)
        }
    }
}

@MainActor
private final class SkinEditorProbeState {
    var creations = 0
    weak var editor: NSTextView?
}

private struct SkinEditorProbe: NSViewRepresentable {
    let state: SkinEditorProbeState
    func makeNSView(context: Context) -> NSTextView {
        state.creations += 1
        let editor = NSTextView()
        state.editor = editor
        return editor
    }
    func updateNSView(_ nsView: NSTextView, context: Context) {}
}
