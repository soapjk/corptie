import AppKit
import CorptieClientCore
import CorptieConversation
import XCTest
@testable import CorptieMac

/// Actual panel/SwiftUI/native editor lifecycle, not source-string contracts.
@MainActor
final class FloatingPanelPresentationLifecycleTests: XCTestCase {
    private var fixtureIDs: [String] = []

    override func tearDown() async throws {
        for id in fixtureIDs { SessionTimelineRepository.shared.remove(id) }
        let store = AppStateStore.shared
        _ = store.apply(changeSet: .init(snapshotRequired: false, baseRevision: store.revision,
            revision: store.revision + 1,
            upserts: .init(sessions: [], tasks: [], works: [], agents: [], skills: [], repositories: [], integrationRuns: []),
            deletes: .init(sessions: fixtureIDs, tasks: [], works: [], agents: [], skills: [], repositories: [], integrationRuns: [])))
        fixtureIDs = []
        try await super.tearDown()
    }

    private func seed(_ client: BackendClient, _ suffix: String) -> String {
        let id = "fixture:floating-\(UUID().uuidString)-\(suffix)"
        fixtureIDs.append(id)
        let session = TaskSession(id: id, title: "Lifecycle \(suffix)", agent: "Fixture", agentId: nil,
            sessionKind: .assistantChat, status: .complete, progress: 1, summary: "",
            suggestedOptions: nil, suggestedPrompt: nil, activityStatus: nil, updatedAt: "2026-10-24",
            accent: .cyan, archived: false, pinned: false, sortOrder: 0, capabilities: nil, external: nil)
        _ = client.appState.acceptCreatedSession(session)
        // This is an online local fixture, independent of test ordering. An
        // offline conversation intentionally has no editable composer.
        client.appState.reportStateStreamConnected()
        let fixture = ChatPerformanceFixture.make(configuration: .init(turnCount: 4, rawItemCount: 20, longMessageCharacters: 800))
        client.storeCachedDetail(fixture.detail, for: id)
        return id
    }

    private func panel(_ client: BackendClient, viewport: SessionViewportController = .init(repository: nil)) throws -> (FloatingPanelController, NSWindow) {
        _ = NSApplication.shared
        let before = Set(NSApp.windows.map(ObjectIdentifier.init))
        let controller = FloatingPanelController(client: client, viewportController: viewport)
        let window = try XCTUnwrap(NSApp.windows.first { !before.contains(ObjectIdentifier($0)) && $0 is FloatingPanel })
        window.isReleasedWhenClosed = false
        return (controller, window)
    }

    private func pump(_ window: NSWindow, for seconds: TimeInterval = 0.4) {
        let deadline = Date().addingTimeInterval(seconds)
        repeat {
            window.contentView?.layoutSubtreeIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        } while Date() < deadline
    }

    private func descendants(_ view: NSView?) -> [NSView] {
        guard let view else { return [] }
        return [view] + view.subviews.flatMap { descendants($0) }
    }

    private func editor(_ window: NSWindow) -> NSTextView? {
        descendants(window.contentView).compactMap { $0 as? NSTextView }.first { $0.isEditable }
    }

    private func waitForEditor(_ window: NSWindow) -> NSTextView? {
        let deadline = Date().addingTimeInterval(5)
        while editor(window) == nil && Date() < deadline { pump(window, for: 0.05) }
        return editor(window)
    }

    func testHiddenSelectionDoesNotMountConversation() throws {
        let client = BackendClient()
        let one = seed(client, "one"), two = seed(client, "two")
        let (controller, window) = try panel(client)
        defer { controller.hide(); window.close() }
        let frame = window.frame
        for id in [one, two, one, two] { client.sessionSelectionController.select(id) }
        pump(window, for: 0.6)
        XCTAssertFalse(window.isVisible)
        XCTAssertEqual(window.frame, frame)
        XCTAssertNil(editor(window))
        XCTAssertTrue(descendants(window.contentView).compactMap { $0 as? NSTableView }.isEmpty)
    }

    func testDeferredMainWindowCleanupDoesNotSuspendReopenedPanel() throws {
        let client = BackendClient()
        let id = seed(client, "foreground")
        let (controller, window) = try panel(client)
        defer { controller.hide(); window.close() }
        client.sessionSelectionController.select(id)
        controller.show()
        let first = try XCTUnwrap(waitForEditor(window))
        first.insertText("keep foreground draft", replacementRange: NSRange(location: 0, length: first.string.utf16.count))
        controller.hideAfterMainWindowForegrounding()
        XCTAssertFalse(window.isVisible)
        controller.show()
        pump(window)
        XCTAssertTrue(window.isVisible)
        XCTAssertTrue(editor(window) === first)
        XCTAssertEqual(editor(window)?.string, "keep foreground draft")
        controller.hideAfterMainWindowForegrounding()
        pump(window)
        XCTAssertFalse(window.isVisible)
        XCTAssertNil(editor(window))
    }

    func testShowMountsLatestSelectionAndRetainsPerSessionDrafts() throws {
        let client = BackendClient()
        let one = seed(client, "one"), two = seed(client, "two")
        let (controller, window) = try panel(client)
        defer { controller.hide(); window.close() }
        client.sessionSelectionController.select(one)
        controller.show()
        pump(window, for: 0.8)
        let first = try XCTUnwrap(editor(window))
        first.insertText("draft one", replacementRange: NSRange(location: 0, length: first.string.utf16.count))
        controller.hide()
        pump(window)
        XCTAssertNil(editor(window))
        client.sessionSelectionController.select(two)
        controller.show()
        pump(window, for: 0.8)
        let second = try XCTUnwrap(editor(window))
        XCTAssertTrue(second.string.isEmpty)
        second.insertText("draft two", replacementRange: NSRange(location: 0, length: 0))
        controller.hide()
        client.sessionSelectionController.select(one)
        controller.show()
        pump(window, for: 0.8)
        XCTAssertEqual(editor(window)?.string, "draft one")
        controller.hide()
        client.sessionSelectionController.select(two)
        controller.show()
        pump(window, for: 0.8)
        XCTAssertEqual(editor(window)?.string, "draft two")
    }

    func testHideCancelsDelayedTransitionsAndCloseUsesSameSuspension() throws {
        let client = BackendClient()
        let one = seed(client, "one"), two = seed(client, "two")
        let (controller, window) = try panel(client)
        defer { controller.hide(); window.close() }
        client.sessionSelectionController.select(one)
        controller.show()
        pump(window)
        client.sessionSelectionController.select(two)
        RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        XCTAssertFalse(controller.windowShouldClose(window))
        let hiddenFrame = window.frame
        pump(window, for: 0.7)
        XCTAssertFalse(window.isVisible)
        XCTAssertNil(editor(window))
        XCTAssertEqual(window.frame, hiddenFrame)
        client.sessionSelectionController.select(one)
        controller.show()
        pump(window, for: 0.8)
        XCTAssertTrue(window.isVisible)
        XCTAssertNotNil(editor(window))
    }

    func testViewportIsCapturedBeforeHiddenTranscriptIsRemoved() throws {
        let client = BackendClient()
        let id = seed(client, "viewport")
        let viewport = SessionViewportController(repository: nil)
        let (controller, window) = try panel(client, viewport: viewport)
        defer { controller.hide(); window.close() }
        client.sessionSelectionController.select(id)
        controller.show()
        pump(window, for: 1)
        let table = try XCTUnwrap(descendants(window.contentView).compactMap { $0 as? NSTableView }.first)
        let scroll = try XCTUnwrap(table.enclosingScrollView)
        let coordinator = try XCTUnwrap(table.delegate as? AppKitChatTimelineCoordinator)
        coordinator.userScrollEventWillBegin()
        scroll.contentView.scroll(to: NSPoint(x: 0, y: 0))
        scroll.reflectScrolledClipView(scroll.contentView)
        coordinator.userScrollEventDidEnd()
        pump(window, for: 0.2)
        controller.hide()
        let captured = try XCTUnwrap(viewport.position(for: id))
        XCTAssertFalse(captured.followsLatest)
        XCTAssertNotNil(captured.rowID)
        pump(window)
        XCTAssertNil(editor(window))
        controller.show()
        pump(window, for: 0.8)
        XCTAssertEqual(viewport.position(for: id)?.rowID, captured.rowID)
        XCTAssertFalse(viewport.position(for: id)?.followsLatest ?? true)
    }

    func testApplicationHideNotificationSuspendsAndUnhideUsesLatestSelection() throws {
        let client = BackendClient()
        let one = seed(client, "one"), two = seed(client, "two")
        let (controller, window) = try panel(client)
        defer { controller.hide(); window.close() }
        client.sessionSelectionController.select(one)
        controller.show()
        pump(window, for: 0.8)
        XCTAssertNotNil(waitForEditor(window))
        NotificationCenter.default.post(name: NSApplication.didHideNotification, object: NSApp)
        pump(window)
        XCTAssertNil(editor(window))
        client.sessionSelectionController.select(two)
        NotificationCenter.default.post(name: NSApplication.didUnhideNotification, object: NSApp)
        pump(window, for: 0.8)
        XCTAssertNotNil(waitForEditor(window))
        XCTAssertEqual(client.selectedSession?.id, two)
    }
}
