#if os(macOS)
import AppKit
import SwiftUI
import Observation
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor struct DetailCardReorderingTests {
    @Test func draftReconcilesLiveInsertionsAndDeletesWithoutMutatingSource() throws {
        let source = ["summary", "references", "provider"]
        var draft = try #require(DetailCardReorderDraft(source: "summary", order: source))
        draft.insert(at: nil)
        #expect(source == ["summary", "references", "provider"])
        #expect(draft.order == ["references", "provider", "summary"])
        #expect(draft.successor == nil)
        let retained = draft.reconcile(["summary", "provider", "new"])
        #expect(retained)
        #expect(draft.order == ["provider", "summary", "new"])
        #expect(draft.successor == "new")
        let removed = draft.reconcile(["provider", "new"])
        #expect(!removed)
    }

    @Test func hoveringMixedSizesOnlyChangesPresentationAndDropCommitsOnce() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try await fixture.settle()
        let controller = try fixture.controller()
        controller.begin("summary", at: CGPoint(x: 50, y: 20))
        #expect(controller.draft?.source == "summary")
        #expect(controller.preview.image != nil)
        let target = try #require(fixture.views(DetailCardProbe.View.self).first { $0.bounds.width == 144 })
        let container = try #require(fixture.views(DetailCardReorderContainerProbe.View.self).first)
        let nativePoint = target.convert(CGPoint(x: target.bounds.midX,
            y: target.isFlipped ? target.bounds.maxY - 4 : 4), to: container)
        let dropPoint = CGPoint(x: nativePoint.x, y: container.bounds.maxY - nativePoint.y)
        controller.move(to: dropPoint)
        try await fixture.settle()
        #expect(controller.draft?.order == ["provider", "summary", "references"])
        #expect(fixture.arrangement.ordered(ClientDetailCardPolicy.orderedCards(in: fixture.handle.store, context: .init(sessionKind: "assistantChat", taskID: nil, workID: nil))).map(\.id) == ["summary", "provider", "references"])
        #expect(fixture.defaults.object(forKey: "corptie.detail.cardKindOrder.v1") == nil)
        let cells = fixture.views(DetailCardProbe.View.self)
        #expect(cells.count == 3)
        #expect(cells.map { $0.bounds.size }.contains(CGSize(width: 144, height: 144)))
        #expect(cells.map { $0.bounds.size }.contains(CGSize(width: 300, height: 84)))
        controller.end(at: dropPoint)
        for _ in 0..<50 {
            if controller.draft == nil { break }
            try await Task.sleep(for: .milliseconds(20))
        }
        #expect(fixture.defaults.stringArray(forKey: "corptie.detail.cardKindOrder.v1") == ["provider", "chatSummary", "contextReferences"])
        #expect(controller.draft == nil)
        #expect(controller.preview.image == nil)
        // A late end/cancel cannot save a second move or resurrect the preview.
        controller.end(at: CGPoint(x: 50, y: 30)); controller.cancel()
        #expect(fixture.defaults.stringArray(forKey: "corptie.detail.cardKindOrder.v1") == ["provider", "chatSummary", "contextReferences"])
    }

    @Test func cursorMovementDoesNotInvalidateCardOrderOrRecapturePreview() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try await fixture.settle()
        let controller = try fixture.controller()
        controller.begin("summary", at: CGPoint(x: 50, y: 20))
        let image = try #require(controller.preview.image)
        nonisolated(unsafe) var orderChanges = 0
        withObservationTracking { _ = controller.draft } onChange: { orderChanges += 1 }
        for offset in 0..<100 { controller.move(to: CGPoint(x: 50 + Double(offset % 10), y: 30)) }
        #expect(orderChanges == 0)
        #expect(controller.preview.image === image)
        controller.cancel()
        #expect(orderChanges == 1)
        #expect(fixture.defaults.object(forKey: "corptie.detail.cardKindOrder.v1") == nil)
    }

    @Test func cancelledOutsideHiddenAndRemovedSourceDragsNeverSave() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try await fixture.settle()
        let controller = try fixture.controller()
        controller.begin("summary", at: CGPoint(x: 50, y: 20))
        controller.move(to: CGPoint(x: 50, y: 160))
        controller.end(at: CGPoint(x: -50, y: -50))
        #expect(controller.draft == nil)
        controller.begin("summary", at: CGPoint(x: 50, y: 20))
        fixture.activity.deactivate()
        try await fixture.settle()
        #expect(controller.draft == nil)
        #expect(controller.preview.image == nil)
        fixture.activity.activate()
        try await fixture.settle()
        controller.begin("summary", at: CGPoint(x: 50, y: 20))
        try fixture.receive(includeSummary: false)
        try await fixture.settle()
        #expect(controller.draft == nil)
        #expect(fixture.defaults.object(forKey: "corptie.detail.cardKindOrder.v1") == nil)
    }

    @Test func escapeCancelsWithoutSavingAndOtherKeysPassThrough() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try await fixture.settle()
        let controller = try fixture.controller()
        controller.begin("summary", at: CGPoint(x: 50, y: 20))
        controller.move(to: CGPoint(x: 50, y: 160))
        let ordinaryKey = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: fixture.window.windowNumber, context: nil, characters: "a", charactersIgnoringModifiers: "a", isARepeat: false, keyCode: 0))
        #expect(!controller.handleKeyDown(ordinaryKey))
        #expect(controller.draft != nil)
        let escape = try #require(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
            windowNumber: fixture.window.windowNumber, context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53))
        #expect(controller.handleKeyDown(escape))
        controller.end(at: CGPoint(x: 50, y: 160))
        #expect(controller.draft == nil)
        #expect(controller.preview.image == nil)
        #expect(fixture.defaults.object(forKey: "corptie.detail.cardKindOrder.v1") == nil)
    }

    @Test func switchingScopeWithTheSameCardIDsCancelsTheOldDrag() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        try await fixture.settle()
        let controller = try fixture.controller()
        controller.begin("summary", at: CGPoint(x: 50, y: 20))
        controller.move(to: CGPoint(x: 50, y: 160))
        controller.synchronize(.init(scope: ["another-session"], enabled: true,
            items: fixture.handle.store.orderedCards.map { .init(id: $0.id, size: DetailWidgetSizing.preferredSize(for: $0.card)) })) { _, _ in
                Issue.record("An old drag committed into a new Session")
            }
        controller.end(at: CGPoint(x: 50, y: 160))
        #expect(controller.draft == nil)
        #expect(fixture.defaults.object(forKey: "corptie.detail.cardKindOrder.v1") == nil)
    }

    @Test func removingTheHostReleasesTheControllerDuringADrag() async throws {
        var fixture: Fixture? = try Fixture()
        try await fixture?.settle()
        weak var released: DetailCardReorderController?
        do {
            let controller = try #require(fixture).controller()
            released = controller
            controller.begin("summary", at: CGPoint(x: 50, y: 20))
            #expect(controller.draft != nil)
        }
        fixture?.close(); fixture = nil
        try await Task.sleep(for: .milliseconds(300))
        #expect(released == nil)
    }

    @MainActor private final class Fixture {
        let suite = "detail-placeholder-test-\(UUID())"
        let defaults: UserDefaults
        let arrangement: ConversationDetailCardArrangement
        let handle: ClientDetailBusinessHandle
        let activity = ConversationDetailPresentationActivity(isActive: true)
        let window: NSWindow
        let host: NSView

        init() throws {
            defaults = try #require(UserDefaults(suiteName: suite))
            arrangement = .init(defaults: defaults)
            let scope = ClientDetailBusinessScope(serverID: "test", ownerID: "test", principalID: "test",
                sessionID: "session:test", taskID: nil, workID: nil)
            handle = ClientDetailBusinessRepository().entry(for: scope)
            let selection = ClientDetailConfiguration.Selection(id: "test", title: "Test", choices: [], canSelect: false)
            let adapters = ConversationDetailAdapters(configuration: .init(provider: selection, model: selection, reasoning: selection),
                selectConfiguration: { _, _ in throw ClientDetailConfigurationFailure.unavailable }, reloadConfiguration: {},
                readTurnSummary: { _ in throw ClientDetailConfigurationFailure.unavailable },
                readTurnTrace: { _, _ in throw ClientDetailConfigurationFailure.unavailable },
                worktreeAPI: { _ in throw ClientDetailConfigurationFailure.unavailable }, onWorktreeJob: { _ in }, resident: .init())
            let handle = self.handle, arrangement = self.arrangement, activity = self.activity
            let content = ConversationDetailDashboard {
                ConversationNativeBusinessDetail(store: handle.store, api: nil, actions: nil,
                    context: .init(sessionKind: "assistantChat", taskID: nil, workID: nil), adapters: adapters,
                    handle: handle, arrangement: arrangement, refresh: {}, activity: activity,
                    canCommand: { _, _ in false }, perform: { _, _, _ in Issue.record("Drag dispatched a business command") })
            }
            host = NSHostingView(rootView: content)
            window = NSWindow(contentRect: CGRect(x: 100, y: 100, width: 324, height: 650),
                styleMask: [.titled, .resizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false; window.contentView = host; window.orderFront(nil)
            try receive()
        }

        func receive(includeSummary: Bool = true) throws {
            var cards: [[String: Any]] = [
                ["id": "references", "kind": "contextReferences", "version": 1, "revision": "1", "loadState": "ready", "data": ["items": [], "hasMore": false], "actions": []],
                ["id": "provider", "kind": "provider", "version": 1, "revision": "1", "loadState": "ready",
                 "data": ["providerId": "test", "name": "Test", "model": "Test", "reasoning": "", "switching": false, "providers": []], "actions": []]
            ]
            if includeSummary { cards.insert(["id": "summary", "kind": "chatSummary", "version": 1, "revision": "1", "loadState": "ready", "data": ["text": "Summary"], "actions": []], at: 0) }
            try handle.store.receive(ClientDetailBusinessDocument.decode(JSONSerialization.data(withJSONObject: [
                "protocolVersion": 1, "catalog": "native-business-v1", "documentId": "detail", "sessionId": "session:test",
                "generation": "generation", "revision": includeSummary ? "1" : "2", "cards": cards, "order": cards.map { $0["id"]! }
            ])))
        }
        func views<T: NSView>(_ type: T.Type) -> [T] {
            func collect(_ view: NSView) -> [T] { (view as? T).map { [$0] } ?? view.subviews.flatMap(collect) }
            return collect(host)
        }
        func controller() throws -> DetailCardReorderController { try #require(views(DetailCardReorderContainerProbe.View.self).first?.controller) }
        func settle() async throws { host.layoutSubtreeIfNeeded(); try await Task.sleep(for: .milliseconds(220)); host.layoutSubtreeIfNeeded() }
        func close() { window.contentView = nil; window.close(); defaults.removePersistentDomain(forName: suite) }
    }
}
#endif
