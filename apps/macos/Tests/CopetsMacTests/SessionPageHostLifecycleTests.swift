import AppKit
import SwiftUI
import XCTest
import CorptieClientCore
@testable import CorptieMac

@MainActor final class SessionPageHostLifecycleTests: XCTestCase {
    private final class Presenter: SessionPagePresenting {
        var callbacks: [@MainActor (SessionPresentationFrameGate.Outcome) -> Void] = []
        var accepts = true
        var cancellations = 0
        func presentOpeningPage(sessionID: String, title: String,
                                activate: @escaping @MainActor (SessionPresentationFrameGate.Outcome) -> Void) -> Bool {
            callbacks.append(activate); return accepts
        }
        func cancelPendingPresentation() { cancellations += 1 }
    }

    func testRapidRequestsAndExternalSelectionCannotActivateStaleTarget() {
        let state = SessionPagePresentationState(), presenter = Presenter()
        state.presenter = presenter
        var selected: [String] = []
        XCTAssertTrue(state.request(sessionID: "a", title: "A") { selected.append("a") })
        XCTAssertTrue(state.request(sessionID: "b", title: "B") { selected.append("b") })
        presenter.callbacks[0](.displayOpportunity)
        XCTAssertTrue(selected.isEmpty)
        state.businessSelectionWillChange(to: "c")
        presenter.callbacks[1](.displayOpportunity)
        XCTAssertTrue(selected.isEmpty)
        XCTAssertEqual(presenter.cancellations, 1)
        state.request(sessionID: "d", title: "D") { selected.append("d") }
        state.businessSelectionWillChange(to: "d")
        presenter.callbacks[2](.timedOut)
        XCTAssertEqual(selected, ["d"])
    }

    func testCancelledOrUnmountedPresentationDoesNotOwnBusinessSelection() {
        let state = SessionPagePresentationState()
        var count = 0
        XCTAssertFalse(state.request(sessionID: "a", title: "A") { count += 1 })
        let presenter = Presenter()
        state.presenter = presenter
        state.request(sessionID: "a", title: "A") { count += 1 }
        state.cancel()
        presenter.callbacks[0](.displayOpportunity)
        XCTAssertEqual(count, 0)
    }

    func testNativeControllerKeepsOneHostAndRejectsOffscreenOpeningPage() {
        let controller = SessionPageHostController(root: ConsolePaneContent { Text("Fixture") })
        controller.loadViewIfNeeded()
        controller.view.frame = NSRect(x: 0, y: 0, width: 1000, height: 700)
        let host = controller.host
        XCTAssertFalse(controller.presentOpeningPage(sessionID: "b", title: "B") { _ in XCTFail("Offscreen") })
        controller.update(root: ConsolePaneContent { Text("Changed") }, selectedSessionID: "b", isActive: true)
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.children.count, 1)
        controller.cancelPendingPresentation()
        XCTAssertNil(controller.pendingSessionID)
    }
}


@MainActor final class SessionPageRenderInputTests: XCTestCase {
    private func session(_ id: String = "page-a", task: String = "task-a") -> TaskSession {
        TaskSession(id: id, title: id, agent: "Fixture", agentId: nil, sessionKind: .worker,
            workId: "work", taskId: task, status: .complete, progress: 0, summary: "",
            suggestedOptions: nil, suggestedPrompt: nil, activityStatus: nil, updatedAt: "2026-09-01",
            accent: .cyan, archived: false, pinned: false, sortOrder: 0, capabilities: nil, external: nil)
    }
    private func makeInputs() -> (SessionPageRenderInputs, AppStateStore, BackendClient, SessionTimelineState) {
        let client = BackendClient(), source = AppStateStore()
        let value = session()
        source.acceptCreatedSession(value)
        client.sessionSelectionController.select(value.id)
        let timeline = SessionTimelineState(sessionID: value.id)
        let scope = ClientDetailBusinessScope(serverID: client.baseURL.absoluteString,
            ownerID: client.detailBusinessOwnerID, principalID: "local-user", sessionID: value.id,
            taskID: value.taskId, workID: value.workId)
        let inputs = SessionPageRenderInputs(session: value, scope: scope, backend: client,
            timeline: timeline, projection: SessionPresentationState(cache: nil),
            entities: EntityAPIClient(appState: source), search: UnifiedSearchNavigation(), sourceState: source)
        return (inputs, source, client, timeline)
    }
    private func detail(_ count: Int) -> CodexThreadDetail {
        ChatPerformanceFixture.make(configuration: .init(turnCount: count, rawItemCount: count * 3,
            longMessageCharacters: 32)).detail
    }
    private func settle() async {
        for _ in 0..<10 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(40))
    }
    func testHiddenPageOnlyAccumulatesChangesAndResumesLatestValues() async {
        let (inputs, source, client, timeline) = makeInputs()
        defer { inputs.retire() }
        timeline.apply(detail(1), timelineRevision: 1)
        inputs.resume(); await settle()
        let first = inputs.detail
        inputs.freeze(); let count = inputs.refreshCount
        for revision in 2...6 { timeline.apply(detail(revision), timelineRevision: revision) }
        source.acceptCreatedSession(session("page-other", task: "other-task"))
        client.sessionCommandController.setSendFailure("Original Session only", sessionID: inputs.scope.sessionID)
        await settle()
        XCTAssertEqual(inputs.refreshCount, count)
        XCTAssertEqual(inputs.detail, first)
        XCTAssertNil(inputs.sendFailure)
        inputs.resume(); await settle()
        XCTAssertEqual(inputs.detail, timeline.detail)
        XCTAssertEqual(inputs.sendFailure, "Original Session only")
        let resumed = inputs.refreshCount
        for _ in 0..<200 { inputs.freeze(); inputs.resume() }
        await settle()
        XCTAssertEqual(inputs.refreshCount, resumed, "An unchanged hot resume must not recapture sources or subscribe again")
    }
    func testActionFenceRejectsPreviousGenerationAndDifferentSelectedSession() async {
        let (inputs, _, client, _) = makeInputs()
        defer { inputs.retire() }
        inputs.resume(); await settle()
        let first = inputs.activity.generation
        XCTAssertEqual(inputs.actionSession(generation: first)?.id, inputs.scope.sessionID)
        inputs.suspendActions()
        XCTAssertNil(inputs.actionSession(generation: first))
        inputs.freeze(); inputs.resume()
        XCTAssertNil(inputs.actionSession(generation: first))
        let current = inputs.activity.generation
        XCTAssertNotNil(inputs.actionSession(generation: current))
        client.sessionSelectionController.select("page-other")
        XCTAssertNil(inputs.actionSession(generation: current))
    }
    func testBindingChangeRetiresEvenFrozenInputsAndRejectsActionsImmediately() async {
        let (inputs, source, _, timeline) = makeInputs()
        timeline.apply(detail(1)); inputs.resume(); await settle(); inputs.freeze()
        source.acceptCreatedSession(session(task: "rebound-task"))
        XCTAssertNil(inputs.actionSession(generation: inputs.activity.generation))
        await settle()
        XCTAssertTrue(inputs.retired)
        XCTAssertNil(inputs.detail)
        inputs.resume(); XCTAssertFalse(inputs.activity.isActive)
    }
    func testNativeHostSkipsHiddenSourceChangesThenPresentsLatestOnResume() async {
        _ = NSApplication.shared
        let (inputs, _, client, timeline) = makeInputs()
        defer { inputs.retire() }
        timeline.apply(detail(1)); inputs.resume(); await settle()
        let counter = Counter()
        let host = NSHostingView(rootView: Probe(inputs: inputs, counter: counter))
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 120),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded(); await settle()
        XCTAssertGreaterThan(counter.count, 0)
        inputs.freeze(); let before = counter.count
        timeline.apply(detail(2), timelineRevision: 2)
        client.sessionCommandController.setSendFailure("Latest failure", sessionID: inputs.scope.sessionID)
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        XCTAssertEqual(counter.count, before)
        inputs.resume(); await settle(); host.layoutSubtreeIfNeeded(); await settle()
        XCTAssertGreaterThan(counter.count, before)
        XCTAssertEqual(counter.lastItemCount, timeline.detail?.items.count)
        XCTAssertEqual(counter.lastFailure, "Latest failure")
    }
    func testMountedPureHeaderAndModelMenuIgnoreHiddenGlobalPublishers() async throws {
        _ = NSApplication.shared
        let (inputs, _, client, _) = makeInputs()
        inputs.resume(); await settle()
        guard SessionSwitchTrace.shared.begin(sessionID: inputs.scope.sessionID) != nil else {
            throw XCTSkip("Run with CORPTIE_SESSION_SWITCH_TRACE=1 for real body counters")
        }
        let host = NSHostingView(rootView: ChromeProbe(inputs: inputs, client: client))
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 600, height: 180),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { inputs.retire(); window.contentView = nil; window.close(); SessionSwitchTrace.shared.end(reason: "test-finished") }
        host.layoutSubtreeIfNeeded(); await settle()
        inputs.freeze(); await settle()
        let snapshot = try XCTUnwrap(SessionSwitchTrace.shared.snapshot)
        let header = snapshot.metrics[.headerBody]?.count ?? 0
        let menu = snapshot.metrics[.modelMenuBody]?.count ?? 0
        XCTAssertGreaterThan(header, 0); XCTAssertGreaterThan(menu, 0)
        client.modelCatalog.objectWillChange.send()
        client.sessionCommandController.objectWillChange.send()
        client.supplementaryDataController.objectWillChange.send()
        client.sessionSelectionController.select("unrelated-session")
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        XCTAssertEqual(SessionSwitchTrace.shared.snapshot?.metrics[.headerBody]?.count, header)
        XCTAssertEqual(SessionSwitchTrace.shared.snapshot?.metrics[.modelMenuBody]?.count, menu)
    }
    func testRetainedEditorIdentityAndDeferredQuickMessageRefresh() async {
        let (inputs, _, _, _) = makeInputs()
        let drafts = ComposerDraftRepository()
        inputs.resume(); await settle()
        let editor = inputs.editorController(for: drafts)
        inputs.freeze()
        for _ in 0..<200 { XCTAssertTrue(inputs.editorController(for: drafts) === editor) }
        let revision = inputs.quickMessageRevision
        inputs.didSendMessage(); inputs.didSendMessage()
        XCTAssertEqual(inputs.quickMessageRevision, revision)
        inputs.resume()
        XCTAssertEqual(inputs.quickMessageRevision, revision + 1)
        XCTAssertTrue(inputs.editorController(for: drafts) === editor)
        inputs.retire()
    }

    func testMountedComposerIgnoresHiddenGlobalPublishersAndRetainsNativeEditor() async throws {
        _ = NSApplication.shared
        let (inputs, _, client, _) = makeInputs()
        let drafts = ComposerDraftRepository()
        inputs.resume(); await settle()
        guard SessionSwitchTrace.shared.begin(sessionID: inputs.scope.sessionID) != nil else {
            throw XCTSkip("Run with CORPTIE_SESSION_SWITCH_TRACE=1 for real body counters")
        }
        let host = NSHostingView(rootView: SessionMessageComposerSurface(sessionId: inputs.scope.sessionID,
            draftRepository: drafts, modelCatalog: client.modelCatalog, backendClient: client,
            compact: true, status: .complete, isReady: true, notReadyReason: nil, activityStatus: nil,
            renderInputs: inputs))
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 600, height: 120),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { inputs.retire(); window.contentView = nil; window.close(); SessionSwitchTrace.shared.end(reason: "test-finished") }
        host.layoutSubtreeIfNeeded(); await settle()
        let editor = try XCTUnwrap(findEditor(host))
        inputs.freeze(); await settle()
        let before = try XCTUnwrap(SessionSwitchTrace.shared.snapshot?.metrics[.composerBody]?.count)
        XCTAssertGreaterThan(before, 0)
        client.modelCatalog.objectWillChange.send()
        client.sessionCommandController.objectWillChange.send()
        client.supplementaryDataController.objectWillChange.send()
        client.sessionSelectionController.select("unrelated-session")
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        XCTAssertEqual(SessionSwitchTrace.shared.snapshot?.metrics[.composerBody]?.count, before)
        XCTAssertTrue(findEditor(host) === editor)
        client.sessionSelectionController.select(inputs.scope.sessionID)
        inputs.resume(); await settle(); host.layoutSubtreeIfNeeded(); await settle()
        XCTAssertTrue(findEditor(host) === editor)
    }
    private func findEditor(_ view: NSView) -> NSTextView? {
        if let text = view as? NSTextView { return text }
        return view.subviews.lazy.compactMap { self.findEditor($0) }.first
    }

    func testWholeNativePagesReuseHostsAfterGateAndEvictBeforeFourthAllocation() async throws {
        _ = NSApplication.shared
        let source = AppStateStore(), client = BackendClient()
        for id in ["a", "b", "c", "d"] { source.acceptCreatedSession(session(id, task: "task-" + id)) }
        client.sessionSelectionController.select("a")
        let gate = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        let content = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        var allocations = 0
        let cleanup = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        let readiness = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        weak var observed: ResidentSessionPageHostController<Text, Text>?
        let controller = ResidentSessionPageHostController(fallback: ConsolePaneContent { Text("None") }, gate: gate, contentGate: content, cleanupGate: cleanup, readinessGate: readiness, isVisible: { _ in true },
            makeInputs: { id in
                guard let value = source.session(id) else { return nil }
                allocations += 1
                XCTAssertLessThan(observed?.entries.count ?? 0, 3, "Evict before allocating the fourth native page")
                return SessionPageRenderInputs(session: value,
                    scope: .init(serverID: client.baseURL.absoluteString, ownerID: client.detailBusinessOwnerID,
                        principalID: "local-user", sessionID: id, taskID: value.taskId, workID: value.workId),
                    backend: client, timeline: SessionTimelineState(sessionID: id), projection: SessionPresentationState(cache: nil),
                    entities: EntityAPIClient(appState: source), search: UnifiedSearchNavigation(), sourceState: source)
            }, root: { Text($0.session.title) })
        observed = controller
        controller.loadViewIfNeeded(); controller.view.frame = NSRect(x: 0, y: 0, width: 640, height: 400)
        controller.update(fallback: ConsolePaneContent { Text("None") }, selectedSessionID: "a", isActive: true)
        let original = try XCTUnwrap(controller.current)
        let window = NSWindow(contentRect: controller.view.bounds, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = controller.view; window.orderFront(nil)
        defer { controller.disposeAll(); window.contentView = nil; window.close() }
        await settle(); controller.view.layoutSubtreeIfNeeded()
        func deliver(_ target: SessionPresentationFrameGate) async {
            target.nativeDrawPrepared(at: 1); target.runLoopDidCommit()
            target.displayTick(timestamp: 2); target.displayTick(timestamp: 3); target.displayTick(timestamp: 4); target.displayTick(timestamp: 5)
            await settle()
        }
        XCTAssertFalse(original.eligibleForWarmPresentation)
        await deliver(readiness)
        XCTAssertTrue(original.eligibleForWarmPresentation)
        for id in ["b", "c"] {
            XCTAssertTrue(controller.presentOpeningPage(sessionID: id, title: id) { _ in client.sessionSelectionController.select(id) })
            XCTAssertEqual(allocations, id == "b" ? 1 : 2, "Cold allocation must wait for the shell display opportunity")
            await deliver(gate); await deliver(content)
            XCTAssertFalse(controller.current?.eligibleForWarmPresentation ?? true)
            await deliver(readiness)
            XCTAssertTrue(controller.current?.eligibleForWarmPresentation ?? false)
        }
        XCTAssertEqual(controller.entries.count, 3)
        XCTAssertEqual(original.layoutSize, controller.view.bounds.size)
        XCTAssertTrue(controller.presentOpeningPage(sessionID: "a", title: "a") { _ in client.sessionSelectionController.select("a") })
        XCTAssertTrue(controller.current === original)
        XCTAssertFalse(original.surface.isHidden)
        XCTAssertFalse(original.host.view.isHiddenOrHasHiddenAncestor)
        XCTAssertEqual(client.sessionSelectionController.selectedSessionID, "c", "Warm visibility must precede business selection")
        XCTAssertEqual(allocations, 3)
        XCTAssertFalse(original.inputs.acceptsPresentationUpdates)
        await deliver(gate)
        XCTAssertTrue(original.inputs.acceptsPresentationUpdates)
        XCTAssertEqual(controller.pendingSessionID, nil)
        XCTAssertEqual(allocations, 3)
        // A size change invalidates the previously displayed layout even if
        // the same host and Session remain mounted.
        let oldBounds = controller.view.frame
        controller.view.setFrameSize(NSSize(width: oldBounds.width + 80, height: oldBounds.height))
        controller.view.needsLayout = true; controller.view.layoutSubtreeIfNeeded()
        XCTAssertFalse(original.eligibleForWarmPresentation)
        controller.update(fallback: ConsolePaneContent { Text("None") }, selectedSessionID: "a", isActive: true)
        await deliver(readiness)
        XCTAssertTrue(original.eligibleForWarmPresentation)
        controller.view.frame = oldBounds
        controller.view.needsLayout = true; controller.view.layoutSubtreeIfNeeded()
        controller.update(fallback: ConsolePaneContent { Text("None") }, selectedSessionID: "a", isActive: true)
        await deliver(readiness)
        // Superseded warm requests must never activate the intermediate page.
        XCTAssertTrue(controller.presentOpeningPage(sessionID: "b", title: "b") { _ in client.sessionSelectionController.select("b") })
        XCTAssertTrue(controller.presentOpeningPage(sessionID: "c", title: "c") { _ in client.sessionSelectionController.select("c") })
        XCTAssertEqual(client.sessionSelectionController.selectedSessionID, "a")
        await deliver(gate)
        XCTAssertEqual(client.sessionSelectionController.selectedSessionID, "c")
        XCTAssertEqual(allocations, 3)
        XCTAssertTrue(controller.presentOpeningPage(sessionID: "d", title: "d") { _ in client.sessionSelectionController.select("d") })
        XCTAssertEqual(allocations, 3)
        await deliver(gate); await deliver(content)
        XCTAssertEqual(allocations, 4); XCTAssertEqual(controller.entries.count, 3)
        XCTAssertEqual(Set(controller.entries.map { $0.inputs.scope.sessionID }), ["a", "c", "d"])
        controller.handleMemoryPressure(.critical)
        XCTAssertEqual(controller.entries.count, 3, "Heavy destruction waits for a display opportunity")
        await deliver(cleanup)
        XCTAssertEqual(controller.entries.count, 1)
        XCTAssertEqual(controller.current?.inputs.scope.sessionID, "d")
        XCTAssertTrue(controller.presentOpeningPage(sessionID: "a", title: "a") { _ in client.sessionSelectionController.select("a") })
        await deliver(gate); await deliver(content)
        XCTAssertEqual(allocations, 5); XCTAssertEqual(controller.entries.count, 1)
    }

    func testDetailHandleRevocationRetiresWholeFrozenPage() async {
        let (inputs, _, client, _) = makeInputs()
        inputs.resume(); inputs.freeze()
        client.detailBusinessRepository.invalidateAll()
        XCTAssertFalse(inputs.hasValidBinding())
        await settle()
        XCTAssertTrue(inputs.retired)
        XCTAssertNil(inputs.actionSession(generation: inputs.activity.generation))
    }

    private struct ChromeProbe: View {
        let inputs: SessionPageRenderInputs
        let client: BackendClient
        var body: some View {
            VStack {
                SessionConversationHeaderSurface(session: inputs.session,
                    backendClient: client, projectStatus: inputs.projectStatus,
                    showsHistoricalThread: false, hasPendingScheduledWake: false,
                    providers: inputs.providers, renderInputs: inputs)
                SessionModelMenuSurface(models: inputs.models, defaultModelID: inputs.defaultModel,
                    defaultReasoningLevel: inputs.defaultReasoning, loadingModels: inputs.loadingModels,
                    switchingModel: inputs.switchingModel, switchingReasoning: inputs.switchingReasoning,
                    backendClient: client, maxWidth: 160, session: inputs.session,
                    activity: inputs.activity, renderInputs: inputs)
            }
        }
    }

    func testSubscriptionsDoNotRetainEvictedInputs() async {
        var values: (SessionPageRenderInputs, AppStateStore, BackendClient, SessionTimelineState)? = makeInputs()
        let client = values!.2, timeline = values!.3
        weak var weakInputs = values!.0
        values!.0.resume(); values!.0.freeze(); values = nil
        await settle()
        XCTAssertNil(weakInputs)
        client.objectWillChange.send(); timeline.apply(detail(1)); await settle()
        XCTAssertNil(weakInputs)
    }
    private final class Counter { var count = 0; var lastItemCount: Int?; var lastFailure: String? }
    private struct Probe: View {
        let inputs: SessionPageRenderInputs
        let counter: Counter
        var body: some View {
            let _ = { counter.count += 1; counter.lastItemCount = inputs.detail?.items.count; counter.lastFailure = inputs.sendFailure }()
            Text(inputs.session.title + " / " + (inputs.sendFailure ?? ""))
        }
    }
}
