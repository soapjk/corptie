import SwiftUI

/// Preserves the content subtree and its complete layout while replacing only paint.
public struct ConversationSkinSurface: ViewModifier {
    @Environment(\.conversationSkin) private var skin
    @Environment(\.colorSchemeContrast) private var contrast
    private let role: ConversationSurfaceRole
    private let radius: CGFloat
    private let legacyFill: Color
    private let legacyBorder: Color
    private let legacyBorderWidth: CGFloat

    public init(role: ConversationSurfaceRole, radius: CGFloat,
                legacyFill: Color = .clear, legacyBorder: Color = .clear,
                legacyBorderWidth: CGFloat = 1) {
        self.role = role; self.radius = radius
        self.legacyFill = legacyFill; self.legacyBorder = legacyBorder
        self.legacyBorderWidth = legacyBorderWidth
    }

    public func body(content: Content) -> some View {
        let style = skin.surface(for: role)
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content.background {
            if style == .legacy { shape.fill(legacyFill) }
            else if style == .bubble || style == .neutral { shape.fill(Color.primary.opacity(0.06)) }
        }.overlay {
            if style == .legacy {
                shape.strokeBorder(legacyBorder, lineWidth: legacyBorderWidth).allowsHitTesting(false)
            } else if style == .neutral || (style == .bubble && contrast == .increased) {
                shape.strokeBorder(Color.primary.opacity(contrast == .increased ? 0.45 : 0.10), lineWidth: 1)
                    .allowsHitTesting(false)
            }
        }
    }
}

public enum ConversationColumnRole: Sendable { case sidebar, transcript, inspector }

public struct ConversationColumnSurface: ViewModifier {
    @Environment(\.conversationSkin) private var skin
    private let role: ConversationColumnRole
    public init(_ role: ConversationColumnRole) { self.role = role }
    public func body(content: Content) -> some View {
        content.background {
            if skin == .codexFlat {
                WorkbenchCanvasSurface.defaultColor
                if role != .transcript { Color.primary.opacity(0.025) }
            }
        }
        .overlay(alignment: .leading) {
            if skin == .codexFlat && role == .inspector {
                Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 0.5)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
        }
    }
}
