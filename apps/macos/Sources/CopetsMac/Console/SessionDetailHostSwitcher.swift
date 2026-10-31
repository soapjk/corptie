import AppKit
import SwiftUI
import CorptieClientCore
import CorptieConversation

/// Development-only bounded cache of mounted Detail controls, independent of business data retention.
struct SessionDetailHostSwitcher: NSViewControllerRepresentable {
    let session: TaskSession
    let scope: ClientDetailBusinessScope
    let repository: ClientDetailBusinessRepository
    let presentation: ConversationDetailPresentationRepository
    let revision: UInt64
    let railWidth: CGFloat
    let isActive: Bool

    func makeNSViewController(context: Context) -> SessionDetailHostController {
        SessionDetailHostController(repository: repository)
    }
    func updateNSViewController(_ controller: SessionDetailHostController, context: Context) {
        controller.present(session: session, scope: scope, revision: revision, isActive: isActive) { activity in
            SessionDetailPanel(session: session, railWidth: railWidth, activity: activity, detailPresentation: presentation)
        }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: SessionDetailHostController, context: Context) -> CGSize? {
        CGSize(width: railWidth, height: proposal.height.flatMap { $0.isFinite ? $0 : nil } ?? 700)
    }
    static func dismantleNSViewController(_ controller: SessionDetailHostController, coordinator: ()) { controller.disposeAll() }
}

@MainActor final class SessionDetailHostController: NSViewController {
    final class Entry {
        let scope: ClientDetailBusinessScope
        let handle: ClientDetailBusinessHandle
        let host: NSHostingController<SessionDetailPanel>
        let activity: ConversationDetailPresentationActivity
        var session: TaskSession
        var revision: UInt64
        var lastUsed: UInt64
        init(scope: ClientDetailBusinessScope, handle: ClientDetailBusinessHandle, host: NSHostingController<SessionDetailPanel>,
             activity: ConversationDetailPresentationActivity, session: TaskSession, revision: UInt64, lastUsed: UInt64) {
            self.scope = scope; self.handle = handle; self.host = host; self.activity = activity
            self.session = session; self.revision = revision; self.lastUsed = lastUsed
        }
    }
    private let repository: ClientDetailBusinessRepository
    private(set) var entries: [Entry] = []
    private(set) weak var current: Entry?
    private var sequence: UInt64 = 0
    private var parentActive = false
    private weak var observedWindow: NSWindow?
    private var observations: [NSObjectProtocol] = []
    private var pressure: (any DispatchSourceMemoryPressure)?
    init(repository: ClientDetailBusinessRepository) { self.repository = repository; super.init(nibName: nil, bundle: nil) }
    isolated deinit {
        pressure?.cancel()
        for token in observations { NotificationCenter.default.removeObserver(token) }
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func loadView() {
        let container = SessionDetailHostContainerView()
        container.owner = self
        view = container
        installMemoryPressureHandler()
    }
    func present(session: TaskSession, scope: ClientDetailBusinessScope, revision: UInt64, isActive: Bool,
                 buildRoot: (ConversationDetailPresentationActivity) -> SessionDetailPanel) {
        loadViewIfNeeded()
        invalidateBindings(for: scope)
        parentActive = isActive
        if current?.scope != scope { deactivateCurrent() }
        sequence &+= 1
        let entry: Entry
        if let cached = entries.first(where: { $0.scope == scope && !$0.handle.retired }) {
            entry = cached
            SessionSwitchTrace.shared.mark(.detailHostReused, sessionID: session.id)
            if cached.revision != revision || cached.session != session {
                SessionSwitchTrace.shared.mark(.detailHostRootUpdated, sessionID: session.id)
                cached.host.rootView = buildRoot(cached.activity)
                cached.session = session; cached.revision = revision
            }
        } else {
            // Evict before allocation so even a cold fourth selection never retains four hosts.
            trim(to: 2)
            entry = makeEntry(session: session, scope: scope, revision: revision, buildRoot: buildRoot)
        }
        current = entry; entry.lastUsed = sequence
        entry.host.view.frame = view.bounds
        entry.host.view.isHidden = false
        refreshVisibility()
        trim(to: 3)
    }
    private func makeEntry(session: TaskSession, scope: ClientDetailBusinessScope, revision: UInt64,
                           buildRoot: (ConversationDetailPresentationActivity) -> SessionDetailPanel) -> Entry {
        SessionSwitchTrace.shared.mark(.detailHostCreated, sessionID: session.id)
        let activity = ConversationDetailPresentationActivity()
        let host = NSHostingController(rootView: buildRoot(activity))
        host.sizingOptions = []
        let entry = Entry(scope: scope, handle: repository.entry(for: scope), host: host, activity: activity,
                          session: session, revision: revision, lastUsed: sequence)
        addChild(host); host.view.isHidden = true; view.addSubview(host.view)
        entries.append(entry)
        return entry
    }
    private func deactivateCurrent() {
        guard let entry = current else { return }
        entry.activity.deactivate()
        for presented in entry.host.presentedViewControllers ?? [] { entry.host.dismiss(presented) }
        if let responder = view.window?.firstResponder as? NSView, responder.isDescendant(of: entry.host.view) {
            view.window?.makeFirstResponder(nil)
        }
        entry.host.view.isHidden = true; current = nil
        if entry.handle.retired || entry.handle.legacy || !entry.handle.store.selected { disposeEntry(entry) }
    }
    private func invalidateBindings(for scope: ClientDetailBusinessScope) {
        for entry in entries {
            let old = entry.scope
            if entry.handle.retired || old.serverID != scope.serverID || old.ownerID != scope.ownerID
                || old.principalID != scope.principalID || (old.sessionID == scope.sessionID && old != scope) {
                disposeEntry(entry)
            }
        }
    }
    private func trim(to capacity: Int) {
        while entries.count > capacity {
            guard let oldest = entries.filter({ $0 !== current }).min(by: { $0.lastUsed < $1.lastUsed }) else { break }
            disposeEntry(oldest)
        }
    }
    private func disposeEntry(_ entry: Entry) {
        entry.activity.deactivate()
        if current === entry { current = nil }
        entry.host.view.removeFromSuperview(); entry.host.removeFromParent()
        entries.removeAll { $0 === entry }
    }
    func disposeAll() {
        for entry in entries { disposeEntry(entry) }
        for token in observations { NotificationCenter.default.removeObserver(token) }
        observations.removeAll(); observedWindow = nil
        pressure?.cancel(); pressure = nil
    }
    func observeWindow(_ window: NSWindow?) {
        guard observedWindow !== window else { refreshVisibility(); return }
        for token in observations { NotificationCenter.default.removeObserver(token) }
        observations.removeAll(); observedWindow = window
        if let window {
            for name in [NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
                         NSWindow.didDeminiaturizeNotification, NSWindow.willCloseNotification] {
                observations.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                    Task { @MainActor [weak self] in self?.refreshVisibility() }
                })
            }
        }
        refreshVisibility()
    }
    func refreshVisibility() {
        guard let current else { return }
        let visible = parentActive && !view.isHiddenOrHasHiddenAncestor && view.window?.isVisible == true
            && view.window?.occlusionState.contains(.visible) == true
        if visible { current.activity.activate() } else { current.activity.deactivate() }
    }
    func trimToActive() { for entry in entries where entry !== current { disposeEntry(entry) } }
    private func installMemoryPressureHandler() {
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in Task { @MainActor [weak self] in self?.trimToActive() } }
        pressure = source; source.resume()
    }
}

@MainActor final class SessionDetailHostContainerView: NSView {
    weak var owner: SessionDetailHostController?
    override var fittingSize: NSSize { NSSize(width: bounds.width > 0 ? bounds.width : 280, height: bounds.height > 0 ? bounds.height : 700) }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
    override func layout() { super.layout(); owner?.current?.host.view.frame = bounds }
    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); owner?.observeWindow(window) }
    override func viewDidHide() { super.viewDidHide(); owner?.refreshVisibility() }
    override func viewDidUnhide() { super.viewDidUnhide(); owner?.refreshVisibility() }
}
