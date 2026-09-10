import SwiftUI

/// One visual contract for Task and Chat cards; actions remain with their owners.
struct ConsoleConversationCardLabel<Summary: View>: View {
    let title: String
    let execution: TaskStatus?
    let needsAttention: Bool
    let status: String
    let isSelected: Bool
    let isFixed: Bool
    let hasScheduledWake: Bool
    let isUnread: Bool
    let isActive: Bool
    @ViewBuilder let summary: Summary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Circle()
                    .fill(execution == .running ? CorptiePalette.running : execution == .failed ? Color.red :
                        (needsAttention || execution == .blocked) ? Color.orange : Color.secondary.opacity(0.65))
                    .frame(width: 7, height: 7)
                    .help(status).accessibilityLabel(status)
                ConsoleWorkTitle(title: title, isWorking: execution == .running, isActive: isActive)
                    .font(.system(size: 13, weight: .semibold)).lineLimit(2).help(title)
                if isFixed {
                    Image(systemName: "bookmark.fill")
                        .font(.system(size: 10, weight: .semibold)).foregroundStyle(Color.accentColor)
                        .help("已固定展示").accessibilityLabel("已固定展示")
                }
                if hasScheduledWake { ConsoleScheduledWakeIcon(isActive: isActive) }
                if isUnread { Circle().fill(.red).frame(width: 6, height: 6) }
            }
            summary
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(10)
        .background(isSelected ? Color.accentColor.opacity(0.12) : Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .strokeBorder(Color.accentColor.opacity(isSelected ? 0.85 : 0.22), lineWidth: isSelected ? 1.5 : 1)
            .allowsHitTesting(false))
        .contentShape(Rectangle())
    }
}
