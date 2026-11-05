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

    /// The host borrows existing page spacing; the message viewport stays unchanged.
    var trailingScrollerExtension: CGFloat = 0 {
        didSet {
            guard oldValue != trailingScrollerExtension else { return }
            tile()
            needsLayout = true
        }
    }

    override func tile() {
        super.tile()
        guard trailingScrollerExtension > 0 else { return }
        let contentWidth = max(0, bounds.width - trailingScrollerExtension)
        contentView.setFrameSize(NSSize(width: contentWidth, height: contentView.frame.height))
        if let scroller = verticalScroller {
            scroller.frame = NSRect(x: bounds.maxX - 12, y: scroller.frame.minY,
                width: 12, height: scroller.frame.height)
        }
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
    var onLayout: (() -> Void)?

    override func layout() {
        super.layout()
        onLayout?()
    }

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

class TimelineIntentScroller: ConsoleThinScroller {
    override var paintedKnobWidth: CGFloat { 4.5 }
    override class func scrollerWidth(for controlSize: NSControl.ControlSize,
                                     scrollerStyle: NSScroller.Style) -> CGFloat {
        scrollerStyle == .overlay ? 12 : super.scrollerWidth(for: controlSize, scrollerStyle: scrollerStyle)
    }
    override var knobTrailingInset: CGFloat? { 0 }
    /// Own the complete capsule instead of drawing into AppKit's 6pt thumb layer.
    private(set) var visibleKnobLayer: CALayer = {
        let layer = CALayer()
        layer.opacity = 0
        return layer
    }()
    private var pendingHide: Task<Void, Never>?
    override var wantsUpdateLayer: Bool { true }

    override func updateLayer() {
        guard let layer else { return }
        if visibleKnobLayer.superlayer !== layer || layer.sublayers?.count != 1 {
            layer.sublayers = [visibleKnobLayer]
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.backgroundColor = nil
        layer.masksToBounds = false
        visibleKnobLayer.frame = knobDrawingRect
        visibleKnobLayer.cornerRadius = paintedKnobWidth / 2
        visibleKnobLayer.contentsScale = window?.backingScaleFactor ?? 1
        effectiveAppearance.performAsCurrentDrawingAppearance {
            visibleKnobLayer.backgroundColor = knobColor.cgColor
        }
        visibleKnobLayer.isHidden = knobDrawingRect.isEmpty
        CATransaction.commit()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        // The transparent leading part of the 12pt control belongs to the card.
        guard !isHidden, alphaValue > 0, visibleKnobLayer.opacity > 0,
              knobDrawingRect.contains(local) else { return nil }
        return super.hitTest(point)
    }
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
        // AppKit's narrow native knob invalidation does not cover our custom
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
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        wantsLayer = true
    }

    // AppKit fades its private knob layer, which updateLayer replaces to avoid
    // clipping. Fade our capsule explicitly without changing native control alpha.
    func beginScrollInteraction() {
        pendingHide?.cancel()
        pendingHide = nil
        visibleKnobLayer.removeAnimation(forKey: "idleFade")
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        visibleKnobLayer.opacity = 1
        CATransaction.commit()
        enclosingScrollView?.flashScrollers()
    }

    func endScrollInteraction() {
        pendingHide?.cancel()
        pendingHide = Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(800)) }
            catch { return }
            guard let self else { return }
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1
            fade.toValue = 0
            fade.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.2
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            self.visibleKnobLayer.opacity = 0
            self.visibleKnobLayer.add(fade, forKey: "idleFade")
            CATransaction.commit()
            self.pendingHide = nil
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            pendingHide?.cancel()
            pendingHide = nil
            visibleKnobLayer.removeAnimation(forKey: "idleFade")
            visibleKnobLayer.opacity = 0
        }
    }
    var onBegin: (() -> Void)?
    var onEnd: (() -> Void)?

    override func testPart(_ point: NSPoint) -> NSScroller.Part {
        // The painted thumb is pinned to the edge rather than the native
        // hover knob's moving center. Keep its whole narrow lane draggable.
        let local = convert(point, from: nil)
        return knobDrawingRect.contains(local) ? .knob : .noPart
    }

    override func mouseDown(with event: NSEvent) {
        guard testPart(event.locationInWindow) == .knob else { return }
        onBegin?()
        defer { onEnd?() }
        super.mouseDown(with: event)
    }
}
