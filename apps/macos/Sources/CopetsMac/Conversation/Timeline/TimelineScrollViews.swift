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
    override var knobTrailingInset: CGFloat? { 1 }
    override var knobColor: NSColor { .white.withAlphaComponent(0.38) }
    private var glassThumb: NSView?

    override var doubleValue: Double { didSet { needsLayout = true } }
    override var knobProportion: CGFloat { didSet { needsLayout = true } }
    override var isEnabled: Bool { didSet { needsLayout = true } }

    override func layout() {
        super.layout()
        if #available(macOS 26.0, *) {
            if glassThumb == nil {
                let glass = ScrollbarGlassThumb()
                glass.style = .clear
                glass.tintColor = .white.withAlphaComponent(0.16)
                glass.cornerRadius = ConsoleThinScroller.knobWidth / 2
                addSubview(glass)
                glassThumb = glass
            }
            let rect = knobDrawingRect
            glassThumb?.isHidden = rect.isEmpty
            if glassThumb?.frame != rect { glassThumb?.frame = rect }
        }
    }

    override func drawKnob() {
        if #available(macOS 26.0, *) { return }
        drawFallbackKnob()
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

@available(macOS 26.0, *)
private final class ScrollbarGlassThumb: NSGlassEffectView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
