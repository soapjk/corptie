import SwiftUI
import CorptieConversation

/// Renders the workspace rail; selection and sheet ownership remain in the console.
struct ConsoleWorkRail: View {
    let works: [Work]
    let sessions: [TaskSession]
    let selectedWorkId: String?
    let selectAssistantSpace: () -> Void
    let selectWorkSpace: (String) -> Void
    let editWork: (Work) -> Void
    let deleteWork: (Work) -> Void

    var body: some View {
        let unreadSummary = WorkRailUnreadSummary(
            sessions: sessions
        )
        return VStack(spacing: 8) {
            Button {
                selectAssistantSpace()
            } label: {
                consoleRailIcon(
                    systemImage: "sparkles",
                    label: L10n("Assistant"),
                    isSelected: selectedWorkId == nil,
                    hasUnread: unreadSummary.hasUnreadAssistantSessions
                )
            }
            .buttonStyle(.plain)

            Divider()
                .padding(.horizontal, 10)

            ScrollViewReader { scrollProxy in
                ScrollView(.vertical) {
                    LazyVStack(spacing: 8) {
                        ForEach(works) { work in
                            Button {
                                selectWorkSpace(work.id)
                            } label: {
                                consoleRailIcon(
                                    text: workInitials(work.name),
                                    avatarPath: work.avatarPath,
                                    objectiveID: work.id,
                                    label: work.name,
                                    isSelected: selectedWorkId == work.id,
                                    hasUnread: unreadSummary.workIDs.contains(work.id)
                                )
                                .contextMenu {
                                    Button(L10n("编辑"), systemImage: "square.and.pencil") {
                                        editWork(work)
                                    }
                                    Divider()
                                    Button(L10n("删除"), systemImage: "trash", role: .destructive) {
                                        deleteWork(work)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .id(work.id)
                        }
                    }
                    .padding(.vertical, 10)
                    .background(ConsoleOverlayScroller(placeOnLeadingEdge: true))
                }
                .mask(workRailScrollMask)
                .onAppear {
                    scrollSelectedWorkIntoView(using: scrollProxy, animated: false)
                }
                .onChange(of: selectedWorkId) { _, _ in
                    scrollSelectedWorkIntoView(using: scrollProxy, animated: true)
                }
            }

        }
        .padding(.vertical, 10)
    }

    private var workRailScrollMask: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                .frame(height: 10)
            Rectangle().fill(.black)
            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: 10)
        }
    }

    private func scrollSelectedWorkIntoView(
        using proxy: ScrollViewProxy,
        animated: Bool
    ) {
        guard let selectedWorkId else { return }
        let action = { proxy.scrollTo(selectedWorkId, anchor: .center) }
        if animated {
            withAnimation(.easeInOut(duration: 0.18), action)
        } else {
            action()
        }
    }

    @ViewBuilder
    private func consoleRailIcon(
        systemImage: String? = nil,
        text: String? = nil,
        avatarPath: String? = nil,
        objectiveID: String? = nil,
        label: String,
        isSelected: Bool,
        hasUnread: Bool
    ) -> some View {
        Group {
            if let objectiveID {
                ObjectiveAvatarView(
                    objectiveID: objectiveID,
                    name: label,
                    avatarPath: avatarPath,
                    size: 42
                )
            } else {
                ZStack {
                    Circle()
                        .fill(Color(nsColor: .controlBackgroundColor))
                        .frame(width: 42, height: 42)
                    if let systemImage {
                        Image(systemName: systemImage)
                            .font(.system(size: 16, weight: .semibold))
                    } else {
                        Text(text ?? "?")
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .lineLimit(1)
                    }
                }
            }
        }
        .foregroundStyle(Color.primary)
        .frame(width: 64, height: 50)
        .overlay(alignment: .leading) {
            if isSelected || hasUnread {
                Capsule()
                    .fill(isSelected ? Color.accentColor.opacity(0.78) : Color.red)
                    .frame(
                        width: isSelected ? 4 : 8,
                        height: isSelected ? 24 : 8
                    )
                    .padding(.leading, 2)
                    .transition(.scale(scale: 0.72).combined(with: .opacity))
            }
        }
        .contentShape(Rectangle())
        .help(label)
        .accessibilityLabel(label)
        .accessibilityValue(
            isSelected ? L10n("Selected") : (hasUnread ? L10n("Unread Session") : "")
        )
        .animation(.easeInOut(duration: 0.15), value: isSelected)
        .animation(.easeInOut(duration: 0.15), value: hasUnread)
    }

    private func workInitials(_ name: String) -> String {
        let compact = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return compact.isEmpty ? "?" : String(compact.prefix(2)).uppercased()
    }

}
