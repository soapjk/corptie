import AppKit
import QuartzCore
import SwiftUI

struct StatusHalo: NSViewRepresentable {
    let status: TaskStatus

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    func makeNSView(context: Context) -> StatusHaloLayerView {
        let view = StatusHaloLayerView()
        view.configure(status: status, reduceMotion: accessibilityReduceMotion)
        return view
    }

    func updateNSView(_ nsView: StatusHaloLayerView, context: Context) {
        nsView.configure(status: status, reduceMotion: accessibilityReduceMotion)
    }
}

final class StatusHaloLayerView: NSView {
    private enum AnimationKey {
        static let pulse = "corptie.status-halo.pulse"
        static let rotation = "corptie.status-halo.rotation"
    }

    private let haloLayer = CALayer()
    private let arcLayer = CALayer()

    private var status: TaskStatus?
    private var reduceMotion = false
    private var renderedSize = CGSize.zero
    private var renderedScale: CGFloat = 0
    private weak var observedWindow: NSWindow?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configureLayers()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureLayers()
    }

    override var isFlipped: Bool {
        true
    }

    override func layout() {
        super.layout()
        layoutLayers()
        renderStaticContentIfNeeded()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        renderStaticContentIfNeeded(force: true)
        observeCurrentWindow()
        updatePlaybackState()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        renderStaticContentIfNeeded(force: true)
    }

    func configure(status: TaskStatus, reduceMotion: Bool) {
        guard self.status != status || self.reduceMotion != reduceMotion else {
            return
        }
        let statusChanged = self.status != status
        self.status = status
        self.reduceMotion = reduceMotion
        if statusChanged {
            renderStaticContentIfNeeded(force: true)
        }
        refreshAnimations()
        updatePlaybackState()
    }

    private func configureLayers() {
        wantsLayer = true
        layer = CALayer()
        layer?.masksToBounds = false

        for contentLayer in [haloLayer, arcLayer] {
            contentLayer.anchorPoint = CGPoint(x: 0.5, y: 0.5)
            contentLayer.contentsGravity = .resizeAspect
            contentLayer.masksToBounds = false
            layer?.addSublayer(contentLayer)
        }
    }

    private func layoutLayers() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        for contentLayer in [haloLayer, arcLayer] {
            contentLayer.bounds = CGRect(origin: .zero, size: bounds.size)
            contentLayer.position = center
        }
        CATransaction.commit()
    }

    private func renderStaticContentIfNeeded(force: Bool = false) {
        guard let status, bounds.width > 0, bounds.height > 0 else {
            return
        }
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        guard force || renderedSize != bounds.size || renderedScale != scale else {
            return
        }

        let colorScheme: ColorScheme = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? .dark
            : .light
        let size = bounds.size
        let haloImage = render(
            StatusHaloGradient(status: status)
                .frame(width: size.width, height: size.height)
                .environment(\.colorScheme, colorScheme),
            size: size,
            scale: scale
        )
        let arcImage = status == .running
            ? render(
                StatusHaloRunningArc()
                    .frame(width: size.width, height: size.height)
                    .environment(\.colorScheme, colorScheme),
                size: size,
                scale: scale
            )
            : nil

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        haloLayer.contents = haloImage
        haloLayer.contentsScale = scale
        arcLayer.contents = arcImage
        arcLayer.contentsScale = scale
        arcLayer.isHidden = status != .running
        CATransaction.commit()

        renderedSize = size
        renderedScale = scale
    }

    private func render<Content: View>(_ content: Content, size: CGSize, scale: CGFloat) -> CGImage? {
        let renderer = ImageRenderer(content: content)
        renderer.proposedSize = ProposedViewSize(width: size.width, height: size.height)
        renderer.scale = scale
        renderer.isOpaque = false
        return renderer.cgImage
    }

    private func refreshAnimations() {
        haloLayer.removeAnimation(forKey: AnimationKey.pulse)
        arcLayer.removeAnimation(forKey: AnimationKey.rotation)

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        haloLayer.opacity = 1
        haloLayer.transform = CATransform3DIdentity
        arcLayer.opacity = 1
        arcLayer.transform = CATransform3DIdentity
        CATransaction.commit()

        guard let status, !reduceMotion else {
            return
        }

        if status == .blocked || status == .complete {
            let opacity = CABasicAnimation(keyPath: "opacity")
            opacity.fromValue = 0.0
            opacity.toValue = 1.0
            opacity.duration = 1.2

            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.62
            scale.toValue = 1.08
            scale.duration = 1.2

            let pulse = CAAnimationGroup()
            pulse.animations = [opacity, scale]
            pulse.duration = 1.2
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            pulse.isRemovedOnCompletion = false
            haloLayer.add(pulse, forKey: AnimationKey.pulse)
        }

        if status == .running {
            let rotation = CABasicAnimation(keyPath: "transform.rotation.z")
            rotation.fromValue = 0.0
            rotation.toValue = Double.pi * 2
            rotation.duration = 1.2
            rotation.repeatCount = .infinity
            rotation.timingFunction = CAMediaTimingFunction(name: .linear)
            rotation.isRemovedOnCompletion = false
            arcLayer.add(rotation, forKey: AnimationKey.rotation)
        }
    }

    private func observeCurrentWindow() {
        stopObservingWindow()
        guard let window else {
            return
        }
        observedWindow = window
        let notifications: [Notification.Name] = [
            NSWindow.didChangeOcclusionStateNotification,
            NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification
        ]
        for notification in notifications {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(windowVisibilityChanged),
                name: notification,
                object: window
            )
        }
    }

    private func stopObservingWindow() {
        guard let observedWindow else {
            return
        }
        NotificationCenter.default.removeObserver(self, name: nil, object: observedWindow)
        self.observedWindow = nil
    }

    @objc private func windowVisibilityChanged() {
        updatePlaybackState()
    }

    private func updatePlaybackState() {
        guard let layer else {
            return
        }
        let shouldRun = !reduceMotion
            && window?.isVisible == true
            && window?.isMiniaturized == false
            && window?.occlusionState.contains(.visible) == true

        if shouldRun, layer.speed == 0 {
            let pausedTime = layer.timeOffset
            layer.speed = 1
            layer.timeOffset = 0
            layer.beginTime = 0
            layer.beginTime = layer.convertTime(CACurrentMediaTime(), from: nil) - pausedTime
        } else if !shouldRun, layer.speed != 0 {
            let pausedTime = layer.convertTime(CACurrentMediaTime(), from: nil)
            layer.speed = 0
            layer.timeOffset = pausedTime
        }
    }
}

private struct StatusHaloGradient: View {
    let status: TaskStatus

    var body: some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [
                        baseColor.opacity(innerOpacity),
                        baseColor.opacity(midOpacity),
                        baseColor.opacity(0)
                    ],
                    center: .center,
                    startRadius: 22,
                    endRadius: 38
                )
            )
    }

    private var baseColor: Color {
        switch status {
        case .running:
            CorptiePalette.connected
        case .blocked, .complete:
            Color(nsColor: NSColor(calibratedRed: 1.0, green: 0.58, blue: 0.02, alpha: 1.0))
        case .failed, .cancelled:
            .red
        }
    }

    private var innerOpacity: Double {
        switch status {
        case .running:
            0.32
        case .blocked, .complete:
            0.82
        case .failed, .cancelled:
            0.54
        }
    }

    private var midOpacity: Double {
        switch status {
        case .running:
            0.16
        case .blocked, .complete:
            0.44
        case .failed, .cancelled:
            0.28
        }
    }
}

private struct StatusHaloRunningArc: View {
    var body: some View {
        Circle()
            .trim(from: 0.05, to: 0.28)
            .stroke(
                AngularGradient(
                    colors: [
                        CorptiePalette.connected.opacity(0),
                        CorptiePalette.connected.opacity(0.86),
                        CorptiePalette.connected.opacity(0)
                    ],
                    center: .center
                ),
                style: StrokeStyle(lineWidth: 3, lineCap: .round)
            )
            .blur(radius: 0.6)
            .padding(8)
    }
}
