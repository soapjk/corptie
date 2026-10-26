import Foundation
import Observation
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit
#endif

@MainActor struct ConversationDetailRenderStateTests {
    private func entry(_ repository: ClientDetailBusinessRepository, _ id: String = "a") -> ClientDetailBusinessHandle {
        repository.entry(for: .init(serverID: "fixture", ownerID: "window", principalID: "user",
            sessionID: id, taskID: nil, workID: nil))
    }
    private func document(_ revision: Int, title: String = "Retained") throws -> ClientDetailBusinessDocument {
        try .decode(JSONSerialization.data(withJSONObject: [
            "protocolVersion": 1, "catalog": "native-business-v1", "documentId": "document", "sessionId": "a",
            "generation": "binding", "revision": "\(revision)", "order": ["session", "summary"],
            "cards": [
                ["id": "session", "kind": "sessionInfo", "version": 1, "revision": "fixed", "loadState": "ready",
                 "data": ["sessionId": "a", "workName": "Work"], "actions": []],
                ["id": "summary", "kind": "chatSummary", "version": 1, "revision": "\(revision)", "loadState": "ready",
                 "data": ["text": title], "actions": []]
            ]
        ]))
    }
    private func settle() async {
        for _ in 0..<10 { await Task.yield() }
        try? await Task.sleep(for: .milliseconds(30))
    }
    @Test func frozenCopiesAreIndependentAndCatchUpOnceWithoutReplacingCards() async throws {
        let repository = ClientDetailBusinessRepository(), render = ConversationDetailRenderState()
        let handle = entry(repository)
        try handle.store.receive(document(1))
        render.resume(from: handle)
        let first = render.store.orderedCards[0], second = render.store.orderedCards[1]
        #expect(first !== handle.store.orderedCards[0])
        render.freeze()
        let captures = render.captureCount, applies = render.applyCount
        for value in 2...10 { try handle.store.receive(document(value, title: "Changed \(value)")) }
        handle.turn.error = "Turn changed"; handle.worktree.error = "Worktree changed"
        await settle()
        #expect(render.captureCount == captures)
        #expect(render.applyCount == applies)
        #expect(render.store.orderedCards[1].card.revision == "1")
        #expect(render.turn.error == nil); #expect(render.worktree.error == nil)
        render.resume(from: handle)
        #expect(render.applyCount == applies + 1)
        #expect(render.store.orderedCards[0] === first)
        #expect(render.store.orderedCards[1] === second)
        #expect(second.card.revision == "10")
        #expect(render.turn.error == "Turn changed"); #expect(render.worktree.error == "Worktree changed")
    }
    @Test func unchangedResumeDoesNotPublishAndActiveChangesCoalesce() async throws {
        let repository = ClientDetailBusinessRepository(), render = ConversationDetailRenderState()
        let handle = entry(repository); try handle.store.receive(document(1)); render.resume(from: handle)
        let applies = render.applyCount
        let captures = render.captureCount
        for _ in 0..<200 { render.freeze(); render.resume(from: handle) }
        #expect(render.captureCount == captures)
        #expect(render.applyCount == applies)
        for value in 2...8 { try handle.store.receive(document(value)) }
        await settle()
        #expect(render.applyCount == applies + 1)
        #expect(render.store.orderedCards[1].card.revision == "8")
        let count = render.captureCount
        let other = entry(repository, "other"); other.turn.error = "Unrelated"
        await settle(); #expect(render.captureCount == count)
    }
    @Test func revocationClearsFrozenDisplayAndCannotResume() async throws {
        let repository = ClientDetailBusinessRepository(), render = ConversationDetailRenderState()
        let handle = entry(repository); try handle.store.receive(document(1)); render.resume(from: handle); render.freeze()
        repository.invalidateAll(); await settle()
        #expect(render.retired); #expect(render.store.order.isEmpty)
        render.resume(from: handle); #expect(render.store.order.isEmpty)
    }
    @Test func nativeSwitchFenceFreezesDetailCopyWithoutPublishingActivityThenResumesDirtyValues() async throws {
        let repository = ClientDetailBusinessRepository(), render = ConversationDetailRenderState()
        let handle = entry(repository); try handle.store.receive(document(1))
        let activity = ConversationDetailPresentationActivity(isActive: true)
        activity.bind(renderState: render); render.resume(from: handle)
        let captures = render.captureCount
        activity.suspendActions()
        #expect(activity.isActive, "Native visibility can change before observable lifecycle publications")
        try handle.store.receive(document(2)); await settle()
        #expect(render.captureCount == captures)
        #expect(render.store.orderedCards[1].card.revision == "1")
        activity.activate(); await settle()
        #expect(render.store.orderedCards[1].card.revision == "2")
        #expect(render.captureCount == captures + 1)
    }

    @Test func sourceDoesNotRetainDisplayTracker() async throws {
        let repository = ClientDetailBusinessRepository(), handle = entry(repository)
        try handle.store.receive(document(1))
        weak var retained: ConversationDetailRenderState?
        do { let render = ConversationDetailRenderState(); retained = render; render.resume(from: handle); render.freeze() }
        #expect(retained == nil)
        try handle.store.receive(document(2)); await settle()
    }
    @Test func synchronousActionFenceDoesNotPublishAnActivityChange() {
        let activity = ConversationDetailPresentationActivity(isActive: true)
        let generation = activity.generation
        activity.suspendActions()
        #expect(activity.isActive); #expect(activity.generation == generation)
        #expect(!activity.allows(generation: generation))
        activity.deactivate(); activity.activate()
        #expect(activity.allows(generation: activity.generation))
        #expect(!activity.allows(generation: generation))
    }
    #if os(macOS)
    @Test func realHostingViewDoesNotObserveFrozenSourceAndUpdatesAfterResume() async throws {
        _ = NSApplication.shared
        let repository = ClientDetailBusinessRepository(), render = ConversationDetailRenderState()
        let handle = entry(repository); try handle.store.receive(document(1)); render.resume(from: handle)
        let counter = RenderCounter()
        let host = NSHostingView(rootView: RenderProbe(render: render, counter: counter))
        let window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 300, height: 200),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderBack(nil)
        defer { window.contentView = nil; window.close() }
        host.layoutSubtreeIfNeeded(); await settle()
        #expect(counter.count > 0)
        render.freeze(); let before = counter.count
        try handle.store.receive(document(2, title: "Latest")); handle.turn.error = "Changed"; handle.worktree.error = "Changed"
        await settle(); host.layoutSubtreeIfNeeded(); await settle()
        #expect(counter.count == before)
        render.resume(from: handle); await settle(); host.layoutSubtreeIfNeeded(); await settle()
        #expect(counter.count > before)
        #expect(counter.lastRevision == "2")
    }
    private final class RenderCounter { var count = 0; var lastRevision: String? }
    private struct RenderProbe: View {
        let render: ConversationDetailRenderState
        let counter: RenderCounter
        var body: some View {
            let _ = { counter.count += 1; counter.lastRevision = render.store.orderedCards.last?.card.revision }()
            VStack {
                ForEach(render.store.orderedCards) { Text($0.card.revision) }
                Text(render.turn.error ?? ""); Text(render.worktree.error ?? "")
            }
        }
    }
    #endif
}
