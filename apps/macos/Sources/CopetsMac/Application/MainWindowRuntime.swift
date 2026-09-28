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

enum MainWindowInitialLayout {
    static let idealContentSize = NSSize(width: 1_480, height: 900)
    static let minimumContentSize = NSSize(width: 980, height: 620)
    static let maximumVisibleFraction: CGFloat = 0.92

    static func contentSize(for visibleFrame: NSRect) -> NSSize {
        NSSize(
            width: max(
                minimumContentSize.width,
                min(idealContentSize.width, floor(visibleFrame.width * maximumVisibleFraction))
            ),
            height: max(
                minimumContentSize.height,
                min(idealContentSize.height, floor(visibleFrame.height * maximumVisibleFraction))
            )
        )
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
final class MainWindow: NSWindow {
    override func sendEvent(_ event: NSEvent) {
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

struct LiveResizeLayoutStatistics: Equatable {
    fileprivate(set) var sizeChangeEvents = 0
    fileprivate(set) var layoutCommits = 0
    fileprivate(set) var coalescedEvents = 0
    fileprivate(set) var exactLayouts = 0
    fileprivate(set) var maximumLayoutDuration: TimeInterval = 0
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

/// Only background task status remains in the native title bar. Navigation is
/// a full-height leading column beside the resident page host.
@MainActor
final class MainWindowTitlebarAccessoryController: NSTitlebarAccessoryViewController {
    let surfaceView: MainWindowTitlebarSurfaceView

    init(
        trailingSurface: NSView = NSHostingView(rootView: MainWindowTaskSurfaceView())
    ) {
        surfaceView = MainWindowTitlebarSurfaceView(
            trailingSurface: trailingSurface
        )
        super.init(nibName: nil, bundle: nil)
        layoutAttribute = .top
        view = surfaceView
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }
}

@MainActor
final class MainWindowTitlebarSurfaceView: NSView {
    let trailingSurface: NSView

    init(trailingSurface: NSView) {
        self.trailingSurface = trailingSurface
        super.init(frame: NSRect(
            x: 0,
            y: 0,
            width: MainWindowLayoutMetrics.taskSurfaceWidth,
            height: MainWindowLayoutMetrics.titlebarHeight
        ))

        for surface in [trailingSurface] {
            surface.autoresizingMask = []
            surface.layerContentsRedrawPolicy = .onSetNeedsDisplay
            addSubview(surface)
        }
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: MainWindowLayoutMetrics.titlebarHeight)
    }

    override var mouseDownCanMoveWindow: Bool { true }

    override func layout() {
        super.layout()
        let verticalCenter = bounds.midY
        trailingSurface.frame = NSRect(
            x: bounds.maxX
                - MainWindowLayoutMetrics.titlebarTrailingInset
                - MainWindowLayoutMetrics.taskSurfaceWidth,
            y: verticalCenter - 11,
            width: MainWindowLayoutMetrics.taskSurfaceWidth,
            height: 22
        )
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

    static func sizeChanged(width: CGFloat, height: CGFloat) {
        os_signpost(
            .event,
            log: log,
            name: "ResizeSizeChanged",
            "%{public}.0fx%{public}.0f",
            Double(width),
            Double(height)
        )
    }

    static func measure<T>(_ name: StaticString, operation: () throws -> T) rethrows -> T {
        os_signpost(.begin, log: log, name: name)
        defer { os_signpost(.end, log: log, name: name) }
        return try operation()
    }
}

@MainActor
final class MainWindowResizeState: ObservableObject {
    @Published fileprivate(set) var isLiveResize = false
}

/// AppKit-owned main-window content hierarchy. Its center and trailing chrome
/// surfaces keep fixed intrinsic sizes and move with native window geometry;
/// the leading controls live in a native title-bar accessory. A display-link
/// consumes only the latest
/// pending content size; completion always restores exact geometry. The content
/// surface is never scaled: fixed-width columns therefore cannot stretch past
/// their target and snap backward at the next real layout commit.
@MainActor
final class MainWindowSurfaceContainer<Content: View>: NSView {
    private enum ResizeReason: Hashable {
        case liveResize
        case fullScreenTransition
    }

    static var liveLayoutInterval: TimeInterval { 1.0 / 30.0 }
    static var animatedLayoutInterval: TimeInterval { 1.0 / 60.0 }
    static var stabilityDelay: TimeInterval { 0.12 }

    private let backgroundView = NSView()
    private let contentContainer = NSView()
    private let hostingView: NSHostingView<Content>
    private let resizeState: MainWindowResizeState
    private var resizeReasons = Set<ResizeReason>()
    private var windowNotificationTokens: [NSObjectProtocol] = []
    private var resizeDisplayLink: CADisplayLink?
    private var hasPendingLayoutCommit = false
    private var exactLayoutTimer: Timer?
    private var lastLayoutTime: TimeInterval = -.infinity
    private var lastSizeChangeTime: TimeInterval = -.infinity
    private var lastObservedSize = NSSize.zero
    private var resizeTraceID: OSSignpostID?
    private(set) var layoutStatistics = LiveResizeLayoutStatistics()
    var renderedContentSize: NSSize { hostingView.frame.size }
    var presentedContentFrame: NSRect {
        contentContainer.layer?.frame ?? contentContainer.frame
    }
    var contentUsesIdentityTransform: Bool {
        contentContainer.layer?.affineTransform() == .identity
    }

    init(
        rootView: Content,
        resizeState: MainWindowResizeState
    ) {
        hostingView = NSHostingView(rootView: rootView)
        self.resizeState = resizeState
        super.init(frame: .zero)

        wantsLayer = true
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        backgroundView.wantsLayer = true
        backgroundView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        backgroundView.autoresizingMask = []
        addSubview(backgroundView)

        contentContainer.wantsLayer = true
        contentContainer.layer?.masksToBounds = true
        contentContainer.autoresizingMask = []
        addSubview(contentContainer)

        hostingView.sizingOptions = []
        hostingView.autoresizingMask = []
        hostingView.layerContentsRedrawPolicy = .duringViewResize
        contentContainer.addSubview(hostingView)

    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeWindowObservers()
        guard let window else { return }
        installDisplayLink()

        let center = NotificationCenter.default
        windowNotificationTokens = [
            center.addObserver(
                forName: NSWindow.willEnterFullScreenNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.beginResize(for: .fullScreenTransition)
                }
            },
            center.addObserver(
                forName: NSWindow.didEnterFullScreenNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.endResize(for: .fullScreenTransition)
                }
            },
            center.addObserver(
                forName: NSWindow.willExitFullScreenNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.beginResize(for: .fullScreenTransition)
                }
            },
            center.addObserver(
                forName: NSWindow.didExitFullScreenNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.endResize(for: .fullScreenTransition)
                }
            }
        ]
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        backgroundView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    override func viewWillStartLiveResize() {
        super.viewWillStartLiveResize()
        beginResize(for: .liveResize)
    }

    override func viewDidEndLiveResize() {
        super.viewDidEndLiveResize()
        endResize(for: .liveResize)
    }

    override func layout() {
        super.layout()
        backgroundView.frame = bounds
        guard bounds.size != lastObservedSize else { return }
        lastObservedSize = bounds.size
        lastSizeChangeTime = ProcessInfo.processInfo.systemUptime
        layoutStatistics.sizeChangeEvents += 1
        MainWindowResizeTrace.sizeChanged(width: bounds.width, height: bounds.height)

        if hostingView.frame.size == .zero {
            applyExactLayout()
            return
        }

        // Native live/full-screen transitions have a definitive end callback.
        // Running the stability fallback during those transitions can mistake a
        // delayed main-thread event for completion and force an expensive exact
        // layout while the pointer is still moving.
        if resizeReasons.isEmpty {
            scheduleExactLayoutAfterStability()
        }
        scheduleLayoutIfNeeded()
    }

    private func beginResize(for reason: ResizeReason) {
        let wasResizing = !resizeReasons.isEmpty
        resizeReasons.insert(reason)
        guard !wasResizing else { return }
        exactLayoutTimer?.invalidate()
        exactLayoutTimer = nil
        resizeState.isLiveResize = true
        lastLayoutTime = ProcessInfo.processInfo.systemUptime
        resizeTraceID = MainWindowResizeTrace.beginSession(
            reason == .liveResize ? "liveResize" : "fullScreenTransition"
        )
    }

    private func endResize(for reason: ResizeReason) {
        resizeReasons.remove(reason)
        guard resizeReasons.isEmpty else { return }
        resizeState.isLiveResize = false
        invalidateLayoutTimers()
        applyExactLayout()
        if let resizeTraceID {
            MainWindowResizeTrace.endSession(resizeTraceID)
            self.resizeTraceID = nil
        }
    }

    private func scheduleLayoutIfNeeded() {
        guard !hasPendingLayoutCommit else {
            layoutStatistics.coalescedEvents += 1
            return
        }
        hasPendingLayoutCommit = true
        resizeDisplayLink?.isPaused = false
    }

    private func installDisplayLink() {
        resizeDisplayLink?.invalidate()
        let link = displayLink(
            target: self,
            selector: #selector(handleDisplayLink(_:))
        )
        link.isPaused = true
        link.add(to: .main, forMode: .common)
        resizeDisplayLink = link
    }

    @objc private func handleDisplayLink(_ displayLink: CADisplayLink) {
        guard hasPendingLayoutCommit else {
            displayLink.isPaused = true
            return
        }
        let interval = resizeReasons.isEmpty
            ? Self.animatedLayoutInterval
            : Self.liveLayoutInterval
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastLayoutTime >= interval else { return }
        hasPendingLayoutCommit = false
        applyLayoutCommit()
        if !hasPendingLayoutCommit {
            displayLink.isPaused = true
        }
    }

    private func scheduleExactLayoutAfterStability() {
        guard exactLayoutTimer == nil else { return }
        scheduleStabilityTimer(after: Self.stabilityDelay)
    }

    private func scheduleStabilityTimer(after delay: TimeInterval) {
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.exactLayoutTimer = nil
                let elapsed = ProcessInfo.processInfo.systemUptime - self.lastSizeChangeTime
                guard elapsed >= Self.stabilityDelay else {
                    self.scheduleStabilityTimer(after: Self.stabilityDelay - elapsed)
                    return
                }
                self.hasPendingLayoutCommit = false
                self.resizeDisplayLink?.isPaused = true
                self.applyExactLayout()
            }
        }
        exactLayoutTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func applyLayoutCommit() {
        let startedAt = ProcessInfo.processInfo.systemUptime
        MainWindowResizeTrace.measure("ResizeLayoutCommit") {
            // Assign only the newest size. AppKit and Core Animation perform the
            // resulting child layout/draw in their normal transaction instead of
            // synchronously blocking this resize callback. Intermediate sizes
            // coalesced by the frame coordinator are intentionally discarded.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            contentContainer.frame = bounds
            hostingView.frame = contentContainer.bounds
            CATransaction.commit()
        }
        let finishedAt = ProcessInfo.processInfo.systemUptime
        lastLayoutTime = finishedAt
        layoutStatistics.layoutCommits += 1
        layoutStatistics.maximumLayoutDuration = max(
            layoutStatistics.maximumLayoutDuration,
            finishedAt - startedAt
        )
    }

    private func applyExactLayout() {
        let startedAt = ProcessInfo.processInfo.systemUptime
        MainWindowResizeTrace.measure("ResizeExactLayout") {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            contentContainer.frame = bounds
            hostingView.frame = contentContainer.bounds
            CATransaction.commit()
            hostingView.needsLayout = true
            hostingView.layoutSubtreeIfNeeded()
            // Drawing remains transaction-driven. The synchronous layout makes
            // geometry and hit-testing exact without waiting for rasterization.
            hostingView.needsDisplay = true
        }
        let finishedAt = ProcessInfo.processInfo.systemUptime
        lastLayoutTime = finishedAt
        layoutStatistics.exactLayouts += 1
        layoutStatistics.maximumLayoutDuration = max(
            layoutStatistics.maximumLayoutDuration,
            finishedAt - startedAt
        )
    }

    private func invalidateLayoutTimers() {
        hasPendingLayoutCommit = false
        resizeDisplayLink?.isPaused = true
        exactLayoutTimer?.invalidate()
        exactLayoutTimer = nil
    }

    private func removeWindowObservers() {
        invalidateLayoutTimers()
        resizeDisplayLink?.invalidate()
        resizeDisplayLink = nil
        let center = NotificationCenter.default
        windowNotificationTokens.forEach(center.removeObserver)
        windowNotificationTokens.removeAll()
    }
}

typealias LiveResizeHostingView<Content: View> = MainWindowSurfaceContainer<Content>
