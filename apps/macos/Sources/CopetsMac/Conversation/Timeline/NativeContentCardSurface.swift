import AppKit
import CorptieConversation

/// Plain translucent color; no per-card backdrop or blur compositor.
@MainActor
final class NativeContentCardSurface: NSView {
    private let tintView = NSView()
    private var tint: NSColor = .clear
    private var tintOpacity: CGFloat = CGFloat(ConversationContentSurfacePolicy.tintOpacity)
    private var radius: CGFloat = 14
    private var isMessage = true
    private static let surfaces = NSHashTable<NativeContentCardSurface>.weakObjects()
    private static let accessibilityObserver: NSObjectProtocol = NSWorkspace.shared.notificationCenter.addObserver(
        forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main
    ) { _ in
        MainActor.assumeIsolated {
            for surface in surfaces.allObjects { surface.refreshAppearance() }
        }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        tintView.frame = bounds
        tintView.autoresizingMask = [.width, .height]
        tintView.wantsLayer = true
        addSubview(tintView)
        Self.surfaces.add(self)
        _ = Self.accessibilityObserver
        refreshAppearance()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(tint: NSColor, opacity: CGFloat = CGFloat(ConversationContentSurfacePolicy.tintOpacity), radius: CGFloat = 14, isMessage: Bool = true) {
        // Rebound timeline rows commonly retain the same semantic style.
        // Appearance and accessibility changes have their own refresh path.
        guard !self.tint.isEqual(tint) || tintOpacity != opacity || self.radius != radius || self.isMessage != isMessage else { return }
        self.tint = tint
        tintOpacity = opacity
        self.radius = radius
        self.isMessage = isMessage
        refreshAppearance()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        refreshAppearance()
    }

    func refreshAppearance(reduceTransparency: Bool? = nil, increasedContrast: Bool? = nil) {
        let opaque = reduceTransparency ?? NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
        let contrast = increasedContrast ?? NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let opacity = ConversationContentSurfacePolicy.backgroundOpacity(dark: dark,
                reduceTransparency: opaque, increasedContrast: contrast, isMessage: isMessage)
            let semantic = tintOpacity == CGFloat(ConversationContentSurfacePolicy.tintOpacity)
            let base = semantic ? tint : NSColor.textBackgroundColor
            layer?.backgroundColor = base.withAlphaComponent(opacity).cgColor
            tintView.isHidden = semantic
            tintView.layer?.backgroundColor = tint.withAlphaComponent(tintOpacity).cgColor
            layer?.borderColor = NSColor.separatorColor.cgColor
            layer?.borderWidth = contrast ? 1 : 0.5
            layer?.shadowOpacity = 0
            tintView.layer?.cornerRadius = radius
            tintView.layer?.masksToBounds = true
            layer?.cornerRadius = radius
        }
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let hit = super.hitTest(point)
        return hit === tintView ? self : hit
    }
}
