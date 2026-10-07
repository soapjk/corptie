import SwiftUI

/// Platform-neutral content styling. Text opacity, layout and interaction are
/// deliberately untouched; only the background gets translucent color.
public enum ConversationContentSurfacePolicy {
    public static let tintOpacity = 0.18
    public static let messageMaterialOpacity = 0.80

    public static func usesMessageMaterial(isMessage: Bool, reduceTransparency: Bool, increasedContrast: Bool) -> Bool {
        isMessage && !reduceTransparency && !increasedContrast
    }

    public static func backgroundOpacity(dark: Bool, reduceTransparency: Bool, increasedContrast: Bool, isMessage: Bool = false, withMaterial: Bool = false) -> Double {
        if reduceTransparency { return 1 }
        if increasedContrast { return 0.85 }
        if isMessage { return withMaterial ? (dark ? 0.65 : 0.55) : (dark ? 0.80 : 0.75) }
        return dark ? 0.28 : 0.18
    }

    public static func borderWidth(increasedContrast: Bool) -> CGFloat {
        increasedContrast ? 1 : 0.5
    }
}

public struct ConversationContentSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.colorScheme) private var colorScheme
    private let cornerRadius: CGFloat
    private let tint: Color?
    private let fallback: Color?
    private let tintOpacity: Double
    private let isMessage: Bool

    public init(cornerRadius: CGFloat, tint: Color? = nil, fallback: Color? = nil,
                tintOpacity: Double = ConversationContentSurfacePolicy.tintOpacity, isMessage: Bool = false) {
        self.cornerRadius = cornerRadius
        self.tint = tint
        self.fallback = fallback
        self.tintOpacity = tintOpacity
        self.isMessage = isMessage
    }

    public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        let increasedContrast = contrast == .increased
        #if os(iOS)
        let withMaterial = ConversationContentSurfacePolicy.usesMessageMaterial(isMessage: isMessage,
            reduceTransparency: reduceTransparency, increasedContrast: increasedContrast)
        #else
        let withMaterial = false
        #endif
        let opacity = ConversationContentSurfacePolicy.backgroundOpacity(dark: colorScheme == .dark,
            reduceTransparency: reduceTransparency, increasedContrast: increasedContrast, isMessage: isMessage, withMaterial: withMaterial)
        let usesSemanticBackground = tintOpacity == ConversationContentSurfacePolicy.tintOpacity
        let base = fallback ?? (usesSemanticBackground ? tint : nil) ?? WorkbenchCanvasSurface.defaultColor
        content.background {
            #if os(iOS)
            if withMaterial {
                shape.fill(.regularMaterial.opacity(ConversationContentSurfacePolicy.messageMaterialOpacity))
            }
            #endif
            shape.fill(base.opacity(opacity))
            if !usesSemanticBackground, let tint {
                shape.fill(tint.opacity(tintOpacity))
            }
        }
        .overlay {
            shape.strokeBorder(Color.primary.opacity(increasedContrast ? 0.40 : 0.10),
                lineWidth: ConversationContentSurfacePolicy.borderWidth(increasedContrast: increasedContrast))
                .allowsHitTesting(false)
        }
    }
}
