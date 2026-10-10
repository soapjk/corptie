import XCTest
import AppKit
import CorptieConversation
@testable import CorptieMac

/// The composer's geometry, key semantics and mention catalog are shared with the
/// iPad; these pin the desktop values the shared layer must keep producing.
final class ComposerShellPolicyTests: XCTestCase {
    func testEmptyDraftRejectsStaleExpandedHeight() {
        XCTAssertEqual(ComposerInputLayout.resolvedHeight(text: "", measuredHeight: 96), 30)
        XCTAssertEqual(ComposerInputLayout.resolvedHeight(text: "", measuredHeight: 400), 30)
        XCTAssertEqual(ComposerInputLayout.resolvedHeight(text: "new draft", measuredHeight: 60), 60)
        XCTAssertEqual(ComposerInputLayout.resolvedHeight(text: "a\nb", measuredHeight: 120), 96)
    }

    @MainActor func testNativeEditorMeasurementAfterClearReturnsMinimumHeight() {
        let draft = ComposerDraftBuffer()
        let controller = ComposerEditorController(draft: draft)
        var heights: [CGFloat] = []
        let input = ComposerInputTextView(controller: controller, placeholder: "", font: .systemFont(ofSize: 12),
            onFocusChange: { _ in }, onSendableTextChange: { _ in },
            onContentHeightChange: { heights.append($0) }, onSubmit: { _ in })
        let coordinator = input.makeCoordinator()
        let text = NSTextView(frame: NSRect(x: 0, y: 0, width: 120, height: 500))
        text.string = String(repeating: "multiline\n", count: 20)
        coordinator.reportContentHeight(of: text)
        XCTAssertGreaterThan(heights.last ?? 0, 30)
        text.string = ""
        coordinator.reportContentHeight(of: text)
        XCTAssertEqual(heights.last, 30)
        text.string = "new"
        coordinator.reportContentHeight(of: text)
        XCTAssertEqual(heights.last, 30)
    }

    func testStopAndSendShareVisualSizeButRetainTouchTarget() throws {
        let sources = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("Sources/CopetsMac")
        let stop = try String(contentsOf: sources.appendingPathComponent("SessionComposerStopButton.swift"), encoding: .utf8)
        let send = try String(contentsOf: sources.appendingPathComponent("Conversation/Composer/MessageComposer.swift"), encoding: .utf8)
        XCTAssertTrue(stop.contains("ComposerShellMetrics.actionVisualEdge"))
        XCTAssertTrue(send.contains("sendControlEdge = ComposerShellMetrics.actionVisualEdge"))
        XCTAssertTrue(stop.contains("compact ? ComposerShellMetrics.actionHitEdge : 44"))
        XCTAssertEqual(ComposerShellMetrics.actionVisualEdge, 22)
    }

    func testCompactComposerDefaultsToOneLineAndBoundsGrowth() {
        XCTAssertEqual(CompactComposerLayout.maximumWidth, 460)
        XCTAssertEqual(CompactComposerLayout.resolvedInputHeight(12), 30)
        XCTAssertEqual(CompactComposerLayout.resolvedInputHeight(50), 50)
        XCTAssertEqual(CompactComposerLayout.resolvedInputHeight(120), 72)
        XCTAssertLessThan(CompactComposerLayout.textInsetHeight, ComposerShellMetrics.textInsetHeight)
    }

    func testDesktopInputLayoutDelegatesToSharedClamp() {
        XCTAssertEqual(ComposerInputLayout.minimumHeight, 30)
        XCTAssertEqual(ComposerInputLayout.maximumHeight, 96)
        XCTAssertEqual(ComposerInputLayout.resolvedHeight(for: 10), 30)
        XCTAssertEqual(ComposerInputLayout.resolvedHeight(for: 60.2), 61)
        XCTAssertEqual(ComposerInputLayout.resolvedHeight(for: 400), 96)
        XCTAssertEqual(ComposerShellMetrics.resolvedInputHeight(for: 60.2), ComposerInputLayout.resolvedHeight(for: 60.2))
    }

    func testModelMenuWidthYieldsToEditor() {
        XCTAssertEqual(ComposerShellMetrics.modelMenuMaxWidth(composerWidth: 0), 74)
        XCTAssertEqual(ComposerShellMetrics.modelMenuMaxWidth(composerWidth: 600), 74)
        XCTAssertEqual(ComposerShellMetrics.modelMenuMaxWidth(composerWidth: 360), 60)
        XCTAssertEqual(ComposerShellMetrics.modelMenuMaxWidth(composerWidth: 120), 54)
    }

    func testReturnSubmitsUnlessComposingOrShifted() {
        XCTAssertEqual(ComposerKeyPolicy.action(for: .return, shift: false, hasMarkedText: false, mentionMenuActive: false), .submit)
        XCTAssertEqual(ComposerKeyPolicy.action(for: .return, shift: true, hasMarkedText: false, mentionMenuActive: false), .passThrough)
        XCTAssertEqual(ComposerKeyPolicy.action(for: .return, shift: false, hasMarkedText: true, mentionMenuActive: true), .passThrough)
        XCTAssertEqual(ComposerKeyPolicy.action(for: .return, shift: false, hasMarkedText: false, mentionMenuActive: true), .mentionSelect)
    }

    func testMentionMenuOwnsArrowsAndEscapeOnlyWhileActive() {
        XCTAssertEqual(ComposerKeyPolicy.action(for: .downArrow, shift: false, hasMarkedText: false, mentionMenuActive: true), .mentionMove(1))
        XCTAssertEqual(ComposerKeyPolicy.action(for: .upArrow, shift: false, hasMarkedText: false, mentionMenuActive: true), .mentionMove(-1))
        XCTAssertEqual(ComposerKeyPolicy.action(for: .escape, shift: false, hasMarkedText: false, mentionMenuActive: true), .mentionDismiss)
        XCTAssertEqual(ComposerKeyPolicy.action(for: .downArrow, shift: false, hasMarkedText: false, mentionMenuActive: false), .passThrough)
        XCTAssertEqual(ComposerKeyPolicy.action(for: .escape, shift: false, hasMarkedText: false, mentionMenuActive: false), .passThrough)
    }

    func testMentionCatalogOrdersWorksBeforeTheirSessionsAndOrphansLast() {
        let suggestions = ComposerMentionCatalog.suggestions(
            works: [.init(id: "w1", name: "Alpha"), .init(id: "w2", name: "Beta")],
            sessions: [
                .init(id: "s-orphan", title: "Loose", workId: nil),
                .init(id: "s-b", title: "Beta chat", workId: "w2"),
                .init(id: "s-a", title: "Alpha chat", workId: "w1"),
                .init(id: "s-current", title: "Me", workId: "w1"),
            ],
            currentSessionID: "s-current", activeMentionIDs: [], query: "")

        XCTAssertEqual(suggestions.map(\.id), ["work:w1", "session:s-a", "work:w2", "session:s-b", "session:s-orphan"])
        XCTAssertEqual(suggestions[1].detail, "Session · Work: Alpha")
        XCTAssertEqual(suggestions[4].detail, "Session")
    }

    func testMentionCatalogFiltersActiveMentionsAndQuery() {
        let works: [ComposerMentionCatalog.Work] = [.init(id: "w1", name: "Alpha"), .init(id: "w2", name: "Beta")]
        let filtered = ComposerMentionCatalog.suggestions(works: works, sessions: [], currentSessionID: "x",
                                                          activeMentionIDs: ["work:w1"], query: " al ")
        XCTAssertTrue(filtered.isEmpty)
        let matched = ComposerMentionCatalog.suggestions(works: works, sessions: [], currentSessionID: "x",
                                                         activeMentionIDs: [], query: "bet")
        XCTAssertEqual(matched.map(\.id), ["work:w2"])
        let saturated = ComposerMentionCatalog.suggestions(works: works, sessions: [], currentSessionID: "x",
                                                           activeMentionIDs: Set((0..<8).map { "session:\($0)" }), query: "")
        XCTAssertTrue(saturated.isEmpty)
    }

    func testModelLabelsMatchDesktopMenu() {
        XCTAssertEqual(ComposerModelLabel.compact("gpt-5-codex-preview-long"), "gpt-5-codex-pr…")
        XCTAssertEqual(ComposerModelLabel.reasoningShort("xhigh"), "XH")
        XCTAssertEqual(ComposerModelLabel.reasoningTitle("xhigh"), "Extra High")
        XCTAssertTrue(ComposerModelLabel.menuEnabled(canSwitchModel: false, canSwitchReasoning: true,
                                                     isSwitchingModel: false, isSwitchingReasoning: false))
        XCTAssertFalse(ComposerModelLabel.menuEnabled(canSwitchModel: true, canSwitchReasoning: true,
                                                      isSwitchingModel: true, isSwitchingReasoning: false))
    }
}
