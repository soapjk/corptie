import AppKit
import CorptieConversation
import SwiftUI

extension UnifiedConsoleView {
    var unifiedTaskSidebar: some View {
        VStack(spacing: 0) {
            if isSearching {
                sessionSearchBar
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
            }

            if let work = selectedWork {
                workTaskList(work)
            } else {
                assistantSessionList
            }

            if isShowingWorkerArchive,
               backendClient.archivedSessionsHasMore
                || backendClient.isLoadingMoreArchivedSessions
                || backendClient.archivedSessionsLoadError != nil {
                archivedWorkerPaginationBar
            }
        }
        .sheet(isPresented: $showNewSessionCreation) {
            NewSessionCreationSheet(fixedKind: .assistantChat)
        }
    }

    var unifiedWorkOutlineSidebar: some View {
        VStack(spacing: 0) {
            if isSearching {
                sessionSearchBar
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
            }

            workOutlineList

            if isShowingWorkerArchive,
               backendClient.archivedSessionsHasMore
                || backendClient.isLoadingMoreArchivedSessions
                || backendClient.archivedSessionsLoadError != nil {
                archivedWorkerPaginationBar
            }
        }
        .sheet(isPresented: $showNewSessionCreation) {
            NewSessionCreationSheet(fixedKind: .assistantChat)
        }
    }

    var workOutlineList: some View {
        let unreadSummary = WorkRailUnreadSummary(
            sessions: sessionIndexStore.rows.map(\.session)
        )
        let tasksByWorkID = outlineTasksByWorkID
        let taskActivity = isShowingWorkerArchive ? outlineTaskActivity : [:]
        let archivedRowsByWorkID = outlineArchivedRowsByWorkID
        let processingWorkIDs = ConsoleWorkActivityPolicy.processingWorkIDs(
            tasks: entityClient.tasks,
            sessions: backendClient.sessions
        )

        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                DisclosureGroup(isExpanded: outlineAssistantExpandedBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        if assistantSessionRows.isEmpty {
                            outlineGroupEmptyRow(L10n("No Assistant Sessions"))
                        } else {
                            ForEach(assistantSessionRows) { row in
                                sessionRow(row)
                                    .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                    .background(outlineChildSelectionBackground(
                                        selectionController.selectedSessionID == row.session.id
                                    ))
                            }
                        }
                    }
                } label: {
                    outlineChatHeader(
                        hasUnread: unreadSummary.hasUnreadAssistantSessions
                    )
                }
                .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
                .consoleWorkOutlineGroupCard()

                ForEach(orderedOutlineWorks) { work in
                    let tasks = tasksByWorkID[work.id] ?? []

                    DisclosureGroup(isExpanded: outlineWorkExpandedBinding(work.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            if isShowingWorkerArchive {
                                let archivedTasks = archivedTasks(for: work.id, activity: taskActivity)
                                let taskIDs = Set(archivedTasks.map(\.id))
                                let rows = (archivedRowsByWorkID[work.id] ?? []).filter {
                                    !taskIDs.contains($0.session.taskId ?? "")
                                }
                                ForEach(archivedTasks) { task in
                                    taskRow(task)
                                        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                        .background(outlineChildSelectionBackground(selectedTaskId == task.id))
                                }
                                if rows.isEmpty && archivedTasks.isEmpty {
                                    outlineGroupEmptyRow(L10n("No Archived Sessions"))
                                } else {
                                    ForEach(rows) { row in
                                        sessionRow(row)
                                            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                            .background(outlineChildSelectionBackground(
                                                selectionController.selectedSessionID == row.session.id
                                            ))
                                    }
                                }
                            } else {
                                ForEach(tasks) { task in
                                    taskRow(task)
                                        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                        .background(outlineChildSelectionBackground(
                                            selectedTaskId == task.id
                                        ))
                                }
                            }
                        }
                    } label: {
                        outlineWorkHeader(
                            work,
                            hasUnread: unreadSummary.workIDs.contains(work.id),
                            isWorking: processingWorkIDs.contains(work.id)
                        )
                            .contextMenu {
                                workContextMenuContent(for: work)
                            }
                    }
                    .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
                    .consoleWorkOutlineGroupCard()
                }
            }
            .padding(.horizontal, ConsoleWorkOutlineMetrics.groupHorizontalInset)
            .padding(.vertical, 4)
            .background(ConsoleOverlayScroller())
        }
    }

    func outlineChatHeader(hasUnread: Bool) -> some View {
        let isExpanded = !outlineExpansionPreferences.isAssistantCollapsed || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return HoverRevealHeaderAction(
            accessibilityLabel: L10n("New Assistant Session"),
            action: { showNewSessionCreation = true }
        ) {
            Button {
                if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
                        outlineExpansionPreferences.toggleAssistant()
                    }
                }
            } label: {
                HStack(spacing: 7) {
                    ChatGroupIcon()
                    Text(L10n("Chat"))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(selectedWorkId == nil ? Color.primary : Color.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if hasUnread {
                        Circle()
                            .fill(Color.red)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel(L10n("Unread Session"))
                    }
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n("Chat"))
            .accessibilityValue(isExpanded ? L10n("Expanded group") : L10n("Collapsed group"))
        }
    }

    func outlineGroupEmptyRow(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent + 24)
            .padding(.vertical, 4)
    }

    func outlineChildSelectionBackground(_ isSelected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(isSelected ? Color.accentColor.opacity(0.09) : Color.clear)
            .padding(.horizontal, 8)
    }

    func outlineWorkIsExpanded(_ workID: String) -> Bool {
        outlineExpansionPreferences.expandedWorkIDs.contains(workID)
            || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var outlineAssistantExpandedBinding: Binding<Bool> {
        Binding(
            get: { !outlineExpansionPreferences.isAssistantCollapsed || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty },
            set: { isExpanded in
                guard searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                outlineExpansionPreferences.setAssistantExpanded(isExpanded)
            }
        )
    }

    func outlineWorkExpandedBinding(_ workID: String) -> Binding<Bool> {
        Binding(
            get: { outlineWorkIsExpanded(workID) },
            set: { isExpanded in
                guard searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return
                }
                outlineExpansionPreferences.setWorkExpanded(isExpanded, workID: workID)
            }
        )
    }

    func outlineWorkHeader(
        _ work: Work,
        hasUnread: Bool,
        isWorking: Bool
    ) -> some View {
        let isExpanded = outlineWorkIsExpanded(work.id)
        let workChat = workChatSession(for: work.id)
        return ConsoleWorkOutlineHeader(
            work: work,
            isExpanded: isExpanded,
            isSelected: selectedWorkId == work.id,
            isWorking: isWorking,
            hasUnread: hasUnread,
            isChatSelected: selectionController.selectedSessionID == workChat?.id,
            isChatRunning: workChat?.executionTaskStatus == .running,
            hasUnreadChat: workChat.map(isSessionUnread) ?? false,
            toggleExpanded: {
                guard searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
                    outlineExpansionPreferences.toggleWork(workID: work.id)
                }
            },
            openChat: {
                guard let workChat else { return }
                openWorkChat(for: work, session: workChat)
            },
            createTask: { presentTaskCreation(for: work.id) }
        )
    }

    @ViewBuilder
    func workContextMenuContent(for work: Work) -> some View {
        Button(L10n("编辑"), systemImage: "square.and.pencil") {
            workPendingEdit = work
        }
        Divider()
        Button(L10n("删除"), systemImage: "trash", role: .destructive) {
            workPendingDeletion = work
        }
    }

    var outlineTasksByWorkID: [String: [CorptieTask]] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let activeTasks = entityClient.tasks.filter { $0.lifecycleState != "done" && $0.archived != true }
        let grouped = Dictionary(grouping: activeTasks, by: \.workId)
        let activity = outlineTaskActivity
        return grouped.mapValues { tasks in
            let filtered = tasks
                .filter { task in
                    query.isEmpty
                        || task.title.localizedCaseInsensitiveContains(query)
                        || task.description.localizedCaseInsensitiveContains(query)
                }
            return sortedOutlineTasks(filtered, activity: activity)
        }
    }

    var orderedOutlineWorks: [Work] {
        guard outlineSort != .standard else { return entityClient.works }
        let activity = outlineSort == .updated
            ? Dictionary(grouping: backendClient.sessions, by: { $0.workId ?? "" })
                .mapValues { $0.compactMap(\.lastMessageAt).max() ?? "" } : [:]
        return outlineSort.ordered(entityClient.works, id: { $0.id }, title: { $0.name },
                                   updatedAt: { $0.updatedAt },
                                   activityAt: { activity[$0.id].flatMap { $0.isEmpty ? nil : $0 } })
    }

    var outlineTaskActivity: [String: String] {
        outlineSort == .updated
            ? Dictionary(grouping: backendClient.sessions, by: { $0.taskId ?? "" })
                .mapValues { $0.compactMap(\.lastMessageAt).max() ?? "" } : [:]
    }

    func sortedOutlineTasks(_ tasks: [CorptieTask], activity: [String: String]? = nil) -> [CorptieTask] {
        guard outlineSort != .standard else { return tasks }
        let activity = activity ?? outlineTaskActivity
        return outlineSort.ordered(tasks, id: { $0.id }, title: { $0.title },
                                   updatedAt: { $0.updatedAt },
                                   activityAt: { activity[$0.id].flatMap { $0.isEmpty ? nil : $0 } },
                                   prioritizesActivity: true)
    }

    var outlineArchivedRowsByWorkID: [String: [SessionRowModel]] {
        let taskWorkIDs = Dictionary(uniqueKeysWithValues: entityClient.tasks.map { ($0.id, $0.workId) })
        return Dictionary(
            grouping: searchFilteredRows.filter { $0.session.resolvedSessionKind == .worker },
            by: { row in
                row.session.workId
                    ?? row.session.taskId.flatMap { taskWorkIDs[$0] }
                    ?? ""
            }
        )
    }

    var archivedWorkerPaginationBar: some View {
        HStack(spacing: 7) {
            if backendClient.isLoadingMoreArchivedSessions {
                ProgressView().controlSize(.small)
                Text(L10n("Loading more…"))
            } else if backendClient.archivedSessionsLoadError != nil {
                Text(L10n("More sessions could not be loaded."))
                Spacer()
                Button(L10n("Retry")) {
                    Task {
                        if backendClient.archivedSessionsHasMore {
                            await backendClient.loadMoreArchivedSessions()
                        } else {
                            await backendClient.refreshArchivedSessions(sessionKind: .worker)
                        }
                    }
                }
            } else {
                Text(L10n("More archived sessions"))
                Spacer()
                Button(L10n("Load More")) {
                    Task { await backendClient.loadMoreArchivedSessions() }
                }
            }
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(.secondary)
        .padding(8)
    }

    var selectedWork: Work? {
        guard let selectedWorkId else { return nil }
        return entityClient.works.first { $0.id == selectedWorkId }
    }

    var selectedTask: CorptieTask? {
        guard let selectedTaskId else { return nil }
        return entityClient.tasks.first { $0.id == selectedTaskId }
    }

    var assistantSessionRows: [SessionRowModel] {
        let rows = searchFilteredRows.filter { $0.session.resolvedSessionKind == .assistantChat }
        return outlineSort.ordered(rows, id: { $0.session.id }, title: { $0.session.title },
                                   updatedAt: { $0.session.updatedAt },
                                   activityAt: { $0.session.lastMessageAt })
    }

    var workChatRows: [SessionRowModel] {
        guard let selectedWorkId else { return [] }
        return searchFilteredRows.filter {
            $0.session.resolvedSessionKind == .workChat
                && $0.session.workId == selectedWorkId
        }
    }

    var visibleWorkTasks: [CorptieTask] {
        guard let selectedWorkId else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return entityClient.tasks
            .filter { $0.workId == selectedWorkId && $0.lifecycleState != "done" && $0.archived != true }
            .filter { task in
                query.isEmpty
                    || task.title.localizedCaseInsensitiveContains(query)
                    || task.description.localizedCaseInsensitiveContains(query)
            }
            .sorted { lhs, rhs in
                if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
                return lhs.id < rhs.id
            }
    }
}
