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
                toggleChats: { showsAllChatSessions.toggle() },
                chatHeader: AnyView(outlineChatHeader(
                    hasUnread: sessionIndexStore.workUnreadSummary.hasUnreadAssistantSessions,
                    isProcessing: sessionIndexStore.hasProcessingAssistantSessions))) {
                    selectSessionAfterHighlight($0, focusComposer: true)
                } menuContent: { session, isRenaming in
                    sessionContextMenuContent(for: session, isRenaming: isRenaming)
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
struct ConsoleFlatSessionList<MenuContent: View>: View {
    @ObservedObject var store: SessionIndexStore
    let works: [Work]
    let tasks: [CorptieTask]
    let sort: WorkOutlineSort
    let selectedSessionID: String?
    let isActive: Bool
    let showsAllChats: Bool
    let toggleChats: () -> Void
    let chatHeader: AnyView
    let select: (TaskSession) -> Void
    @ViewBuilder var menuContent: (TaskSession, Binding<Bool>) -> MenuContent

    var body: some View {
        let workNames = Dictionary(works.map { ($0.id, $0.name) }, uniquingKeysWith: { _, last in last })
        let taskWorks = Dictionary(tasks.map { ($0.id, $0.workId) }, uniquingKeysWith: { _, last in last })
        let sections = ConsoleFlatSessionList<EmptyView>.partitionedRows(store.rows, sort: sort)
        let groups = [
            ConsoleChatSection.group(header: chatHeader, rows: sections.chats, showsAll: showsAllChats),
            ConsoleNativeOutlineGroup(id: "projects-heading",
                header: AnyView(ConsolePrimarySectionHeading(title: L10n("Projects"))),
                rows: sections.projects.map { ConsoleNativeOutlineEntry.session($0) },
                isExpanded: true, usesSectionStyle: true, allowsCollapse: false,
                showsDisclosureIndicator: false, rowHeight: { _ in 44 })
        ]
        ConsoleNativeOutline(groups: { groups }) { entry in
            switch entry {
            case .session(let row):
                let isChat = row.session.resolvedSessionKind == .assistantChat
                ConsoleSessionRow(projectName: isChat ? nil : ConsoleFlatSessionList<EmptyView>.projectName(
                    for: row.session, workNames: workNames, taskWorks: taskWorks),
                    showsHoverFeedback: false, isActive: isActive, row: row,
                    selectionRequested: select, menuContent: menuContent)
                    .consoleOutlineRowSurface(isSelected: selectedSessionID == row.id,
                        fixesHeightToNativeRow: isChat)
            case .moreChats:
                ConsoleChatPreviewButton(showsAll: showsAllChats, toggle: toggleChats)
            case .empty(_, let title):
                Text(title).font(.system(size: 11)).foregroundStyle(.secondary).padding(.vertical, 4)
            default: EmptyView()
            }
        }
        .accessibilityIdentifier("console.session-list")
    }

}

extension ConsoleFlatSessionList where MenuContent == EmptyView {
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
