import AppKit
import Combine
import SwiftUI

@MainActor
final class PanelFocusState: ObservableObject {
    @Published var isFocused = false
}

struct ListLayoutMetrics: Equatable {
    let layoutKey: String
    let minimumHeight: CGFloat
    let preferredHeight: CGFloat
    let usefulHeight: CGFloat
    let itemHeights: [CGFloat]
}

@MainActor
final class PanelLayoutState: ObservableObject {
    @Published private(set) var listMetrics: ListLayoutMetrics?
    @Published var canRenderDetailMessages = false

    static let horizontalPadding: CGFloat = 18
    static let verticalPadding: CGFloat = 14
    static let headerHeight: CGFloat = 0
    static let headerToListSpacing: CGFloat = 0
    static let estimatedCardHeight: CGFloat = 116
    static let cardSpacing: CGFloat = 10
    static let listBottomPadding: CGFloat = 0
    static let bottomBreathingRoom: CGFloat = 0
    static let externalControlsGutter: CGFloat = 42

    var minimumListHeight: CGFloat? { listMetrics?.minimumHeight }
    var preferredListHeight: CGFloat? { listMetrics?.preferredHeight }
    var usefulListHeight: CGFloat? { listMetrics?.usefulHeight }

    func updateMeasuredListHeights(layoutKey: String, minimum: CGFloat, preferred: CGFloat, useful: CGFloat, itemHeights: [CGFloat]) {
        guard !layoutKey.isEmpty,
              minimum.isFinite, preferred.isFinite, useful.isFinite,
              minimum > 0, preferred > 0, useful > 0,
              !itemHeights.isEmpty,
              itemHeights.allSatisfy({ $0.isFinite && $0 > 0 }) else { return }
        let metrics = ListLayoutMetrics(
            layoutKey: layoutKey,
            minimumHeight: minimum,
            preferredHeight: preferred,
            usefulHeight: useful,
            itemHeights: itemHeights
        )
        guard listMetrics != metrics else { return }
        listMetrics = metrics
    }

}

@MainActor
final class FloatingPanelController: NSObject {
    private let panel: FloatingPanel
    private let client: BackendClient
    private let detachedSessionManager: DetachedSessionManager
    private let focusState = PanelFocusState()
    private let layoutState = PanelLayoutState()
    private let listMinimumSize = NSSize(width: 402, height: 92)
    private let detailSizeStorageKey = "corptie.detailWindowSizesBySession"
    private let listHeightStorageKey = "corptie.userListWindowHeightsByLayout.v4"
    private var cancellables = Set<AnyCancellable>()
    private var isProgrammaticResize = false
    private var isBouncingResize = false
    private var isNativeUserLiveResize = false
    private var isListTransitionLocked = false
    private var isDetailTransitionLocked = false
    private var didUserResize = false
    private var lastSessionCount = 0
    private var lastEffectiveListHeight: CGFloat?
    private var listWidthBeforeDetail: CGFloat?
    private var currentDisplayedSessionId: String?
    private var currentListLayoutKey: String?
    private var pendingResizeBounce: DispatchWorkItem?
    private var pendingListTransitionUnlock: DispatchWorkItem?
    private var pendingDetailTransitionUnlock: DispatchWorkItem?

    var isVisible: Bool {
        panel.isVisible
    }

    init(client: BackendClient, detachedSessionManager: DetachedSessionManager) {
        self.client = client
        self.detachedSessionManager = detachedSessionManager

        let initialFrame = NSRect(x: 1120, y: 580, width: 420, height: 460)

        panel = FloatingPanel(
            contentRect: initialFrame,
            styleMask: [.borderless, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false
        )

        super.init()

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.isMovableByWindowBackground = false
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.minSize = listMinimumSize
        panel.maxSize = NSSize(width: 720, height: 820)
        panel.delegate = self
        panel.customResizeDidEnd = { [weak self] in
            self?.finishListResizeIfNeeded()
        }

        let rootView = FloatingRootView()
            .environmentObject(client)
            .environmentObject(focusState)
            .environmentObject(layoutState)
            .environmentObject(detachedSessionManager)

        let hostingView = FirstMouseHostingView(rootView: rootView)
        // The SwiftUI root (including the liquid-glass panel background) must
        // always have exactly the same bounds as the NSWindow content view.
        // Without autoresizing or constraints, a layout-mode transition can
        // leave the hosting view at its previous height while the window has
        // already shrunk, which clips the rounded top and bottom edges.
        hostingView.translatesAutoresizingMaskIntoConstraints = true
        hostingView.autoresizingMask = [.width, .height]
        hostingView.frame = NSRect(
            origin: .zero,
            size: panel.contentRect(forFrameRect: panel.frame).size
        )
        hostingView.wantsLayer = true
        hostingView.layer?.backgroundColor = NSColor.clear.cgColor
        hostingView.layer?.masksToBounds = false
        panel.contentView = hostingView

        client.$sessions
            .receive(on: RunLoop.main)
            .sink { [weak self] sessions in
                self?.resizeForSessionCount(sessions.count)
                self?.adjustListHeightForCurrentMeasurements(animated: true)
            }
            .store(in: &cancellables)

        client.$selectedSession
            .receive(on: RunLoop.main)
            .sink { [weak self] selectedSession in
                guard let self else { return }
                let previousSessionId = self.currentDisplayedSessionId
                let nextSessionId = selectedSession?.id
                guard previousSessionId != nextSessionId else {
                    return
                }
                self.currentDisplayedSessionId = nextSessionId
                if selectedSession == nil {
                    self.pendingDetailTransitionUnlock?.cancel()
                    self.isDetailTransitionLocked = false
                    self.beginListTransition()
                } else {
                    if previousSessionId == nil {
                        self.listWidthBeforeDetail = self.panel.frame.width
                    }
                    self.pendingListTransitionUnlock?.cancel()
                    self.isListTransitionLocked = false
                    self.beginDetailTransition()
                }
            }
            .store(in: &cancellables)

        layoutState.$listMetrics
            .compactMap { $0 }
            .receive(on: RunLoop.main)
            .sink { [weak self] metrics in
                self?.applyListMetrics(metrics)
            }
            .store(in: &cancellables)

    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.orderFrontRegardless()
        focusState.isFocused = panel.isKeyWindow
    }

    @objc private func closePanelButtonPressed() {
        panel.orderOut(nil)
    }

    private func beginListTransition() {
        pendingListTransitionUnlock?.cancel()
        isListTransitionLocked = true
        layoutState.canRenderDetailMessages = false

        restoreListFrameForTransition(animated: true)

        let workItem = DispatchWorkItem { [weak self] in
            guard let self else {
                return
            }
            self.isListTransitionLocked = false
            guard self.client.selectedSession == nil else {
                return
            }
            self.adjustListHeightForCurrentMeasurements(animated: true)
        }
        pendingListTransitionUnlock = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.24, execute: workItem)
    }

    private func beginDetailTransition() {
        pendingDetailTransitionUnlock?.cancel()
        pendingDetailTransitionUnlock = nil
        isDetailTransitionLocked = true
        layoutState.canRenderDetailMessages = false

        let targetSessionId = client.selectedSession?.id
        applyDetailSizing(animated: true, restoreSavedSize: true) { [weak self] in
            guard let self else {
                return
            }
            self.isDetailTransitionLocked = false
            guard self.client.selectedSession?.id == targetSessionId else {
                return
            }
            self.layoutState.canRenderDetailMessages = true
        }
    }

    private func resizeForSessionCount(_ count: Int) {
        guard client.selectedSession == nil, !isListTransitionLocked else {
            return
        }

        let didDecreaseSessionCount = count < lastSessionCount
        lastSessionCount = count

        if didUserResize {
            if didDecreaseSessionCount {
                shrinkToPreferredHeightIfTooTall()
            }
            return
        }

        setPanelSize(NSSize(width: 420, height: preferredListHeight(for: count)))
    }

    private func applyListMetrics(_ metrics: ListLayoutMetrics) {
        guard client.selectedSession == nil, !isListTransitionLocked else { return }

        logWindowGeometry("apply-metrics key=\(metrics.layoutKey) min=\(format(metrics.minimumHeight)) preferred=\(format(metrics.preferredHeight)) useful=\(format(metrics.usefulHeight))")

        let isLayoutChange = currentListLayoutKey != metrics.layoutKey
        currentListLayoutKey = metrics.layoutKey
        applyListSizing()

        if isLayoutChange {
            pendingResizeBounce?.cancel()
            let savedHeight = savedListHeight(for: metrics.layoutKey)
            didUserResize = savedHeight != nil
            let requestedHeight = savedHeight.map { snappedListHeight($0, metrics: metrics) } ?? metrics.preferredHeight
            let targetHeight = min(
                panel.maxSize.height,
                max(currentListMinimumHeight(), min(metrics.usefulHeight, requestedHeight))
            )
            lastEffectiveListHeight = targetHeight
            guard abs(panel.frame.height - targetHeight) > 1 else { return }
            setPanelHeight(targetHeight, duration: 0.20, timing: .easeOut)
            return
        }

        resizeForMeasuredListHeight(metrics.preferredHeight)
        adjustListHeightForCurrentMeasurements(animated: true)
    }

    private func resizeForMeasuredListHeight(_ measuredHeight: CGFloat) {
        guard client.selectedSession == nil, !didUserResize, !isListTransitionLocked else {
            return
        }
        let targetHeight = min(panel.maxSize.height, max(currentListMinimumHeight(), measuredHeight))
        guard abs(panel.frame.height - targetHeight) > 4 else {
            return
        }
        setPanelSize(NSSize(width: panel.frame.width, height: targetHeight), duration: 0.14, timing: .easeOut)
    }

    private func adjustListHeightForCurrentMeasurements(animated: Bool) {
        guard client.selectedSession == nil, !isListTransitionLocked,
              !panel.inLiveResize, !panel.isPerformingCustomLiveResize, !isBouncingResize else {
            return
        }

        applyListSizing()

        let minimumHeight = currentListMinimumHeight()
        if panel.frame.height < minimumHeight - 1 {
            setPanelHeight(minimumHeight, duration: animated ? 0.12 : 0.0, timing: animated ? .easeOut : .linear)
            return
        }

        let usefulHeight = usefulMaximumListHeight(for: client.sessions.count)
        if panel.frame.height > usefulHeight + 8 {
            if animated {
                bounceHeightBackIfNeeded()
            } else {
                setPanelHeight(usefulHeight, duration: 0.0, timing: .linear)
            }
            return
        }

        guard !didUserResize else {
            return
        }

        let preferredHeight = preferredListHeight(for: client.sessions.count)
        guard abs(panel.frame.height - preferredHeight) > 4 else {
            return
        }
        setPanelSize(
            NSSize(width: panel.frame.width, height: preferredHeight),
            duration: animated ? 0.14 : 0.0,
            timing: animated ? .easeOut : .linear
        )
    }

    private func preferredListHeight(for count: Int) -> CGFloat {
        if let measuredHeight = layoutState.preferredListHeight, measuredHeight > 0 {
            return min(panel.maxSize.height, max(currentListMinimumHeight(), measuredHeight))
        }
        let visibleCards = max(1, min(count, 3))
        let targetHeight = listContentHeight(visibleCards: visibleCards)
        return min(460, max(listMinimumSize.height, targetHeight))
    }

    private func usefulMaximumListHeight(for count: Int) -> CGFloat {
        if let measuredHeight = layoutState.usefulListHeight, measuredHeight > 0 {
            return min(panel.maxSize.height, max(currentListMinimumHeight(), measuredHeight))
        }
        let visibleCards = max(1, count)
        let targetHeight = listContentHeight(visibleCards: visibleCards)
        return min(panel.maxSize.height, max(listMinimumSize.height, targetHeight))
    }

    private func listContentHeight(visibleCards: Int) -> CGFloat {
        PanelLayoutState.verticalPadding * 2
            + PanelLayoutState.headerHeight
            + PanelLayoutState.headerToListSpacing
            + CGFloat(visibleCards) * PanelLayoutState.estimatedCardHeight
            + CGFloat(max(0, visibleCards - 1)) * PanelLayoutState.cardSpacing
            + PanelLayoutState.listBottomPadding
            + PanelLayoutState.bottomBreathingRoom
    }

    private func detailDefaultHeight() -> CGFloat {
        preferredListHeight(for: 3)
    }

    private func detailMinimumHeight() -> CGFloat {
        // Message content belongs to the scroll view and must never resize the
        // window as live cards arrive. Only explicit user resizing changes the
        // detail window after its initial fixed layout has been established.
        let lastMessageHeight: CGFloat = 72
        let outerPadding = PanelLayoutState.verticalPadding * 2
        let headerHeight: CGFloat = 32
        let metaHeight: CGFloat = 32
        let composerHeight: CGFloat = 40
        let detailSpacings: CGFloat = 12 * 3
        let scrollBottomPadding: CGFloat = 8
        let safetyMargin: CGFloat = 12
        let targetHeight = outerPadding
            + headerHeight
            + metaHeight
            + composerHeight
            + detailSpacings
            + scrollBottomPadding
            + safetyMargin
            + lastMessageHeight

        return min(panel.maxSize.height, max(detailDefaultHeight(), targetHeight))
    }

    private func applyListSizing() {
        let minimumHeight = currentListMinimumHeight()
        panel.minSize = NSSize(width: listMinimumSize.width, height: minimumHeight)
        if panel.frame.height < minimumHeight - 1 {
            setPanelHeight(minimumHeight, duration: isListTransitionLocked ? 0.16 : 0.12, timing: .easeOut)
        }
    }

    private func restoreListFrameForTransition(animated: Bool) {
        let minimumHeight = currentListMinimumHeight()
        panel.minSize = NSSize(width: listMinimumSize.width, height: minimumHeight)

        let savedWidth = listWidthBeforeDetail?.isFinite == true ? listWidthBeforeDetail : nil
        let targetWidth = min(panel.maxSize.width, max(listMinimumSize.width, savedWidth ?? panel.frame.width))
        let targetHeight = restoredListHeight(minimumHeight: minimumHeight)
        guard abs(panel.frame.width - targetWidth) > 1 || abs(panel.frame.height - targetHeight) > 1 else {
            return
        }
        setPanelSize(
            NSSize(width: targetWidth, height: targetHeight),
            duration: animated ? 0.18 : 0.0,
            timing: animated ? .easeOut : .linear
        )
    }

    private func listTransitionTargetHeight(minimumHeight: CGFloat) -> CGFloat {
        let usefulHeight = usefulMaximumListHeight(for: client.sessions.count)
        if panel.frame.height > usefulHeight + 8 {
            return usefulHeight
        }
        if panel.frame.height < minimumHeight - 1 {
            return minimumHeight
        }
        return panel.frame.height
    }

    private func restoredListHeight(minimumHeight: CGFloat) -> CGFloat {
        let usefulHeight = usefulMaximumListHeight(for: client.sessions.count)
        if let lastEffectiveListHeight, lastEffectiveListHeight.isFinite, lastEffectiveListHeight > 0 {
            let restored = layoutState.listMetrics.map {
                snappedListHeight(lastEffectiveListHeight, metrics: $0)
            } ?? lastEffectiveListHeight
            return min(usefulHeight, max(minimumHeight, restored))
        }
        return listTransitionTargetHeight(minimumHeight: minimumHeight)
    }

    private func snappedListHeight(_ requestedHeight: CGFloat, metrics: ListLayoutMetrics) -> CGFloat {
        metrics.itemHeights.min(by: {
            abs($0 - requestedHeight) < abs($1 - requestedHeight)
        }) ?? metrics.preferredHeight
    }

    private func currentListMinimumHeight() -> CGFloat {
        guard let measuredHeight = layoutState.minimumListHeight, measuredHeight > 0 else {
            return listMinimumSize.height
        }
        return min(panel.maxSize.height, max(listMinimumSize.height, measuredHeight))
    }

    private func applyDetailSizing(animated: Bool, restoreSavedSize: Bool, completion: (@MainActor @Sendable () -> Void)? = nil) {
        let minimumHeight = detailMinimumHeight()
        let currentSize = panel.frame.size

        if let savedSize = savedDetailWindowSize(for: client.selectedSession?.id) {
            let fixedHeight = min(panel.maxSize.height, max(listMinimumSize.height, savedSize.height))
            panel.minSize = NSSize(width: listMinimumSize.width, height: min(minimumHeight, fixedHeight))

            guard restoreSavedSize else {
                completion?()
                return
            }

            let targetWidth = min(panel.maxSize.width, max(listMinimumSize.width, savedSize.width))
            let targetHeight = fixedHeight
            guard abs(currentSize.width - targetWidth) > 1 || abs(currentSize.height - targetHeight) > 1 else {
                completion?()
                return
            }

            setPanelSize(
                NSSize(width: targetWidth, height: targetHeight),
                duration: animated ? 0.18 : 0.0,
                timing: animated ? .easeOut : .linear,
                completion: completion
            )
            return
        }

        panel.minSize = NSSize(width: listMinimumSize.width, height: minimumHeight)

        let defaultHeight = max(detailDefaultHeight(), minimumHeight)
        let targetWidth = min(panel.maxSize.width, max(listMinimumSize.width, currentSize.width))
        let targetHeight = min(panel.maxSize.height, max(minimumHeight, defaultHeight))
        let shouldResize = currentSize.height < targetHeight - 1

        guard shouldResize else {
            completion?()
            return
        }

        setPanelSize(
            NSSize(width: targetWidth, height: targetHeight),
            duration: animated ? 0.18 : 0.0,
            timing: animated ? .easeOut : .linear,
            completion: completion
        )
    }

    private func shrinkToPreferredHeightIfTooTall() {
        let targetHeight = preferredListHeight(for: client.sessions.count)
        guard panel.frame.height > targetHeight + 8 else {
            return
        }
        setPanelHeight(targetHeight, duration: 0.18, timing: .easeOut)
    }

    private func setPanelSize(_ size: NSSize) {
        setPanelSize(size, duration: 0.16, timing: .easeOut)
    }

    private func setPanelSize(_ size: NSSize, duration: TimeInterval, timing: CAMediaTimingFunctionName, completion: (@MainActor @Sendable () -> Void)? = nil) {
        var frame = panel.frame
        let oldMaxY = frame.maxY
        frame.size = size
        frame.origin.y = oldMaxY - size.height

        logWindowGeometry("set-size target=\(format(size.width))x\(format(size.height)) duration=\(String(format: "%.2f", duration))")

        isProgrammaticResize = true
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: timing)
            panel.animator().setFrame(frame, display: true)
        } completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self else {
                    return
                }
                self.isProgrammaticResize = false
                self.logWindowGeometry("set-size-complete")
                completion?()
            }
        }
    }

    private func setPanelHeight(_ height: CGFloat, duration: TimeInterval, timing: CAMediaTimingFunctionName) {
        var frame = panel.frame
        let oldMaxY = frame.maxY
        frame.size.height = height
        frame.origin.y = oldMaxY - height

        logWindowGeometry("set-height target=\(format(height)) duration=\(String(format: "%.2f", duration))")

        isProgrammaticResize = true
        NSAnimationContext.runAnimationGroup { context in
            context.duration = duration
            context.timingFunction = CAMediaTimingFunction(name: timing)
            panel.animator().setFrame(frame, display: true)
        } completionHandler: { [weak self] in
            Task { @MainActor in
                self?.isProgrammaticResize = false
                self?.logWindowGeometry("set-height-complete")
            }
        }
    }

    private func logWindowGeometry(_ trigger: String) {
        guard CorptieAppEnvironment.isDevelopment else { return }
        let frame = panel.frame
        let contentRect = panel.contentRect(forFrameRect: frame)
        let viewFrame = panel.contentView?.frame ?? .zero
        let viewBounds = panel.contentView?.bounds ?? .zero
        print("[layout-debug] window trigger=\(trigger) frame=\(debugRect(frame)) contentRect=\(debugRect(contentRect)) hostingFrame=\(debugRect(viewFrame)) hostingBounds=\(debugRect(viewBounds))")
    }

    private func format(_ value: CGFloat) -> String {
        String(format: "%.1f", value)
    }

    private func debugRect(_ rect: NSRect) -> String {
        "x\(format(rect.minX)) y\(format(rect.minY)) w\(format(rect.width)) h\(format(rect.height))"
    }

    private func bounceHeightBackIfNeeded() {
        guard client.selectedSession == nil, !panel.inLiveResize,
              !panel.isPerformingCustomLiveResize, !isBouncingResize else {
            return
        }

        let targetHeight = usefulMaximumListHeight(for: client.sessions.count)
        let currentHeight = panel.frame.height
        guard currentHeight > targetHeight + 8 else {
            return
        }

        isBouncingResize = true
        pendingResizeBounce?.cancel()
        pendingResizeBounce = nil
        let undershoot = max(listMinimumSize.height, targetHeight - 10)
        let rebound = min(panel.maxSize.height, targetHeight + 5)

        setPanelHeight(undershoot, duration: 0.16, timing: .easeOut)

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) { [weak self] in
            guard let self else { return }
            self.setPanelHeight(rebound, duration: 0.11, timing: .easeInEaseOut)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.27) { [weak self] in
            guard let self else { return }
            self.setPanelHeight(targetHeight, duration: 0.13, timing: .easeOut)
        }

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.40) { [weak self] in
            self?.isBouncingResize = false
        }
    }

    private func shrinkToUsefulListHeightIfNeeded(animated: Bool) {
        guard client.selectedSession == nil else {
            return
        }
        let targetHeight = usefulMaximumListHeight(for: client.sessions.count)
        guard panel.frame.height > targetHeight + 8 else {
            return
        }
        if animated {
            bounceHeightBackIfNeeded()
        } else {
            setPanelHeight(targetHeight, duration: 0.0, timing: .linear)
        }
    }

    private func captureEffectiveListHeight() {
        guard client.selectedSession == nil else {
            return
        }
        let minimumHeight = currentListMinimumHeight()
        let usefulHeight = usefulMaximumListHeight(for: client.sessions.count)
        lastEffectiveListHeight = min(usefulHeight, max(minimumHeight, panel.frame.height))
        if let currentListLayoutKey, let lastEffectiveListHeight {
            saveListHeight(lastEffectiveListHeight, for: currentListLayoutKey)
        }
    }

    private func savedListHeight(for layoutKey: String) -> CGFloat? {
        guard let value = CorptieAppEnvironment.userDefaults.dictionary(forKey: listHeightStorageKey)?[layoutKey] as? NSNumber else {
            return nil
        }
        let height = CGFloat(value.doubleValue)
        return height.isFinite && height > 0 ? height : nil
    }

    private func saveListHeight(_ height: CGFloat, for layoutKey: String) {
        guard height.isFinite, height > 0 else { return }
        var heights = CorptieAppEnvironment.userDefaults.dictionary(forKey: listHeightStorageKey) ?? [:]
        heights[layoutKey] = Double(height)
        CorptieAppEnvironment.userDefaults.set(heights, forKey: listHeightStorageKey)
    }

    private func scheduleResizeBounceCheck() {
        pendingResizeBounce?.cancel()

        let workItem = DispatchWorkItem { [weak self] in
            Task { @MainActor in
                self?.bounceHeightBackIfNeeded()
            }
        }
        pendingResizeBounce = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.24, execute: workItem)
    }

    private func saveCurrentDetailWindowSizeIfNeeded() {
        guard let sessionId = client.selectedSession?.id else {
            return
        }
        let size = panel.frame.size
        guard size.width.isFinite, size.height.isFinite else {
            return
        }

        var sizes = detailWindowSizes()
        sizes[sessionId] = StoredPanelSize(width: size.width, height: size.height)
        saveDetailWindowSizes(sizes)
    }

    private func savedDetailWindowSize(for sessionId: String?) -> NSSize? {
        guard let sessionId, let size = detailWindowSizes()[sessionId] else {
            return nil
        }
        return NSSize(width: size.width, height: size.height)
    }

    private func detailWindowSizes() -> [String: StoredPanelSize] {
        guard let data = CorptieAppEnvironment.userDefaults.data(forKey: detailSizeStorageKey) else {
            return [:]
        }
        return (try? JSONDecoder().decode([String: StoredPanelSize].self, from: data)) ?? [:]
    }

    private func saveDetailWindowSizes(_ sizes: [String: StoredPanelSize]) {
        guard let data = try? JSONEncoder().encode(sizes) else {
            return
        }
        CorptieAppEnvironment.userDefaults.set(data, forKey: detailSizeStorageKey)
    }
}

private struct StoredPanelSize: Codable {
    let width: CGFloat
    let height: CGFloat
}

extension FloatingPanelController: NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }

    func windowDidBecomeKey(_ notification: Notification) {
        focusState.isFocused = true
    }

    func windowDidResignKey(_ notification: Notification) {
        focusState.isFocused = false
    }

    func windowDidResize(_ notification: Notification) {
        logWindowGeometry("window-did-resize")
        let isUserDrivenResize = isNativeUserLiveResize || panel.isPerformingCustomLiveResize
        if isUserDrivenResize && !isProgrammaticResize && !isBouncingResize {
            didUserResize = true
            if client.selectedSession != nil {
                saveCurrentDetailWindowSizeIfNeeded()
            } else {
                captureEffectiveListHeight()
            }
            scheduleResizeBounceCheck()
        }
    }

    func windowWillStartLiveResize(_ notification: Notification) {
        isNativeUserLiveResize = NSEvent.pressedMouseButtons != 0
    }

    func windowDidEndLiveResize(_ notification: Notification) {
        guard isNativeUserLiveResize else { return }
        isNativeUserLiveResize = false
        finishListResizeIfNeeded()
    }

    private func finishListResizeIfNeeded() {
        pendingResizeBounce?.cancel()
        if client.selectedSession != nil {
            saveCurrentDetailWindowSizeIfNeeded()
        } else {
            captureEffectiveListHeight()
            bounceHeightBackIfNeeded()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.41) { [weak self] in
                self?.captureEffectiveListHeight()
            }
        }
    }
}

final class FloatingPanel: NSPanel {
    var isPerformingCustomLiveResize = false
    var customResizeDidEnd: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        NSApp.activate(ignoringOtherApps: true)
        super.mouseDown(with: event)
    }

    override func sendEvent(_ event: NSEvent) {
        // A floating panel remains visible while another app is active. Promote
        // it to key before AppKit dispatches the first mouse-down so that the
        // same click reaches the SwiftUI control instead of only activating the
        // panel. acceptsFirstMouse on the root hosting view is insufficient for
        // controls nested inside SwiftUI ScrollView hosting layers.
        if event.type == .leftMouseDown && !isKeyWindow {
            NSApp.activate(ignoringOtherApps: true)
            makeKey()
        }
        super.sendEvent(event)
    }

    override var canBecomeKey: Bool {
        true
    }

    override var canBecomeMain: Bool {
        true
    }
}

private final class FirstMouseHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        true
    }
}
