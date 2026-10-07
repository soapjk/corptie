import SwiftUI
import CorptieConversation

/// Mobile surfaces target the latest iOS/iPadOS and use native system APIs.
extension View {
    /// Apply to each page *inside* the compact workspace's NavigationStack.
    /// The wallpaper remains owned by PadAppShell, including during navigation.
    @ViewBuilder
    func padWorkspaceNavigationBackground() -> some View {
        #if os(iOS)
        containerBackground(.clear, for: .navigation)
        #else
        self
        #endif
    }

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
