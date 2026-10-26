import AppKit
import Combine
import CorptieClientCore
import CorptieConversation
import Observation
import OSLog
import SwiftUI

/// Only the small recommendation surface observes its cache signal and state.
/// AppKit visibility, not an unrelated SwiftUI Settings Scene, owns its work.
struct MacComposerQuickMessages: View {
    let host: String
    let sessionID: String
    let taskID: String?
    let online: Bool
    let refreshRevision: Int
    let enabled: Bool
    let cache: ClientQuickMessageCache
    let activity: ConversationDetailPresentationActivity?
    let load: @MainActor @Sendable () async throws -> ClientQuickMessageRecommendations
    let send: (String) -> Void
    @State private var state: MacQuickMessageState
    @State private var visibility = MacQuickMessageVisibility()

    init(host: String, sessionID: String, taskID: String?, online: Bool, refreshRevision: Int,
         enabled: Bool, cache: ClientQuickMessageCache = BackendClient.quickMessageCache,
         state: MacQuickMessageState = MacQuickMessageState(),
         activity: ConversationDetailPresentationActivity? = nil,
         load: @escaping @MainActor @Sendable () async throws -> ClientQuickMessageRecommendations,
         send: @escaping (String) -> Void) {
        self.host = host; self.sessionID = sessionID; self.taskID = taskID
        self.online = online; self.refreshRevision = refreshRevision; self.enabled = enabled
        self.cache = cache; self.load = load; self.send = send; self.activity = activity
        _state = State(initialValue: state)
    }

    private var identity: MacQuickMessageIdentity {
        .init(host: host, sessionID: sessionID, taskID: taskID)
    }

    private var isActive: Bool { activity?.isActive ?? visibility.visible }
    private var refreshKey: String {
        "\(identity.scope):\(sessionID):\(online):\(refreshRevision):\((isActive ? cache.revision(for: identity.scope, host: host) : 0)):\(isActive):\(visibility.activation)"
    }

    var body: some View {
        // Never show A's items during the first rendering pass after switching to B.
        ConversationQuickMessages(items: state.identity == identity || !isActive ? state.items : cache.items(for: identity.scope),
                                  enabled: enabled, send: send)
            .background {
                if activity == nil { MacQuickMessageVisibilityBridge { visibility = $0 } }
            }
            .task(id: refreshKey) {
                await state.refresh(identity: identity, visible: isActive, online: online,
                                    cache: cache, load: load)
            }
    }
}

struct MacQuickMessageIdentity: Equatable {
    let host: String
    let sessionID: String
    let taskID: String?
    @MainActor var scope: String { ClientQuickMessageCache.scope(host: host, taskID: taskID, sessionID: sessionID) }
}

@MainActor @Observable
final class MacQuickMessageState {
    enum Phase: Equatable { case idle, deferred, loading, loaded, failed }
    private(set) var items = ClientQuickMessage.defaults
    private(set) var phase: Phase = .idle
    private(set) var identity: MacQuickMessageIdentity?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var attempted = false
    private static let log = Logger(subsystem: "com.corptie.client", category: "QuickMessages")

    func refresh(identity next: MacQuickMessageIdentity, visible: Bool, online: Bool,
                 cache: ClientQuickMessageCache,
                 pause: @MainActor @Sendable () async throws -> Void = { try await Task.sleep(for: .milliseconds(600)) },
                 load: @escaping @MainActor @Sendable () async throws -> ClientQuickMessageRecommendations) async {
        generation &+= 1
        let requestGeneration = generation
        if identity != next {
            identity = next
            items = cache.items(for: next.scope)
            attempted = false
        }
        guard visible, online else {
            phase = .deferred
            Self.log.debug("Recommendation refresh deferred. visible=\(visible) online=\(online)")
            return
        }
        let debounce = attempted
        attempted = true
        phase = .loading
        do {
            // Cold/changed scopes load immediately. Only follow-up events debounce.
            if debounce { try await pause() }
            try Task.checkCancellation()
            guard generation == requestGeneration else { return }
            Self.log.debug("Recommendation request started. debounced=\(debounce)")
            let result = try await cache.readRefreshing(scope: next.scope, load: load)
            try Task.checkCancellation()
            guard generation == requestGeneration, identity == next else { return }
            guard next.taskID == nil || result.taskId == next.taskID else { throw ClientConnectionError.invalidResponse }
            let resolved = ClientQuickMessageCache.scope(host: next.host, taskID: result.taskId, sessionID: next.sessionID)
            let items = cache.remember(result.items, for: resolved)
            if resolved != next.scope { cache.remember(items, for: next.scope) }
            if self.items != items { self.items = items }
            phase = .loaded
            Self.log.debug("Recommendation request applied. count=\(items.count)")
        } catch {
            guard generation == requestGeneration else { return }
            if Task.isCancelled || error is CancellationError || (error as? URLError)?.code == .cancelled {
                phase = .idle
                Self.log.debug("Recommendation request cancelled; retaining snapshot.")
            } else {
                phase = .failed
                ClientQuickMessageDiagnostics.failure(error)
            }
        }
    }
}

struct MacQuickMessageVisibility: Equatable {
    var visible = false
    var activation = 0
}

private struct MacQuickMessageVisibilityBridge: NSViewRepresentable {
    let changed: @MainActor (MacQuickMessageVisibility) -> Void
    func makeNSView(context: Context) -> MacQuickMessageVisibilityView {
        MacQuickMessageVisibilityView(changed: changed)
    }
    func updateNSView(_ view: MacQuickMessageVisibilityView, context: Context) { view.changed = changed }
    static func dismantleNSView(_ view: MacQuickMessageVisibilityView, coordinator: ()) { view.stop() }
}

/// No polling, layout observation, key-window requirement or global window manager.
/// NSView propagates ancestor hide/unhide callbacks to hosted descendants.
@MainActor
final class MacQuickMessageVisibilityView: NSView {
    var changed: @MainActor (MacQuickMessageVisibility) -> Void
    private let center: NotificationCenter
    private var observers: [AnyCancellable] = []
    private var snapshot = MacQuickMessageVisibility()
    private var scheduled = false
    private var pendingActivation = false
    private var stopped = false
    private(set) var publicationCount = 0

    init(center: NotificationCenter = .default, changed: @escaping @MainActor (MacQuickMessageVisibility) -> Void) {
        self.center = center; self.changed = changed
        super.init(frame: .zero)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeObservers()
        if let window, !stopped {
            for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                         NSWindow.didDeminiaturizeNotification, NSWindow.willCloseNotification] {
                let token = center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.schedule() }
                }
                observers.append(AnyCancellable { [center] in center.removeObserver(token) })
            }
            for name in [NSApplication.didBecomeActiveNotification, NSApplication.didHideNotification,
                         NSApplication.didUnhideNotification] {
                let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                    MainActor.assumeIsolated { self?.schedule(activation: name == NSApplication.didBecomeActiveNotification) }
                }
                observers.append(AnyCancellable { [center] in center.removeObserver(token) })
            }
        }
        schedule()
    }
    override func viewDidMoveToSuperview() { super.viewDidMoveToSuperview(); schedule() }
    override func viewDidHide() { super.viewDidHide(); schedule() }
    override func viewDidUnhide() { super.viewDidUnhide(); schedule() }

    func schedule(activation: Bool = false) {
        guard !stopped else { return }
        pendingActivation = pendingActivation || activation
        guard !scheduled else { return }
        scheduled = true
        // Never mutate SwiftUI state from a layout/attachment callback.
        DispatchQueue.main.async { [weak self] in self?.publish() }
    }
    private func publish() {
        scheduled = false
        guard !stopped else { return }
        let visible = window?.isVisible == true && window?.isMiniaturized == false
            && !NSApp.isHidden && !isHiddenOrHasHiddenAncestor
        var next = snapshot
        next.visible = visible
        if visible && pendingActivation { next.activation &+= 1 }
        pendingActivation = false
        guard next != snapshot else { return }
        snapshot = next
        publicationCount += 1
        changed(next)
    }
    func stop() {
        stopped = true
        removeObservers()
    }
    private func removeObservers() {
        observers.removeAll()
    }
}
