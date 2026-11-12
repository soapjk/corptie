import AppKit
import SwiftUI

/// One backdrop for the entire rail, including the gaps between cards.
/// The mask fades material opacity, not blur radius. AppKit owns sampling
/// and appearance adaptation; card contents never enter a blur filter.
struct DetailRailBackdrop: NSViewRepresentable {
    func makeNSView(context: Context) -> DetailRailBackdropView {
        DetailRailBackdropView()
    }

    func updateNSView(_ view: DetailRailBackdropView, context: Context) {}
}

final class DetailRailBackdropView: NSVisualEffectView {
    private let horizontalFade = CAGradientLayer()
    private let verticalFade = CAGradientLayer()

    init() {
        super.init(frame: .zero)
        material = .hudWindow
        blendingMode = .withinWindow
        state = .active
        wantsLayer = true
        let colors = [NSColor.clear.cgColor, NSColor.black.cgColor,
                      NSColor.black.cgColor, NSColor.clear.cgColor]
        horizontalFade.colors = colors
        horizontalFade.startPoint = CGPoint(x: 0, y: 0.5)
        horizontalFade.endPoint = CGPoint(x: 1, y: 0.5)
        verticalFade.colors = colors
        verticalFade.startPoint = CGPoint(x: 0.5, y: 0)
        verticalFade.endPoint = CGPoint(x: 0.5, y: 1)
        horizontalFade.mask = verticalFade
        layer?.mask = horizontalFade
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        // Fixed point feather widths; only native layout updates these layers.
        // No observation, scroll work, timers, or implicit mask animations.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        horizontalFade.frame = bounds
        verticalFade.frame = horizontalFade.bounds
        let left = min(0.45, 32 / max(bounds.width, 1))
        let right = min(0.45, 12 / max(bounds.width, 1))
        let vertical = min(0.45, 24 / max(bounds.height, 1))
        horizontalFade.locations = [0, NSNumber(value: left), NSNumber(value: 1 - right), 1]
        verticalFade.locations = [0, NSNumber(value: vertical), NSNumber(value: 1 - vertical), 1]
        CATransaction.commit()
    }
}
