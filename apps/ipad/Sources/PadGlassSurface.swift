import SwiftUI
import CorptieConversation

/// Uses Apple's native Liquid Glass where available and keeps the iOS 17–25
/// fallback local to the element instead of introducing a shared toolbar surface.
extension View {
    @ViewBuilder
    func padGlassSurface<S: Shape>(
        in shape: S,
        tint: Color? = nil,
        interactive: Bool = false,
        fallbackUsesMaterial: Bool = true,
        variant: PlatformGlassVariant = .regular
    ) -> some View {
        platformGlassSurface(in: shape, tint: tint, interactive: interactive,
                             fallbackUsesMaterial: fallbackUsesMaterial, variant: variant)
    }
}
