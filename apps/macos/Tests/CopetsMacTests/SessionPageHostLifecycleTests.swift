import AppKit
import Combine
import SwiftUI
import XCTest
import Darwin
import CorptieClientCore
import CorptieConversation
@testable import CorptieMac

@MainActor final class SessionPageHostLifecycleTests: XCTestCase {
    private final class Presenter: SessionPagePresenting {
        var callbacks: [@MainActor () -> Void] = []
        var accepts = true
        var cancellations = 0
        func presentOpeningPage(sessionID: String, title: String,
                                activate: @escaping @MainActor () -> Void) -> Bool {
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
        presenter.callbacks[0]()
        XCTAssertTrue(selected.isEmpty)
        state.businessSelectionWillChange(to: "c")
        presenter.callbacks[1]()
        XCTAssertTrue(selected.isEmpty)
        XCTAssertEqual(presenter.cancellations, 1)
        state.request(sessionID: "d", title: "D") { selected.append("d") }
        state.businessSelectionWillChange(to: "d")
        presenter.callbacks[2]()
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
        presenter.callbacks[0]()
        XCTAssertEqual(count, 0)
    }

    func testLegacyComparisonLeavesLocalContentVisibleWithoutOpeningScreen() {
        _ = NSApplication.shared
        let controller = SessionPageHostController(root: ConsolePaneContent { Text("Existing messages") })
        controller.loadViewIfNeeded()
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 400),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = controller.view; window.orderFront(nil)
        defer { window.contentView = nil; window.close() }
        XCTAssertFalse(controller.presentOpeningPage(sessionID: "b", title: "B") { XCTFail("No placeholder activation") })
        XCTAssertFalse(controller.host.view.isHiddenOrHasHiddenAncestor)
        XCTAssertEqual(controller.view.subviews, [controller.host.view])
        XCTAssertNil(controller.pendingSessionID)
    }

    func testNativeControllerKeepsOneHostAndRejectsOffscreenOpeningPage() {
        let controller = SessionPageHostController(root: ConsolePaneContent { Text("Fixture") })
        controller.loadViewIfNeeded()
        controller.view.frame = NSRect(x: 0, y: 0, width: 1000, height: 700)
        let host = controller.host
        XCTAssertFalse(controller.presentOpeningPage(sessionID: "b", title: "B") { XCTFail("Offscreen") })
        controller.update(root: ConsolePaneContent { Text("Changed") }, selectedSessionID: "b", isActive: true)
        XCTAssertTrue(controller.host === host)
        XCTAssertEqual(controller.children.count, 1)
        controller.cancelPendingPresentation()
        XCTAssertNil(controller.pendingSessionID)
    }
}


@MainActor final class SessionPageRenderInputTests: XCTestCase {
    private func session(_ id: String = "page-a", task: String = "task-a") -> TaskSession {
        TaskSession(id: id, title: id, agent: "Fixture", roleId: nil, sessionKind: .worker,
            workId: "work", taskId: task, status: .complete, progress: 0, summary: "",
            suggestedOptions: nil, suggestedPrompt: nil, activityStatus: nil, updatedAt: "2026-09-01",
            accent: .cyan, archived: false, pinned: false, sortOrder: 0, capabilities: nil, external: nil)
    }
    private func makeInputs(richToolbar: Bool = false) -> (SessionPageRenderInputs, AppStateStore, BackendClient, SessionTimelineState) {
        let client = BackendClient(), source = AppStateStore()
        var value = session()
        if richToolbar {
            var fields = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
            fields["capabilities"] = ["canSend": true, "canSwitchModel": true, "canInterrupt": true]
            fields["external"] = ["provider": "fixture", "currentModel": "A provider neutral long model name", "currentReasoningLevel": "high"]
            fields["executionStatus"] = "running"
            value = try! JSONDecoder().decode(TaskSession.self, from: JSONSerialization.data(withJSONObject: fields))
            client.supplementaryDataController.selectedSessionUsage = try! JSONDecoder().decode(SessionUsageResponse.self,
                from: Data(#"{"account":{"available":true,"provider":"fixture","rateLimits":{"primary":{"usedPercent":63.5}}},"context":{"usedTokens":141400,"contextWindow":200000,"remainingTokens":58600,"usedPercent":70.7}}"#.utf8))
        }
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
    func testHiddenPageDisconnectsSourcesAndResumesLatestValues() async {
        let (inputs, source, client, timeline) = makeInputs()
        defer { inputs.retire() }
        timeline.apply(detail(1), timelineRevision: 1)
        inputs.resume(); await settle()
        let first = inputs.detail
        inputs.freeze(); let count = inputs.refreshCount
        XCTAssertEqual(inputs.subscriptionCount, 0)
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
        let countAfterResume = inputs.subscriptionCount
        XCTAssertGreaterThan(countAfterResume, 0)
        for _ in 0..<10 {
            inputs.freeze()
            XCTAssertEqual(inputs.subscriptionCount, 0)
            inputs.resume()
            XCTAssertEqual(inputs.subscriptionCount, countAfterResume)
        }
        await settle()
    }

    func testInactiveViewPublisherDoesNotSubscribeUpstream() {
        let subject = PassthroughSubject<Int, Never>()
        var connections = 0
        let publisher = subject.handleEvents(receiveSubscription: { _ in connections += 1 },
            receiveCancel: { connections -= 1 })
        let hidden = publisher.whilePresented(false).sink { _ in XCTFail("Hidden delivery") }
        XCTAssertEqual(connections, 0)
        let visible = publisher.whilePresented(true).sink { _ in }
        XCTAssertEqual(connections, 1)
        visible.cancel()
        XCTAssertEqual(connections, 0)
        hidden.cancel()
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
    func testFrozenBindingChangeRejectsActionsAndRetiresBeforeResume() async {
        let (inputs, source, _, timeline) = makeInputs()
        timeline.apply(detail(1)); inputs.resume(); await settle(); inputs.freeze()
        source.acceptCreatedSession(session(task: "rebound-task"))
        XCTAssertNil(inputs.actionSession(generation: inputs.activity.generation))
        await settle()
        XCTAssertFalse(inputs.retired, "Hidden pages do not subscribe to binding changes")
        XCTAssertEqual(inputs.subscriptionCount, 0)
        inputs.resume()
        XCTAssertTrue(inputs.retired)
        XCTAssertNil(inputs.detail)
        XCTAssertFalse(inputs.activity.isActive)
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
        if let text = view as? NSTextView, text.isEditable { return text }
        return view.subviews.lazy.compactMap { self.findEditor($0) }.first
    }

    func testWelcomeResizeAndFirstMessageKeepBottomEditorAndMarkedDraft() async throws {
        _ = NSApplication.shared
        let (inputs, _, client, timeline) = makeInputs()
        client.markBackendConnectedFromSessionStream()
        let empty = CodexThreadDetail(id: "thread", title: "Welcome", status: .complete,
            source: nil, connectionStatus: nil, currentModel: nil, currentReasoningLevel: nil,
            activityStatus: nil, cwd: nil, createdAt: "", updatedAt: "", canSend: true,
            sendUnavailableReason: nil, capabilities: nil, turnCount: 0, items: [])
        timeline.apply(empty)
        inputs.resume(); await settle()
        let drafts = ComposerDraftRepository()
        let host = NSHostingView(rootView: SessionConversationSurface(
            sessionId: inputs.scope.sessionID, presentationCache: SessionPresentationCache(),
            composerDraftRepository: drafts, backendClient: client,
            showsHeader: false, renderInputs: inputs))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 900, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { inputs.retire(); window.contentView = nil; window.close() }
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        let editor = try XCTUnwrap(findEditor(host))
        window.makeFirstResponder(editor)
        editor.insertText("draft ", replacementRange: NSRange(location: 0, length: 0))
        editor.setMarkedText("输入", selectedRange: NSRange(location: 2, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        let text = editor.string
        let selection = editor.selectedRange()
        func region(_ view: NSView) -> ConversationRegionContainer<AnyView, AnyView>? {
            (view as? ConversationRegionContainer<AnyView, AnyView>)
                ?? view.subviews.lazy.compactMap(region).first
        }
        let regions = try XCTUnwrap(region(host))
        for size in [CGSize(width: 360, height: 500), CGSize(width: 1000, height: 800)] {
            window.setContentSize(size)
            host.layoutSubtreeIfNeeded(); await settle(); host.layoutSubtreeIfNeeded()
            XCTAssertGreaterThan(regions.content.frame.height, size.height / 2)
            XCTAssertEqual(regions.accessory.frame.minY, regions.bounds.minY, accuracy: 0.5)
            XCTAssertEqual(regions.content.frame.minY, regions.accessory.frame.maxY, accuracy: 0.5)
        }
        timeline.apply(detail(1))
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        XCTAssertTrue(findEditor(host) === editor)
        XCTAssertTrue(window.firstResponder === editor)
        XCTAssertEqual(editor.string, text)
        XCTAssertEqual(editor.selectedRange(), selection)
        XCTAssertTrue(editor.hasMarkedText())
    }

    func testRealSessionQuickDockGeometryAcrossChecklistNoticesAndEditorGrowth() async throws {
        _ = NSApplication.shared
        let (inputs, _, client, timeline) = makeInputs(richToolbar: true)
        client.markBackendConnectedFromSessionStream()
        timeline.apply(detail(1)); inputs.resume(); await settle()
        let suite = "welcome-dock-geometry-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let cache = ClientQuickMessageCache(defaults: defaults)
        let scope = ClientQuickMessageCache.scope(host: client.baseURL.absoluteString,
            taskID: inputs.session.taskId, sessionID: inputs.scope.sessionID)
        cache.remember((0..<8).map { .init(id: "chip-\($0)",
            text: "A full quick message recommendation \($0)", scope: "task", count: 1) }, for: scope)
        let host = NSHostingView(rootView: SessionConversationSurface(sessionId: inputs.scope.sessionID,
            presentationCache: SessionPresentationCache(), composerDraftRepository: ComposerDraftRepository(),
            backendClient: client, showsHeader: false, renderInputs: inputs, quickMessageCache: cache))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 900, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { inputs.retire(); window.contentView = nil; window.close() }
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
        let region = try XCTUnwrap(descendants(host).compactMap { $0 as? ConversationRegionContainer<AnyView, AnyView> }.first)
        let editor = try XCTUnwrap(findEditor(host))
        var revision = 0
        XCTAssertNotNil(inputs.usage?.context)
        XCTAssertEqual(inputs.session.capabilities?.canSwitchModel, true)
        for width: CGFloat in [340, 1233] {
            window.setContentSize(.init(width: width, height: 700))
            for checklist in [false, true] {
                revision += 1
                let fields: [String: Any] = ["schemaVersion": 1, "planId": "checklist:geometry", "taskId": inputs.session.taskId ?? "task-a",
                    "revision": revision, "closed": !checklist, "lifecycle": "completed", "completedCount": 1,
                    "updatedAt": "2026-11-12", "steps": [["stepId": "one", "ordinal": 0, "text": "Completed", "status": "completed"]]]
                let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: JSONSerialization.data(withJSONObject: fields))
                NotificationCenter.default.post(name: .executionChecklistChanged, object: inputs.session.taskId, userInfo: ["checklist": plan])
                for notice in [nil, "   ", "Send failed"] as [String?] {
                    client.sessionCommandController.setSendFailure(notice, sessionID: inputs.scope.sessionID)
                    var shortHeight: CGFloat = 0
                    for longDraft in [false, true] {
                        let text = longDraft ? Array(repeating: "A longer draft line", count: 12).joined(separator: "\n") : "Draft"
                        editor.insertText(text, replacementRange: NSRange(location: 0, length: editor.string.utf16.count))
                        await settle(); host.layoutSubtreeIfNeeded(); await settle(); host.layoutSubtreeIfNeeded()
                        let scroll = try XCTUnwrap(editor.enclosingScrollView)
                        let quick = try XCTUnwrap(descendants(region.floatingHost).compactMap { $0 as? NSScrollView }
                            .first { abs($0.frame.height - ConversationQuickMessages.rowHeight) < 0.5 })
                        let qf = quick.convert(quick.bounds, to: region)
                        let ef = scroll.convert(scroll.bounds, to: region)
                        let laneWidth = WorkbenchStyle.lane(viewportWidth: region.bounds.width).width
                        let chromeView = try XCTUnwrap(descendants(region.accessory).first {
                            abs($0.frame.width - laneWidth) < 0.5 && $0.frame.height > ef.height + 20
                        })
                        let chromeFrame = chromeView.convert(chromeView.bounds, to: region)
                        let chromeTop = chromeFrame.maxY
                        XCTAssertEqual(chromeTop - ef.maxY, 10, accuracy: 0.5)
                        if width == 1233 { XCTAssertEqual(chromeFrame.height, ef.height + 60, accuracy: 0.5) }
                        else { XCTAssertGreaterThan(chromeFrame.height, ef.height + 60) }
                        let noticeHeight = region.accessory.frame.maxY - chromeTop
                        XCTAssertEqual(qf.minY, region.accessory.frame.maxY + 4, accuracy: 0.5,
                            "The real quick row must retain its existing 4pt exterior spacing")
                        if notice == "Send failed" { XCTAssertGreaterThan(noticeHeight, 6) }
                        else { XCTAssertEqual(noticeHeight, 0, accuracy: 0.5) }
                        XCTAssertEqual(region.accessory.frame.minY, region.bounds.minY, accuracy: 0.5)
                        XCTAssertEqual(region.content.frame.minY, region.accessory.frame.maxY, accuracy: 0.5,
                            "The transcript viewport must still reach the editor boundary beneath the floating row")
                        XCTAssertEqual(region.floatingRegionClearance ?? -1, checklist ? 76 : 34, accuracy: 0.5)
                        let chips = descendants(quick).filter { abs($0.frame.height - 24) < 0.5 && $0.frame.width > 0 }
                        XCTAssertEqual(chips.count, 8, "Use the actual overflowing eight-chip native row")
                        let chip = try XCTUnwrap(chips.first)
                        let chipGap = chip.convert(chip.bounds, to: region).minY - chromeTop
                        XCTAssertEqual(chipGap, noticeHeight + 7, accuracy: 0.5)
                        if longDraft { XCTAssertGreaterThan(ef.height, shortHeight) }
                        else { shortHeight = ef.height }
                        XCTAssertTrue(findEditor(host) === editor)
                        XCTAssertEqual(descendants(host).compactMap { $0 as? NSTextView }.filter(\.isEditable).count, 1)
                        XCTAssertEqual(editor.string, text)
                        print("REAL_DOCK width=\(width) checklist=\(checklist) notice=\(notice ?? "nil") long=\(longDraft) rowGap=\(qf.minY - region.accessory.frame.maxY) chipGap=\(chipGap) noticeHeight=\(noticeHeight) editorHeight=\(ef.height) viewport=\(region.content.frame) accessory=\(region.accessory.frame) floating=\(region.floatingHost.frame) quick=\(qf) chip=\(chip.convert(chip.bounds, to: region)) chrome=\(chromeFrame) editor=\(ef)")
                    }
                }
            }
        }
    }

    func testRealToolbarWidthChangesKeepMarkedTextDuringNativeLiveResize() async throws {
        _ = NSApplication.shared
        let (inputs, _, client, timeline) = makeInputs(richToolbar: true)
        client.markBackendConnectedFromSessionStream(); timeline.apply(detail(1))
        inputs.resume(); await settle()
        let host = NSHostingView(rootView: SessionConversationSurface(sessionId: inputs.scope.sessionID,
            presentationCache: SessionPresentationCache(), composerDraftRepository: ComposerDraftRepository(),
            backendClient: client, showsHeader: false, renderInputs: inputs))
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 1233, height: 700),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host
        defer { inputs.retire(); window.contentView = nil; window.close() }
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        let editor = try XCTUnwrap(findEditor(host))
        window.makeFirstResponder(editor)
        editor.setMarkedText("输入", selectedRange: NSRange(location: 2, length: 0),
            replacementRange: NSRange(location: NSNotFound, length: 0))
        let text = editor.string, selection = editor.selectedRange(), marked = editor.markedRange()
        func region(_ view: NSView) -> ConversationRegionContainer<AnyView, AnyView>? {
            (view as? ConversationRegionContainer<AnyView, AnyView>) ?? view.subviews.lazy.compactMap(region).first
        }
        let native = try XCTUnwrap(region(host))
        native.liveResizeOverride = true
        let commits = native.rootCommitCount
        for width: CGFloat in [1000, 740, 560, 340, 560, 740, 1000, 1233] {
            window.setContentSize(.init(width: width, height: 700))
            host.layoutSubtreeIfNeeded(); await settle(); host.layoutSubtreeIfNeeded()
            XCTAssertTrue(findEditor(host) === editor)
            XCTAssertTrue(window.firstResponder === editor)
            XCTAssertEqual(editor.string, text); XCTAssertEqual(editor.selectedRange(), selection)
            XCTAssertEqual(editor.markedRange(), marked)
            XCTAssertEqual(native.rootCommitCount, commits, "Width binding must not commit the retained content roots")
        }
        native.liveResizeOverride = false; native.commitPendingRoots()
        XCTAssertTrue(findEditor(host) === editor)
    }

    func testMissingResidentInputDoesNotConsumeSelectionAndNextClickCanRecover() throws {
        _ = NSApplication.shared
        let (inputs, source, client, _) = makeInputs()
        let target = session("recovered-page", task: "recovered-task")
        source.acceptCreatedSession(target)
        var targetAvailable = false
        let controller = ResidentSessionPageHostController(fallback: ConsolePaneContent { Text("Fallback") },
            isVisible: { _ in true }, makeInputs: { id in
                if id == inputs.scope.sessionID { return inputs }
                guard targetAvailable, id == target.id else { return nil }
                return SessionPageRenderInputs(session: target,
                    scope: .init(serverID: client.baseURL.absoluteString, ownerID: client.detailBusinessOwnerID,
                        principalID: "local-user", sessionID: target.id, taskID: target.taskId, workID: target.workId),
                    backend: client, timeline: SessionTimelineState(sessionID: target.id),
                    projection: SessionPresentationState(cache: nil), entities: EntityAPIClient(appState: source),
                    search: UnifiedSearchNavigation(), sourceState: source)
            }, root: { Text($0.session.title) })
        controller.loadViewIfNeeded()
        controller.view.frame = NSRect(x: 0, y: 0, width: 640, height: 400)
        let window = NSWindow(contentRect: controller.view.bounds, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = controller.view; window.orderBack(nil)
        defer { controller.disposeAll(); window.contentView = nil; window.close() }
        XCTAssertTrue(controller.presentOpeningPage(sessionID: inputs.scope.sessionID, title: "Original", activate: {}))
        var selections: [String] = []
        let presentation = SessionPagePresentationState()
        presentation.presenter = controller
        let handled = presentation.request(sessionID: target.id, title: target.title) { selections.append(target.id) }
        XCTAssertFalse(handled, "A failed resident page must allow the caller's regular selection path")
        if !handled { selections.append(target.id) }
        XCTAssertEqual(selections, [target.id])
        XCTAssertNil(controller.pendingSessionID)
        XCTAssertTrue(inputs.acceptsPresentationUpdates, "The previous page must not remain frozen after a failed opening")
        targetAvailable = true
        XCTAssertTrue(presentation.request(sessionID: target.id, title: target.title) {
            client.sessionSelectionController.select(target.id)
        })
        XCTAssertEqual(controller.settledSessionID, target.id)
        XCTAssertEqual(client.sessionSelectionController.selectedSessionID, target.id)
    }

    func testOffscreenRoundTripsReuseDistinctSessionPagesInsteadOfConsumingDuplicateSlots() throws {
        _ = NSApplication.shared
        let source = AppStateStore(), client = BackendClient()
        let ids = ["cache-a", "cache-b", "cache-c", "cache-d", "cache-e", "cache-f"]
        for id in ids { source.acceptCreatedSession(session(id, task: "task-" + id)) }
        var allocations = 0
        let controller = ResidentSessionPageHostController(fallback: ConsolePaneContent { Text("None") },
            isVisible: { _ in false }, makeInputs: { id in
                guard let value = source.session(id) else { return nil }
                allocations += 1
                return SessionPageRenderInputs(session: value,
                    scope: .init(serverID: client.baseURL.absoluteString, ownerID: client.detailBusinessOwnerID,
                        principalID: "local-user", sessionID: id, taskID: value.taskId, workID: value.workId),
                    backend: client, timeline: SessionTimelineState(sessionID: id),
                    projection: SessionPresentationState(cache: nil), entities: EntityAPIClient(appState: source),
                    search: UnifiedSearchNavigation(), sourceState: source)
            }, root: { Text($0.session.title) })
        controller.loadViewIfNeeded()
        controller.view.frame = NSRect(x: 0, y: 0, width: 640, height: 400)
        defer { controller.disposeAll() }
        for id in ids {
            client.sessionSelectionController.select(id)
            controller.update(fallback: ConsolePaneContent { Text("None") }, selectedSessionID: id, isActive: true)
        }
        let original = Dictionary(uniqueKeysWithValues: controller.entries.map { ($0.inputs.scope.sessionID, ObjectIdentifier($0)) })
        for id in ids.reversed() + ids {
            client.sessionSelectionController.select(id)
            controller.update(fallback: ConsolePaneContent { Text("None") }, selectedSessionID: id, isActive: true)
            XCTAssertEqual(controller.current.map(ObjectIdentifier.init), original[id])
            XCTAssertEqual(Set(controller.entries.map { $0.inputs.scope.sessionID }).count, controller.entries.count)
        }
        XCTAssertEqual(allocations, ids.count)
        XCTAssertEqual(controller.entries.count, ids.count)
    }

    func testWholeNativePagesKeepEightAndEvictBeforeNinthAllocation() async throws {
        _ = NSApplication.shared
        let source = AppStateStore(), client = BackendClient()
        for id in ["a", "b", "c", "d", "e", "f", "g", "h", "i"] { source.acceptCreatedSession(session(id, task: "task-" + id)) }
        client.sessionSelectionController.select("a")
        var allocations = 0
        weak var observed: ResidentSessionPageHostController<Text, Text>?
        let controller = ResidentSessionPageHostController(fallback: ConsolePaneContent { Text("None") }, isVisible: { _ in true },
            makeInputs: { id in
                guard let value = source.session(id) else { return nil }
                allocations += 1
                XCTAssertLessThan(observed?.entries.count ?? 0, 8)
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
        func select(_ id: String) {
            XCTAssertTrue(controller.presentOpeningPage(sessionID: id, title: id) {
                XCTAssertEqual(controller.visiblePage?.inputs.scope.sessionID, id, "Display must precede business activation")
                client.sessionSelectionController.select(id)
            })
            XCTAssertEqual(controller.visiblePage?.inputs.scope.sessionID, id)
            XCTAssertEqual(controller.settledSessionID, id)
            XCTAssertTrue(controller.current?.inputs.acceptsPresentationUpdates == true)
            XCTAssertNil(controller.pendingSessionID)
        }
        select("b"); select("c"); select("a")
        XCTAssertTrue(controller.current === original)
        XCTAssertEqual(allocations, 3)
        controller.view.setFrameSize(NSSize(width: 720, height: 400))
        select("a")
        XCTAssertTrue(controller.current === original)
        XCTAssertEqual(original.surface.frame.size, controller.view.bounds.size)
        select("b"); select("c")
        XCTAssertEqual(allocations, 3, "Rapid changes must not recreate retained pages")
        select("d")
        XCTAssertEqual(allocations, 4)
        for id in ["e", "f", "g", "h"] { select(id) }
        XCTAssertEqual(controller.entries.count, 8)
        XCTAssertEqual(allocations, 8)
        for id in ["a", "b", "c", "d", "e", "f", "g", "h"] { select(id) }
        XCTAssertEqual(allocations, 8, "All eight recently visited pages must remain reusable")
        select("a"); select("i")
        XCTAssertEqual(controller.entries.count, 8)
        XCTAssertEqual(allocations, 9)
        XCTAssertEqual(Set(controller.entries.map { $0.inputs.scope.sessionID }), ["a", "c", "d", "e", "f", "g", "h", "i"])
        select("c"); select("d")
        controller.handleMemoryPressure(.warning)
        XCTAssertEqual(controller.capacity, 8)
        await settle()
        XCTAssertEqual(controller.entries.count, 8)
        let before = allocations
        for id in ["a", "c", "d", "e", "f", "g", "h", "i"] { select(id) }
        for _ in 0..<5 { select("c"); select("d") }
        XCTAssertEqual(allocations, before)
        controller.handleMemoryPressure(.critical)
        XCTAssertEqual(controller.entries.count, 8)
        await settle()
        XCTAssertEqual(controller.capacity, 8)
        XCTAssertEqual(controller.entries.count, 8)
        for id in ["a", "c", "d", "e", "f", "g", "h", "i"] { select(id) }
        XCTAssertEqual(allocations, before, "Critical pressure must preserve all eight cached pages")
        controller.handleMemoryPressure(.normal)
        select("a"); select("b")
        XCTAssertEqual(controller.capacity, 8)
        XCTAssertEqual(controller.entries.count, 8)
        // Same-page SwiftUI updates must not repeatedly resume native children.
        var nativeResumes = 0
        controller.current?.inputs.resumeNativePresentation = { nativeResumes += 1 }
        for _ in 0..<20 { controller.update(fallback: ConsolePaneContent { Text("None") }, selectedSessionID: "b", isActive: true) }
        XCTAssertEqual(nativeResumes, 0)
    }

    func testRealResidentPagesWarmSwitchLatencyAndIncrementalMemory() async throws {
        _ = NSApplication.shared
        let client = BackendClient(), drafts = ComposerDraftRepository()
        let source = client.appState
        let cache = SessionPresentationCache(), viewport = SessionViewportController(repository: nil)
        let detailPresentation = ConversationDetailPresentationRepository(), layout = PanelLayoutState()
        let fixture = ChatPerformanceFixture.make(configuration: .init(turnCount: 12, rawItemCount: 240, longMessageCharacters: 2000))
        var allocations = 0
        for id in ["memory-a", "memory-b", "memory-c", "memory-d", "memory-e", "memory-f", "memory-g", "memory-h", "memory-i"] {
            source.acceptCreatedSession(session(id, task: "task-" + id))
            client.storeCachedDetail(fixture.detail, for: id)
            cache.store(makeDetailDisplayCache(for: fixture.detail, sessionId: id, visibleMessageLimit: 7))
        }
        let controller = ResidentSessionPageHostController(fallback: ConsolePaneContent { Text("None") }, isVisible: { _ in true }, makeInputs: { id in
            guard let value = source.session(id) else { return nil }
            allocations += 1
            let timeline = SessionTimelineRepository.shared.state(for: id)
            return SessionPageRenderInputs(session: value,
                scope: .init(serverID: client.baseURL.absoluteString, ownerID: client.detailBusinessOwnerID,
                    principalID: "local-user", sessionID: id, taskID: value.taskId, workID: value.workId),
                backend: client, timeline: timeline, projection: cache.state(for: id),
                entities: EntityAPIClient(appState: source), search: UnifiedSearchNavigation(), sourceState: source)
        }, root: { inputs in
            ResidentSessionPageRoot(inputs: inputs, backend: client, cache: cache, drafts: drafts,
                viewport: viewport, detailPresentation: detailPresentation, layout: layout)
        })
        controller.loadViewIfNeeded(); controller.view.frame = NSRect(x: 0, y: 0, width: 1200, height: 800)
        let window = NSWindow(contentRect: controller.view.bounds, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = controller.view; window.orderBack(nil)
        defer { controller.disposeAll(); window.contentView = nil; window.close() }
        func footprint() throws -> UInt64 {
            var info = task_vm_info_data_t()
            var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
            let result = withUnsafeMutablePointer(to: &info) { pointer in
                pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                    task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
                }
            }
            XCTAssertEqual(result, KERN_SUCCESS)
            return info.phys_footprint
        }
        func show(_ id: String) {
            XCTAssertTrue(controller.presentOpeningPage(sessionID: id, title: id) {
                if let value = source.session(id) { client.select(session: value) }
            })
            XCTAssertEqual(controller.visiblePage?.inputs.scope.sessionID, id)
        }
        let baseline = try footprint()
        var memory: [UInt64] = [baseline]
        for id in ["memory-a", "memory-b", "memory-c", "memory-d", "memory-e", "memory-f", "memory-g", "memory-h", "memory-i"] {
            show(id); controller.view.layoutSubtreeIfNeeded(); window.displayIfNeeded(); await settle()
            memory.append(try footprint())
        }
        let hosts = controller.entries.map { ObjectIdentifier($0.host) }
        let before = allocations
        var synchronous: [Double] = [], throughLayout: [Double] = []
        for index in 0..<30 {
            let start = ProcessInfo.processInfo.systemUptime
            show(index.isMultiple(of: 2) ? "memory-c" : "memory-d")
            synchronous.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
            controller.view.layoutSubtreeIfNeeded(); window.displayIfNeeded()
            throughLayout.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
            await settle()
        }
        XCTAssertEqual(allocations, before)
        XCTAssertEqual(controller.entries.map { ObjectIdentifier($0.host) }, hosts)
        synchronous.sort(); throughLayout.sort()
        print("[resident-perf] warm synchronous p95=\(synchronous[28])ms; through AppKit layout/display submission p95=\(throughLayout[28])ms (not physical display latency)")
        print("[resident-memory] fixture 240 items/page; footprint bytes baseline/pages1-through-9 (8-page LRU)=\(memory)")
        XCTAssertLessThan(synchronous[28], 16)
        controller.handleMemoryPressure(.critical); await settle()
        XCTAssertEqual(controller.entries.count, 8)
        print("[resident-memory] after critical pressure, 8 pages retained=\(try footprint()) bytes")
        controller.disposeAll(); await settle()
        print("[resident-memory] after disposal=\(try footprint()) bytes (allocator/shared caches may retain memory)")
        XCTAssertTrue(controller.entries.isEmpty)
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

    func testInactiveResidentPagesLeaveTheWindowLayoutHierarchy() throws {
        let packageRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let url = packageRoot.appendingPathComponent(
            "Sources/CopetsMac/Console/SessionPageHostSwitcher.swift")
        let source = try String(contentsOf: url, encoding: .utf8)

        func slice(from start: String, to end: String) throws -> String {
            guard let a = source.range(of: start),
                  let b = source.range(of: end, range: a.upperBound..<source.endIndex) else {
                throw NSError(domain: "guard", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "missing \(start) / \(end)"])
            }
            return String(source[a.lowerBound..<b.lowerBound])
        }

        // Hidden NSViews still enter the window layout pass every frame, so
        // hiding alone couples resize cost to the number of visited Sessions.
        let reveal = try slice(from: "private func reveal", to: "func cancelPendingPresentation")
        XCTAssertTrue(reveal.contains("other.surface.removeFromSuperview()"))
        XCTAssertTrue(reveal.contains("view.addSubview(entry.surface)"))
        XCTAssertFalse(reveal.contains("inputs.freeze()"),
            "freeze belongs to the switch path, not to visibility changes")

        // reveal() is the only attachment point; materialize() must not pin
        // every newly created page into the hierarchy.
        let materialize = try slice(from: "private func materialize", to: "private func scheduleCleanup")
        XCTAssertFalse(materialize.contains("addSubview"),
            "materialize must not attach pages; reveal owns attachment")
        XCTAssertTrue(materialize.contains("reveal(entry)"))

        let fallback = try slice(from: "private func showFallback", to: "private func trim")
        XCTAssertTrue(fallback.contains("$0.surface.removeFromSuperview()"))

        // Resident pages depend on which Sessions were opened and on capacity /
        // memory pressure, never on whether a task is running. Reclaiming on a
        // running -> idle edge would make page lifetime depend on execution state.
        XCTAssertFalse(source.contains("hasRunningSession()"))
        XCTAssertFalse(source.contains("releaseCompletedSessionPages()"))
        XCTAssertFalse(source.contains("reason: \"session-completed\""))
    }
}
