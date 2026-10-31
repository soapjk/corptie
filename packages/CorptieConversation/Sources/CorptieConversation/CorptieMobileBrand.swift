#if canImport(UIKit)
import SwiftUI
import UIKit
import QuartzCore

public struct CorptieBrandLogo: UIViewRepresentable {
    private let animated: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    public init(animated: Bool = false) { self.animated = animated }

    public func makeUIView(context: Context) -> CorptieBrandLogoView {
        let view = CorptieBrandLogoView()
        updateUIView(view, context: context)
        return view
    }

    public func updateUIView(_ view: CorptieBrandLogoView, context: Context) {
        view.configure(animated: animated && !reduceMotion && scenePhase == .active,
                       isDark: colorScheme == .dark)
    }

    public static func dismantleUIView(_ view: CorptieBrandLogoView, coordinator: ()) {
        view.configure(animated: false, isDark: view.traitCollection.userInterfaceStyle == .dark)
    }
}

public final class CorptieBrandLogoView: UIView {
    private let artwork = CorptieLogoArtworkLayer()
    private var animated = false

    public override init(frame: CGRect) {
        super.init(frame: frame)
        isOpaque = false
        isUserInteractionEnabled = false
        layer.addSublayer(artwork)
    }

    public required init?(coder: NSCoder) { nil }

    public override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        artwork.position = CGPoint(x: bounds.midX, y: bounds.midY)
        let scale = min(bounds.width, bounds.height) / CorptieLogoArtworkLayer.designSize
        artwork.setAffineTransform(CGAffineTransform(scaleX: scale, y: scale))
        CATransaction.commit()
    }

    public override func didMoveToWindow() {
        super.didMoveToWindow()
        artwork.setAnimating(animated && window != nil)
    }

    public func configure(animated: Bool, isDark: Bool) {
        self.animated = animated
        artwork.setNeutralColor(isDark
            ? CGColor(red: 250/255, green: 243/255, blue: 231/255, alpha: 1)
            : CGColor(red: 16/255, green: 39/255, blue: 71/255, alpha: 1))
        artwork.setAnimating(animated && window != nil)
    }
}

/// Use for primary loading surfaces; ordinary row/button spinners stay compact.
public struct CorptieBrandProgress: View {
    private let title: String
    private let prominent: Bool

    public init(_ title: String, prominent: Bool = false) {
        self.title = title
        self.prominent = prominent
    }

    public var body: some View {
        Group {
            if prominent {
                VStack(spacing: 20) {
                    logo.frame(width: 112, height: 112)
                    Text(title).multilineTextAlignment(.center)
                }
            } else {
                HStack(spacing: 10) {
                    logo.frame(width: 28, height: 28)
                    Text(title)
                }
            }
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }

    private var logo: some View {
        CorptieBrandLogo(animated: true).accessibilityHidden(true)
    }
}
#endif
