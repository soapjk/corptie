import AppKit
import Combine
import os
import QuartzCore
import SwiftUI
import UserNotifications

enum MainWindowTitlebarZoomPolicy {
    static let topEdgeHeight: CGFloat = 12

    static func shouldToggleZoom(
        clickCount: Int,
        locationY: CGFloat,
        contentHeight: CGFloat
    ) -> Bool {
        guard clickCount == 2, contentHeight > 0 else { return false }
        return locationY >= contentHeight - topEdgeHeight
            && locationY <= contentHeight
    }
}

enum MainWindowLevelPolicy {
    static func level(isPinned: Bool) -> NSWindow.Level {
        isPinned ? .floating : .normal
    }
}

enum MainWindowActivationPolicy {
    static func shouldPresentMainWindow(detachedChatWindowIsKey: Bool) -> Bool {
        !detachedChatWindowIsKey
    }
}

@MainActor
enum MainWindowForegrounding {
    /// An explicit menu/Dock request must also order the window while another
    /// application is active. Activation is asynchronous; ordinary ordering
    /// alone can leave the window behind the previously active application.
    static func present(_ window: NSWindow, activate: () -> Void) {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        activate()
    }
}

enum MainWindowInitialLayout {
    static let idealContentSize = NSSize(width: 1_480, height: 900)
    static let firstRunContentSize = NSSize(width: 952, height: 695)
    /// Only a floor for the *initial* window size. The resizable minimum is
    /// derived from the visible columns by `MainWindowMinimumSizePolicy`, so
    /// collapsing a sidebar can make the window smaller than this.
    static let minimumContentSize = NSSize(width: 900, height: 560)
    static let maximumVisibleFraction: CGFloat = 0.92

    static func contentSize(for visibleFrame: NSRect, firstRun: Bool = false) -> NSSize {
        let ideal = firstRun ? firstRunContentSize : idealContentSize
        return NSSize(
            width: max(
                minimumContentSize.width,
                min(ideal.width, floor(visibleFrame.width * maximumVisibleFraction))
            ),
            height: max(
                minimumContentSize.height,
                min(ideal.height, floor(visibleFrame.height * maximumVisibleFraction))
            )
        )
    }
}

/// The window minimum is the sum of the minimum thicknesses of the parts that
/// are currently visible, not a fixed size for the whole window. AppKit's
/// `NSSplitViewItem.minimumThickness` only constrains panes *inside* the split
/// view; on its own it lets the window shrink further and clip the transcript.
/// Keep one derived window floor and refresh it whenever a column collapses.
enum MainWindowMinimumSizePolicy {
    /// Work/Task outline column. Also used as the split item's minimumThickness.
    static let workColumnMinimumWidth: CGFloat = 284
    /// Conversation transcript plus composer. The optional 324pt detail rail
    /// is an overlay that hides itself in narrow viewports, so it is not part
    /// of the floor: with only messages showing the window can get much smaller.
    static let transcriptMinimumWidth: CGFloat = 360
    static let minimumContentHeight: CGFloat = 480
    /// Keep in sync with `MainWindowContentView`'s labelled rail width.
    static let labelledNavigationRailWidth: CGFloat = 168

    static func contentMinSize(workColumnCollapsed: Bool, navigationShowsLabels: Bool) -> NSSize {
        let navigationWidth = navigationShowsLabels
            ? labelledNavigationRailWidth
            : MainNavigationRailLayout.width
        let columns = (workColumnCollapsed ? 0 : workColumnMinimumWidth) + transcriptMinimumWidth
        return NSSize(
            width: navigationWidth + columns + MainWindowPageLayoutMetrics.outerPadding * 2,
            height: minimumContentHeight
        )
    }

    /// Startup state: the Work column is visible and the rail is compact.
    static var defaultContentMinSize: NSSize {
        contentMinSize(workColumnCollapsed: false, navigationShowsLabels: false)
    }
}

@MainActor
final class MainWindowPresentationState: ObservableObject {
    static let shared = MainWindowPresentationState()

    @Published private(set) var isPinned = false

    func setPinned(_ isPinned: Bool) {
        guard self.isPinned != isPinned else { return }
        self.isPinned = isPinned
    }
}

/// Restores the standard title-bar double-click maximize/restore interaction
/// for the full-size transparent title bar. SwiftUI owns the content under the
/// title bar, so NSWindow's default empty-title-bar handler never sees it.
@MainActor
class MainWindow: NSWindow {
    weak var compactWindowControls: CompactWindowControlsView?

    /// Every live-resize layout pass makes AppKit rebuild the whole window's
    /// key view loop (`NSView._layoutSubtreeWithOldSize` →
    /// `_recursiveSetDefaultKeyViewLoop` → SwiftUI
    /// `FocusBridge.updateDefaultKeyViewLoop`). That walk is O(views): a running
    /// Session keeps accumulating hosting views, so dragging gets slower the
    /// longer the app has been used and stays slow after the turn stops.
    /// Rebuild the loop once after the resize ends instead of on every frame.
    private var keyViewLoopResizeObserver: NSObjectProtocol?

    override init(contentRect: NSRect, styleMask style: NSWindow.StyleMask,
                  backing backingStoreType: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: style, backing: backingStoreType, defer: flag)
        autorecalculatesKeyViewLoop = false
        keyViewLoopResizeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didEndLiveResizeNotification,
            object: self,
            queue: .main
        ) { [weak self] _ in
            // `inLiveResize` can still be true while the notification is
            // delivered; deferring one turn keeps the rebuild off the last
            // drag frame and restores Tab navigation after the gesture.
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.recalculateKeyViewLoop() }
            }
        }
    }

    isolated deinit {
        if let keyViewLoopResizeObserver {
            NotificationCenter.default.removeObserver(keyViewLoopResizeObserver)
        }
    }

    override func recalculateKeyViewLoop() {
        guard !inLiveResize else { return }
        super.recalculateKeyViewLoop()
    }

    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown, !isOverStandardWindowButton(event),
           compactWindowControls?.button(at: event.locationInWindow) == nil {
            MainWindowMouseActivation.prepare(event, window: self,
                applicationIsActive: NSApp.isActive, modalWindow: NSApp.modalWindow) {
                NSApp.activate(ignoringOtherApps: true)
            }
        }
        if event.type == .leftMouseDown, attachedSheet == nil,
           let button = compactWindowControls?.button(at: event.locationInWindow) {
            button.mouseDown(with: event)
            return
        }
        if event.type == .leftMouseDown,
           let contentView,
           MainWindowTitlebarZoomPolicy.shouldToggleZoom(
               clickCount: event.clickCount,
               locationY: contentView.convert(event.locationInWindow, from: nil).y,
               contentHeight: contentView.bounds.height
           ),
           !isOverStandardWindowButton(event) {
            zoom(nil)
            return
        }
        if event.type == .leftMouseDown,
           event.clickCount == 1,
           attachedSheet == nil,
           event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty,
           let contentView,
           !isOverStandardWindowButton(event),
           MainWindowBackgroundDragPolicy.canDrag(
               at: event.locationInWindow,
               in: contentView
           ) {
            performDrag(with: event)
            return
        }
        super.sendEvent(event)
    }

    private func isOverStandardWindowButton(_ event: NSEvent) -> Bool {
        let buttonTypes: [NSWindow.ButtonType] = [
            .closeButton,
            .miniaturizeButton,
            .zoomButton
        ]
        return buttonTypes.contains { buttonType in
            guard let button = standardWindowButton(buttonType), !button.isHidden else {
                return false
            }
            return button.bounds.contains(
                button.convert(event.locationInWindow, from: nil)
            )
        }
    }
}

/// Complete activation before a custom drag consumes the original mouse-down.
/// Command-click and modal/sheet routing retain AppKit's background behavior.
@MainActor
enum MainWindowMouseActivation {
    static func prepare(_ event: NSEvent, window: NSWindow, applicationIsActive: Bool,
                        modalWindow: NSWindow?, activate: () -> Void) {
        guard event.type == .leftMouseDown, !event.modifierFlags.contains(.command),
              window.attachedSheet == nil, window.canBecomeKey,
              modalWindow == nil || modalWindow === window else { return }
        if !applicationIsActive { activate() }
        if !window.isKeyWindow { window.makeKey() }
    }
}

/// Native scroll containers consume empty clicks before SwiftUI backgrounds.
/// Only their unoccupied canvas is draggable; descendants inside cells and all
/// native input controls keep their ordinary mouse handling.
@MainActor
enum MainWindowBackgroundDragPolicy {
    static func canDrag(at windowPoint: NSPoint, in contentView: NSView) -> Bool {
        guard contentView.window != nil,
              contentView.bounds.insetBy(dx: 4, dy: 4).contains(contentView.convert(windowPoint, from: nil)),
              let hit = contentView.hitTest(contentView.superview?.convert(windowPoint, from: nil) ?? windowPoint)
        else { return false }
        var ancestor: NSView? = hit
        var isScrollCanvas = false
        while let view = ancestor {
            if view is NSTextView || view is NSScroller { return false }
            if view is NSControl, !(view is NSTableView) { return false }
            if view is NSTableCellView, view !== hit { return false }
            if let scroll = view as? NSScrollView {
                isScrollCanvas = true
                if hit === scroll.documentView,
                   scroll.documentView?.subviews.first is IntrinsicHeightTableView {
                    return true
                }
            }
            if view === contentView { break }
            ancestor = view.superview
        }
        // SwiftUI owns gestures in its hosting leaves. Its background drag
        // surface handles empty regions without competing with foreground UI.
        return isScrollCanvas && (hit is NSClipView || hit is NSTableView
            || type(of: hit) == NSView.self || hit is NSTableCellView)
    }
}

/// Hosts the leading controls in AppKit's actual title-bar hierarchy. A content
/// view drawn beneath a full-size transparent title bar is still subject to the
/// window's drag-region event routing, even when its SwiftUI controls are
/// visible. A native accessory receives mouse events before that routing.
@MainActor
final class MainWindowLeadingChromeAccessoryController: NSTitlebarAccessoryViewController {
    let hostingView: NSHostingView<MainWindowFixedChromeView>

    init(rootView: MainWindowFixedChromeView = MainWindowFixedChromeView()) {
        hostingView = NSHostingView(rootView: rootView)
        super.init(nibName: nil, bundle: nil)

        layoutAttribute = .left
        hostingView.sizingOptions = []
        hostingView.frame = NSRect(x: 0, y: 0, width: 24, height: 22)
        hostingView.autoresizingMask = []
        hostingView.layerContentsRedrawPolicy = .onSetNeedsDisplay
        view = hostingView
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

enum MainWindowResizeTrace {
    private static let log = OSLog(
        subsystem: "com.corptie.mac",
        category: "MainWindowResizePerformance"
    )

    static func beginSession(_ reason: String) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "ResizeSession", signpostID: id, "%{public}@", reason)
        return id
    }

    static func endSession(_ id: OSSignpostID) {
        os_signpost(.end, log: log, name: "ResizeSession", signpostID: id)
    }


}

@MainActor
final class MainWindowResizeState: ObservableObject {
    @Published fileprivate(set) var isLiveResize = false
}

/// The hosting view follows native autoresizing. Resize notifications only
/// suppress unrelated animations; they never schedule or delay geometry.
@MainActor
final class MainWindowSurfaceContainer<Content: View>: NSView {
    private enum ResizeReason: Hashable {
        case liveResize
        case fullScreenTransition
    }

    private let hostingView: NSHostingView<Content>
    private let resizeState: MainWindowResizeState
    private var resizeReasons = Set<ResizeReason>()
    private var windowNotificationTokens: [NSObjectProtocol] = []
    private var resizeTraceID: OSSignpostID?

    var renderedContentSize: NSSize { hostingView.frame.size }
    var presentedContentFrame: NSRect { hostingView.frame }
    var contentUsesIdentityTransform: Bool {
        (hostingView.layer?.affineTransform() ?? .identity) == .identity
    }

    init(rootView: Content, resizeState: MainWindowResizeState) {
        hostingView = NSHostingView(rootView: rootView)
        self.resizeState = resizeState
        super.init(frame: .zero)
        wantsLayer = true
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        hostingView.sizingOptions = []
        hostingView.autoresizingMask = [.width, .height]
        addSubview(hostingView)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeWindowObservers()
        guard let window else { return }
        let center = NotificationCenter.default
        for (name, reason, begins) in [
            (NSWindow.willEnterFullScreenNotification, ResizeReason.fullScreenTransition, true),
            (NSWindow.didEnterFullScreenNotification, ResizeReason.fullScreenTransition, false),
            (NSWindow.willExitFullScreenNotification, ResizeReason.fullScreenTransition, true),
            (NSWindow.didExitFullScreenNotification, ResizeReason.fullScreenTransition, false)
        ] {
            windowNotificationTokens.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    if begins { self?.beginResize(for: reason) }
                    else { self?.endResize(for: reason) }
                }
            })
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    override func viewWillStartLiveResize() {
        super.viewWillStartLiveResize()
        beginResize(for: .liveResize)
    }

    override func viewDidEndLiveResize() {
        super.viewDidEndLiveResize()
        endResize(for: .liveResize)
    }

    private func beginResize(for reason: ResizeReason) {
        let wasResizing = !resizeReasons.isEmpty
        resizeReasons.insert(reason)
        guard !wasResizing else { return }
        resizeState.isLiveResize = true
        resizeTraceID = MainWindowResizeTrace.beginSession(
            reason == .liveResize ? "liveResize" : "fullScreenTransition")
    }

    private func endResize(for reason: ResizeReason) {
        guard resizeReasons.remove(reason) != nil, resizeReasons.isEmpty else { return }
        resizeState.isLiveResize = false
        if let resizeTraceID { MainWindowResizeTrace.endSession(resizeTraceID) }
        resizeTraceID = nil
    }

    private func removeWindowObservers() {
        windowNotificationTokens.forEach(NotificationCenter.default.removeObserver)
        windowNotificationTokens.removeAll()
        for reason in resizeReasons { endResize(for: reason) }
    }
}

typealias LiveResizeHostingView<Content: View> = MainWindowSurfaceContainer<Content>
