import AppKit
import QuartzCore
import CorptieClientCore

/// Paint-only decoration. Its frame never participates in row measurement.
@MainActor
final class NativeMessageStatusGlow: NSView {
    static let pulseKey = "message.status.pulse"
    private var status: UserMessageStatusPresentation?
    private var pathSize: CGSize = .zero
    private(set) var pathUpdateCount = 0
    private static let instances = NSHashTable<NativeMessageStatusGlow>.weakObjects()
    private static let observers: [NSObjectProtocol] = {
        let center = NotificationCenter.default
        var tokens = [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
                      NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
                      NSWindow.didMiniaturizeNotification, NSWindow.didDeminiaturizeNotification].map { name in
            center.addObserver(forName: name, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { for view in instances.allObjects { view.refreshAnimation() } }
            }
        }
        tokens.append(center.addObserver(forName: NSView.boundsDidChangeNotification, object: nil, queue: .main) { note in
            guard let clip = note.object as? NSClipView else { return }
            MainActor.assumeIsolated {
                for view in instances.allObjects where view.enclosingScrollView?.contentView === clip {
                    view.refreshAnimation()
                }
            }
        })
        tokens.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
        ) { _ in
            MainActor.assumeIsolated { for view in instances.allObjects { view.refreshAnimation() } }
        })
        return tokens
    }()

    override init(frame: NSRect) {
        super.init(frame: frame)
        identifier = .init("chat.timeline.message-glow")
        wantsLayer = true
        clipsToBounds = false
        layer?.masksToBounds = false
        layer?.shadowRadius = 4
        layer?.shadowOffset = .zero
        _ = Self.observers
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { false }

    func configure(_ status: UserMessageStatusPresentation) {
        guard self.status != status else { return }
        self.status = status
        if status.lightPulses { Self.instances.add(self) }
        else { Self.instances.remove(self) }
        refreshColor()
        refreshAnimation()
    }

    override func layout() {
        super.layout()
        guard bounds.size != pathSize else { return }
        pathSize = bounds.size
        pathUpdateCount += 1
        CATransaction.begin(); CATransaction.setDisableActions(true)
        // Explicit geometry, rather than the alpha of text/images, determines
        // the rounded halo. It extends outside this view without a mask.
        layer?.shadowPath = CGPath(roundedRect: bounds, cornerWidth: 14, cornerHeight: 14, transform: nil)
        CATransaction.commit()
    }

    override func viewDidMoveToWindow() { super.viewDidMoveToWindow(); allowRowOverflow(); refreshAnimation() }
    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        allowRowOverflow()
    }

    func allowRowOverflow() {
        // Preserve the scroll viewport's clipping; only the reusable row is paint-transparent.
        var ancestor = superview
        while let view = ancestor, !(view is NSClipView) {
            if view is NSTableRowView {
                view.clipsToBounds = false
                view.layer?.masksToBounds = false
                break
            }
            ancestor = view.superview
        }
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); refreshColor() }

    private func refreshColor() {
        let color: NSColor = switch status?.light {
        case .blue: .systemBlue
        case .purple: .systemPurple
        case .orange: .systemOrange
        case .green: .systemGreen
        case .red: .systemRed
        default: .clear
        }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            CATransaction.begin(); CATransaction.setDisableActions(true)
            layer?.shadowColor = color.cgColor
            CATransaction.commit()
        }
    }

    private func refreshAnimation() {
        updateAnimation(isVisible: window != nil && !isHiddenOrHasHiddenAncestor && !visibleRect.isEmpty,
                        reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
                        appActive: NSApp.isActive && window?.isKeyWindow == true)
    }

    func updateAnimation(isVisible: Bool, reduceMotion: Bool, appActive: Bool) {
        guard let layer else { return }
        let running = isVisible && !reduceMotion && appActive && status?.lightPulses == true
        let opacity: Float = status?.light == .off || status == nil ? 0 : 0.65
        CATransaction.begin(); CATransaction.setDisableActions(true)
        if layer.shadowOpacity != opacity { layer.shadowOpacity = opacity }
        CATransaction.commit()
        if running {
            guard layer.animation(forKey: Self.pulseKey) == nil else { return }
            let animation = CABasicAnimation(keyPath: "shadowOpacity")
            animation.fromValue = 0.25
            animation.toValue = 0.85
            animation.duration = 1.2
            animation.autoreverses = true
            animation.repeatCount = .infinity
            animation.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            layer.add(animation, forKey: Self.pulseKey)
        } else { layer.removeAnimation(forKey: Self.pulseKey) }
    }
}
