import SwiftUI

extension View {
    func detailRailSectionLabelStyle() -> some View {
        font(.system(size: 10, weight: .semibold))
            .foregroundStyle(.tertiary)
    }

    func detailRailReferenceRowStyle() -> some View {
        padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                Color.primary.opacity(0.035),
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
    }
}
