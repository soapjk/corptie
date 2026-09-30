import SwiftUI

/// A compact, element-sized glass surface shared by the iPad and Mac chrome.
/// The material fallback stays local to each control, never to a whole bar.
public extension View {
    @ViewBuilder
    func platformGlassSurface<S: Shape>(
        in shape: S,
        tint: Color? = nil,
        interactive: Bool = false,
        fallbackUsesMaterial: Bool = true
    ) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            if let tint {
                glassEffect(.regular.tint(tint).interactive(interactive), in: shape)
            } else {
                glassEffect(.regular.interactive(interactive), in: shape)
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
