import AppKit

/// AppKit owns knob geometry, tracking and layer fading. Only the capsule
/// pixels are drawn here, avoiding the inherited bitmap's asymmetric caps.
final class WorkOutlineThinScroller: ConsoleThinScroller {
    override func drawKnobSlot(in slotRect: NSRect, highlight flag: Bool) {}

    override func drawKnob() {
        let knob = rect(for: .knob)
        guard knob.width > 0, knob.height > 0 else { return }
        NSColor.secondaryLabelColor.withAlphaComponent(0.6).setFill()
        NSBezierPath(roundedRect: knob, xRadius: knob.width / 2, yRadius: knob.width / 2).fill()
    }
}

/// One local policy for all scrollable Work navigation surfaces.
@MainActor
enum WorkNavigationScrollStyle {
    static let trailingClearance: CGFloat = 4

    static func configure(_ scroll: NSScrollView) {
        if scroll.scrollerStyle != .overlay { scroll.scrollerStyle = .overlay }
        if !scroll.hasVerticalScroller { scroll.hasVerticalScroller = true }
        if !(scroll.verticalScroller is WorkOutlineThinScroller) {
            scroll.verticalScroller = WorkOutlineThinScroller()
        }
        if !scroll.autohidesScrollers { scroll.autohidesScrollers = true }
        if scroll.drawsBackground { scroll.drawsBackground = false }
        if scroll.contentView.drawsBackground { scroll.contentView.drawsBackground = false }
        if scroll.borderType != .noBorder { scroll.borderType = .noBorder }
        let insets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: trailingClearance)
        if scroll.scrollerInsets.top != 0 || scroll.scrollerInsets.left != 0
            || scroll.scrollerInsets.bottom != 0 || scroll.scrollerInsets.right != trailingClearance {
            scroll.scrollerInsets = insets
        }
    }
}
