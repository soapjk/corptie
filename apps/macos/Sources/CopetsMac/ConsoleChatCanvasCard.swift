import SwiftUI

/// All regular Chat sessions, independent of the Task attention filter.
struct ConsoleChatCanvasCard: View {
    let sessions: [TaskSession]
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
                CompactSessionRow(session: session, isUnread: isSessionUnread(session),
                    showsProjectName: false, style: .sessionsSidebar,
                    selectionRequested: openChat)
            }
        }
        .frame(width: 264)
        .onHover { isHovering = $0 }
    }
}
