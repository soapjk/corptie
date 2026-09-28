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
    @Environment(\.isLiquidGlass) private var isLiquidGlass
    let highlightsUnread: Bool

    func makeBody(configuration: Configuration) -> some View {
        let neutralBackground = isLiquidGlass
            ? Color.white.opacity(configuration.isPressed ? 0.24 : 0.13)
            : Color(nsColor: .controlBackgroundColor)
        let background = highlightsUnread
            ? CorptiePalette.connected.opacity(configuration.isPressed ? 0.78 : 1)
            : neutralBackground
        let border = highlightsUnread
            ? CorptiePalette.connected.opacity(0.75)
            : (isLiquidGlass
                ? Color.white.opacity(0.16)
                : Color(nsColor: .separatorColor).opacity(0.6))

        configuration.label
            .foregroundStyle(highlightsUnread ? Color.white : Color.primary)
            .background(background, in: Circle())
            .overlay(Circle().strokeBorder(border, lineWidth: 1))
            .contentShape(Circle())
    }
}
