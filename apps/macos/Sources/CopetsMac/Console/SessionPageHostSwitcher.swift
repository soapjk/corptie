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
        HStack(spacing: MainWindowPageLayoutMetrics.columnSpacing) {
            VStack(spacing: 6) {
                SearchMessageNavigationSurface(sessionID: inputs.scope.sessionID,
                    target: inputs.searchTarget, matches: inputs.searchMatches) { delta in
                    guard inputs.actionSession(generation: inputs.activity.generation) != nil else { return }
                    UnifiedSearchNavigation.shared.step(delta)
                }
                SessionConversationSurface(sessionId: inputs.scope.sessionID, presentationCache: cache,
                    composerDraftRepository: drafts, backendClient: backend,
                    initialTimelinePosition: viewport.position(for: inputs.scope.sessionID),
                    onTimelinePositionChange: { viewport.store($0, for: inputs.scope.sessionID) }, renderInputs: inputs)
                    .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)
            }
            // Keep the legacy conversation viewport without changing the
            // Detail rail's native scroll insets or adding another observer.
            .padding(.top, -inputs.conversationTopInset)
            .modifier(ConversationColumnSurface(.transcript))
            SessionDetailPanel(session: inputs.session, railWidth: ConversationDetailWidgetMetrics.railWidth,
                activity: inputs.activity, detailPresentation: detailPresentation)
                .frame(maxHeight: .infinity)
        }
        .padding(MainWindowPageLayoutMetrics.outerPadding)
        .modifier(ConsoleDetailColumnBackground())
        .modifier(ConversationSkinHost())
        .environmentObject(layout)
        .environmentObject(backend)
    }
}

private struct SessionPageLayoutStamp: Equatable {
    let scale: CGFloat
    let topInset: CGFloat
    let appearance: NSAppearance.Name
    let language: String
    let direction: NSUserInterfaceLayoutDirection
    @MainActor init(_ view: NSView) {
        scale = view.window?.backingScaleFactor ?? 1
        topInset = view.safeAreaInsets.top
        appearance = view.effectiveAppearance.name
        language = AppLanguageController.shared.languageCode
        direction = view.userInterfaceLayoutDirection
    }
}

@MainActor final class ResidentSessionPageHostController<Root: View, Fallback: View>: NSViewController, SessionPagePresenting {
    @MainActor final class Entry {
        let inputs: SessionPageRenderInputs
        let host: NSHostingController<Root>
        let surface: NSView
        var lastUsed: UInt64 = 0
        var layoutSize: NSSize = .zero
        var eligibleForWarmPresentation = false
        fileprivate var layoutStamp: SessionPageLayoutStamp?
        init(inputs: SessionPageRenderInputs, root: Root) {
            self.inputs = inputs; host = NSHostingController(rootView: root); host.sizingOptions = []
            let surface = SessionPageSurfaceView()
            surface.wantsLayer = true; surface.isHidden = true; surface.alphaValue = 0
            surface.content = host.view; surface.addSubview(host.view)
            self.surface = surface
            surface.onCompletedLayout = { [weak self] size in
                guard let self else { return }
                let stamp = SessionPageLayoutStamp(self.surface)
                if self.layoutSize != size || self.layoutStamp != stamp { self.eligibleForWarmPresentation = false }
                self.layoutSize = size; self.layoutStamp = stamp
            }
        }
    }
    private let isVisible: @MainActor (NSView) -> Bool
    private let makeInputs: (String) -> SessionPageRenderInputs?
    private let root: (SessionPageRenderInputs) -> Root
    private var fallbackRoot: ConsolePaneContent<Fallback>
    private var fallbackHost: NSHostingController<ConsolePaneContent<Fallback>>?
    private let gate: SessionPresentationFrameGate
    private let contentGate: SessionPresentationFrameGate
    private let cleanupGate: SessionPresentationFrameGate
    private let readinessGate: SessionPresentationFrameGate
    private(set) var entries: [Entry] = []
    private(set) weak var current: Entry?
    private(set) weak var visiblePage: Entry?
    private(set) var pendingSessionID: String?
    var settledSessionID: String? { pendingSessionID == nil && current?.inputs.hasValidBinding() == true ? current?.inputs.scope.sessionID : nil }
    private var selectedSessionID: String?
    private var sequence: UInt64 = 0
    private var epoch: UInt64 = 0
    private var isActive = true
    private var capacity = 3
    private var pressure: (any DispatchSourceMemoryPressure)?
    private var observations: [NSObjectProtocol] = []

    init(fallback: ConsolePaneContent<Fallback>, gate: SessionPresentationFrameGate = SessionPresentationFrameGate(),
         contentGate: SessionPresentationFrameGate = SessionPresentationFrameGate(),
         cleanupGate: SessionPresentationFrameGate = SessionPresentationFrameGate(),
         readinessGate: SessionPresentationFrameGate = SessionPresentationFrameGate(),
         isVisible: @escaping @MainActor (NSView) -> Bool = {
             !$0.isHiddenOrHasHiddenAncestor && $0.window?.isVisible == true
                 && $0.window?.occlusionState.contains(.visible) == true
         },
         makeInputs: @escaping (String) -> SessionPageRenderInputs?, root: @escaping (SessionPageRenderInputs) -> Root) {
        fallbackRoot = fallback; self.gate = gate; self.contentGate = contentGate; self.cleanupGate = cleanupGate; self.readinessGate = readinessGate; self.isVisible = isVisible
        self.makeInputs = makeInputs; self.root = root
        super.init(nibName: nil, bundle: nil)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    isolated deinit {
        pressure?.cancel()
        for token in observations { NotificationCenter.default.removeObserver(token) }
    }
    override func loadView() {
        let container = SessionPageContainerView()
        container.layoutChildren = { [weak self] bounds in
            guard let self else { return }
            self.fallbackHost?.view.frame = bounds
            // Hidden pages retain their layout until they are selected again.
            if let current = self.current, !current.surface.isHidden {
                if current.surface.frame != bounds { current.surface.frame = bounds }
                let inset = current.host.view.safeAreaInsets.top
                if current.inputs.conversationTopInset != inset {
                    DispatchQueue.main.async { [weak self, weak current] in
                        guard let self, let current, self.current === current else { return }
                        current.inputs.setConversationTopInset(inset)
                    }
                }
            }
        }
        container.onDraw = { [weak self] in self?.gate.nativeDrawPrepared() }
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
        capacity = event.contains(.normal) ? 3 : 1
        guard pendingSessionID == nil else { return }
        cleanupGate.arm(view: view) { [weak self] _ in self?.trim(to: self?.capacity ?? 1) }
    }

    @discardableResult
    func presentOpeningPage(sessionID: String, title: String,
                            activate: @escaping @MainActor (SessionPresentationFrameGate.Outcome) -> Void) -> Bool {
        loadViewIfNeeded()
        guard isActive, isVisible(view), let window = view.window else { return false }
        // Consume a refused IME/modal switch. Returning false here would let
        // the legacy caller perform the very selection AppKit refused.
        if window.attachedSheet != nil { return true }
        cancelPendingPresentation()
        let previous = current
        previous?.inputs.suspendActions()
        guard previous?.inputs.finishEditingForSwitch() ?? true else { previous?.inputs.resume(); return true }
        if let responder = window.firstResponder as? NSView, responder.isDescendant(of: view),
           !window.makeFirstResponder(nil) { previous?.inputs.resume(); return true }
        previous?.inputs.suspendEditorPresentation()
        gate.cancel(); contentGate.cancel(); cleanupGate.cancel(); readinessGate.cancel(); epoch &+= 1
        let request = epoch
        pendingSessionID = sessionID
        // At most three value-key checks. No projection, new host, table bind,
        // root assignment, row apply or editor text reset on the warm path.
        let warm = entries.first {
            $0.inputs.scope.sessionID == sessionID && $0.inputs.hasValidBinding()
                && $0.inputs.historicalThreadID == nil
        }
        if let warm {
            current = warm
            if warm.surface.frame != view.bounds { warm.surface.frame = view.bounds }
            reveal(warm)
            SessionSwitchTrace.shared.mark(.pageHostReused, sessionID: sessionID)
        }
        // A cache miss keeps the old content visible and inert. Never replace
        // resident messages with an empty opening screen.
        view.needsDisplay = true
        let armed = gate.arm(view: view, afterNativeDraw: warm != nil, minimumRefreshIntervals: warm == nil ? 1 : 3) { [weak self] outcome in
            guard let self, self.epoch == request else { return }
            self.entries.forEach { $0.inputs.freeze() }
            SessionSwitchTrace.shared.mark(outcome == .timedOut ? .presentationGateTimedOut : .presentationDeferredWorkAllowed, sessionID: sessionID)
            activate(outcome)
            guard self.epoch == request else { return }
            self.selectedSessionID = sessionID
            self.materialize(sessionID, request: request, alreadyVisible: warm)
        }
        if !armed { cancelPendingPresentation() }
        return true
    }

    func update(fallback: ConsolePaneContent<Fallback>, selectedSessionID: String?, isActive: Bool) {
        fallbackRoot = fallback; self.selectedSessionID = selectedSessionID; self.isActive = isActive
        loadViewIfNeeded()
        guard isActive else { cancelPendingPresentation(); entries.forEach { $0.inputs.freeze() }; return }
        if pendingSessionID != nil { return }
        if let current, current.inputs.scope.sessionID == selectedSessionID, current.inputs.hasValidBinding() {
            current.inputs.resume(); prepareWarmReadiness(current); return
        }
        if let selectedSessionID {
            if presentOpeningPage(sessionID: selectedSessionID, title: "", activate: { _ in }) { return }
            // Initial mounting can precede window attachment. Build only the
            // authoritative initial page; user clicks still require the gate.
            entries.forEach { $0.inputs.freeze(); $0.surface.isHidden = true }
            materialize(selectedSessionID, request: epoch, alreadyVisible: nil)
        } else { showFallback() }
    }
    private func materialize(_ sessionID: String, request: UInt64, alreadyVisible: Entry?) {
        guard epoch == request else { return }
        for invalid in entries.filter({ !$0.inputs.hasValidBinding() }) { dispose(invalid) }
        let entry: Entry
        if let cached = alreadyVisible ?? entries.first(where: { $0.inputs.scope.sessionID == sessionID }) {
            entry = cached
        } else {
            // Preserve the visible page until the replacement has rendered.
            // Pressure mode may overlap two pages during this handoff; the
            // hard three-page bound still holds before allocation.
            trim(to: min(2, max(1, capacity - 1)))
            guard let inputs = makeInputs(sessionID), inputs.hasValidBinding() else { cancelPendingPresentation(); showFallback(); return }
            inputs.resume()
            entry = Entry(inputs: inputs, root: root(inputs))
            SessionSwitchTrace.shared.mark(.pageHostCreated, sessionID: sessionID)
            addChild(entry.host)
            view.addSubview(entry.surface, positioned: .below, relativeTo: current?.surface)
            entries.append(entry)
        }
        current = entry; sequence &+= 1; entry.lastUsed = sequence
        if alreadyVisible == nil { entry.eligibleForWarmPresentation = false }
        entry.inputs.resume()
        if entry.surface.frame != view.bounds { entry.surface.frame = view.bounds }
        if alreadyVisible == nil, entry.host.view.frame != entry.surface.bounds {
            entry.host.view.frame = entry.surface.bounds
        }
        entry.inputs.setConversationTopInset(entry.host.view.safeAreaInsets.top)
        entry.surface.isHidden = false; entry.surface.setAccessibilityHidden(pendingSessionID != nil)
        if alreadyVisible != nil || pendingSessionID == nil {
            reveal(entry); pendingSessionID = nil; trim(to: capacity)
            prepareWarmReadiness(entry)
        } else {
            let armed = contentGate.arm(view: view) { [weak self] outcome in
                guard let self, self.epoch == request else { return }
                SessionSwitchTrace.shared.mark(outcome == .timedOut ? .presentationContentGateTimedOut : .pageContentUncovered, sessionID: sessionID)
                self.reveal(entry); self.pendingSessionID = nil; self.trim(to: self.capacity)
                self.prepareWarmReadiness(entry)
            }
            if !armed {
                reveal(entry); pendingSessionID = nil; trim(to: capacity)
                prepareWarmReadiness(entry)
            }
        }
    }
    private func reveal(_ entry: Entry) {
        SessionSwitchTrace.shared.mark(.nativePageVisibilityCommitted, sessionID: entry.inputs.scope.sessionID)
        visiblePage = entry
        for other in entries {
            let hidden = other !== entry
            other.surface.isHidden = hidden
            other.surface.alphaValue = hidden ? 0 : 1
            other.surface.setAccessibilityHidden(hidden)
        }
        fallbackHost?.view.isHidden = true
    }
    private func prepareWarmReadiness(_ entry: Entry) {
        guard !entry.eligibleForWarmPresentation, !readinessGate.isArmed,
              pendingSessionID == nil, current === entry else { return }
        let request = epoch
        readinessGate.arm(view: entry.surface) { [weak self, weak entry] outcome in
            guard let self, let entry, self.epoch == request, self.current === entry,
                  outcome == .displayOpportunity, entry.inputs.hasValidBinding() else { return }
            entry.eligibleForWarmPresentation = true
        }
    }
    func cancelPendingPresentation() {
        epoch &+= 1; gate.cancel(); contentGate.cancel(); cleanupGate.cancel(); readinessGate.cancel()
        pendingSessionID = nil
        if let visiblePage { current = visiblePage; reveal(visiblePage) }
    }
    private func showFallback() {
        cancelPendingPresentation()
        entries.forEach { $0.inputs.freeze(); $0.surface.isHidden = true; $0.surface.setAccessibilityHidden(true) }
        current = nil; visiblePage = nil
        if let fallbackHost { fallbackHost.rootView = fallbackRoot }
        else {
            let host = NSHostingController(rootView: fallbackRoot); host.sizingOptions = []
            fallbackHost = host; addChild(host); view.addSubview(host.view, positioned: .below, relativeTo: current?.surface)
        }
        fallbackHost?.view.frame = view.bounds; fallbackHost?.view.isHidden = false
    }
    private func trim(to capacity: Int) {
        while entries.count > max(0, capacity) {
            guard let oldest = entries.filter({ $0 !== current }).min(by: { $0.lastUsed < $1.lastUsed }) else { break }
            dispose(oldest)
        }
    }
    private func dispose(_ entry: Entry) {
        entry.inputs.retire(); entry.surface.removeFromSuperview(); entry.host.removeFromParent()
        if current === entry { current = nil }
        if visiblePage === entry { visiblePage = nil }
        entries.removeAll { $0 === entry }
        SessionSwitchTrace.shared.mark(.pageHostEvicted, sessionID: entry.inputs.scope.sessionID)
    }
    func disposeAll() { cancelPendingPresentation(); for entry in entries { dispose(entry) } }
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
        container.layoutChildren = { [weak self] bounds in
            self?.host.view.frame = bounds
        }
        view = container
        addChild(host)
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
                            activate: @escaping @MainActor (SessionPresentationFrameGate.Outcome) -> Void) -> Bool {
        loadViewIfNeeded()
        guard isActive, let window = view.window, window.isVisible,
              window.occlusionState.contains(.visible), !view.isHiddenOrHasHiddenAncestor else { return false }
        if window.attachedSheet != nil { return true }
        if let responder = window.firstResponder as? NSView, responder.isDescendant(of: host.view),
           !window.makeFirstResponder(nil) { return true }
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
    weak var content: NSView?
    var onCompletedLayout: ((NSSize) -> Void)?
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
    override func layout() {
        super.layout()
        if let content, content.frame != bounds { content.frame = bounds }
        onCompletedLayout?(bounds.size)
    }
}

@MainActor private final class SessionPageContainerView: NSView {
    var onDraw: (() -> Void)?
    override func draw(_ dirtyRect: NSRect) { onDraw?() }
    var layoutChildren: ((NSRect) -> Void)?
    override var fittingSize: NSSize { NSSize(width: 1000, height: 700) }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }
    override func layout() { super.layout(); layoutChildren?(bounds) }
}
