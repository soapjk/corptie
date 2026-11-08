import AppKit

/// A scroll-edge cue owned by AppKit. Only the divider changes when the list
/// crosses its top boundary; scrolling never publishes SwiftUI state.
final class WorkOutlineScrollView: NSScrollView {
    // Keep this local to Work. AppKit can update the style after attaching a
    // window or changing input-device preferences; it must remain an overlay.
    override var scrollerStyle: NSScroller.Style {
        get { super.scrollerStyle }
        set {
            if super.scrollerStyle != .overlay { super.scrollerStyle = .overlay }
        }
    }

    private let topDivider = DividerView()
    var showsTopDivider: Bool { !topDivider.isHidden }
    var topDividerFrame: NSRect { topDivider.frame }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        topDivider.isHidden = true
        addSubview(topDivider, positioned: .above, relativeTo: nil)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func tile() {
        super.tile()
        updateTopDivider()
    }
    override func reflectScrolledClipView(_ clipView: NSClipView) {
        super.reflectScrolledClipView(clipView)
        updateTopDivider()
    }
    private func updateTopDivider() {
        let thickness = 1 / (window?.backingScaleFactor ?? 2)
        let frame = NSRect(x: bounds.minX, y: isFlipped ? bounds.minY : bounds.maxY - thickness,
                           width: bounds.width, height: thickness)
        if topDivider.frame != frame { topDivider.frame = frame }
        let obscured = documentView.map { document in
            document.isFlipped
                ? contentView.documentVisibleRect.minY > document.bounds.minY + 0.5
                : contentView.documentVisibleRect.maxY < document.bounds.maxY - 0.5
        } ?? false
        if topDivider.isHidden == obscured { topDivider.isHidden = !obscured }
    }

    private final class DividerView: NSView {
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func draw(_ dirtyRect: NSRect) {
            NSColor.separatorColor.setFill()
            bounds.fill()
        }
    }
}
