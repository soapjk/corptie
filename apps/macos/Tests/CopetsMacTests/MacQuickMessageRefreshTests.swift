import AppKit
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieMac

@MainActor
struct MacQuickMessageRefreshTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CORPTIE_QUICK_MESSAGE_LIVE_URL"] != nil))
    func loopbackRecommendationsDecodeAndReachAppKitPresentationWithoutWritingUserCache() async throws {
        let raw = try #require(ProcessInfo.processInfo.environment["CORPTIE_QUICK_MESSAGE_LIVE_URL"])
        let url = try #require(URL(string: raw))
        try #require(url.scheme == "http" && url.host == "127.0.0.1" && url.port == 47321)
        try #require(url.path.hasPrefix("/sessions/") && url.path.hasSuffix("/quick-messages"))
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        let (data, response) = try await URLSession.shared.data(for: request)
        try #require((response as? HTTPURLResponse)?.statusCode == 200)
        let result = try JSONDecoder().decode(ClientQuickMessageRecommendations.self, from: data).validated()
        try #require(result.items.count == 8)
        try await withCache { cache in
            let state = MacQuickMessageState()
            let content = MacComposerQuickMessages(host: "live-response-fixture", sessionID: "fixture",
                taskID: result.taskId, online: true, refreshRevision: 0, enabled: true, cache: cache,
                state: state, load: { result }, send: { _ in })
                .environment(\.scenePhase, .background)
            let window = makeWindow(NSHostingView(rootView: content))
            defer { window.contentView = nil; window.close() }
            window.orderFront(nil)
            try await eventually { state.phase == .loaded }
            #expect(state.items.count == 8)
            #expect(state.items.map(\.id) == result.items.map(\.id))
        }
    }

    @Test func composerDoesNotGateQuickMessagesOnAnUnmanagedSwiftUIScene() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/Conversation/Composer/MessageComposer.swift")
        let text = try String(contentsOf: source, encoding: .utf8)
        #expect(!text.contains("scenePhase == .active"))
        #expect(text.contains("MacComposerQuickMessages("))
    }

    @Test func independentAppKitHostLoadsEightWithBackgroundSceneAndRefreshesOnInvalidation() async throws {
        try await withCache { cache in
            let state = MacQuickMessageState()
            var calls = 0
            let content = MacComposerQuickMessages(host: "fixture", sessionID: "s", taskID: "task:a",
                online: true, refreshRevision: 0, enabled: true, cache: cache, state: state,
                load: { calls += 1; return self.result(task: "task:a", prefix: "new\(calls)") }, send: { _ in })
                .environment(\.scenePhase, .background)
            let host = NSHostingView(rootView: content)
            let window = makeWindow(host)
            defer { window.contentView = nil; window.close() }
            #expect(state.items == ClientQuickMessage.defaults)
            window.orderFront(nil)
            host.layoutSubtreeIfNeeded()
            try await eventually { state.phase == .loaded }
            #expect(calls == 1 && state.items.count == 8)
            #expect(cache.items(for: identity().scope).count == 8)
            cache.invalidate(host: "fixture", taskID: "task:a", sessionID: "s")
            try await eventually { calls == 2 && state.phase == .loaded }
            #expect(state.items.first?.text == "new2-0")
            host.isHidden = true
            try await eventually { state.phase == .deferred }
            cache.invalidate(host: "fixture", taskID: "task:a", sessionID: "s")
            try await Task.sleep(for: .milliseconds(50))
            #expect(calls == 2)
            host.isHidden = false
            try await eventually { calls == 3 && state.phase == .loaded }
            #expect(window.isKeyWindow == false)
        }
    }

    @Test func hiddenAndOfflineScopesDeferAndColdLoadDoesNotDebounce() async throws {
        try await withCache { cache in
            let state = MacQuickMessageState()
            var calls = 0
            let load: @MainActor @Sendable () async throws -> ClientQuickMessageRecommendations = {
                calls += 1; return self.result(task: "task:a")
            }
            await state.refresh(identity: identity(), visible: false, online: true, cache: cache, load: load)
            await state.refresh(identity: identity(), visible: true, online: false, cache: cache, load: load)
            #expect(calls == 0 && state.phase == .deferred)
            await state.refresh(identity: identity(), visible: true, online: true, cache: cache,
                pause: { Issue.record("A cold load must not debounce") }, load: load)
            #expect(calls == 1 && state.items.count == 8)
        }
    }

    @Test func lateResponseCannotReplaceAnotherScopesItems() async throws {
        try await withCache { cache in
            let state = MacQuickMessageState()
            var pending: CheckedContinuation<ClientQuickMessageRecommendations, Never>?
            let old = Task { @MainActor in
                await state.refresh(identity: identity(), visible: true, online: true, cache: cache) {
                    await withCheckedContinuation { pending = $0 }
                }
            }
            try await eventually { pending != nil }
            await state.refresh(identity: identity(task: "task:b"), visible: true, online: true, cache: cache) {
                self.result(task: "task:b", prefix: "B")
            }
            pending?.resume(returning: result(task: "task:a", prefix: "A"))
            await old.value
            #expect(state.identity == identity(task: "task:b"))
            #expect(state.items.first?.text == "B-0")
            #expect(cache.items(for: identity().scope) == ClientQuickMessage.defaults)
        }
    }

    @Test func failuresKeepLastGoodSnapshotAndSuccessfulDefaultsAreDistinct() async throws {
        try await withCache { cache in
            let state = MacQuickMessageState()
            await state.refresh(identity: identity(), visible: true, online: true, cache: cache) { self.result(task: "task:a") }
            let previous = state.items
            await state.refresh(identity: identity(), visible: true, online: true, cache: cache, pause: {}) {
                throw ClientConnectionError.invalidResponse
            }
            #expect(state.phase == .failed && state.items == previous)
            #expect(cache.items(for: identity().scope) == previous)
            await state.refresh(identity: identity(), visible: true, online: true, cache: cache, pause: {}) {
                self.result(task: "task:a", defaultsOnly: true)
            }
            #expect(state.phase == .loaded && state.items == ClientQuickMessage.defaults)
        }
    }

    @Test func appKitVisibilityCoalescesChangesAndIgnoresLayoutAndKeyFocus() async throws {
        let center = NotificationCenter()
        var values: [MacQuickMessageVisibility] = []
        let probe = MacQuickMessageVisibilityView(center: center) { values.append($0) }
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 400, height: 80))
        root.addSubview(probe)
        let window = makeWindow(root)
        defer { probe.stop(); window.contentView = nil; window.close() }
        window.orderFront(nil)
        try await eventually { values.last?.visible == true }
        let count = probe.publicationCount
        for _ in 0..<100 { probe.layoutSubtreeIfNeeded(); probe.schedule() }
        try await Task.sleep(for: .milliseconds(30))
        #expect(probe.publicationCount == count)
        root.isHidden = true
        try await eventually { values.last?.visible == false }
        center.post(name: NSApplication.didBecomeActiveNotification, object: nil)
        try await Task.sleep(for: .milliseconds(30))
        #expect(values.last?.activation == 0)
        root.isHidden = false
        try await eventually { values.last?.visible == true }
        for _ in 0..<20 { center.post(name: NSApplication.didBecomeActiveNotification, object: nil) }
        try await eventually { values.last?.activation == 1 }
        #expect(window.isKeyWindow == false)
        probe.stop()
        let stoppedCount = probe.publicationCount
        center.post(name: NSApplication.didBecomeActiveNotification, object: nil)
        try await Task.sleep(for: .milliseconds(30))
        #expect(probe.publicationCount == stoppedCount)
    }

    @Test func hidingHostCancelsItsWaiterAndAnIgnoringTransportCannotApplyLateItems() async throws {
        try await withCache { cache in
            let state = MacQuickMessageState()
            var pending: CheckedContinuation<ClientQuickMessageRecommendations, Never>?
            let content = MacComposerQuickMessages(host: "fixture", sessionID: "s", taskID: "task:a",
                online: true, refreshRevision: 0, enabled: true, cache: cache, state: state,
                load: { await withCheckedContinuation { pending = $0 } }, send: { _ in })
            let host = NSHostingView(rootView: content)
            let window = makeWindow(host)
            defer {
                pending?.resume(returning: result(task: "task:a"))
                window.contentView = nil; window.close()
            }
            window.orderFront(nil)
            try await eventually { pending != nil }
            host.isHidden = true
            try await eventually { state.phase == .deferred && cache.inFlightCount == 0 }
            pending?.resume(returning: result(task: "task:a")); pending = nil
            try await Task.sleep(for: .milliseconds(30))
            #expect(state.items == ClientQuickMessage.defaults)
            #expect(cache.items(for: identity().scope) == ClientQuickMessage.defaults)
        }
    }

    private func identity(task: String = "task:a") -> MacQuickMessageIdentity {
        .init(host: "fixture", sessionID: "s", taskID: task)
    }
    private func result(task: String, prefix: String = "command", defaultsOnly: Bool = false) -> ClientQuickMessageRecommendations {
        let items: [ClientQuickMessage] = defaultsOnly ? ClientQuickMessage.defaults : (0..<8).map {
            .init(id: "\(prefix)-\($0)", text: "\(prefix)-\($0)", scope: "task", count: 3)
        }
        let payload: [String: Any] = ["schemaVersion": 1, "taskId": task, "items": items.map {
            ["id": $0.id, "text": $0.text, "scope": $0.scope, "count": $0.count] as [String: Any]
        }]
        return try! JSONDecoder().decode(ClientQuickMessageRecommendations.self, from: JSONSerialization.data(withJSONObject: payload))
    }
    private func makeWindow(_ content: NSView) -> NSWindow {
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 460, height: 80),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = content
        return window
    }
    private func eventually(_ condition: () -> Bool) async throws {
        for _ in 0..<200 {
            if condition() { return }
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(condition())
    }
    private func withCache(_ body: (ClientQuickMessageCache) async throws -> Void) async rethrows {
        let suite = "quick-mac-test-\(UUID())"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        try await body(ClientQuickMessageCache(defaults: defaults))
    }
}
