import AppKit
import SwiftUI
import CorptieConversation
import CorptieClientCore

final class FirstLayoutRestoringScrollView: NSScrollView {
    var forcesOverlayScrollers = false {
        didSet {
            if forcesOverlayScrollers { scrollerStyle = .overlay }
        }
    }

    override var scrollerStyle: NSScroller.Style {
        get { super.scrollerStyle }
        set { super.scrollerStyle = forcesOverlayScrollers ? .overlay : newValue }
    }

    var onLayout: (() -> Void)?
    var onUserScrollWillBegin: (() -> Void)?
    var onUserScrollDidEnd: (() -> Void)?

    override func scrollWheel(with event: NSEvent) {
        onUserScrollWillBegin?()
        defer { onUserScrollDidEnd?() }
        super.scrollWheel(with: event)
    }

    override func layout() {
        super.layout()
        onLayout?()
    }
}

final class IntrinsicHeightTableView: NSTableView {
    override func keyDown(with event: NSEvent) {
        guard [UInt16(116), 121, 115, 119, 125, 126].contains(event.keyCode),
              let scroll = enclosingScrollView as? FirstLayoutRestoringScrollView else {
            super.keyDown(with: event)
            return
        }
        scroll.onUserScrollWillBegin?()
        defer { scroll.onUserScrollDidEnd?() }
        super.keyDown(with: event)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        enclosingScrollView?.contentView.postsBoundsChangedNotifications = true
    }
}

final class TimelineIntentScroller: ConsoleThinScroller {
    override var paintedKnobWidth: CGFloat { 9 }
    override class func scrollerWidth(for controlSize: NSControl.ControlSize,
                                     scrollerStyle: NSScroller.Style) -> CGFloat {
        scrollerStyle == .overlay ? 12 : super.scrollerWidth(for: controlSize, scrollerStyle: scrollerStyle)
    }
    override var knobTrailingInset: CGFloat? { 1 }
    override var doubleValue: Double {
        didSet { if oldValue != doubleValue { needsDisplay = true } }
    }
    override var knobProportion: CGFloat {
        didSet { if oldValue != knobProportion { needsDisplay = true } }
    }
    override var isEnabled: Bool {
        didSet { if oldValue != isEnabled { needsDisplay = true } }
    }
    override func setNeedsDisplay(_ invalidRect: NSRect) {
        // AppKit's narrow native knob invalidation does not cover our 9pt
        // drawing. Repaint this small control, never the message viewport.
        guard !invalidRect.isEmpty else { return }
        super.setNeedsDisplay(bounds)
    }
    override func draw(_ dirtyRect: NSRect) {
        // This control is layer-backed. Clear old translucent pixels instead
        // of blending each new knob onto the previous cached image.
        NSColor.clear.setFill()
        dirtyRect.fill(using: .copy)
        super.draw(dirtyRect)
    }
    private static let visibleKnobColor = NSColor(name: nil) { appearance in
        let dark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        return NSColor(calibratedWhite: dark ? 1 : 0.4, alpha: 0.45)
    }
    override var knobColor: NSColor { Self.visibleKnobColor }
    private var hideTimer: Timer?
    private var pointerArea: NSTrackingArea?
    private var pointerInside = false
    private var interacting = false

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        alphaValue = 0
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
        alphaValue = 0
    }
    isolated deinit { hideTimer?.invalidate() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let pointerArea { removeTrackingArea(pointerArea) }
        let area = NSTrackingArea(rect: .zero,
            options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        addTrackingArea(area)
        pointerArea = area
    }
    override func mouseEntered(with event: NSEvent) {
        pointerInside = true
        reveal()
    }
    override func mouseExited(with event: NSEvent) {
        pointerInside = false
        scheduleHide()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            hideTimer?.invalidate()
            hideTimer = nil
            pointerInside = false
            interacting = false
            alphaValue = 0
        }
    }

    func beginScrollInteraction() {
        interacting = true
        reveal()
    }
    func endScrollInteraction() {
        interacting = false
        scheduleHide()
    }
    private func reveal() {
        // Keep one event-driven deadline per gesture, not one task per wheel tick.
        hideTimer?.fireDate = .distantFuture
        layer?.removeAnimation(forKey: "opacity")
        alphaValue = 1
    }
    private func scheduleHide() {
        guard !pointerInside, !interacting else { return }
        if let hideTimer {
            hideTimer.fireDate = Date().addingTimeInterval(0.8)
            return
        }
        let timer = Timer(timeInterval: 0.8, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.hideTimer = nil
                guard !self.pointerInside, !self.interacting else { return }
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.18
                    self.animator().alphaValue = 0
                }
            }
        }
        RunLoop.main.add(timer, forMode: .common)
        hideTimer = timer
    }
    var onBegin: (() -> Void)?
    var onEnd: (() -> Void)?

    override func testPart(_ point: NSPoint) -> NSScroller.Part {
        // The painted thumb is pinned to the edge rather than the native
        // hover knob's moving center. Keep its whole narrow lane draggable.
        let local = convert(point, from: nil)
        let knob = rect(for: .knob)
        return bounds.contains(local) && local.y >= knob.minY && local.y <= knob.maxY
            ? .knob : .noPart
    }

    override func mouseDown(with event: NSEvent) {
        guard testPart(event.locationInWindow) == .knob else { return }
        onBegin?()
        defer { onEnd?() }
        super.mouseDown(with: event)
    }
}
