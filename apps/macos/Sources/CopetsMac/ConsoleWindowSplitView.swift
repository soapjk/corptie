import AppKit
import CorptieConversation
import QuartzCore
import SwiftUI

@MainActor
final class ConsoleNativeSplitView: NSSplitView {
    // Column colors provide the boundary; keep the native divider's hit area.
    override func drawDivider(in rect: NSRect) {}

    // A viewport has no content-derived ideal size. In particular, querying
    // fittingSize must not recursively measure the SwiftUI trees it contains.
    override var fittingSize: NSSize { NSSize(width: 1000, height: 700) }
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric)
    }
    static let didEndDividerTracking = Notification.Name("ConsoleNativeSplitView.didEndDividerTracking")
    static let willBeginDividerTracking = Notification.Name("ConsoleNativeSplitView.willBeginDividerTracking")
    private(set) var isTrackingDivider = false

    override func mouseDown(with event: NSEvent) {
        isTrackingDivider = true
        NotificationCenter.default.post(name: Self.willBeginDividerTracking, object: self)
        defer {
            isTrackingDivider = false
            NotificationCenter.default.post(name: Self.didEndDividerTracking, object: window)
        }
        super.mouseDown(with: event)
    }

    static func isResizing(_ view: NSView) -> Bool {
        if view.window?.inLiveResize == true { return true }
        var ancestor: NSView? = view
        while let current = ancestor {
            if let split = current as? ConsoleNativeSplitView, split.isTrackingDivider { return true }
            ancestor = current.superview
        }
        return false
    }
}

/// AppKit owns the window-sized split. SwiftUI owns only each pane's content.
/// The hosting controllers survive navigation-mode changes and divider drags.
struct ConsolePaneContent<Content: View>: View {
    let content: () -> Content
    var columnRole: ConversationColumnRole = .transcript

    var body: some View {
        content().modifier(ConversationColumnSurface(columnRole)).modifier(ConversationSkinHost())
    }
}

/// Paint outside page padding and title-bar safe areas. Card/content geometry
/// stays unchanged, and the trailing page gutter belongs to the Detail canvas.
private struct DetailColumnVisibilityKey: EnvironmentKey {
    static let defaultValue: Binding<Bool>? = nil
}

extension EnvironmentValues {
    var detailColumnVisibility: Binding<Bool>? {
        get { self[DetailColumnVisibilityKey.self] }
        set { self[DetailColumnVisibilityKey.self] = newValue }
    }
}

/// One weak native hit region per page; no layout observation or global registry.
@MainActor
final class DetailToggleExclusion {
    weak var view: NSView?
    func contains(_ event: NSEvent) -> Bool {
        guard let view, view.window === event.window, !view.isHiddenOrHasHiddenAncestor else { return false }
        return view.bounds.contains(view.convert(event.locationInWindow, from: nil))
    }
}

private struct DetailToggleExclusionKey: EnvironmentKey {
    static let defaultValue: DetailToggleExclusion? = nil
}

extension EnvironmentValues {
    var detailToggleExclusion: DetailToggleExclusion? {
        get { self[DetailToggleExclusionKey.self] }
        set { self[DetailToggleExclusionKey.self] = newValue }
    }
}

struct DetailToggleClickTarget: NSViewRepresentable {
    @Environment(\.detailToggleExclusion) private var exclusion
    func makeNSView(context: Context) -> NSView { ClickThroughView() }
    func updateNSView(_ view: NSView, context: Context) { exclusion?.view = view }
    private final class ClickThroughView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

/// A docked Detail rail owns its full width at the trailing edge, so the
/// transcript ends where the rail begins and `WorkbenchStyle.lane` centres the
/// reading lane in the space that is left: equal blank gutters on both sides.
/// Docking is kept only while that remaining space still holds the full lane
/// plus both gutters; below it the rail gives up its column and floats above
/// the messages instead. An AppKit-driven horizontal slide carries the
/// handover: the rail slides out to the right (and back in from the right)
/// instead of vanishing in a single frame.
struct AdaptiveConversationColumns<Transcript: View, Detail: View, Header: View>: View {
    @Binding var isVisible: Bool
    @State private var canDock = false
    @State private var temporaryVisible = false
    @State private var toggleExclusion = DetailToggleExclusion()
    @State private var railPhase: RailPhase = .hidden
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ViewBuilder let transcript: () -> Transcript
    @ViewBuilder let detail: () -> Detail
    @ViewBuilder let header: () -> Header

    private enum RailPhase { case hidden, visible, slidingOut }

    /// A live resize can deliver a stream of widths that sit within a point or
    /// two of the docking boundary. Classifying width into bands keeps the
    /// decision stable through that stream instead of flipping it every frame.
    enum WidthBand: Equatable { case narrow, hysteresis, wide }

    init(isVisible: Binding<Bool>, @ViewBuilder transcript: @escaping () -> Transcript,
         @ViewBuilder detail: @escaping () -> Detail, @ViewBuilder header: @escaping () -> Header) {
        _isVisible = isVisible
        self.transcript = transcript
        self.detail = detail
        self.header = header
    }

    /// Space the HStack keeps for the rail when docked: exactly the rail's
    /// width, no overlap into the transcript. `WorkbenchStyle.lane` then centres
    /// the reading lane in `[0, width - railWidth]`, so the blank gutter on the
    /// leading edge equals the one before the rail. Reserving less would tilt
    /// the lane to the left and let the rail eat the trailing gutter.
    static var dockedReservedWidth: CGFloat {
        ConversationDetailWidgetMetrics.railWidth
    }

    /// Dock only while the space left after subtracting the rail still holds
    /// the full reading lane with a complete gutter on each side. Below this
    /// the rail becomes an overlay above the messages instead of a column.
    static var minimumDockedWidth: CGFloat {
        WorkbenchStyle.readingWidth + 2 * WorkbenchStyle.readingInset + dockedReservedWidth
    }

    /// Hiding is decisive, but coming back needs a little more room so the
    /// rail does not flicker on and off while the pointer sits on the edge.
    /// The band only delays re-docking; it never delays hiding.
    static var dockHysteresis: CGFloat { 24 }
    static var redockWidth: CGFloat { minimumDockedWidth + dockHysteresis }

    static func widthBand(for width: CGFloat) -> WidthBand {
        if width < minimumDockedWidth { return .narrow }
        if width < redockWidth { return .hysteresis }
        return .wide
    }

    static var railSlideDuration: Double { 0.20 }

    private var docked: Bool { canDock && isVisible }
    private var presented: Bool { canDock ? isVisible : temporaryVisible }
    private var visibility: Binding<Bool> {
        Binding(get: { presented }, set: { value in
            if canDock { isVisible = value }
            else { temporaryVisible = value }
        })
    }

    var body: some View {
        ConversationRegionStack(accessoryAtTop: true,
                                accessoryHeight: Header.self == EmptyView.self ? 0 : MainWindowPageLayoutMetrics.headerRowHeight) {
            ZStack(alignment: .trailing) {
                HStack(spacing: 0) {
                    transcript()
                        .environment(\.detailColumnVisibility, visibility)
                        .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
                    // Stable transcript identity; only native stack space
                    // changes. Docked: the full rail width is reserved so the
                    // reading lane centres with equal gutters. Overlay: no
                    // slice is reserved and the rail floats above the text.
                    Color.clear
                        .frame(width: docked ? Self.dockedReservedWidth : 0)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                // Width proposals stay synchronous: never interpolate the
                // transcript column while the window is being resized, so the
                // native text keeps reflowing on every live-resize frame.
                .animation(nil, value: docked)
                DetailRailSlide(visible: railPhase == .visible,
                                duration: reduceMotion ? 0 : Self.railSlideDuration,
                                onSlideOutFinished: {
                    if railPhase == .slidingOut { railPhase = .hidden }
                }) {
                    Group {
                        if railPhase != .hidden {
                            detail()
                                .environment(\.detailColumnVisibility, visibility)
                                .frame(width: ConversationDetailWidgetMetrics.railWidth)
                                .frame(maxHeight: .infinity)
                                .background(DetailRailBackdrop())
                                .background(DetailOutsideClickDismissal(enabled: !canDock) {
                                    temporaryVisible = false
                                })
                        }
                    }
                }
                .frame(width: ConversationDetailWidgetMetrics.railWidth)
                .frame(maxHeight: .infinity)
                .allowsHitTesting(railPhase == .visible)
                .accessibilityHidden(railPhase != .visible)
                .zIndex(1)
            }
            .clipped()
        } accessory: {
            header().environment(\.detailColumnVisibility, visibility)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .overlay(alignment: .bottom) {
                    if Header.self != EmptyView.self {
                        Divider().allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
        }
        .environment(\.detailToggleExclusion, toggleExclusion)
        // `onGeometryChange` only calls the action when the band changes, so
        // dragging inside one band performs no state writes at all.
        .onGeometryChange(for: WidthBand.self) { Self.widthBand(for: $0.size.width) } action: { band in
            switch band {
            case .narrow:
                guard canDock else { return }
                canDock = false
                temporaryVisible = false
            case .hysteresis:
                // Hold the last decision. No flip, no slide restart, no
                // transcript width change while the window sits on the edge.
                break
            case .wide:
                guard !canDock else { return }
                canDock = true
                temporaryVisible = false
            }
        }
        // One place drives all presentation sources: width crossing the
        // threshold, the toggle and outside-click dismissal.
        .onChange(of: presented) { _, value in
            if value { railPhase = .visible }
            else if railPhase == .visible { railPhase = .slidingOut }
        }
        .onAppear { if presented { railPhase = .visible } }
        .onChange(of: isVisible) { _, visible in
            if !visible { temporaryVisible = false }
        }
        .onDisappear {
            temporaryVisible = false
            // No slide completion will arrive once the host is gone; do not
            // leave the rail's content mounted in the sliding-out phase.
            railPhase = .hidden
        }
    }
}

/// A local AppKit monitor sees clicks in native message/editor views and sibling
/// Work/Tab panes too. It returns the original event and exists only while open.
struct DetailOutsideClickDismissal: NSViewRepresentable {
    @Environment(\.detailToggleExclusion) private var toggleExclusion
    let enabled: Bool
    let dismiss: () -> Void

    func makeNSView(context: Context) -> DetailOutsideClickView { DetailOutsideClickView() }
    func updateNSView(_ view: DetailOutsideClickView, context: Context) {
        view.toggleExclusion = toggleExclusion
        view.update(enabled: enabled, dismiss: dismiss)
    }
    static func dismantleNSView(_ view: DetailOutsideClickView, coordinator: ()) {
        view.update(enabled: false, dismiss: {})
    }
}

final class DetailOutsideClickView: NSView {
    var toggleExclusion: DetailToggleExclusion?
    private var monitor: Any?
    private var dismiss: (() -> Void)?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func update(enabled: Bool, dismiss: @escaping () -> Void) {
        self.dismiss = enabled ? dismiss : nil
        if enabled, monitor == nil {
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
                MainActor.assumeIsolated { self?.observe(event) }
                return event
            }
        } else if !enabled, let monitor {
            NSEvent.removeMonitor(monitor)
            self.monitor = nil
        }
    }

    func observe(_ event: NSEvent) {
        guard let window, event.window === window, !isHiddenOrHasHiddenAncestor,
              toggleExclusion?.contains(event) != true,
              !bounds.contains(convert(event.locationInWindow, from: nil)),
              let dismiss else { return }
        // The toggle is excluded above; ordinary outside controls keep their event.
        DispatchQueue.main.async { dismiss() }
    }

    isolated deinit { if let monitor { NSEvent.removeMonitor(monitor) } }
}

/// Test-visible handle for the rail's slide state. The concrete view is generic
/// over its SwiftUI content, so the assertion side uses this protocol.
@MainActor
protocol DetailRailSlidePositioning: AnyObject {
    /// Translation read from the presentation layer, never from a model value.
    var slideOffset: CGFloat { get }
    /// The hosting view's model frame must stay pinned to the container.
    var modelFrameIsStable: Bool { get }
    var hasSlideAnimation: Bool { get }
    var railAlphaValue: CGFloat { get }
}

/// AppKit-owned horizontal slide for the Detail rail. SwiftUI transitions are
/// dropped by ConversationRegionStack's rootView replacement, so a standard
/// CABasicAnimation translates the hosting view's layer. No frame and no
/// constraint constant changes for the whole animation: Auto Layout runs once
/// and SwiftUI never receives a per-frame size proposal. Opacity is never
/// touched. Content is unmounted only after the slide ends.
private struct DetailRailSlide<Content: View>: NSViewRepresentable {
    let visible: Bool
    let duration: Double
    let onSlideOutFinished: () -> Void
    @ViewBuilder let content: () -> Content

    func makeNSView(context: Context) -> DetailRailSlideView<Content> {
        let view = DetailRailSlideView(rootView: content())
        view.applyInitial(visible: visible)
        return view
    }

    func updateNSView(_ view: DetailRailSlideView<Content>, context: Context) {
        view.host.rootView = content()
        view.setVisible(visible, duration: duration, onSlideOutFinished: onSlideOutFinished)
    }
}

private final class DetailRailSlideView<Content: View>: NSView, DetailRailSlidePositioning {
    /// One full rail width is enough to move the card completely out of sight.
    static var slideDistance: CGFloat { ConversationDetailWidgetMetrics.railWidth }
    private static var animationKey: String { "detail-rail-slide" }

    let host: NSHostingView<Content>
    private var visible = true
    private var onSlideOutFinished: (() -> Void)?

    var slideOffset: CGFloat { host.layer?.presentation()?.transform.m41 ?? 0 }
    var modelFrameIsStable: Bool {
        abs(host.frame.origin.x - bounds.origin.x) < 0.5
            && abs(host.frame.origin.y - bounds.origin.y) < 0.5
            && abs(host.frame.width - bounds.width) < 0.5
            && abs(host.frame.height - bounds.height) < 0.5
    }
    var hasSlideAnimation: Bool { host.layer?.animation(forKey: Self.animationKey) != nil }
    var railAlphaValue: CGFloat { alphaValue }

    init(rootView: Content) {
        host = NSHostingView(rootView: rootView)
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true
        host.wantsLayer = true
        host.translatesAutoresizingMaskIntoConstraints = false
        addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: leadingAnchor),
            host.trailingAnchor.constraint(equalTo: trailingAnchor),
            host.topAnchor.constraint(equalTo: topAnchor),
            host.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    func applyInitial(visible: Bool) {
        self.visible = visible
        isHidden = !visible
        host.layer?.removeAllAnimations()
        host.layer?.transform = visible
            ? CATransform3DIdentity
            : CATransform3DMakeTranslation(Self.slideDistance, 0, 0)
    }

    override func hitTest(_ point: NSPoint) -> NSView? { visible ? super.hitTest(point) : nil }

    func setVisible(_ value: Bool, duration: Double, onSlideOutFinished: @escaping () -> Void) {
        guard value != visible else { return }
        visible = value
        self.onSlideOutFinished = onSlideOutFinished
        guard let layer = host.layer else {
            finishSlideOutIfNeeded()
            return
        }
        // Resume from whatever is on screen right now. If a resize crosses
        // back over the boundary mid-slide, snapping to a hard start value
        // would show one frame of the card at the opposite edge: a flicker.
        let from = layer.presentation()?.transform.m41 ?? layer.transform.m41
        let to: CGFloat = value ? 0 : Self.slideDistance
        layer.removeAnimation(forKey: Self.animationKey)
        // The model always holds the final position; only the presentation
        // layer interpolates. Removing the previous animation can therefore
        // never expose an intermediate frame.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.transform = CATransform3DMakeTranslation(to, 0, 0)
        CATransaction.commit()
        if value { isHidden = false }

        guard duration > 0 else {
            finishSlideOutIfNeeded()
            return
        }

        let animation = CABasicAnimation(keyPath: "transform.translation.x")
        animation.fromValue = from
        animation.toValue = to
        animation.duration = duration
        animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        // Hold the presentation value at the target until the content is
        // unmounted. The model transform is never written to follow it.
        animation.fillMode = .forwards
        animation.isRemovedOnCompletion = false
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            MainActor.assumeIsolated { self?.finishSlideOutIfNeeded() }
        }
        layer.add(animation, forKey: Self.animationKey)
        CATransaction.commit()
    }

    private func finishSlideOutIfNeeded() {
        guard !visible else { return }
        isHidden = true
        let finish = onSlideOutFinished
        onSlideOutFinished = nil
        finish?()
    }
}

extension AdaptiveConversationColumns where Header == EmptyView {
    init(isVisible: Binding<Bool>, @ViewBuilder transcript: @escaping () -> Transcript,
         @ViewBuilder detail: @escaping () -> Detail) {
        self.init(isVisible: isVisible, transcript: transcript, detail: detail, header: { EmptyView() })
    }
}

struct ConsoleDetailColumnBackground: ViewModifier {
    @Environment(\.conversationSkin) private var skin
    var isVisible = true
    func body(content: Content) -> some View {
        content.background {
            if skin == .codexFlat {
                // This layer is outside the page padding. The trailing gutter
                // belongs to Detail; all other gutters belong to the transcript.
                // The Detail column itself stays unpainted: cards float on the
                // window canvas instead of on a tinted column of their own.
                Color.primary.opacity(0.12)
                    .padding(.trailing, isVisible
                        ? ConversationDetailWidgetMetrics.railWidth + MainWindowPageLayoutMetrics.outerPadding : 0)
                    .ignoresSafeArea(.container, edges: .vertical)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
        }
    }
}

struct ConsoleWindowSplitView<Sidebar: View, Detail: View>: NSViewControllerRepresentable {
    let mode: ConsoleNavigationMode
    let isActive: Bool
    let sidebar: () -> Sidebar
    let detail: () -> Detail

    init(mode: ConsoleNavigationMode, isActive: Bool,
         @ViewBuilder sidebar: @escaping () -> Sidebar, @ViewBuilder detail: @escaping () -> Detail) {
        self.mode = mode
        self.isActive = isActive
        self.sidebar = sidebar
        self.detail = detail
    }

    func makeNSViewController(context: Context) -> ConsoleSplitController<ConsolePaneContent<Sidebar>, ConsolePaneContent<Detail>> {
        ConsoleSplitController(mode: mode, sidebar: ConsolePaneContent(content: sidebar, columnRole: .sidebar), detail: ConsolePaneContent(content: detail))
    }

    func updateNSViewController(_ controller: ConsoleSplitController<ConsolePaneContent<Sidebar>, ConsolePaneContent<Detail>>, context: Context) {
        controller.update(mode: mode, isActive: isActive, sidebar: ConsolePaneContent(content: sidebar, columnRole: .sidebar), detail: ConsolePaneContent(content: detail))
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsViewController: ConsoleSplitController<ConsolePaneContent<Sidebar>, ConsolePaneContent<Detail>>, context: Context) -> CGSize? {
        // This is a window-filling container, not content-sized. Avoid asking
        // Auto Layout to measure the entire hosted conversation for its ideal size.
        CGSize(width: proposal.width ?? 1000, height: proposal.height ?? 700)
    }
}

@MainActor
final class ConsolePaneController<Content: View>: NSViewController {
    let host: NSHostingController<Content>
    private let isSidebar: Bool
    /// The top, leading and trailing edges stay active even during a live
    /// resize: they keep the sidebar pinned to the top of the pane.
    private var edgeConstraints: [NSLayoutConstraint] = []
    /// The bottom edge is what makes the sidebar follow the window's height.
    /// It is swapped for a fixed height while the window edge is dragged.
    private var bottomConstraint: NSLayoutConstraint?
    private var heldHeightConstraint: NSLayoutConstraint?
    private(set) var isFrozenForLiveResize = false

    init(root: Content, isSidebar: Bool) {
        host = NSHostingController(rootView: root)
        host.sizingOptions = []
        self.isSidebar = isSidebar
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        // The window owns the canvas wallpaper. Panes are transparent so the
        // same image is not duplicated or recropped during divider drags.
        view = NSView()
        addChild(host)
        host.view.identifier = NSUserInterfaceItemIdentifier(isSidebar ? "console.sidebar.content" : "console.detail.content")
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        let bottom = host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        edgeConstraints = [
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor)
        ]
        bottomConstraint = bottom
        NSLayoutConstraint.activate(edgeConstraints + [bottom])
    }

    /// Holds the sidebar's size for the duration of a live-resize gesture so
    /// its SwiftUI tree does no layout, body evaluation or redraw. Only the
    /// bottom edge is released; the top, leading and trailing edges keep
    /// following the pane, so the sidebar stays anchored at the **top** and
    /// the window's height change is absorbed at the **bottom** — content is
    /// cropped or revealed from the bottom up, never pulled off the top.
    ///
    /// `NSHostingView` receives no new size proposal (width is held by
    /// `holdingPriority`, height is now a constant), so AppKit just repositions
    /// the existing layer as the window changes. No bitmap, overlay, hidden
    /// host or redraw-policy tricks: the view stays visible and interactive.
    /// Only the width-stable sidebar may do this. The transcript detail is
    /// never touched and keeps receiving every geometry frame, so message
    /// text and the composer re-wrap continuously during the drag.
    func freezeForLiveResize() {
        guard isSidebar, !isFrozenForLiveResize, isViewLoaded,
              let bottomConstraint else { return }
        let height = host.view.frame.height
        guard height > 1 else { return }
        NSLayoutConstraint.deactivate([bottomConstraint])
        let held = host.view.heightAnchor.constraint(equalToConstant: height)
        held.isActive = true
        heldHeightConstraint = held
        isFrozenForLiveResize = true
    }

    /// Restores the real bottom edge and lays the sidebar out exactly once at
    /// the final window size. Idempotent.
    func unfreezeAfterLiveResize() {
        guard isFrozenForLiveResize else { return }
        heldHeightConstraint?.isActive = false
        heldHeightConstraint = nil
        if let bottomConstraint { NSLayoutConstraint.activate([bottomConstraint]) }
        view.layoutSubtreeIfNeeded()
        host.view.needsDisplay = true
        isFrozenForLiveResize = false
    }
}

@MainActor
protocol ConsoleSplitContentUpdating: AnyObject {
    var contentUpdateCount: Int { get }
}

@MainActor
final class ConsoleSplitController<Sidebar: View, Detail: View>: NSSplitViewController, ConsoleSplitContentUpdating, WorkColumnControlling {
    private let sidebarController: ConsolePaneController<Sidebar>
    private let detailController: ConsolePaneController<Detail>
    private var mode: ConsoleNavigationMode
    private var isActive = true
    private(set) var contentUpdateCount = 0
    /// Counts real `detailController.host.rootView` assignments, independent of
    /// how often SwiftUI asks for an update during a live-resize gesture.
    private(set) var detailRootCommitCount = 0
    private var restoredWidth = false
    private var isRestoring = false
    /// The newest sidebar/detail values offered while the window is being
    /// resized. A geometry frame must not rebuild either SwiftUI tree: the
    /// outline projection is O(total sessions) and the detail tree includes
    /// the whole transcript. Edges are held by Auto Layout, so the hosted
    /// views still receive every width change and text keeps reflowing live.
    /// Both roots are committed once, when the gesture ends.
    private var pendingSidebar: Sidebar?
    private var pendingDetail: Detail?
    /// Test seam: `NSWindow.inLiveResize` is not settable outside AppKit.
    var liveResizeOverride: Bool?
    private let widthDefaults: UserDefaults
    private let workRestoreHandle = WorkColumnRestoreHandle(frame: .zero)
    private var collapseObservation: NSKeyValueObservation?

    init(mode: ConsoleNavigationMode, sidebar: Sidebar, detail: Detail, defaults: UserDefaults? = nil) {
        self.mode = mode
        widthDefaults = defaults ?? CorptieAppEnvironment.userDefaults
        sidebarController = ConsolePaneController(root: sidebar, isSidebar: true)
        detailController = ConsolePaneController(root: detail, isSidebar: false)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let native = ConsoleNativeSplitView()
        splitView = native
        view = native
    }

    override func viewDidLoad() {
        splitView.isVertical = true
        splitView.dividerStyle = .thin
        // The console's Work/Task surfaces already draw their own cards.
        // A system Sidebar item adds a full-column material behind them.
        let sidebar = NSSplitViewItem(viewController: sidebarController)
        sidebar.allowsFullHeightLayout = true
        sidebar.canCollapse = true
        sidebar.minimumThickness = MainWindowMinimumSizePolicy.workColumnMinimumWidth
        sidebar.maximumThickness = 900
        // Window resizing belongs to the transcript. AppKit still lets the
        // user change this held width by dragging the native divider.
        sidebar.holdingPriority = .defaultHigh
        addSplitViewItem(sidebar)
        let detail = NSSplitViewItem(viewController: detailController)
        detail.holdingPriority = .defaultLow
        // Only the transcript/composer floor. The two-cell widget rail is an
        // overlay that slides away in narrow viewports, so it must not keep the
        // whole window wide when only messages are visible.
        detail.minimumThickness = MainWindowMinimumSizePolicy.transcriptMinimumWidth
        addSplitViewItem(detail)
        workRestoreHandle.translatesAutoresizingMaskIntoConstraints = false
        workRestoreHandle.expand = { [weak self] in self?.setWorkColumnCollapsed(false) }
        detailController.view.addSubview(workRestoreHandle, positioned: .above, relativeTo: nil)
        NSLayoutConstraint.activate([
            workRestoreHandle.leadingAnchor.constraint(equalTo: detailController.view.leadingAnchor, constant: 8),
            workRestoreHandle.topAnchor.constraint(equalTo: detailController.view.topAnchor, constant: 4),
            workRestoreHandle.widthAnchor.constraint(equalToConstant: 32),
            workRestoreHandle.heightAnchor.constraint(equalToConstant: 36)
        ])
        collapseObservation = sidebar.observe(\.isCollapsed, options: [.initial, .new]) { [weak self] _, change in
            let collapsed = change.newValue ?? false
            MainActor.assumeIsolated {
                self?.workRestoreHandle.isHidden = !collapsed
                self?.workRestoreHandle.resetHover()
                self?.updateWindowMinimumSize()
            }
        }
        NotificationCenter.default.addObserver(self, selector: #selector(dividerTrackingDidEnd(_:)),
            name: ConsoleNativeSplitView.didEndDividerTracking, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(dividerTrackingWillBegin(_:)),
            name: ConsoleNativeSplitView.willBeginDividerTracking, object: splitView)
        NotificationCenter.default.addObserver(self, selector: #selector(liveResizeWillStart(_:)),
            name: NSWindow.willStartLiveResizeNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(liveResizeDidEnd(_:)),
            name: NSWindow.didEndLiveResizeNotification, object: nil)
        super.viewDidLoad()
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        // `viewDidLoad` sees no window yet, so the initial KVO callback cannot
        // apply the floor. Do it once the controller is on screen.
        updateWindowMinimumSize()
    }

    /// Keep the window floor equal to the sum of the visible column minimums.
    /// Collapsing the Work outline frees its 284pt; expanding it asks for the
    /// space back. Comparing before assigning avoids touching AppKit layout on
    /// the many update passes that happen during a live resize.
    private func updateWindowMinimumSize() {
        guard let window = view.window else { return }
        let showsLabels = widthDefaults.bool(forKey: "ui.navigation.showLabels")
        let collapsed = splitViewItems.first?.isCollapsed ?? false
        let minimum = MainWindowMinimumSizePolicy.contentMinSize(
            workColumnCollapsed: collapsed,
            navigationShowsLabels: showsLabels
        )
        guard window.contentMinSize != minimum else { return }
        window.contentMinSize = minimum
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        if !restoredWidth, splitView.bounds.width > 0 {
            restoredWidth = true
            restoreWidth()
        }
    }

    func update(mode: ConsoleNavigationMode, isActive: Bool, sidebar: Sidebar, detail: Detail) {
        let trace = SessionSwitchTrace.shared.start(.splitUpdate)
        defer { SessionSwitchTrace.shared.finish(trace) }
        // Also picks up a navigation-rail label toggle, which SwiftUI commits
        // through an update pass rather than through the split item's KVO.
        if isActive { updateWindowMinimumSize() }
        // Commit the transition to inactive once, then leave retained hidden
        // hosts alone. Reactivation always receives the latest root values.
        if isActive || self.isActive {
            // A window resize changes only the transcript column's width: the
            // sidebar keeps its held width. Re-assigning its root on each
            // geometry frame rebuilds the whole outline projection, which is
            // O(total works/tasks/sessions). Hold the last committed sidebar
            // tree for the gesture and apply the newest value once at the end.
            // The detail root is always refreshed so message text reflows live.
            let liveResize = liveResizeOverride ?? (isViewLoaded && view.window?.inLiveResize == true)
            if liveResize {
                pendingSidebar = sidebar
                pendingDetail = detail
            } else {
                pendingSidebar = nil
                pendingDetail = nil
                let sidebarTrace = SessionSwitchTrace.shared.start(.sidebarRoot)
                sidebarController.host.rootView = sidebar
                SessionSwitchTrace.shared.finish(sidebarTrace)
                let detailTrace = SessionSwitchTrace.shared.start(.detailRoot)
                detailController.host.rootView = detail
                detailRootCommitCount += 1
                SessionSwitchTrace.shared.finish(detailTrace)
            }
            contentUpdateCount += 1
        }
        if !isActive { sidebarController.unfreezeAfterLiveResize() }
        self.isActive = isActive
        if self.mode != mode {
            saveWidth()
            self.mode = mode
            restoreWidth()
        }
    }

    @objc private func liveResizeWillStart(_ note: Notification) {
        guard (note.object as? NSWindow) === view.window else { return }
        // Only the sidebar/worker/cards column is held at its current geometry.
        // Its SwiftUI tree does no layout or redraw work for the gesture; the
        // transcript detail keeps its live layout and native TextKit reflow.
        sidebarController.freezeForLiveResize()
    }

    @objc private func liveResizeDidEnd(_ note: Notification) {
        guard (note.object as? NSWindow) === view.window else { return }
        sidebarController.unfreezeAfterLiveResize()
        if let pending = pendingSidebar {
            pendingSidebar = nil
            sidebarController.host.rootView = pending
        }
        if let pending = pendingDetail {
            pendingDetail = nil
            let detailTrace = SessionSwitchTrace.shared.start(.detailRoot)
            detailController.host.rootView = pending
            detailRootCommitCount += 1
            SessionSwitchTrace.shared.finish(detailTrace)
        }
    }

    override func splitView(_ splitView: NSSplitView, shouldHideDividerAt dividerIndex: Int) -> Bool {
        let defaultResult = super.splitView(splitView, shouldHideDividerAt: dividerIndex)
        return dividerIndex == 0 ? false : defaultResult
    }

    override func splitView(_ splitView: NSSplitView, additionalEffectiveRectOfDividerAt dividerIndex: Int) -> NSRect {
        let defaultRect = super.splitView(splitView, additionalEffectiveRectOfDividerAt: dividerIndex)
        guard dividerIndex == 0, splitViewItems.first?.isCollapsed == true else { return defaultRect }
        // AppKit still owns divider tracking; leave a narrow reachable edge.
        return NSRect(x: 0, y: 0, width: 6, height: splitView.bounds.height)
    }

    private var widthKey: String {
        mode == .taskCards ? "console.nativeSidebar.cardsWidth" : "console.nativeSidebar.listWidth.v2"
    }

    func setWorkColumnCollapsed(_ collapsed: Bool) {
        guard isActive, isViewLoaded, let item = splitViewItems.first,
              item.isCollapsed != collapsed else { return }
        if collapsed { saveWidth() }
        // One native layout change; no per-frame transcript width animation.
        item.isCollapsed = collapsed
        if !collapsed { restoreWidth() }
    }

    private func restoreWidth() {
        guard isViewLoaded, splitView.bounds.width > 0,
              splitViewItems.first?.isCollapsed == false else { return }
        isRestoring = true
        let stored = widthDefaults.double(forKey: widthKey)
        let minimum = MainWindowMinimumSizePolicy.workColumnMinimumWidth
        let preferred = stored > 0 ? stored : (mode == .taskCards ? 540 : minimum)
        let maximum = max(minimum,
                          splitView.bounds.width - MainWindowMinimumSizePolicy.transcriptMinimumWidth)
        splitViewItems[0].holdingPriority = .defaultLow
        splitView.setPosition(min(max(minimum, preferred), maximum), ofDividerAt: 0)
        splitViewItems[0].holdingPriority = .defaultHigh
        isRestoring = false
    }

    private func saveWidth() {
        guard isViewLoaded, !splitViewItems[0].isCollapsed else { return }
        let width = sidebarController.view.frame.width
        if width >= 284 { widthDefaults.set(width, forKey: widthKey) }
    }

    @objc private func dividerTrackingDidEnd(_ notification: Notification) {
        guard isActive, restoredWidth, !isRestoring,
              !splitView.isHiddenOrHasHiddenAncestor,
              let window = notification.object as? NSWindow, window === view.window else { return }
        saveWidth()
        splitViewItems[0].holdingPriority = .defaultHigh
    }

    @objc private func dividerTrackingWillBegin(_ notification: Notification) {
        splitViewItems[0].holdingPriority = .defaultLow
    }
}
