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

public enum PlatformWorkOutlineToolbarDensity: Sendable {
    case regular
    case compact

    public var controlSize: CGFloat { self == .compact ? 36 : PlatformWorkOutlineLayout.controlSize }
    public var controlSurfaceDiameter: CGFloat { self == .compact ? 30 : PlatformWorkOutlineLayout.controlSurfaceDiameter }
    public var symbolSize: CGFloat { self == .compact ? 14 : PlatformWorkOutlineLayout.symbolSize }
    public var controlSpacing: CGFloat { self == .compact ? 5 : PlatformWorkOutlineLayout.controlSpacing }
    public var horizontalInset: CGFloat { self == .compact ? 10 : PlatformWorkOutlineLayout.horizontalInset }
    public var verticalInset: CGFloat { self == .compact ? 4 : PlatformWorkOutlineLayout.verticalInset }
}

private struct WorkOutlineToolbarDensityKey: EnvironmentKey {
    static let defaultValue: PlatformWorkOutlineToolbarDensity = .regular
}

private extension EnvironmentValues {
    var workOutlineToolbarDensity: PlatformWorkOutlineToolbarDensity {
        get { self[WorkOutlineToolbarDensityKey.self] }
        set { self[WorkOutlineToolbarDensityKey.self] = newValue }
    }
}

/// One toolbar row whose controls align with the shared Work outline column.
public struct PlatformWorkOutlineToolbar<Leading: View, Trailing: View>: View {
    private let density: PlatformWorkOutlineToolbarDensity
    private let topInset: CGFloat?
    private let bottomInset: CGFloat?
    private let leading: Leading
    private let trailing: Trailing

    public init(
        density: PlatformWorkOutlineToolbarDensity = .regular,
        topInset: CGFloat? = nil,
        bottomInset: CGFloat? = nil,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.density = density
        self.topInset = topInset
        self.bottomInset = bottomInset
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: density.controlSpacing) {
                leading
            }
            Spacer(minLength: density.controlSpacing)
            trailing
        }
        .padding(.horizontal, density.horizontalInset)
        .padding(.top, topInset ?? density.verticalInset)
        .padding(.bottom, bottomInset ?? density.verticalInset)
        .frame(maxWidth: .infinity)
        .environment(\.workOutlineToolbarDensity, density)
    }
}

public struct PlatformWorkOutlineToolbarGlyph: View {
    @Environment(\.workOutlineToolbarDensity) private var density
    private let symbol: String
    private let color: Color

    public init(symbol: String, color: Color = .primary) {
        self.symbol = symbol
        self.color = color
    }

    public var body: some View {
        Image(systemName: symbol)
            .font(.system(size: density.symbolSize, weight: .medium))
            .foregroundStyle(color)
            .frame(
                width: density.controlSurfaceDiameter,
                height: density.controlSurfaceDiameter
            )
    }
}

private struct PlatformWorkOutlineToolbarControlModifier: ViewModifier {
    @Environment(\.workOutlineToolbarDensity) private var density

    func body(content: Content) -> some View {
        content
            .menuStyle(.borderlessButton)
            .buttonStyle(.plain)
            .frame(
                width: density.controlSize,
                height: density.controlSize
            )
            .background {
                Color.clear
                    .frame(
                        width: density.controlSurfaceDiameter,
                        height: density.controlSurfaceDiameter
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
