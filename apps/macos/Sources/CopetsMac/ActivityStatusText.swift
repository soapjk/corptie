import AppKit
import QuartzCore
import SwiftUI

struct ActivityStatusText: NSViewRepresentable {
    let text: String
    let isActive: Bool
    var fontSize: CGFloat = 9

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    func makeNSView(context: Context) -> ActivityStatusLayerView {
        let view = ActivityStatusLayerView()
        view.configure(
            text: text,
            isActive: isActive,
            fontSize: fontSize,
            reduceMotion: accessibilityReduceMotion
        )
        return view
    }

    func updateNSView(_ nsView: ActivityStatusLayerView, context: Context) {
        nsView.configure(
            text: text,
            isActive: isActive,
            fontSize: fontSize,
            reduceMotion: accessibilityReduceMotion
        )
    }

    func sizeThatFits(
        _ proposal: ProposedViewSize,
        nsView: ActivityStatusLayerView,
        context: Context
    ) -> CGSize? {
        Self.fittedSize(
            proposedWidth: proposal.width,
            proposedHeight: proposal.height,
            intrinsicSize: nsView.intrinsicContentSize
        )
    }

    static func fittedSize(
        proposedWidth: CGFloat?,
        proposedHeight: CGFloat?,
        intrinsicSize: CGSize
    ) -> CGSize {
        let finiteWidth = proposedWidth.flatMap { $0.isFinite ? $0 : nil }
        let finiteHeight = proposedHeight.flatMap { $0.isFinite ? $0 : nil }
        return CGSize(
            width: max(0, min(finiteWidth ?? intrinsicSize.width, intrinsicSize.width)),
            height: max(0, min(finiteHeight ?? intrinsicSize.height, intrinsicSize.height))
        )
    }
}

final class ActivityStatusLayerView: NSView {
    private enum AnimationKey {
        static let shimmer = "corptie.activity-status.shimmer"
    }

    private let baseGradientLayer = CAGradientLayer()
    private let shimmerGradientLayer = CAGradientLayer()
    private let baseTextMask = CATextLayer()
    private let shimmerTextMask = CATextLayer()

    private var text = ""
    private var isActive = false
    private var fontSize: CGFloat = 9
    private var reduceMotion = false
    private var measuredSize = CGSize.zero
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

    override var intrinsicContentSize: NSSize {
        measuredSize
    }

    override func layout() {
        super.layout()
        layoutLayers()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeCurrentWindow()
        updatePlaybackState()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateLayerContent()
    }

    func configure(text: String, isActive: Bool, fontSize: CGFloat, reduceMotion: Bool) {
        let contentChanged = self.text != text || self.fontSize != fontSize || self.isActive != isActive
        let animationChanged = self.isActive != isActive || self.reduceMotion != reduceMotion
        self.text = text
        self.isActive = isActive
        self.fontSize = fontSize
        self.reduceMotion = reduceMotion

        if contentChanged {
            updateLayerContent()
        }
        if animationChanged {
            refreshAnimation()
        }
        updatePlaybackState()
    }

    private func configureLayers() {
        setContentHuggingPriority(.required, for: .horizontal)
        setContentHuggingPriority(.required, for: .vertical)
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .vertical)
        wantsLayer = true
        layer = CALayer()
        layer?.masksToBounds = false

        for textLayer in [baseTextMask, shimmerTextMask] {
            textLayer.alignmentMode = .left
            textLayer.truncationMode = .end
            textLayer.contentsGravity = .center
            textLayer.isWrapped = false
        }

        baseGradientLayer.startPoint = CGPoint(x: 0, y: 0.5)
        baseGradientLayer.endPoint = CGPoint(x: 1, y: 0.5)
        baseGradientLayer.masksToBounds = true
        baseGradientLayer.mask = baseTextMask

        shimmerGradientLayer.startPoint = CGPoint(x: 0, y: 0.5)
        shimmerGradientLayer.endPoint = CGPoint(x: 1, y: 0.5)
        shimmerGradientLayer.masksToBounds = true
        shimmerGradientLayer.colors = [
            NSColor.clear.cgColor,
            NSColor.white.withAlphaComponent(0.92).cgColor,
            NSColor.clear.cgColor
        ]
        shimmerGradientLayer.locations = [-0.3, -0.15, 0]
        shimmerGradientLayer.mask = shimmerTextMask

        layer?.addSublayer(baseGradientLayer)
        layer?.addSublayer(shimmerGradientLayer)
    }

    private func updateLayerContent() {
        let font = NSFont.systemFont(ofSize: fontSize, weight: .semibold)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: NSColor.white
        ]
        let attributedText = NSAttributedString(string: text, attributes: attributes)
        let rawSize = attributedText.size()
        measuredSize = CGSize(width: ceil(rawSize.width), height: ceil(rawSize.height))
        invalidateIntrinsicContentSize()

        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        for textLayer in [baseTextMask, shimmerTextMask] {
            textLayer.string = attributedText
            textLayer.contentsScale = scale
        }

        if isActive {
            baseGradientLayer.colors = [
                NSColor.systemGreen.cgColor,
                NSColor.systemBlue.cgColor,
                NSColor.systemPurple.cgColor
            ]
        } else {
            let color = NSColor.secondaryLabelColor
            baseGradientLayer.colors = [color.cgColor, color.cgColor]
        }
        shimmerGradientLayer.isHidden = !isActive || reduceMotion
        needsLayout = true
    }

    private func layoutLayers() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        for contentLayer in [baseGradientLayer, shimmerGradientLayer] {
            contentLayer.frame = bounds
            contentLayer.mask?.frame = bounds
        }
        CATransaction.commit()
    }

    private func refreshAnimation() {
        shimmerGradientLayer.removeAnimation(forKey: AnimationKey.shimmer)
        shimmerGradientLayer.isHidden = !isActive || reduceMotion
        guard isActive, !reduceMotion else {
            return
        }

        let animation = CABasicAnimation(keyPath: "locations")
        animation.fromValue = [-0.3, -0.15, 0]
        animation.toValue = [1, 1.15, 1.3]
        animation.duration = 1.45
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(name: .linear)
        animation.isRemovedOnCompletion = false
        shimmerGradientLayer.add(animation, forKey: AnimationKey.shimmer)
    }

    private func observeCurrentWindow() {
        if let observedWindow {
            NotificationCenter.default.removeObserver(self, name: nil, object: observedWindow)
        }
        observedWindow = window
        guard let window else {
            return
        }
        for notification in [
            NSWindow.didChangeOcclusionStateNotification,
            NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification
        ] {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(windowVisibilityChanged),
                name: notification,
                object: window
            )
        }
    }

    @objc private func windowVisibilityChanged() {
        updatePlaybackState()
    }

    private func updatePlaybackState() {
        guard let layer else {
            return
        }
        let shouldRun = isActive
            && !reduceMotion
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

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
}
