import XCTest
import CorptieConversation
@testable import CorptieMac

/// The composer's geometry, key semantics and mention catalog are shared with the
/// iPad; these pin the desktop values the shared layer must keep producing.
final class ComposerShellPolicyTests: XCTestCase {
    func testDesktopInputLayoutDelegatesToSharedClamp() {
        XCTAssertEqual(ComposerInputLayout.minimumHeight, 44)
        XCTAssertEqual(ComposerInputLayout.maximumHeight, 96)
        XCTAssertEqual(ComposerInputLayout.resolvedHeight(for: 10), 44)
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
