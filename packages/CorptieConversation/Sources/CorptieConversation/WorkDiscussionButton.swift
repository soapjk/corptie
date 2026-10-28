import SwiftUI

/// Shared Work-outline entry. Platform hosts choose hit area and navigation action.
public struct WorkDiscussionButton: View {
    let isSelected: Bool
    let isRunning: Bool
    let isActive: Bool
    let hasUnread: Bool
    let title: String
    let accessibilityTitle: String
    let accessibilityState: String
    let action: () -> Void
    let minimumHitHeight: CGFloat
    @State private var isHovering = false

    public init(isSelected: Bool, isRunning: Bool, isActive: Bool = true,
                hasUnread: Bool = false, title: String = "讨论",
                accessibilityTitle: String = "打开 Work 讨论", accessibilityState: String = "",
                minimumHitHeight: CGFloat = 22, action: @escaping () -> Void) {
        self.isSelected = isSelected
        self.isRunning = isRunning
        self.isActive = isActive
        self.hasUnread = hasUnread
        self.title = title
        self.accessibilityTitle = accessibilityTitle
        self.accessibilityState = accessibilityState
        self.action = action
        self.minimumHitHeight = minimumHitHeight
    }

    public var body: some View {
        Button(action: action) {
            WorkDiscussionLabel(isSelected: isSelected, isRunning: isRunning, isActive: isActive,
                hasUnread: hasUnread, title: title, minimumHitHeight: minimumHitHeight, isHovering: isHovering)
        }
        .buttonStyle(.plain)
        .fixedSize()
        .onHover { isHovering = $0 }
        .accessibilityLabel(accessibilityTitle)
        .accessibilityValue(accessibilityState)
        .help(accessibilityTitle)
    }
}

/// The same compact badge for a direct discussion button and an overflow Menu.
/// Larger touch targets surround the badge without increasing its visual size.
public struct WorkDiscussionLabel: View {
    private let isSelected: Bool
    private let isRunning: Bool
    private let isActive: Bool
    private let hasUnread: Bool
    private let title: String
    private let minimumHitHeight: CGFloat
    private let isHovering: Bool
    public init(isSelected: Bool, isRunning: Bool, isActive: Bool = true, hasUnread: Bool = false,
                title: String = "讨论", minimumHitHeight: CGFloat = 22, isHovering: Bool = false) {
        self.isSelected = isSelected; self.isRunning = isRunning; self.isActive = isActive
        self.hasUnread = hasUnread; self.title = title
        self.minimumHitHeight = minimumHitHeight; self.isHovering = isHovering
    }
    public var body: some View {
        Label {
            Text(title).font(.system(size: 10, weight: .medium))
        } icon: {
            Image(systemName: "bubble.left.fill").font(.system(size: 9, weight: .semibold))
        }
        .labelStyle(.titleAndIcon)
        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
        .padding(.horizontal, 7)
        .frame(height: 22)
        .background {
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.13)
                    : Color.secondary.opacity(isHovering ? 0.13 : 0.07))
        }
        .overlay(alignment: .topTrailing) {
            if hasUnread {
                Circle().fill(Color.red).frame(width: 6, height: 6).offset(x: 1, y: -1)
            }
        }
        .overlay { ConsoleDiscussionActivityBorder(isRunning: isRunning, isActive: isActive) }
        .frame(minWidth: minimumHitHeight >= 44 ? 44 : nil, minHeight: minimumHitHeight)
        .contentShape(Rectangle())
    }
}

public struct WorkGroupCardSurface: ViewModifier {
    public init() {}
    public func body(content: Content) -> some View {
        content.padding(.horizontal, 6).padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(ConversationContentSurface(cornerRadius: 8, isPanel: true, role: .project))
    }
}
