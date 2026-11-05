import AppKit
import Combine
import Observation
import SwiftUI
import XCTest
@testable import CorptieMac

@MainActor
final class ComposerRegionIsolationTests: XCTestCase {
    func testTenThousandMentionMatchesResolveOnlyMountedRows() async throws {
        _ = NSApplication.shared
        let sessions = try (0..<10_000).map { index in
            let fields: [String: Any] = ["id": "s\(index)", "title": "Chat \(index)", "agent": "OtherProvider",
                "status": "complete", "progress": 1, "summary": "", "updatedAt": "2026-11-05", "accent": "cyan"]
            return try JSONDecoder().decode(TaskSession.self, from: JSONSerialization.data(withJSONObject: fields))
        }
        let presentation = ComposerMentionPresentation()
        let search = presentation.search
        await search.search(.init(query: "", catalogRevision: 1, draftRevision: 1,
            selectedMentions: [], active: true), sessionID: "current", sessions: sessions, works: [], draft: "@")
        XCTAssertEqual(search.matches.count, 10_000)
        let select = ComposerMentionSelectionAction(controller: .init(draft: .init(text: "@")),
            presentation: presentation, renderInputs: nil,
            hasSendableText: .constant(false), selectedMentions: .constant([]))
        let host = NSHostingView(rootView: ComposerMentionMenu(search: search, select: select))
        host.frame = .init(x: 0, y: 0, width: 480, height: 400)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.contentView = nil }
        try await settle(host)
        XCTAssertGreaterThan(search.candidateResolutionCount, 0)
        XCTAssertLessThan(search.candidateResolutionCount, 100,
            "List identity must not resolve all 10,000 candidate presentations")
    }

    func testLegacyShellIgnoresUnrelatedCommandsAndDuplicateSendingValues() {
        let commands = SessionCommandController()
        var updates = 0
        let subscription = LegacyComposerInvalidation.commandUpdates(commands).sink { _ in updates += 1 }
        defer { subscription.cancel() }
        XCTAssertEqual(updates, 1)
        commands.projectWorktreeActionError = "Unrelated Git action"
        commands.isSwitchingModel = true
        commands.scheduledTaskError = "Unrelated schedule action"
        XCTAssertEqual(updates, 1)
        commands.isSendingMessage = true
        XCTAssertEqual(updates, 2)
        commands.isSendingMessage = true
        XCTAssertEqual(updates, 2)
        commands.isSendingMessage = false
        XCTAssertEqual(updates, 3)
    }

    private final class BodyCount { var value = 0 }
    @Observable final class Controls {
        var running = false
        var sendable = false
        var mentions: [ConversationMention] = []
    }

    private struct Harness: View {
        let controller: ComposerEditorController
        let count: BodyCount
        let controls: Controls
        @State private var sendable = true
        @State private var mentions: [ConversationMention] = []

        var body: some View {
            count.value += 1
            return VStack {
                ComposerEditorSurface(sessionId: "isolation", editorController: controller,
                    backendClient: BackendClient.shared, renderInputs: nil,
                    legacyMentionCatalogRevision: 0, compact: false,
                    hasSendableText: $sendable, selectedMentions: $mentions,
                    onPasteImages: { _ in false }, onSubmit: { _ in })
                ComposerActionSurface(showsModel: true, showsStop: controls.running) {
                    Text("Model")
                } stop: { Text("Stop") } send: { Text("Send") }
            }.frame(maxWidth: .infinity, alignment: .topLeading)
        }
    }

    private func editor(in view: NSView) -> NSTextView? {
        if let text = view as? NSTextView { return text }
        return view.subviews.lazy.compactMap { self.editor(in: $0) }.first
    }

    private func settle(_ host: NSView) async throws {
        host.layoutSubtreeIfNeeded()
        try await Task.sleep(for: .milliseconds(80))
        host.layoutSubtreeIfNeeded()
    }

    func testMentionActionRejectsSuspendedEditorAndReadsCurrentQuery() {
        let controller = ComposerEditorController(draft: ComposerDraftBuffer(text: "@a"))
        let text = NSTextView()
        text.string = controller.draft.text
        controller.attach(text)
        let presentation = ComposerMentionPresentation()
        presentation.query = .init(replacementRange: NSRange(location: 0, length: 2), text: "a")
        presentation.draftRevision = controller.draft.revision
        @Bindable var state = Controls()
        let select = ComposerMentionSelectionAction(controller: controller, presentation: presentation,
            renderInputs: nil, hasSendableText: $state.sendable, selectedMentions: $state.mentions)
        let candidate = ComposerMentionCandidate(mention: .init(targetType: .session,
            targetId: "alpha", displayName: "Alpha"), detail: "", symbol: "bubble")
        controller.suspendPresentation()
        select(candidate)
        XCTAssertEqual(text.string, "@a")
        XCTAssertTrue(state.mentions.isEmpty)
        controller.resumePresentation()
        // The action predates this query change. It must use the new range.
        text.string = "hello @b"
        controller.recordEditorText(text.string)
        presentation.query = .init(replacementRange: NSRange(location: 6, length: 2), text: "b")
        presentation.draftRevision = controller.draft.revision
        select(candidate)
        XCTAssertEqual(text.string, "hello @Alpha ")
        XCTAssertEqual(state.mentions.map(\.targetId), ["alpha"])
        XCTAssertTrue(state.sendable)
        XCTAssertNil(presentation.query)
        select(candidate)
        XCTAssertEqual(state.mentions.count, 1, "A dismissed query cannot be selected again")
    }

    func testNativeTypingHeightIsLocalAndDoesNotEvaluateToolbarParent() async throws {
        _ = NSApplication.shared
        let controller = ComposerEditorController(draft: ComposerDraftBuffer(text: "Hello"))
        let count = BodyCount(), controls = Controls()
        let host = NSHostingView(rootView: Harness(controller: controller, count: count, controls: controls))
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.contentView = nil }
        try await settle(host)
        let text = try XCTUnwrap(editor(in: host))
        let originalHeight = try XCTUnwrap(text.enclosingScrollView).frame.height
        let parentCount = count.value
        text.string = (0..<20).map { "Line \($0): resize should stay local" }.joined(separator: "\n")
        text.didChangeText()
        try await settle(host)
        XCTAssertEqual(controller.draft.text, text.string)
        XCTAssertGreaterThan(try XCTUnwrap(text.enclosingScrollView).frame.height, originalHeight)
        XCTAssertEqual(count.value, parentCount, "A local height change must not reevaluate sibling toolbar construction")
        XCTAssertTrue(editor(in: host) === text)
        text.setSelectedRange(NSRange(location: 4, length: 2))
        controls.running = true
        try await settle(host)
        XCTAssertTrue(editor(in: host) === text, "Stop insertion must retain the native editor")
        XCTAssertEqual(text.selectedRange(), NSRange(location: 4, length: 2))
    }

    func testProgrammaticClearAndFailureRestoreKeepEditorAndResetHeight() async throws {
        _ = NSApplication.shared
        let draft = ComposerDraftBuffer(text: String(repeating: "Long draft\n", count: 20))
        let controller = ComposerEditorController(draft: draft)
        let host = NSHostingView(rootView: Harness(controller: controller, count: BodyCount(), controls: Controls()))
        host.frame = NSRect(x: 0, y: 0, width: 480, height: 240)
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { window.contentView = nil }
        try await settle(host)
        let text = try XCTUnwrap(editor(in: host))
        let submission = try XCTUnwrap(controller.submission())
        XCTAssertTrue(controller.clear(ifUnchangedSince: submission))
        try await settle(host)
        XCTAssertTrue(editor(in: host) === text)
        XCTAssertEqual(text.string, "")
        XCTAssertLessThanOrEqual(try XCTUnwrap(text.enclosingScrollView).frame.height, 44.5)
        XCTAssertTrue(controller.restoreAfterFailedSubmission(submission))
        try await settle(host)
        XCTAssertTrue(editor(in: host) === text)
        XCTAssertEqual(text.string, submission.text)
        XCTAssertGreaterThan(try XCTUnwrap(text.enclosingScrollView).frame.height, 44.5)
    }
}
