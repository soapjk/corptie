import SwiftUI

/// Shared geometry for the Work outline and its controls on iPad and macOS.
public enum PlatformWorkOutlineLayout {
    public static let columnWidth: CGFloat = 312
    public static let controlSize: CGFloat = 44
    public static let controlSurfaceDiameter: CGFloat = 36
    public static let symbolSize: CGFloat = 16
    public static let controlSpacing: CGFloat = 8
    public static let horizontalInset: CGFloat = 12
    public static let verticalInset: CGFloat = 6
    public static let toolbarHeight = controlSize + verticalInset * 2
    public static let minimumToolbarWidth = controlSize * 5
        + controlSpacing * 4
        + horizontalInset * 2
}

/// One toolbar row whose controls align with the shared Work outline column.
public struct PlatformWorkOutlineToolbar<Leading: View, Trailing: View>: View {
    private let topInset: CGFloat
    private let bottomInset: CGFloat
    private let leading: Leading
    private let trailing: Trailing

    public init(
        topInset: CGFloat = PlatformWorkOutlineLayout.verticalInset,
        bottomInset: CGFloat = PlatformWorkOutlineLayout.verticalInset,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.topInset = topInset
        self.bottomInset = bottomInset
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: PlatformWorkOutlineLayout.controlSpacing) {
                leading
            }
            Spacer(minLength: PlatformWorkOutlineLayout.controlSpacing)
            trailing
        }
        .padding(.horizontal, PlatformWorkOutlineLayout.horizontalInset)
        .padding(.top, topInset)
        .padding(.bottom, bottomInset)
        .frame(maxWidth: .infinity)
    }
}

public struct PlatformWorkOutlineToolbarGlyph: View {
    private let symbol: String
    private let color: Color

    public init(symbol: String, color: Color = .primary) {
        self.symbol = symbol
        self.color = color
    }

    public var body: some View {
        Image(systemName: symbol)
            .font(.system(size: PlatformWorkOutlineLayout.symbolSize, weight: .medium))
            .foregroundStyle(color)
            .frame(
                width: PlatformWorkOutlineLayout.controlSurfaceDiameter,
                height: PlatformWorkOutlineLayout.controlSurfaceDiameter
            )
    }
}

private struct PlatformWorkOutlineToolbarControlModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .menuStyle(.borderlessButton)
            .buttonStyle(.plain)
            .frame(
                width: PlatformWorkOutlineLayout.controlSize,
                height: PlatformWorkOutlineLayout.controlSize
            )
            .background {
                Color.clear
                    .frame(
                        width: PlatformWorkOutlineLayout.controlSurfaceDiameter,
                        height: PlatformWorkOutlineLayout.controlSurfaceDiameter
                    )
                    .platformGlassSurface(in: Circle(), variant: .clear)
                    .allowsHitTesting(false)
            }
            .contentShape(Rectangle())
    }
}

public extension View {
    func platformWorkOutlineToolbarControl() -> some View {
        modifier(PlatformWorkOutlineToolbarControlModifier())
    }
}
