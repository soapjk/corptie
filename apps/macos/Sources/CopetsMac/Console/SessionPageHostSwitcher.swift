import AppKit
import SwiftUI
import CorptieClientCore
import CorptieConversation

/// The Work column remains outside this container. Each entry owns exactly
/// one mounted conversation/editor/Detail tree; there is no nested Detail pool.
struct ResidentSessionPageSwitcher<Fallback: View>: NSViewControllerRepresentable {
    let presentation: SessionPagePresentationState
    let selectedSessionID: String?
    let isActive: Bool
    let backend: BackendClient
    let cache: SessionPresentationCache
    let drafts: ComposerDraftRepository
    let viewport: SessionViewportController
    let detailPresentation: ConversationDetailPresentationRepository
    let layout: PanelLayoutState
    @ViewBuilder let fallback: () -> Fallback

    func makeNSViewController(context: Context) -> ResidentSessionPageHostController<ResidentSessionPageRoot, Fallback> {
        let controller = ResidentSessionPageHostController(fallback: ConsolePaneContent(content: fallback),
            makeInputs: { id in
                guard let session = backend.appState.session(id) ?? backend.archivedSessions.first(where: { $0.id == id }) else { return nil }
                return SessionPageRenderInputs(session: session,
                    scope: ClientDetailBusinessScope(serverID: backend.baseURL.absoluteString,
                        ownerID: backend.detailBusinessOwnerID, principalID: "local-user", sessionID: id,
                        taskID: session.taskId, workID: session.workId), backend: backend,
                    timeline: SessionTimelineRepository.shared.state(for: id), projection: cache.state(for: id))
            }, root: { inputs in
                ResidentSessionPageRoot(inputs: inputs, backend: backend, cache: cache,
                    drafts: drafts, viewport: viewport, detailPresentation: detailPresentation, layout: layout)
            })
        presentation.presenter = controller
        return controller
    }
    func updateNSViewController(_ controller: ResidentSessionPageHostController<ResidentSessionPageRoot, Fallback>, context: Context) {
        controller.update(fallback: ConsolePaneContent(content: fallback), selectedSessionID: selectedSessionID, isActive: isActive)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: ResidentSessionPageHostController<ResidentSessionPageRoot, Fallback>, context: Context) -> CGSize? {
        CGSize(width: proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 1000,
               height: proposal.height.flatMap { $0.isFinite ? $0 : nil } ?? 700)
    }
    static func dismantleNSViewController(_ controller: ResidentSessionPageHostController<ResidentSessionPageRoot, Fallback>, coordinator: ()) {
        controller.disposeAll()
    }
}

struct ResidentSessionPageRoot: View {
    @State private var showsMailbox = false
    @AppStorage("ui.conversation.showDetails", store: CorptieAppEnvironment.userDefaults) private var showsDetailColumn = false
    let inputs: SessionPageRenderInputs
    let backend: BackendClient
    let cache: SessionPresentationCache
    let drafts: ComposerDraftRepository
    let viewport: SessionViewportController
    let detailPresentation: ConversationDetailPresentationRepository
    let layout: PanelLayoutState
    var body: some View {
        Group {
            if inputs.retired {
                Text(L10n("This conversation no longer exists."))
                    .foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else { page }
        }
    }
    private var page: some View {
        AdaptiveConversationColumns(isVisible: Binding(
            get: { showsDetailColumn && inputs.activity.isActive },
            set: { if inputs.activity.isActive { showsDetailColumn = $0 } }
        )) {
            SessionConversationSurface(sessionId: inputs.scope.sessionID, presentationCache: cache,
                composerDraftRepository: drafts, backendClient: backend,
                initialTimelinePosition: viewport.position(for: inputs.scope.sessionID),
                onTimelinePositionChange: { viewport.store($0, for: inputs.scope.sessionID) },
                showsHeader: false, renderInputs: inputs)
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
            .modifier(ConversationColumnSurface(.transcript))
        } detail: {
            Group {
                if showsMailbox && inputs.activity.isActive {
                    SessionMailboxPanel(sessionID: inputs.scope.sessionID,
                        pendingRevision: "\(inputs.session.mailboxPendingCount ?? 0):\(inputs.session.executionStatus ?? inputs.session.status.rawValue)",
                        activity: inputs.activity, showsTitle: false)
                        .id(inputs.scope.sessionID)
                } else {
                    SessionDetailPanel(session: inputs.session, railWidth: ConversationDetailWidgetMetrics.railWidth,
                        activity: inputs.activity, detailPresentation: detailPresentation)
                }
            }
            .frame(width: ConversationDetailWidgetMetrics.railWidth)
            .frame(maxHeight: .infinity)
        } header: {
            // Keep the total height inside the pinned 48pt accessory: the
            // header moved its padding from the bottom to the top.
            ResidentSessionPageHeader(inputs: inputs, backend: backend)
        }
        .padding(.horizontal, MainWindowPageLayoutMetrics.outerPadding)
        .padding(.bottom, MainWindowPageLayoutMetrics.outerPadding)
        .padding(.top, 2)
        // Both columns share the full-height viewport. Compensating only the
        // transcript leaves Detail's clip edge below the floating controls.
        .ignoresSafeArea(.container, edges: .top)
        .environment(\.detailColumnVisibility, $showsDetailColumn)
        .environment(\.sessionMailboxVisibility, $showsMailbox)
        .onChange(of: inputs.activity.isActive) { _, active in if !active { showsMailbox = false } }
        .onChange(of: showsDetailColumn) { _, visible in if !visible { showsMailbox = false } }
        .modifier(ConversationSkinHost())
        .environmentObject(layout)
        .environmentObject(backend)
    }
}

/// Observe header data here rather than invalidating the whole page for it.
private struct ResidentSessionPageHeader: View {
    let inputs: SessionPageRenderInputs
    let backend: BackendClient
    var body: some View {
        SessionConversationHeaderSurface(session: inputs.session, historicalWorkspacePath: inputs.detail?.cwd,
            backendClient: backend, projectStatus: inputs.projectStatus,
            showsHistoricalThread: inputs.historicalThreadID != nil,
            hasPendingScheduledWake: inputs.tasks.first { $0.id == inputs.session.taskId }?.hasPendingScheduledWake == true,
            providers: inputs.providers, renderInputs: inputs)
    }
}

@MainActor final class ResidentSessionPageHostController<Root: View, Fallback: View>: NSViewController, SessionPagePresenting {
    @MainActor final class Entry {
        let inputs: SessionPageRenderInputs
        let host: NSHostingController<Root>
        let surface: NSView
        var lastUsed: UInt64 = 0
        var layoutSize: NSSize = .zero
        init(inputs: SessionPageRenderInputs, root: Root) {
            self.inputs = inputs; host = NSHostingController(rootView: root); host.sizingOptions = []
            (host.view as? NSHostingView<Root>)?.safeAreaRegions = []
            let surface = SessionPageSurfaceView()
            surface.wantsLayer = true; surface.isHidden = true; surface.alphaValue = 0
            host.view.autoresizingMask = [.width, .height]
            surface.addSubview(host.view)
            self.surface = surface
            surface.onCompletedLayout = { [weak self] size in
                guard let self else { return }
                self.layoutSize = size
            }
        }
    }
    private let isVisible: @MainActor (NSView) -> Bool
    private let makeInputs: (String) -> SessionPageRenderInputs?
    private let root: (SessionPageRenderInputs) -> Root
    private var fallbackRoot: ConsolePaneContent<Fallback>
    private var fallbackHost: NSHostingController<ConsolePaneContent<Fallback>>?
    private var cleanupWork: DispatchWorkItem?
    private(set) var entries: [Entry] = []
    private(set) weak var current: Entry?
    private(set) weak var visiblePage: Entry?
    private(set) var pendingSessionID: String?
    var settledSessionID: String? { pendingSessionID == nil && current?.inputs.retired == false ? current?.inputs.scope.sessionID : nil }
    private var selectedSessionID: String?
    private var sequence: UInt64 = 0
    private var epoch: UInt64 = 0
    private var isActive = true
    private(set) var capacity = SessionSwitchingPreferences.maximumResidentPages
    private var pressure: (any DispatchSourceMemoryPressure)?
    private var observations: [NSObjectProtocol] = []

    init(fallback: ConsolePaneContent<Fallback>,
         isVisible: @escaping @MainActor (NSView) -> Bool = {
             !$0.isHiddenOrHasHiddenAncestor && $0.window?.isVisible == true
                 && $0.window?.occlusionState.contains(.visible) == true
         },
         makeInputs: @escaping (String) -> SessionPageRenderInputs?, root: @escaping (SessionPageRenderInputs) -> Root) {
        fallbackRoot = fallback; self.isVisible = isVisible
        self.makeInputs = makeInputs; self.root = root
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    isolated deinit {
        cleanupWork?.cancel()
        pressure?.cancel()
        for token in observations { NotificationCenter.default.removeObserver(token) }
    }
    override func loadView() {
        let container = SessionPageContainerView()
        view = container
        for name in [NSWindow.didMiniaturizeNotification, NSWindow.willCloseNotification, NSWindow.didChangeOcclusionStateNotification] {
            observations.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let window = notification.object as? NSWindow else { return }
                Task { @MainActor [weak self] in
                    guard let self, self.view.window === window else { return }
                    if !window.isVisible || !window.occlusionState.contains(.visible) {
                        self.cancelPendingPresentation(); self.entries.forEach { $0.inputs.freeze() }
                    } else if self.isActive {
                        self.update(fallback: self.fallbackRoot, selectedSessionID: self.selectedSessionID, isActive: true)
                    }
                }
            })
        }
        let source = DispatchSource.makeMemoryPressureSource(eventMask: [.normal, .warning, .critical], queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated {
                guard let self, let source = self.pressure else { return }
                self.handleMemoryPressure(source.data)
            }
        }
        pressure = source; source.resume()
    }

    func handleMemoryPressure(_ event: DispatchSource.MemoryPressureEvent) {
        capacity = SessionSwitchingPreferences.maximumResidentPages
        SessionSwitchTrace.shared.recordPagePool(sessionID: current?.inputs.scope.sessionID,
            count: entries.count, capacity: capacity, reason: event.contains(.critical) ? "critical" : event.contains(.warning) ? "warning" : "normal")
        scheduleCleanup()
    }

    @discardableResult
    func presentOpeningPage(sessionID: String, title: String,
                            activate: @escaping @MainActor () -> Void) -> Bool {
        loadViewIfNeeded()
        guard isActive, isVisible(view), view.window != nil else { return false }
        cancelPendingPresentation()
        let request = epoch
        pendingSessionID = sessionID
        if current?.inputs.scope.sessionID != sessionID {
            // Finish the old editor's normal AppKit focus handoff. Its return
            // value is not a prerequisite for displaying another Session.
            _ = current?.inputs.finishEditingForSwitch()
            current?.inputs.freeze()
        }
        let warm = entries.first { $0.inputs.scope.sessionID == sessionID && !$0.inputs.retired }
        SessionSwitchTrace.shared.recordPagePool(sessionID: sessionID, count: entries.count,
            capacity: capacity, reason: warm == nil ? "miss" : "hit")
        let materialized = materialize(sessionID, request: request, cached: warm)
        guard epoch == request else { return true }
        guard materialized, let current, current.inputs.scope.sessionID == sessionID else {
            cancelPendingPresentation()
            if let current { reveal(current); current.inputs.resume() }
            else { showFallback() }
            return false
        }
        activate()
        guard epoch == request else { return true }
        selectedSessionID = sessionID
        pendingSessionID = nil
        current.inputs.resume()
        scheduleCleanup()
        return true
    }

    func update(fallback: ConsolePaneContent<Fallback>, selectedSessionID: String?, isActive: Bool) {
        fallbackRoot = fallback; self.selectedSessionID = selectedSessionID; self.isActive = isActive
        loadViewIfNeeded()
        guard isActive else { cancelPendingPresentation(); entries.forEach { $0.inputs.freeze() }; return }
        guard pendingSessionID == nil else { return }
        if let current, current.inputs.scope.sessionID == selectedSessionID, !current.inputs.retired, current.inputs.hasValidBinding() {
            current.inputs.resume(); return
        }
        if let selectedSessionID {
            if presentOpeningPage(sessionID: selectedSessionID, title: "", activate: {}) { return }
            // Initial mounting may precede attachment to a window.
            current?.inputs.freeze()
            if !materialize(selectedSessionID, request: epoch, cached: nil) { showFallback() }
            current?.inputs.resume()
        } else { showFallback() }
    }

    @discardableResult
    private func materialize(_ sessionID: String, request: UInt64, cached: Entry?) -> Bool {
        guard epoch == request else { return false }
        for invalid in entries.filter({ $0.inputs.retired || !$0.inputs.hasValidBinding() }) { dispose(invalid, reason: "retired") }
        let entry: Entry
        // Initial attachment and offscreen selection also reach this path.
        // Reuse by identity here so those paths cannot consume multiple slots
        // with copies of the same Session.
        if let cached = cached.flatMap({ $0.inputs.hasValidBinding() ? $0 : nil }) ?? entries.first(where: { $0.inputs.scope.sessionID == sessionID && !$0.inputs.retired }) {
            entry = cached
            SessionSwitchTrace.shared.mark(.pageHostReused, sessionID: sessionID)
        } else {
            // Free only the one slot needed before exceeding the page limit.
            // Pressure-mode surplus is removed after the target is visible.
            trim(to: min(SessionSwitchingPreferences.maximumResidentPages - 1, max(1, capacity - 1)))
            guard let inputs = makeInputs(sessionID) else { return false }
            inputs.resume()
            entry = Entry(inputs: inputs, root: root(inputs))
            SessionSwitchTrace.shared.mark(.pageHostCreated, sessionID: sessionID)
            addChild(entry.host)
            // reveal() is the single attachment point; it also detaches every
            // inactive page so the window only ever lays out one page tree.
            entries.append(entry)
        }
        current = entry; sequence &+= 1; entry.lastUsed = sequence
        if entry.surface.frame != view.bounds { entry.surface.frame = view.bounds }
        if entry.host.view.frame != entry.surface.bounds { entry.host.view.frame = entry.surface.bounds }
        reveal(entry)
        return true
    }

    private func scheduleCleanup() {
        cleanupWork?.cancel()
        guard entries.count > capacity else { cleanupWork = nil; return }
        let request = epoch
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.epoch == request, self.pendingSessionID == nil else { return }
            self.cleanupWork = nil
            self.trim(to: self.capacity)
        }
        cleanupWork = work
        DispatchQueue.main.async(execute: work)
    }
    private func reveal(_ entry: Entry) {
        SessionSwitchTrace.shared.mark(.nativePageVisibilityCommitted, sessionID: entry.inputs.scope.sessionID)
        visiblePage = entry
        // Only the active page belongs in the window's view hierarchy. Hidden
        // NSViews still take part in the window's layout pass; detaching them
        // keeps switch-back instant without adding layout work per Session.
        if entry.surface.superview !== view { view.addSubview(entry.surface) }
        if entry.surface.frame != view.bounds { entry.surface.frame = view.bounds }
        if entry.host.view.frame != entry.surface.bounds { entry.host.view.frame = entry.surface.bounds }
        for other in entries {
            let hidden = other !== entry
            other.surface.autoresizingMask = hidden ? [] : [.width, .height]
            other.surface.isHidden = hidden
            other.surface.alphaValue = hidden ? 0 : 1
            other.surface.setAccessibilityHidden(hidden)
            if hidden {
                // Detach only. Freezing here would invalidate an already-warm
                // page's binding; callers own the freeze/resume lifecycle.
                other.surface.removeFromSuperview()
            }
        }
        fallbackHost?.view.autoresizingMask = []
        fallbackHost?.view.isHidden = true
    }
    func cancelPendingPresentation() {
        epoch &+= 1
        cleanupWork?.cancel(); cleanupWork = nil
        pendingSessionID = nil
    }
    private func showFallback() {
        cancelPendingPresentation()
        entries.forEach { $0.inputs.freeze(); $0.surface.autoresizingMask = []; $0.surface.isHidden = true; $0.surface.setAccessibilityHidden(true); $0.surface.removeFromSuperview() }
        current = nil; visiblePage = nil
        if let fallbackHost { fallbackHost.rootView = fallbackRoot }
        else {
            let host = NSHostingController(rootView: fallbackRoot); host.sizingOptions = []
            fallbackHost = host; addChild(host); view.addSubview(host.view, positioned: .below, relativeTo: current?.surface)
        }
        fallbackHost?.view.frame = view.bounds
        fallbackHost?.view.autoresizingMask = [.width, .height]
        fallbackHost?.view.isHidden = false
    }
    private func trim(to capacity: Int) {
        while entries.count > max(0, capacity) {
            guard let oldest = entries.filter({ $0 !== current }).min(by: { $0.lastUsed < $1.lastUsed }) else { break }
            dispose(oldest, reason: "capacity")
        }
    }
    private func dispose(_ entry: Entry, reason: String) {
        SessionSwitchTrace.shared.recordPagePool(sessionID: entry.inputs.scope.sessionID,
            count: entries.count, capacity: capacity, reason: reason)
        entry.inputs.retire(); entry.surface.removeFromSuperview(); entry.host.removeFromParent()
        if current === entry { current = nil }
        if visiblePage === entry { visiblePage = nil }
        entries.removeAll { $0 === entry }
        SessionSwitchTrace.shared.mark(.pageHostEvicted, sessionID: entry.inputs.scope.sessionID)
    }
    func disposeAll() { cancelPendingPresentation(); for entry in entries { dispose(entry, reason: "disposed") } }
}

/// One stable legacy host for the Development comparison path.
struct SessionPageHostSwitcher<Content: View>: NSViewControllerRepresentable {
    let presentation: SessionPagePresentationState
    let selectedSessionID: String?
    let isActive: Bool
    @ViewBuilder let content: () -> Content

    func makeNSViewController(context: Context) -> SessionPageHostController<Content> {
        let controller = SessionPageHostController(root: ConsolePaneContent(content: content))
        presentation.presenter = controller
        return controller
    }

    func updateNSViewController(_ controller: SessionPageHostController<Content>, context: Context) {
        controller.update(root: ConsolePaneContent(content: content), selectedSessionID: selectedSessionID, isActive: isActive)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: SessionPageHostController<Content>, context: Context) -> CGSize? {
        CGSize(width: proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 1000,
               height: proposal.height.flatMap { $0.isFinite ? $0 : nil } ?? 700)
    }

    static func dismantleNSViewController(_ controller: SessionPageHostController<Content>, coordinator: ()) {
        controller.cancelPendingPresentation()
    }
}

@MainActor final class SessionPageHostController<Content: View>: NSViewController, SessionPagePresenting {
    let host: NSHostingController<ConsolePaneContent<Content>>
    private(set) var pendingSessionID: String?
    private var isActive = true
    private var observations: [NSObjectProtocol] = []

    init(root: ConsolePaneContent<Content>) {
        host = NSHostingController(rootView: root)
        host.sizingOptions = []
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    isolated deinit { for token in observations { NotificationCenter.default.removeObserver(token) } }

    override func loadView() {
        let container = SessionPageContainerView()
        view = container
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.width, .height]
        view.addSubview(host.view)
        for name in [NSWindow.didMiniaturizeNotification, NSWindow.willCloseNotification, NSWindow.didChangeOcclusionStateNotification] {
            observations.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
                guard let window = notification.object as? NSWindow else { return }
                Task { @MainActor [weak self] in
                    guard let self, self.view.window === window else { return }
                    if !window.isVisible || !window.occlusionState.contains(.visible) { self.cancelPendingPresentation() }
                }
            })
        }
    }

    @discardableResult
    func presentOpeningPage(sessionID: String, title: String,
                            activate: @escaping @MainActor () -> Void) -> Bool {
        loadViewIfNeeded()
        guard isActive, let window = view.window, window.isVisible,
              window.occlusionState.contains(.visible), !view.isHiddenOrHasHiddenAncestor else { return false }
        // Returning false uses the ordinary direct selection path. There is
        // no placeholder display prerequisite for showing local messages.
        cancelPendingPresentation()
        return false
    }

    func update(root: ConsolePaneContent<Content>, selectedSessionID: String?, isActive: Bool) {
        self.isActive = isActive
        guard isActive else { cancelPendingPresentation(); return }
        host.rootView = root
    }

    func cancelPendingPresentation() { pendingSessionID = nil }

}

@MainActor private final class SessionPageSurfaceView: NSView {
    var onCompletedLayout: ((NSSize) -> Void)?
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
    override func layout() {
        super.layout()
        onCompletedLayout?(bounds.size)
    }
}

@MainActor private final class SessionPageContainerView: NSView {
    override var fittingSize: NSSize { NSSize(width: 1000, height: 700) }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
}
