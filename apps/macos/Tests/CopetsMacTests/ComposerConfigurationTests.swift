import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class ComposerConfigurationTests: XCTestCase {
    func testFastIsIndependentFromReasoningAndOnlyUsesAdvertisedTiers() {
        XCTAssertNil(ComposerServiceTier.fastID(nil))
        XCTAssertNil(ComposerServiceTier.fastID([.init(id: "ultrafast", name: "Ultra")]))
        XCTAssertEqual(ComposerServiceTier.fastID([.init(id: "priority", name: "Fast")]), "priority")
        XCTAssertFalse(ComposerServiceTier.isFast("default"))
        XCTAssertTrue(ComposerServiceTier.isFast("priority"))
    }
    func testCreationOptionsSurviveNavigationAndRetry() {
        let draft = UnifiedCreationDraft()
        draft.prepare(.init(workID: "work"))
        draft.permission = .init(sandbox: "read-only", approval: "on-request")
        draft.serviceTier = "priority"
        draft.prompt = "Hello"
        let request = draft.requestID
        draft.prepare(.init())
        XCTAssertTrue(draft.taskMode)
        XCTAssertEqual(draft.permission.sandbox, "read-only")
        XCTAssertEqual(draft.serviceTier, "priority")
        draft.submissionStarted = true
        draft.selectWork(nil)
        XCTAssertEqual(draft.requestID, request)
        XCTAssertEqual(draft.workID, "work")
        XCTAssertFalse(draft.configurationApplied)
    }
    func testTransitionReleasesSnapshotAndRevealsDestination() async throws {
        let root = NSView(frame: .init(x: 0, y: 0, width: 800, height: 600))
        let source = NSView(frame: .init(x: 100, y: 300, width: 600, height: 160))
        let destination = NSView(frame: .init(x: 50, y: 10, width: 700, height: 80))
        root.addSubview(source); root.addSubview(destination)
        let window = NSWindow(contentRect: root.bounds, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = root
        defer { window.contentView = nil; window.close() }
        let transition = ComposerCreationTransition()
        transition.source = source
        transition.begin(sessionID: "s")
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            XCTAssertEqual(transition.concealedSessionID, "s")
            XCTAssertEqual(root.subviews.count, 3)
            transition.destinationReady(destination, sessionID: "s")
            try await Task.sleep(for: .milliseconds(350))
        }
        XCTAssertNil(transition.concealedSessionID)
        XCTAssertEqual(root.subviews.count, 2)
        transition.begin(sessionID: "next")
        transition.cancel(sessionID: "next")
        XCTAssertNil(transition.concealedSessionID)
        XCTAssertEqual(root.subviews.count, 2)
    }
}
