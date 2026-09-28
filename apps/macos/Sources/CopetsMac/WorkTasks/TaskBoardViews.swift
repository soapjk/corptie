import SwiftUI
import CorptieClientCore
import CorptieConversation

struct CorptieTaskBoardView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    let work: Work?
    let items: [CorptieTask]
    @Binding var selectedCorptieTaskId: String?
    let pendingDeletionIds: Set<String>
    let onRequestEdit: (CorptieTask) -> Void
    let onRequestDeletion: (CorptieTask) -> Void
    var onRequestReload: () -> Void = {}
    var onRequestLoadMore: () async -> Void = {}
    @State private var boardItems: [CorptieTask] = []
    @State private var isCreating = false
    @State private var isCreatingWorkChat = false
    @State private var collapsedColumns: Set<CorptieTaskColumn> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(work?.name ?? L10n("All"))
                    .font(.title3.bold())
                Spacer()
                if work != nil {
                    Button {
                        openOrCreateWorkDiscussion()
                    } label: {
                        Label(L10n("讨论"), systemImage: "bubble.left.and.bubble.right")
                    }
                    Button {
                        isCreating = true
                    } label: {
                        Label(L10n("新建工作项"), systemImage: "plus")
                    }
                }
            }
            HStack(alignment: .top, spacing: 12) {
                ForEach(CorptieTaskColumn.allCases) { column in
                    CorptieTaskColumnView(
                        column: column,
                        items: boardItems.filter { CorptieTaskColumn.column(for: $0.lifecycleState) == column },
                        sessions: backendClient.sessions,
                        selectedCorptieTaskId: $selectedCorptieTaskId,
                        pendingDeletionIds: pendingDeletionIds,
                        onRequestEdit: onRequestEdit,
                        onRequestDeletion: onRequestDeletion,
                        isCollapsed: Binding(
                            get: { collapsedColumns.contains(column) },
                            set: { isCollapsed in
                                if isCollapsed { collapsedColumns.insert(column) }
                                else { collapsedColumns.remove(column) }
                            }
                        )
                    )
                }
            }
            if client.browsedTasksHasMore {
                Button(L10n("加载更多工作项")) {
                    Task { await onRequestLoadMore() }
                }
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .padding()
        .onAppear { boardItems = items }
        .onChange(of: items) { _, newValue in boardItems = newValue }
        .sheet(isPresented: $isCreating) {
            if let work {
                CorptieTaskCreateView(
                    initialWorkId: work.id
                ) { created in
                    if !boardItems.contains(where: { $0.id == created.id }) {
                        boardItems.append(created)
                    }
                    onRequestReload()
                }
            }
        }
        .sheet(isPresented: $isCreatingWorkChat) {
            if let work {
                NewSessionCreationSheet(fixedWork: work) { session in
                    router.openSession(session.id, source: .createdSession)
                }
            }
        }
    }

    private func openOrCreateWorkDiscussion() {
        guard let work else { return }
        switch WorkDiscussionRouteDecision.resolve(
            workId: work.id,
            sessions: backendClient.sessions
        ) {
        case .open(let sessionId):
            router.openSession(sessionId, source: .userSelection)
        case .create:
            isCreatingWorkChat = true
        }
    }
}

// MARK: - 单列

struct CorptieTaskColumnView: View {
    let column: CorptieTaskColumn
    let items: [CorptieTask]
    let sessions: [TaskSession]
    @Binding var selectedCorptieTaskId: String?
    let pendingDeletionIds: Set<String>
    let onRequestEdit: (CorptieTask) -> Void
    let onRequestDeletion: (CorptieTask) -> Void
    @Binding var isCollapsed: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        isCollapsed.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                        Text(column.title)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer()

                Text("\(items.count)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)

            Divider()

            if !isCollapsed {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            CorptieTaskCard(
                                item: item,
                                sessions: sessions,
                                isSelected: selectedCorptieTaskId == item.id,
                                isDeletionPending: pendingDeletionIds.contains(item.id)
                            )
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                                .onTapGesture { selectedCorptieTaskId = item.id }
                                .contextMenu {
                                    Button(L10n("编辑"), systemImage: "square.and.pencil") {
                                        onRequestEdit(item)
                                    }
                                    Divider()
                                    Button(role: .destructive) {
                                        onRequestDeletion(item)
                                    } label: {
                                        Label(L10n("删除 CorptieTask"), systemImage: "trash")
                                    }
                                    .disabled(pendingDeletionIds.contains(item.id))
                                }

                            if index < items.count - 1 {
                                Divider()
                                    .padding(.leading, 12)
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, 4)
    }
}

// MARK: - 工作项卡片

struct CorptieTaskCard: View {
    let item: CorptieTask
    let sessions: [TaskSession]
    let isSelected: Bool
    let isDeletionPending: Bool

    var body: some View {
        HStack(spacing: 10) {
            Capsule()
                .fill(isSelected ? Color.accentColor : Color.secondary.opacity(0.28))
                .frame(width: 3, height: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.body.weight(isSelected ? .semibold : .medium))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 4) {
                    Text(item.priority)
                    if let agentId = item.mainAgentId {
                        Text("·")
                        Text(agentId)
                            .lineLimit(1)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                if isDeletionPending || item.deletionStatus == "deleting" {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text(L10n("后台处理中"))
                    }
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.secondary)
                } else {
                    sessionStatusPill
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isSelected ? Color.accentColor.opacity(0.08) : Color.clear)
        .contentShape(Rectangle())
    }

    private var sessionActivity: CorptieTaskBoundSessionActivity {
        CorptieTaskBoundSessionActivity.resolve(task: item, sessions: sessions)
    }

    private var sessionStatusPill: some View {
        statusPill(
            L10nFormat("Session: %@", sessionActivity.label),
            color: sessionActivity.color
        )
    }

    private func statusPill(_ label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .lineLimit(1)
        }
        .font(.system(size: 9.5, weight: .medium))
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(color.opacity(0.1), in: Capsule())
    }
}

// MARK: - Agent 行（侧栏 Agent 一览）

struct AgentRow: View {
    let agent: Agent

    var body: some View {
        HStack(spacing: 8) {
            Text(avatarInitial)
                .font(.caption.bold())
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(avatarColor, in: Circle())

            VStack(alignment: .leading, spacing: 1) {
                Text(agent.name)
                    .font(.callout)
                Text(L10n(agent.isPlatformAssistant ? "Platform managed" : "Agent"))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
        }
        .padding(.vertical, 2)
    }

    private var avatarInitial: String {
        String(agent.name.prefix(1)).uppercased()
    }

    private var avatarColor: Color {
        agent.isPlatformAssistant ? .accentColor : .blue
    }

    private var statusColor: Color {
        switch agent.status {
        case "available": .green
        case "busy": .orange
        case "offline", "inactive": Color.secondary.opacity(0.5)
        default: Color.secondary.opacity(0.5)
        }
    }
}

// MARK: - 工作项详情（占位）
