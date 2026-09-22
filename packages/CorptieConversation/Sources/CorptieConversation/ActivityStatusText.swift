#if os(macOS)
import AppKit
public typealias ActivityPlatformView = NSView
private typealias ActivityFont = NSFont
private typealias ActivityColor = NSColor
#else
import UIKit
public typealias ActivityPlatformView = UIView
private typealias ActivityFont = UIFont
private typealias ActivityColor = UIColor
#endif
import QuartzCore
import SwiftUI

public struct ActivityStatusText {
    public init(text: String, isActive: Bool, fontSize: CGFloat = 9) {
        self.text = text
        self.isActive = isActive
        self.fontSize = fontSize
    }
    let text: String
    let isActive: Bool
    var fontSize: CGFloat = 9

    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    public static func fittedSize(
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

#if os(macOS)
extension ActivityStatusText: NSViewRepresentable {
    public func makeNSView(context: Context) -> ActivityStatusLayerView {
        let view = ActivityStatusLayerView()
        view.configure(
            text: text,
            isActive: isActive,
            fontSize: fontSize,
            reduceMotion: accessibilityReduceMotion
        )
        return view
    }

    public func updateNSView(_ nsView: ActivityStatusLayerView, context: Context) {
        nsView.configure(
            text: text,
            isActive: isActive,
            fontSize: fontSize,
            reduceMotion: accessibilityReduceMotion
        )
    }

    public func sizeThatFits(
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

}
#else
extension ActivityStatusText: UIViewRepresentable {
    public func makeUIView(context: Context) -> ActivityStatusLayerView {
        let view = ActivityStatusLayerView()
        view.configure(
            text: text,
            isActive: isActive,
            fontSize: fontSize,
            reduceMotion: accessibilityReduceMotion
        )
        return view
    }

    public func updateUIView(_ uiView: ActivityStatusLayerView, context: Context) {
        uiView.configure(
            text: text,
            isActive: isActive,
            fontSize: fontSize,
            reduceMotion: accessibilityReduceMotion
        )
    }

    public func sizeThatFits(
        _ proposal: ProposedViewSize,
        uiView: ActivityStatusLayerView,
        context: Context
    ) -> CGSize? {
        Self.fittedSize(
            proposedWidth: proposal.width,
            proposedHeight: proposal.height,
            intrinsicSize: uiView.intrinsicContentSize
        )
    }

}
#endif

public final class ActivityStatusLayerView: ActivityPlatformView {
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

#if os(macOS)
    private weak var observedWindow: NSWindow?
#endif

    public override init(frame frameRect: CGRect) {
        super.init(frame: frameRect)
        configureLayers()
    }

    public required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureLayers()
    }

#if os(macOS)
    public override var isFlipped: Bool {
        true
    }

    public override var intrinsicContentSize: NSSize {
        measuredSize
    }

    public override func layout() {
        super.layout()
        layoutLayers()
    }

    public override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeCurrentWindow()
        updatePlaybackState()
    }

    public override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateLayerContent()
    }

#else
    public override var intrinsicContentSize: CGSize { measuredSize }

    public override func layoutSubviews() {
        super.layoutSubviews()
        layoutLayers()
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        updateLayerContent()
        updatePlaybackState()
    }

#endif

    private var contentRootLayer: CALayer {
#if os(macOS)
        layer!
#else
        layer
#endif
    }

    public func configure(text: String, isActive: Bool, fontSize: CGFloat, reduceMotion: Bool) {
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
#if os(macOS)
        wantsLayer = true
        layer = CALayer()
#else
        isAccessibilityElement = true
        registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitDisplayScale.self]) {
            (view: ActivityStatusLayerView, _: UITraitCollection) in
            view.updateLayerContent()
        }
        for notification in [
            UIApplication.didBecomeActiveNotification, UIApplication.willResignActiveNotification,
            UIApplication.didEnterBackgroundNotification, UIScene.didActivateNotification,
            UIScene.willDeactivateNotification
        ] {
            NotificationCenter.default.addObserver(self, selector: #selector(windowVisibilityChanged(_:)),
                name: notification, object: nil)
        }
#endif
        contentRootLayer.masksToBounds = false

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
            ActivityColor.clear.cgColor,
            ActivityColor.white.withAlphaComponent(0.92).cgColor,
            ActivityColor.clear.cgColor
        ]
        shimmerGradientLayer.locations = [-0.3, -0.15, 0]
        shimmerGradientLayer.mask = shimmerTextMask

        contentRootLayer.addSublayer(baseGradientLayer)
        contentRootLayer.addSublayer(shimmerGradientLayer)
    }

    private func updateLayerContent() {
        let font = ActivityFont.systemFont(ofSize: fontSize, weight: .semibold)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: ActivityColor.white
        ]
        let attributedText = NSAttributedString(string: text, attributes: attributes)
        let rawSize = attributedText.size()
        measuredSize = CGSize(width: ceil(rawSize.width), height: ceil(rawSize.height))
        invalidateIntrinsicContentSize()

#if os(macOS)
        let scale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        setAccessibilityLabel(text)
#else
        let scale = window?.screen.scale ?? traitCollection.displayScale
        accessibilityLabel = text
#endif
        for textLayer in [baseTextMask, shimmerTextMask] {
            textLayer.string = attributedText
            textLayer.contentsScale = scale
        }

        if isActive {
            baseGradientLayer.colors = [
                ActivityColor.systemGreen.cgColor,
                ActivityColor.systemBlue.cgColor,
                ActivityColor.systemPurple.cgColor
            ]
        } else {
#if os(macOS)
            let color = ActivityColor.secondaryLabelColor
#else
            let color = ActivityColor.secondaryLabel.resolvedColor(with: traitCollection)
#endif
            baseGradientLayer.colors = [color.cgColor, color.cgColor]
        }
        shimmerGradientLayer.isHidden = !isActive || reduceMotion
#if os(macOS)
        needsLayout = true
#else
        setNeedsLayout()
#endif
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

#if os(macOS)
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
                selector: #selector(windowVisibilityChanged(_:)),
                name: notification,
                object: window
            )
        }
    }

#endif

    @objc private func windowVisibilityChanged(_ notification: Notification) {
#if !os(macOS)
        if let scene = notification.object as? UIScene, scene !== window?.windowScene { return }
        // "will" notifications arrive before UIKit changes application/scene state.
        if notification.name == UIApplication.willResignActiveNotification
            || notification.name == UIScene.willDeactivateNotification {
            setPlaybackState(shouldRun: false)
            return
        }
#endif
        updatePlaybackState()
    }

    private func updatePlaybackState() {
#if os(macOS)
        let shouldRun = isActive
            && !reduceMotion
            && window?.isVisible == true
            && window?.isMiniaturized == false
            && window?.occlusionState.contains(.visible) == true
#else
        let shouldRun = isActive && !reduceMotion && window != nil
            && window?.windowScene?.activationState == .foregroundActive
            && UIApplication.shared.applicationState == .active
#endif
        setPlaybackState(shouldRun: shouldRun)
    }

    private func setPlaybackState(shouldRun: Bool) {
        let layer = contentRootLayer
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
