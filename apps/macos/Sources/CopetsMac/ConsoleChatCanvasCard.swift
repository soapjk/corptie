import SwiftUI

/// All regular Chat sessions, independent of the Task attention filter.
struct ConsoleChatCanvasCard: View {
    let sessions: [TaskSession]
    var selectedSessionID: String? = nil
    var isActive = true
    let openChat: (TaskSession) -> Void
    let createChat: () -> Void
    @State private var isHovering = false
    @FocusState private var createFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: 10)).foregroundStyle(Color.accentColor)
                Text("Chat").font(.system(size: 10, weight: .medium)).foregroundStyle(.secondary)
                Button(action: createChat) {
                    Image(systemName: "plus").font(.system(size: 10, weight: .semibold))
                        .frame(width: 20, height: 18)
                }
                .buttonStyle(.plain).focused($createFocused)
                .opacity(isHovering || createFocused ? 1 : 0)
                .accessibilityLabel(L10n("New Assistant Session"))
                .help(L10n("New Assistant Session"))
            }
            if sessions.isEmpty {
                Text("暂无匹配的 Chat").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(sessions) { session in
                ConsoleChatCanvasRow(session: session, isSelected: selectedSessionID == session.id,
                    isActive: isActive, openChat: openChat)
            }
        }
        .frame(width: 264)
        .onHover { isHovering = $0 }
    }
}

private struct ConsoleChatCanvasRow: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var isRenaming = false
    let session: TaskSession
    let isSelected: Bool
    let isActive: Bool
    let openChat: (TaskSession) -> Void

    var body: some View {
        Button { openChat(session) } label: {
            ConsoleConversationCardLabel(title: session.title, execution: session.executionTaskStatus,
                needsAttention: session.attention != nil, status: session.executionTaskStatus.rawValue,
                isSelected: isSelected, isFixed: false, hasScheduledWake: session.hasPendingScheduledWake == true,
                isUnread: isSessionUnread(session), isActive: isActive) {
                let text = TaskCardSummaryPreview.text(content: nil, isCurrent: false,
                    sessionSummary: session.attention?.reason ?? session.summary, description: "")
                Text(text).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(4).help(text)
            }
        }
        .buttonStyle(.plain)
        .contextMenu { SessionContextMenuContent(session: session, isRenaming: $isRenaming) }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) { isRenaming = false }
                .environmentObject(backendClient).presentationBackground(.clear)
        }
    }
}
