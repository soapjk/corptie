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

/// A column's canvas extends behind window chrome without moving its content.
public struct ConversationColumnBackground: View {
    @Environment(\.conversationSkin) private var skin
    private let role: ConversationColumnRole
    public init(_ role: ConversationColumnRole) { self.role = role }
    public var body: some View {
        ZStack {
            // The window owns the wallpaper and its default canvas. Columns
            // only tint that shared canvas instead of covering it with a fill.
            if skin == .codexFlat && role != .transcript {
                Color.primary.opacity(0.025)
            }
        }
        .ignoresSafeArea(.container, edges: .vertical)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

public struct ConversationColumnSurface: ViewModifier {
    private let role: ConversationColumnRole
    public init(_ role: ConversationColumnRole) { self.role = role }
    public func body(content: Content) -> some View {
        content.background { ConversationColumnBackground(role) }
    }
}
