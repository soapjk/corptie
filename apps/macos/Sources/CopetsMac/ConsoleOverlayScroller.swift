import AppKit
import SwiftUI

/// Install on scroll content, so only its enclosing scroll view is configured.
/// AppKit owns showing/fading the overlay; no timers or scroll observations.
struct ConsoleOverlayScroller: NSViewRepresentable {
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
