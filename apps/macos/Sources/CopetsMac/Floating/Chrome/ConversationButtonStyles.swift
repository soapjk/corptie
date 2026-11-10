import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct IconButtonStyle: ButtonStyle {
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.primary)
            .background(
                isLiquidGlass
                    ? Color.white.opacity(configuration.isPressed ? 0.24 : 0.13)
                    : Color(nsColor: .controlBackgroundColor),
                in: Circle()
            )
            .overlay(
                Circle().strokeBorder(
                    isLiquidGlass
                        ? Color.white.opacity(0.16)
                        : Color(nsColor: .separatorColor).opacity(0.6),
                    lineWidth: 1
                )
            )
            .contentShape(Circle())
    }
}

struct JumpToLatestButtonStyle: ButtonStyle {
    let highlightsUnread: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            // Apple's base liquid-glass material: untinted and unframed. There
            // is no opaque plate or stroke around the circle, so the transcript
            // underneath shows through while the system handles the press state.
            .foregroundStyle(highlightsUnread ? Color.accentColor : Color.primary)
            .platformGlassSurface(in: Circle(), interactive: true)
            .contentShape(Circle())
            .opacity(configuration.isPressed ? 0.86 : 1)
    }
}
