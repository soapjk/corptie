import SwiftUI
import CorptieConversation

extension UnifiedConsoleView {
    var flatSessionSidebar: some View {
        VStack(spacing: 0) {
            ConsoleFlatSessionList(store: visibleSessionIndexStore, works: entityClient.works,
                tasks: entityClient.tasks, sort: outlineSort,
                selectedSessionID: selectionController.presentationSessionID,
                isActive: sidebarState.isSelected,
                showsAllChats: showsAllChatSessions,
                showMoreChats: { showsAllChatSessions = true },
                chatHeader: AnyView(outlineChatHeader(
                    hasUnread: sessionIndexStore.workUnreadSummary.hasUnreadAssistantSessions,
                    isProcessing: sessionIndexStore.hasProcessingAssistantSessions))) {
                    selectSessionAfterHighlight($0, focusComposer: true)
                }
            if isShowingWorkerArchive,
               backendClient.archivedSessionsHasMore
                || backendClient.isLoadingMoreArchivedSessions
                || backendClient.archivedSessionsLoadError != nil {
                archivedWorkerPaginationBar
            }
        }
    }
}

/// Uses the SDK's reusable list rows; status updates stay on SessionRowModel.
struct ConsoleFlatSessionList: View {
    @ObservedObject var store: SessionIndexStore
    let works: [Work]
    let tasks: [CorptieTask]
    let sort: WorkOutlineSort
    let selectedSessionID: String?
    let isActive: Bool
    let showsAllChats: Bool
    let showMoreChats: () -> Void
    let chatHeader: AnyView
    let select: (TaskSession) -> Void

    var body: some View {
        let workNames = Dictionary(works.map { ($0.id, $0.name) }, uniquingKeysWith: { _, last in last })
        let taskWorks = Dictionary(tasks.map { ($0.id, $0.workId) }, uniquingKeysWith: { _, last in last })
        let sections = Self.partitionedRows(store.rows, sort: sort)
        let chatCount = ConsoleChatPreviewPolicy.visibleCount(total: sections.chats.count, showsAll: showsAllChats)
        List {
            chatHeader
                .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
                .listRowSeparator(.hidden)
            Group {
                ForEach(Array(sections.chats.prefix(chatCount))) { row in
                    ConsoleSessionRow(showsHoverFeedback: false, isActive: isActive,
                        row: row, selectionRequested: select)
                        .consoleOutlineRowSurface(isSelected: selectedSessionID == row.id)
                        .listRowSeparator(.hidden)
                }
                if sections.chats.isEmpty {
                    Text(L10n("No Assistant Sessions"))
                        .font(.caption).foregroundStyle(.secondary)
                        .listRowSeparator(.hidden)
                }
            }
            if chatCount < sections.chats.count {
                Button(L10n("展示更多"), action: showMoreChats)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
                    .listRowSeparator(.hidden)
                    .accessibilityIdentifier("console.chat.show-more")
            }
            VStack(alignment: .leading, spacing: 10) {
                Divider()
                Text(L10n("Projects"))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 3)
            }
            .padding(.top, 6)
            .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            ForEach(sections.projects) { row in
                ConsoleSessionRow(projectName: Self.projectName(for: row.session,
                    workNames: workNames, taskWorks: taskWorks),
                    showsHoverFeedback: false, isActive: isActive, row: row,
                    selectionRequested: select)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .consoleHoverFeedback(isSelected: selectedSessionID == row.id, horizontalInset: 0)
                    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 16))
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .contentMargins(.horizontal, 0, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .accessibilityIdentifier("console.session-list")
    }

    @MainActor static func partitionedRows(_ rows: [SessionRowModel], sort: WorkOutlineSort)
        -> (chats: [SessionRowModel], projects: [SessionRowModel]) {
        let ordered = orderedRows(rows, sort: sort)
        let chats = WorkOutlineSort.updated.ordered(ordered.filter { $0.session.resolvedSessionKind == .assistantChat },
            id: { $0.id }, title: { $0.listTitle }, updatedAt: { $0.session.updatedAt },
            activityAt: { $0.session.lastMessageAt })
        return (chats,
                ordered.filter { $0.session.resolvedSessionKind != .assistantChat })
    }

    @MainActor static func orderedRows(_ rows: [SessionRowModel], sort: WorkOutlineSort) -> [SessionRowModel] {
        sort.ordered(rows.filter { $0.session.hasValidProductClassification }, id: { $0.id },
            title: { $0.listTitle }, updatedAt: { $0.session.updatedAt },
            activityAt: { $0.session.lastMessageAt })
    }

    static func projectName(for session: TaskSession, workNames: [String: String],
                            taskWorks: [String: String]) -> String {
        let workID = session.workId ?? session.taskId.flatMap { taskWorks[$0] }
        return workID.flatMap { workNames[$0] } ?? L10n("未关联项目")
    }
}
