import AppKit
import SwiftUI

/// Install on scroll content, so only its enclosing scroll view is configured.
/// AppKit owns showing/fading the overlay; no timers or scroll observations.
struct ConsoleOverlayScroller: NSViewRepresentable {
    func makeNSView(context: Context) -> Probe { Probe() }
    func updateNSView(_ view: Probe, context: Context) { view.configure() }

    final class Probe: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            configure()
        }
        override func viewDidMoveToSuperview() {
            super.viewDidMoveToSuperview()
            configure()
        }
        func configure() {
            guard let scrollView = enclosingScrollView else { return }
            scrollView.scrollerStyle = .overlay
            scrollView.drawsBackground = false
            scrollView.contentView.drawsBackground = false
        }
    }
}
