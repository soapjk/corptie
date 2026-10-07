import SwiftUI

public enum PlatformGlassVariant: Sendable {
    case regular
    case clear
}

/// Functional glass is reserved for navigation and floating input chrome.
public struct ConversationFunctionalGlassSurface: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private let cornerRadius: CGFloat
    private let tint: Color?
    private let fallback: Color?

    public init(cornerRadius: CGFloat, tint: Color? = nil,
                fallback: Color? = nil) {
        self.cornerRadius = cornerRadius
        self.tint = tint
        self.fallback = fallback
    }

    public static func usesNativeGlass(supported: Bool, reduceTransparency: Bool) -> Bool {
        supported && !reduceTransparency
    }

    @ViewBuilder public func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        Group {
            if #available(iOS 26.0, macOS 26.0, *),
               Self.usesNativeGlass(supported: true, reduceTransparency: reduceTransparency) {
                content.platformGlassSurface(in: shape, tint: tint)
            } else {
                content.background {
                    shape.fill(fallback ?? WorkbenchCanvasSurface.defaultColor)
                    if fallback == nil, let tint { shape.fill(tint) }
                }
                    .overlay(shape.strokeBorder(Color.primary.opacity(0.10), lineWidth: 0.5)
                        .allowsHitTesting(false))
            }
        }
        .shadow(color: .black.opacity(0.06), radius: 4, y: 1.5)
    }
}

/// A compact, element-sized glass surface shared by the iPad and Mac chrome.
/// The material fallback stays local to each control, never to a whole bar.
public extension View {
    @ViewBuilder
    func platformGlassSurface<S: Shape>(
        in shape: S,
        tint: Color? = nil,
        interactive: Bool = false,
        fallbackUsesMaterial: Bool = true,
        variant: PlatformGlassVariant = .regular
    ) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            let glass: Glass = variant == .clear ? .clear : .regular
            if let tint {
                glassEffect(glass.tint(tint).interactive(interactive), in: shape)
            } else {
                glassEffect(glass.interactive(interactive), in: shape)
            }
        } else if fallbackUsesMaterial {
            background {
                shape.fill(.ultraThinMaterial)
                if let tint { shape.fill(tint.opacity(0.12)) }
            }
            .overlay {
                shape.stroke(Color.primary.opacity(0.10), lineWidth: 0.5)
                    .allowsHitTesting(false)
            }
        } else {
            background {
                shape.fill((tint ?? Color.primary).opacity(tint == nil ? 0.08 : 0.14))
            }
            .overlay {
                shape.stroke(Color.primary.opacity(0.08), lineWidth: 0.5)
                    .allowsHitTesting(false)
            }
        }
    }
}
