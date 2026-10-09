import SwiftUI

/// Platform-neutral content styling. Text opacity, layout and interaction are
/// deliberately untouched; only the background gets translucent color.
public enum ConversationContentSurfacePolicy {
    // Diagnostic A/B only: fixed before launch, never toggled while scrolling.
    // Keep the same tint layer so the comparison isolates message material.
    static let suppressMessageMaterialForProfiling: Bool = {
        #if DEBUG && os(iOS)
        ProcessInfo.processInfo.environment["CORPTIE_PROFILE_MESSAGE_MATERIAL"] == "0"
        #else
        false
        #endif
    }()
    public static let tintOpacity = 0.18
    public static let messageMaterialOpacity = 0.80
    public static let panelMaterialOpacity = 0.60

    public static func usesPanelMaterial(isPanel: Bool, reduceTransparency: Bool, increasedContrast: Bool) -> Bool {
        isPanel && !reduceTransparency && !increasedContrast
    }

    public static func usesMessageMaterial(isMessage: Bool, reduceTransparency: Bool, increasedContrast: Bool) -> Bool {
        isMessage && !reduceTransparency && !increasedContrast
    }

    public static func backgroundOpacity(dark: Bool, reduceTransparency: Bool, increasedContrast: Bool, isMessage: Bool = false, withMaterial: Bool = false, isPanel: Bool = false) -> Double {
        if reduceTransparency { return 1 }
        if increasedContrast { return 0.85 }
        if isMessage { return withMaterial ? (dark ? 0.65 : 0.55) : (dark ? 0.80 : 0.75) }
        if isPanel { return dark ? 0.42 : 0.32 }
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
    private let isPanel: Bool

    public init(cornerRadius: CGFloat, tint: Color? = nil, fallback: Color? = nil,
                tintOpacity: Double = ConversationContentSurfacePolicy.tintOpacity, isMessage: Bool = false, isPanel: Bool = false) {
        self.cornerRadius = cornerRadius
        self.tint = tint
        self.fallback = fallback
        self.tintOpacity = tintOpacity
        self.isMessage = isMessage
        self.isPanel = isPanel
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
        let withPanelMaterial = ConversationContentSurfacePolicy.usesPanelMaterial(isPanel: isPanel && !isMessage,
            reduceTransparency: reduceTransparency, increasedContrast: increasedContrast)
        let opacity = ConversationContentSurfacePolicy.backgroundOpacity(dark: colorScheme == .dark,
            reduceTransparency: reduceTransparency, increasedContrast: increasedContrast, isMessage: isMessage, withMaterial: withMaterial, isPanel: isPanel)
        let usesSemanticBackground = tintOpacity == ConversationContentSurfacePolicy.tintOpacity
        let base = fallback ?? (usesSemanticBackground ? tint : nil) ?? WorkbenchCanvasSurface.defaultColor
        content.background {
            #if os(iOS)
            if withMaterial && !ConversationContentSurfacePolicy.suppressMessageMaterialForProfiling {
                shape.fill(.regularMaterial.opacity(ConversationContentSurfacePolicy.messageMaterialOpacity))
            }
            #endif
            if withPanelMaterial {
                shape.fill(.thinMaterial.opacity(ConversationContentSurfacePolicy.panelMaterialOpacity))
            }
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
