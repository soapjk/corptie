import AppKit
import QuartzCore
import SwiftUI

/// Execution state is distinct from connection readiness. Blue is active,
/// orange awaits input, red failed, and neutral states no longer imply a warning.
///
/// The decorative breathing pulse is a CALayer opacity animation: it runs on
/// the compositor and never schedules a SwiftUI graph update or an AppKit
/// layout pass. An infinite SwiftUI animation modifier keeps every
/// NSHostingView in the window inside a permanent display cycle, so the cost
/// of the animation grew with the number of retained view nodes.
struct SessionStatusLight: View {
    let status: TaskStatus
    let diameter: CGFloat

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    var body: some View {
        StatusLightLayer(
            color: NSColor(color),
            dotSize: diameter,
            glowSize: nil,
            isBreathing: status == .running,
            reduceMotion: accessibilityReduceMotion,
            duration: 1.4,
            minimumOpacity: 0.35
        )
        .frame(width: diameter, height: diameter)
    }

    private var color: Color {
        switch status {
        case .running:
            .blue
        case .failed:
            .red
        case .blocked:
            .orange
        case .complete, .cancelled:
            .secondary
        }
    }
}

/// Shared layer-backed indicator for the session status dot and the connection
/// light. Keeping the pulse inside an `NSViewRepresentable` means SwiftUI only
/// re-evaluates when the state itself changes, not on every animation frame.
struct StatusLightLayer: NSViewRepresentable {
    let color: NSColor
    let dotSize: CGFloat
    let glowSize: CGFloat?
    let isBreathing: Bool
    let reduceMotion: Bool
    let duration: Double
    let minimumOpacity: CGFloat

    func makeNSView(context: Context) -> StatusLightLayerView {
        let view = StatusLightLayerView()
        view.configure(
            color: color,
            dotSize: dotSize,
            glowSize: glowSize,
            isBreathing: isBreathing,
            reduceMotion: reduceMotion,
            duration: duration,
            minimumOpacity: minimumOpacity
        )
        return view
    }

    func updateNSView(_ view: StatusLightLayerView, context: Context) {
        view.configure(
            color: color,
            dotSize: dotSize,
            glowSize: glowSize,
            isBreathing: isBreathing,
            reduceMotion: reduceMotion,
            duration: duration,
            minimumOpacity: minimumOpacity
        )
    }
}

@MainActor
final class StatusLightLayerView: NSView {
    private static let breathingAnimationKey = "corptie.status-light.breathing"

    private let dotLayer = CAShapeLayer()
    private let glowLayer = CAGradientLayer()
    private var renderedColor: NSColor = .clear
    private var renderedDotSize: CGFloat = 0
    private var renderedGlowSize: CGFloat = 0
    private var breathing = false
    private var animationDuration: CFTimeInterval = 0
    private var renderedMinimumOpacity: CGFloat = 0

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        let rootLayer = CALayer()
        rootLayer.frame = bounds
        layer = rootLayer
        glowLayer.type = .radial
        glowLayer.startPoint = CGPoint(x: 0.5, y: 0.5)
        glowLayer.endPoint = CGPoint(x: 1.0, y: 1.0)
        rootLayer.addSublayer(glowLayer)
        rootLayer.addSublayer(dotLayer)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(
        color: NSColor,
        dotSize: CGFloat,
        glowSize: CGFloat?,
        isBreathing: Bool,
        reduceMotion: Bool,
        duration: Double,
        minimumOpacity: CGFloat
    ) {
        let nextBreathing = isBreathing && !reduceMotion
        // Colour changes only rewrite layer properties; they never need an
        // AppKit layout pass. Only a size change may reposition the sublayers.
        let geometryChanged = renderedDotSize != dotSize
            || renderedGlowSize != (glowSize ?? 0)
        let animationChanged = nextBreathing != breathing
            || animationDuration != duration
            || renderedMinimumOpacity != minimumOpacity

        renderedColor = color
        renderedDotSize = dotSize
        renderedGlowSize = glowSize ?? 0
        animationDuration = duration
        renderedMinimumOpacity = minimumOpacity

        dotLayer.fillColor = color.cgColor
        dotLayer.shadowColor = color.withAlphaComponent(0.45).cgColor
        dotLayer.shadowOpacity = 1
        dotLayer.shadowRadius = dotSize * 0.55
        dotLayer.shadowOffset = .zero

        let hasGlow = glowSize != nil
        glowLayer.isHidden = !hasGlow
        if hasGlow {
            glowLayer.colors = [
                color.withAlphaComponent(0.42).cgColor,
                color.withAlphaComponent(0.22).cgColor,
                color.withAlphaComponent(0.0).cgColor
            ]
        }

        if geometryChanged {
            needsLayout = true
        }

        guard animationChanged else { return }
        breathing = nextBreathing
        // Dropping the animation is what makes "stop execution" actually stop
        // paying for the decorative pulse.
        layer?.removeAnimation(forKey: Self.breathingAnimationKey)
        layer?.opacity = 1
        guard nextBreathing else { return }

        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = minimumOpacity
        pulse.duration = duration
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer?.add(pulse, forKey: Self.breathingAnimationKey)
    }

    override func layout() {
        super.layout()
        let bounds = self.bounds
        glowLayer.frame = bounds
        let dot = CGRect(
            x: bounds.midX - renderedDotSize / 2,
            y: bounds.midY - renderedDotSize / 2,
            width: renderedDotSize,
            height: renderedDotSize
        )
        dotLayer.frame = bounds
        dotLayer.path = CGPath(ellipseIn: dot, transform: nil)
    }
}
