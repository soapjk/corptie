import AppKit
import SwiftUI

/// System-painted small overlay scroller. AppKit owns drawing and fading.
class ConsoleThinScroller: NSScroller {
    override class var isCompatibleWithOverlayScrollers: Bool { true }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        controlSize = .small
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        controlSize = .small
    }
}

/// Install on scroll content, so only its enclosing scroll view is configured.
/// AppKit owns showing/fading the overlay; no timers or scroll observations.
struct ConsoleOverlayScroller: NSViewRepresentable {
    // Native small scroller starts at x=8; reserve its system lane plus a gap.
    static let leadingContentInset: CGFloat = NSScroller.scrollerWidth(for: .small, scrollerStyle: .overlay) + 12
    var placeOnLeadingEdge = false
    var usesWorkStyle = false

    func makeNSView(context: Context) -> Probe {
        Probe(placeOnLeadingEdge: placeOnLeadingEdge, usesWorkStyle: usesWorkStyle)
    }
    func updateNSView(_ view: Probe, context: Context) {
        view.placeOnLeadingEdge = placeOnLeadingEdge
        view.usesWorkStyle = usesWorkStyle
        view.configure()
    }

    final class Probe: NSView {
        var placeOnLeadingEdge: Bool
        var usesWorkStyle: Bool

        init(placeOnLeadingEdge: Bool = false, usesWorkStyle: Bool = false) {
            self.placeOnLeadingEdge = placeOnLeadingEdge
            self.usesWorkStyle = usesWorkStyle
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
            if usesWorkStyle {
                WorkNavigationScrollStyle.configure(scrollView)
                return
            }
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
