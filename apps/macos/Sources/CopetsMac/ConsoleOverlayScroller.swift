import AppKit
import SwiftUI

/// A narrow native overlay scroller. The scroll view still owns its visibility,
/// tracking and accessibility behavior. Paint only a thin knob, never a track
/// (including the native hover track), inside a wider native drag target.
class ConsoleThinScroller: NSScroller {
    static let knobWidth: CGFloat = 3
    var knobTrailingInset: CGFloat? { nil }
    var knobColor: NSColor { .secondaryLabelColor.withAlphaComponent(0.55) }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        // Repaint at each native overlay width, rather than stretching a cached
        // bitmap of the wider hover state into a hairline.
        layerContentsRedrawPolicy = .duringViewResize
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        layerContentsRedrawPolicy = .duringViewResize
    }
    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        needsDisplay = true
    }

    override var isOpaque: Bool { false }
    override class var isCompatibleWithOverlayScrollers: Bool { true }

    override class func scrollerWidth(for controlSize: NSControl.ControlSize,
                                     scrollerStyle: NSScroller.Style) -> CGFloat {
        scrollerStyle == .overlay ? 8 : super.scrollerWidth(for: controlSize, scrollerStyle: scrollerStyle)
    }

    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) { }

    override func draw(_ dirtyRect: NSRect) {
        // Do not ask NSScroller to paint its bezel or hover-slot background.
        // NSScrollView still manages the overlay's visibility and fading.
        drawKnob()
    }

    var knobDrawingRect: NSRect {
        guard isEnabled, knobProportion < 1 else { return .zero }
        let nativeKnob = rect(for: .knob)
        guard nativeKnob.width > 0, nativeKnob.height > 0 else { return .zero }
        let x = knobTrailingInset.map { bounds.maxX - $0 - Self.knobWidth }
            ?? (nativeKnob.midX - Self.knobWidth / 2)
        let scale = window?.backingScaleFactor ?? 1
        return NSRect(x: (x * scale).rounded() / scale,
                      y: nativeKnob.minY, width: Self.knobWidth, height: nativeKnob.height)
    }

    override func drawKnob() { drawFallbackKnob() }

    func drawFallbackKnob() {
        let knob = knobDrawingRect
        guard !knob.isEmpty else { return }
        knobColor.setFill()
        NSBezierPath(roundedRect: knob, xRadius: Self.knobWidth / 2,
                     yRadius: Self.knobWidth / 2).fill()
    }
}

/// Install on scroll content, so only its enclosing scroll view is configured.
/// AppKit owns showing/fading the overlay; no timers or scroll observations.
struct ConsoleOverlayScroller: NSViewRepresentable {
    // Indicator spans x=8...16; leave a dedicated gutter before card padding.
    static let leadingContentInset: CGFloat = 20
    var placeOnLeadingEdge = false

    func makeNSView(context: Context) -> Probe { Probe(placeOnLeadingEdge: placeOnLeadingEdge) }
    func updateNSView(_ view: Probe, context: Context) {
        view.placeOnLeadingEdge = placeOnLeadingEdge
        view.configure()
    }

    final class Probe: NSView {
        var placeOnLeadingEdge: Bool

        init(placeOnLeadingEdge: Bool = false) {
            self.placeOnLeadingEdge = placeOnLeadingEdge
            super.init(frame: .zero)
        }

        required init?(coder: NSCoder) { fatalError() }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            configure()
        }
        override func viewDidMoveToSuperview() {
            super.viewDidMoveToSuperview()
            configure()
        }
        override func layout() {
            super.layout()
            configure()
        }
        func configure() {
            guard let scrollView = enclosingScrollView else { return }
            if scrollView.scrollerStyle != .overlay { scrollView.scrollerStyle = .overlay }
            if scrollView.hasVerticalScroller, !(scrollView.verticalScroller is ConsoleThinScroller) {
                scrollView.verticalScroller = ConsoleThinScroller()
            }
            if !scrollView.autohidesScrollers { scrollView.autohidesScrollers = true }
            if scrollView.drawsBackground { scrollView.drawsBackground = false }
            if scrollView.contentView.drawsBackground { scrollView.contentView.drawsBackground = false }
            if !placeOnLeadingEdge {
                if scrollView.scrollerInsets.right != 0 {
                    scrollView.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
                }
                return
            }
            // Overlay scrollers don't consume content width. An inset places the
            // native indicator beside the cards without reversing their layout.
            let scrollerWidth = scrollView.verticalScroller?.frame.width
                ?? NSScroller.scrollerWidth(for: .regular, scrollerStyle: .overlay)
            let rightInset = max(0, scrollView.bounds.width - scrollerWidth - 8)
            if abs(scrollView.scrollerInsets.right - rightInset) > 0.5 {
                scrollView.scrollerInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: rightInset)
            }
        }
    }
}
