import XCTest
import AppKit
import SwiftUI
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor final class SessionDetailHostLifecycleTests: XCTestCase {
    private func session(_ id: String) -> TaskSession {
        TaskSession(id: id, title: id, agent: "Fixture", agentId: nil, sessionKind: .worker,
            workId: "work", taskId: "task-\(id)", status: .complete, progress: 0, summary: "",
            suggestedOptions: nil, suggestedPrompt: nil, activityStatus: nil, updatedAt: "2026-09-01",
            accent: .cyan, archived: false, pinned: false, sortOrder: 0, capabilities: nil, external: nil)
    }
    private func scope(_ id: String, owner: String = "window", task: String? = nil) -> ClientDetailBusinessScope {
        .init(serverID: "fixture", ownerID: owner, principalID: "local", sessionID: id, taskID: task ?? "task-\(id)", workID: "work")
    }
    private func seed(_ repository: ClientDetailBusinessRepository, _ scope: ClientDetailBusinessScope) throws {
        let bytes = Data("""
        {"protocolVersion":1,"catalog":"native-business-v1","documentId":"detail","sessionId":"\(scope.sessionID)","generation":"fixture","revision":"1","cards":[],"order":[]}
        """.utf8)
        try repository.entry(for: scope).store.receive(ClientDetailBusinessDocument.decode(bytes))
    }
    private func present(_ controller: SessionDetailHostController, _ id: String, owner: String = "window", task: String? = nil, active: Bool = true) {
        let value = session(id)
        controller.present(session: value, scope: scope(id, owner: owner, task: task), revision: 0, isActive: active) {
            XCTAssertLessThan(controller.entries.count, 3, "Reserve capacity before constructing a cold host")
            return SessionDetailPanel(session: value, activity: $0, detailPresentation: ConversationDetailPresentationRepository())
        }
    }
    func testInactivePanelDoesNotObserveGlobalCatalogEntityOrSelectionChanges() async throws {
        _ = NSApplication.shared
        let value = session("inactive-detail-observation")
        guard SessionSwitchTrace.shared.begin(sessionID: value.id) != nil else {
            throw XCTSkip("Run with CORPTIE_SESSION_SWITCH_TRACE=1 for actual body counters")
        }
        let activity = ConversationDetailPresentationActivity()
        let host = NSHostingView(rootView: SessionDetailPanel(session: value, activity: activity,
            detailPresentation: ConversationDetailPresentationRepository()))
        let window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 280, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.contentView = nil; window.close(); SessionSwitchTrace.shared.end(reason: "test-finished") }
        host.layoutSubtreeIfNeeded(); await settle()
        let initial = try XCTUnwrap(SessionSwitchTrace.shared.snapshot).detailBodies
        XCTAssertGreaterThan(initial, 0)
        let client = BackendClient.shared
        let previous = client.sessionSelectionController.selectedSessionID
        defer { if let previous { client.sessionSelectionController.select(previous) } else { client.sessionSelectionController.clear() } }
        client.modelCatalog.objectWillChange.send()
        EntityAPIClient.shared.sessionGroupingDidChange.send()
        client.sessionCommandController.objectWillChange.send()
        client.sessionSelectionController.select("unrelated-detail-selection")
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        XCTAssertEqual(try XCTUnwrap(SessionSwitchTrace.shared.snapshot).detailBodies, initial,
            "A mounted inactive Detail must not depend on global source publishers")
    }

    func testWarmReturnReusesMountedHost() async throws {
        let repository = ClientDetailBusinessRepository()
        let controller = SessionDetailHostController(repository: repository)
        defer { controller.disposeAll(); repository.invalidateAll() }
        controller.loadViewIfNeeded()
        controller.view.frame = NSRect(x: 0, y: 0, width: 280, height: 700)
        present(controller, "a")
        let first = try XCTUnwrap(controller.current)
        let document = try ClientDetailBusinessDocument.decode(Data(#"{"protocolVersion":1,"catalog":"native-business-v1","documentId":"detail","sessionId":"a","generation":"fixture","revision":"1","cards":[],"order":[]}"#.utf8))
        try first.handle.store.receive(document)
        let native = first.host.view
        native.layoutSubtreeIfNeeded()
        await settle()
        let children = native.subviews
        XCTAssertFalse(children.isEmpty, "Verify mounted native children, not only an allocated host")
        present(controller, "b"); present(controller, "a")
        XCTAssertTrue(controller.current === first)
        XCTAssertTrue(controller.current?.host.view === native)
        XCTAssertTrue(native.superview === controller.view)
        XCTAssertFalse(native.isHidden)
        XCTAssertEqual(native.subviews.count, children.count)
        for (before, after) in zip(children, native.subviews) { XCTAssertTrue(before === after) }
    }
    func testCapacityNeverExceedsThreeAndEvictionReleasesHost() async throws {
        let repository = ClientDetailBusinessRepository()
        let controller = SessionDetailHostController(repository: repository)
        defer { controller.disposeAll(); repository.invalidateAll() }
        weak var old: NSViewController?
        for index in 0..<7 {
            let id = "s\(index)"
            present(controller, id)
            let entry = try XCTUnwrap(controller.current)
            let data = Data("""
            {"protocolVersion":1,"catalog":"native-business-v1","documentId":"detail","sessionId":"\(id)","generation":"fixture","revision":"1","cards":[],"order":[]}
            """.utf8)
            try entry.handle.store.receive(ClientDetailBusinessDocument.decode(data))
            if index == 0 { old = entry.host }
            XCTAssertLessThanOrEqual(controller.entries.count, 3)
        }
        for _ in 0..<10 { if old == nil { break }; await settle() }
        XCTAssertNil(old)
        XCTAssertEqual(controller.entries.count, 3)
        controller.trimToActive()
        XCTAssertEqual(controller.entries.count, 1)
    }
    func testScopeChangesInvalidateOldViews() throws {
        let repository = ClientDetailBusinessRepository(), controller = SessionDetailHostController(repository: repository)
        defer { controller.disposeAll() }
        try seed(repository, scope("a")); present(controller, "a")
        let first = try XCTUnwrap(controller.current)
        present(controller, "a", task: "rebound")
        XCTAssertFalse(controller.entries.contains { $0 === first })
        let rebound = try XCTUnwrap(controller.current)
        present(controller, "b", owner: "another-window")
        XCTAssertFalse(controller.entries.contains { $0 === rebound })
        let old = try XCTUnwrap(controller.current)
        repository.invalidateAll(); present(controller, "b", owner: "another-window")
        XCTAssertFalse(controller.current === old)
    }
    func testUnknownDetailIsNotRetained() throws {
        let controller = SessionDetailHostController(repository: ClientDetailBusinessRepository())
        defer { controller.disposeAll() }
        present(controller, "unknown")
        let old = try XCTUnwrap(controller.current)
        present(controller, "next")
        XCTAssertFalse(controller.entries.contains { $0 === old })
        XCTAssertFalse(old.activity.isActive)
    }
    func testLegacyDetailIsReleasedEvenWithSelectedBusinessData() async throws {
        let repository = ClientDetailBusinessRepository()
        let controller = SessionDetailHostController(repository: repository)
        let identity = scope("legacy")
        let handle = repository.entry(for: identity)
        let lease = repository.acquire(handle, api: { throw ClientServiceFailure(statusCode: 409, code: "DETAIL_CATALOG_UNSUPPORTED") })
        defer { controller.disposeAll(); repository.release(lease, from: handle); repository.invalidateAll() }
        for _ in 0..<10 { if handle.legacy { break }; await settle() }
        XCTAssertTrue(handle.legacy)
        try seed(repository, identity)
        XCTAssertTrue(handle.store.selected)
        present(controller, "legacy")
        let old = try XCTUnwrap(controller.current)
        present(controller, "next")
        XCTAssertFalse(controller.entries.contains { $0 === old })
        XCTAssertFalse(old.activity.isActive)
    }
    func testHiddenOrDetachedWindowSuspendsActivity() async throws {
        let repository = ClientDetailBusinessRepository(), controller = SessionDetailHostController(repository: repository)
        let window = DetailLifecycleTestWindow(contentRect: NSRect(x: 200, y: 200, width: 280, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentViewController = controller
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        defer { controller.disposeAll(); window.contentViewController = nil; window.close() }
        present(controller, "a")
        await settle()
        controller.refreshVisibility()
        let activity = try XCTUnwrap(controller.current?.activity)
        XCTAssertTrue(activity.isActive, "windowVisible=\(window.isVisible) occlusion=\(window.occlusionState.rawValue) hidden=\(controller.view.isHiddenOrHasHiddenAncestor) attached=\(controller.view.window === window) current=\(controller.current != nil)")
        controller.view.isHidden = true
        XCTAssertFalse(activity.isActive)
        controller.view.isHidden = false; await settle(); controller.refreshVisibility()
        XCTAssertTrue(activity.isActive, "windowVisible=\(window.isVisible) occlusion=\(window.occlusionState.rawValue) hidden=\(controller.view.isHiddenOrHasHiddenAncestor) attached=\(controller.view.window === window) current=\(controller.current != nil)")
        window.reportedOcclusion = []
        controller.refreshVisibility()
        XCTAssertFalse(activity.isActive)
        window.reportedOcclusion = .visible
        controller.refreshVisibility()
        XCTAssertTrue(activity.isActive)
        present(controller, "a", active: false)
        XCTAssertFalse(activity.isActive)
        present(controller, "a")
        window.contentViewController = nil
        XCTAssertFalse(activity.isActive)
    }
    func testResizeOnlyLaysOutVisibleHost() throws {
        let repository = ClientDetailBusinessRepository(), controller = SessionDetailHostController(repository: repository)
        defer { controller.disposeAll() }
        controller.loadViewIfNeeded(); controller.view.frame = NSRect(x: 0, y: 0, width: 280, height: 700)
        try seed(repository, scope("a")); present(controller, "a")
        let old = try XCTUnwrap(controller.current?.host.view)
        let original = old.frame
        try seed(repository, scope("b")); present(controller, "b")
        controller.view.frame.size.height = 600
        controller.view.needsLayout = true; controller.view.layoutSubtreeIfNeeded()
        XCTAssertEqual(old.frame, original)
        XCTAssertEqual(controller.current?.host.view.frame.height, 600)
        present(controller, "a")
        XCTAssertEqual(old.frame.height, 600)
    }
    private func settle() async { try? await Task.sleep(for: .milliseconds(160)) }
}

/// Window-server occlusion is nondeterministic for an xctest executable in a busy desktop.
/// Keep actual NSWindow attachment/hiding, and control only this OS-provided input.
@MainActor private final class DetailLifecycleTestWindow: NSWindow {
    var reportedOcclusion: NSWindow.OcclusionState = .visible
    override var occlusionState: NSWindow.OcclusionState { reportedOcclusion }
}
