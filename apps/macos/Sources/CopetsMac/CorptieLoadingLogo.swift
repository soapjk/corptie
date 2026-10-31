import AppKit
import CorptieConversation
import QuartzCore
import SwiftUI

/// Code-drawn, transparent startup mark. Only the two group transforms animate;
/// no timer or per-frame SwiftUI state updates are needed.
struct CorptieLoadingLogo: NSViewRepresentable {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeNSView(context: Context) -> CorptieLoadingLogoView {
        let view = CorptieLoadingLogoView()
        view.configure(reduceMotion: reduceMotion)
        return view
    }

    func updateNSView(_ view: CorptieLoadingLogoView, context: Context) {
        view.configure(reduceMotion: reduceMotion)
    }

    static func dismantleNSView(_ view: CorptieLoadingLogoView, coordinator: ()) {
        view.stopAnimations()
    }
}

final class CorptieLoadingLogoView: NSView {
    private let artwork = CorptieLogoArtworkLayer()
    private var reduceMotion = false

    override var isFlipped: Bool { true }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer = CALayer()
        layer?.isGeometryFlipped = true
        layer?.addSublayer(artwork)
        updateColors()
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("Corptie")
    }

    required init?(coder: NSCoder) { nil }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        artwork.position = CGPoint(x: bounds.midX, y: bounds.midY)
        let scale = min(bounds.width, bounds.height) / CorptieLogoArtworkLayer.designSize
        artwork.setAffineTransform(CGAffineTransform(scaleX: scale, y: scale))
        CATransaction.commit()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self)
        if let window {
            for name in [NSWindow.didChangeOcclusionStateNotification,
                         NSWindow.didMiniaturizeNotification,
                         NSWindow.didDeminiaturizeNotification] {
                NotificationCenter.default.addObserver(self, selector: #selector(updatePlayback),
                                                       name: name, object: window)
            }
        }
        updatePlayback()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateColors()
    }

    deinit { NotificationCenter.default.removeObserver(self) }

    func configure(reduceMotion: Bool) {
        self.reduceMotion = reduceMotion
        updatePlayback()
    }

    func stopAnimations() {
        artwork.setAnimating(false)
    }

    @objc private func updatePlayback() {
        guard !reduceMotion, window?.isVisible == true,
              window?.isMiniaturized == false,
              window?.occlusionState.contains(.visible) == true else {
            stopAnimations()
            return
        }
        artwork.setAnimating(true)
    }

    private func updateColors() {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let neutral = isDark
            ? NSColor(srgbRed: 250/255, green: 243/255, blue: 231/255, alpha: 1)
            : NSColor(srgbRed: 16/255, green: 39/255, blue: 71/255, alpha: 1)
        artwork.setNeutralColor(neutral.cgColor)
    }
}
