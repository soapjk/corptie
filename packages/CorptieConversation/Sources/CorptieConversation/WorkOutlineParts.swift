import CorptieClientCore
import SwiftUI

/// Leaf views of the Work outline shared verbatim by the macOS sidebar and the iPad
/// workbench. Hosts add tooltips, localization and context menus; the geometry,
/// colors and animation policy live here so both platforms stay pixel-identical.
public enum WorkOutlineMetrics {
    /// Child rows: `HStack(spacing: rowSpacing)` + vertical `rowPadding`.
    public static let rowSpacing: CGFloat = 9
    public static let rowPadding: CGFloat = 4
    public static let rowTitleFont = Font.system(size: 12, weight: .semibold)
    public static let headerTitleFont = Font.system(size: 11, weight: .semibold)
    public static let headerPadding: CGFloat = 3
    public static let headerIconSize: CGFloat = 22
    public static let disclosureChevronFont = Font.system(size: 9, weight: .semibold)
    public static let disclosureChevronSize = CGSize(width: 18, height: 24)
    public static let selectionCornerRadius: CGFloat = 5
    public static let selectionOpacity: Double = 0.09
    public static let selectionHorizontalInset: CGFloat = 8
    public static let unreadDotDiameter: CGFloat = 8
    /// Accent of the "Chat" group tile (independent Sessions).
    public static let chatGroupTint = Color(red: 0.36, green: 0.32, blue: 0.86)
}

/// Red 8pt dot placed at the trailing edge of headers and rows with unread agent output.
public struct UnreadSessionDot: View {
    private let label: String
    public init(label: String = "未读会话") { self.label = label }
    public var body: some View {
        Circle()
            .fill(Color.red)
            .frame(width: WorkOutlineMetrics.unreadDotDiameter, height: WorkOutlineMetrics.unreadDotDiameter)
            .accessibilityLabel(label)
    }
}

/// Child-row selection backdrop (`RoundedRectangle 5`, accent 9%) inset 8pt horizontally.
public struct WorkOutlineSelectionBackground: View {
    private let isSelected: Bool
    public init(isSelected: Bool) { self.isSelected = isSelected }
    public var body: some View {
        RoundedRectangle(cornerRadius: WorkOutlineMetrics.selectionCornerRadius, style: .continuous)
            .fill(isSelected ? Color.accentColor.opacity(WorkOutlineMetrics.selectionOpacity) : Color.clear)
            .padding(.horizontal, WorkOutlineMetrics.selectionHorizontalInset)
    }
}

/// Disclosure chevron of a group header (18×24, secondary, 9pt semibold).
public struct WorkOutlineDisclosureChevron: View {
    private let isExpanded: Bool
    public init(isExpanded: Bool) { self.isExpanded = isExpanded }
    public var body: some View {
        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
            .font(WorkOutlineMetrics.disclosureChevronFont)
            .foregroundStyle(.secondary)
            .frame(width: WorkOutlineMetrics.disclosureChevronSize.width,
                   height: WorkOutlineMetrics.disclosureChevronSize.height)
            .contentShape(Rectangle())
    }
}

/// Tile of the "Chat" group: white bubbles on the app-icon squircle, same footprint as a Work avatar.
public struct ChatGroupIcon: View {
    public init() {}
    public var body: some View {
        let edge = ObjectiveAvatarGeometry.displaySize(for: WorkOutlineMetrics.headerIconSize)
        Image(systemName: "bubble.left.and.bubble.right.fill")
            .font(.system(size: 10, weight: .regular))
            .foregroundStyle(.white)
            .frame(width: edge, height: edge)
            .background { MacOSAppIconShape().fill(WorkOutlineMetrics.chatGroupTint) }
            .frame(width: WorkOutlineMetrics.headerIconSize, height: WorkOutlineMetrics.headerIconSize)
            .accessibilityHidden(true)
    }
}

/// 7pt execution-state dot of an independent Session row (`TaskStatus.color` on macOS).
public struct SessionExecutionDot: View {
    private let state: SessionExecutionState?
    private let label: String
    @Environment(\.colorScheme) private var colorScheme

    public init(state: SessionExecutionState?, label: String? = nil) {
        self.state = state
        self.label = label ?? state?.label ?? ""
    }

    private var color: Color {
        switch state {
        case .running:
            return colorScheme == .dark
                ? Color(red: 0.62, green: 0.82, blue: 0.66)
                : Color(red: 0.08, green: 0.70, blue: 0.34)
        case .blocked, .complete: return .orange
        case .failed, .cancelled: return .red
        case nil: return .secondary
        }
    }

    public var body: some View {
        Circle().fill(color).frame(width: 7, height: 7).accessibilityLabel(label)
    }
}

/// Animated alarm glyph shown next to Tasks with a pending scheduled wake. The
/// TimelineView is paused whenever the row is off-screen or the scene is inactive,
/// and collapses to a static gradient under Reduce Motion.
public struct ScheduledWakeIcon: View {
    private let isActive: Bool
    private let label: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isVisible = false

    public init(isActive: Bool = true, label: String = "存在等待执行的计划任务") {
        self.isActive = isActive
        self.label = label
    }

    public var body: some View {
        Group {
            if reduceMotion {
                coloredIcon(progress: 0)
            } else {
                TimelineView(.animation(
                    minimumInterval: ConsoleWorkOutlineMetrics.workingGradientFrameInterval,
                    paused: !isVisible || !isActive
                )) { context in
                    coloredIcon(progress: ConsoleWorkFlowingGradientPolicy.progress(at: context.date))
                }
            }
        }
        .frame(width: 12, height: 12)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .accessibilityLabel(label)
    }

    private func coloredIcon(progress: CGFloat) -> some View {
        AngularGradient(
            colors: [.cyan, .blue, .purple, .pink, .orange, .cyan],
            center: .center,
            angle: .degrees(Double(progress) * 360)
        )
        .frame(width: 12, height: 12)
        .mask {
            Image(systemName: "alarm")
                .font(.system(size: 10, weight: .semibold))
                .frame(width: 12, height: 12)
        }
    }
}
