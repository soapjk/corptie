import AppKit
import CorptieConversation
import SwiftUI

extension UnifiedConsoleView {
    var unifiedTaskSidebar: some View {
        VStack(spacing: 0) {
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
    }

    var unifiedWorkOutlineSidebar: some View {
        VStack(spacing: 0) {
            workOutlineList

            if isShowingWorkerArchive,
               backendClient.archivedSessionsHasMore
                || backendClient.isLoadingMoreArchivedSessions
                || backendClient.archivedSessionsLoadError != nil {
                archivedWorkerPaginationBar
            }
        }
    }

    var workOutlineList: some View {
        let unreadSummary = sessionIndexStore.workUnreadSummary
        let workRowsByWorkID = outlineProjection.workRowsByWorkID
        let archivedRowsByWorkID = outlineProjection.archivedRowsByWorkID
        let processingWorkIDs = sessionIndexStore.processingWorkIDs

        return ScrollView {
            // Keep group extents exact even when a header is offscreen. The
            // rows inside each group provide the viewport virtualization.
            VStack(alignment: .leading, spacing: 4) {
                DisclosureGroup(isExpanded: outlineAssistantExpandedBinding) {
                    ConsoleWorkOutlineRows(rowCount: max(1, assistantSessionRows.count)) {
                        if assistantSessionRows.isEmpty {
                            outlineGroupEmptyRow(L10n("No Assistant Sessions"))
                                .frame(height: ConsoleWorkOutlineRowMetrics.height)
                        } else {
                            ForEach(assistantSessionRows) { row in
                                sessionRow(row)
                                    .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                    .background(outlineChildSelectionBackground(
                                        selectionController.presentationSessionID == row.session.id
                                    ))
                                    .frame(height: ConsoleWorkOutlineRowMetrics.height)
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

                Text(L10n("Projects"))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.top, 20)
                    .padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)

                ForEach(orderedOutlineWorks, id: \.id) { (work: Work) in
                    let workRows = workRowsByWorkID[work.id] ?? .empty
                    let queryIsActive = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    let showsAll = outlineFullyExpandedWorkIDs.contains(work.id)
                    let visibleTaskCount = WorkOutlineTaskDisclosurePolicy.visibleCount(
                        totalCount: workRows.rootCount,
                        showsAll: showsAll,
                        isSearching: queryIsActive,
                        isShowingArchive: isShowingWorkerArchive
                    )
                    let hiddenTaskCount = workRows.rootCount - visibleTaskCount
                    let visibleTasks = workRows.rows(showsAll: showsAll || queryIsActive || isShowingWorkerArchive)

                    DisclosureGroup(isExpanded: outlineWorkExpandedBinding(work.id)) {
                        if isShowingWorkerArchive {
                            let orderedTasks: [CorptieTask] = outlineProjection.archivedTasksByWorkID[work.id] ?? []
                            let rows: [SessionRowModel] = archivedRowsByWorkID[work.id] ?? []
                            ConsoleWorkOutlineRows(rowCount: max(1, orderedTasks.count + rows.count)) {
                                ForEach(orderedTasks) { task in
                                    hierarchyTaskRow(task)
                                        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                        .background(outlineChildSelectionBackground(selectedTaskId == task.id))
                                        .frame(height: ConsoleWorkOutlineRowMetrics.height)
                                }
                                if rows.isEmpty && orderedTasks.isEmpty {
                                    outlineGroupEmptyRow(L10n("No Archived Sessions"))
                                        .frame(height: ConsoleWorkOutlineRowMetrics.height)
                                } else {
                                    ForEach(rows) { row in
                                        sessionRow(row)
                                            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                            .background(outlineChildSelectionBackground(
                                                selectionController.presentationSessionID == row.session.id
                                            ))
                                            .frame(height: ConsoleWorkOutlineRowMetrics.height)
                                    }
                                }
                            }
                        } else {
                            ConsoleWorkOutlineRows(rowCount: visibleTasks.count + (hiddenTaskCount > 0 ? 1 : 0)) {
                                ForEach(visibleTasks) { task in
                                    hierarchyTaskRow(task)
                                        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                        .background(outlineChildSelectionBackground(
                                            selectedTaskId == task.id
                                        ))
                                        .frame(height: ConsoleWorkOutlineRowMetrics.height)
                                }
                                if hiddenTaskCount > 0 {
                                    outlineShowAllTasksButton(
                                        workID: work.id,
                                        hiddenCount: hiddenTaskCount
                                    )
                                    .frame(height: ConsoleWorkOutlineRowMetrics.height)
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
                    .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle(onCollapseCompleted: {
                        if outlineFullyExpandedWorkIDs.contains(work.id) {
                            outlineFullyExpandedWorkIDs.remove(work.id)
                        }
                    }))
                    .consoleWorkOutlineGroupCard()
                }
            }
            .padding(.horizontal, ConsoleWorkOutlineMetrics.groupHorizontalInset)
            .padding(.vertical, 4)
            .background(ConsoleOverlayScroller())
        }
    }

    func outlineChatHeader(hasUnread: Bool) -> some View {
        ConsoleAssistantExpansionScope(preferences: outlineExpansionPreferences,
            forceExpanded: !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { isExpanded in
            Button {
                let expanded = outlineAssistantExpandedBinding
                expanded.wrappedValue = !expanded.wrappedValue
            } label: {
                HStack(spacing: 7) {
                    Text(L10n("Chat"))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
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
            .buttonStyle(SessionSelectionPressStyle())
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

    func outlineShowAllTasksButton(workID: String, hiddenCount: Int) -> some View {
        Button {
            outlineFullyExpandedWorkIDs.insert(workID)
        } label: {
            Label("展开其余 \(hiddenCount) 个 Task", systemImage: "chevron.down")
                .font(.system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.vertical, 4)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .consoleHoverFeedback()
        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent + 24)
        .accessibilityLabel("展开全部 Task，还剩 \(hiddenCount) 个")
    }

    func outlineChildSelectionBackground(_ isSelected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(isSelected ? Color.primary.opacity(0.055) : Color.clear)
            .padding(.horizontal, 8)
    }

    func outlineWorkIsExpanded(_ workID: String) -> Bool {
        outlineExpansionPreferences.isWorkExpanded(workID)
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
            isChatSelected: selectionController.presentationSessionID == workChat?.id,
            isChatRunning: workChat?.executionTaskStatus == .running,
            hasUnreadChat: workChat.map(isSessionUnread) ?? false,
            toggleExpanded: {
                let expanded = outlineWorkExpandedBinding(work.id)
                expanded.wrappedValue = !expanded.wrappedValue
            },
            openChat: {
                // Resolve at invocation: an equal header must not retain an
                // old Work Chat binding when its display inputs stay the same.
                guard let currentChat = workChatSession(for: work.id) else { return }
                openWorkChat(for: work, session: currentChat)
            },
            createTask: { presentTaskCreation(for: work.id) },
            actionOwner: outlineExpansionPreferences,
            isActive: sidebarState.isSelected
        ).equatable()
    }

    @ViewBuilder
    func workContextMenuContent(for work: Work) -> some View {
        Button(L10n("Open Work Chat"), systemImage: "bubble.left") {
            guard let session = workChatSession(for: work.id) else { return }
            openWorkChat(for: work, session: session)
        }
        .disabled(workChatSession(for: work.id) == nil)
        Button(L10nFormat("Create Task in %@", work.name), systemImage: "plus") {
            presentTaskCreation(for: work.id)
        }
        Divider()
        Button(L10n("编辑"), systemImage: "square.and.pencil") {
            workPendingEdit = work
        }
        Divider()
        Button(L10n("删除"), systemImage: "trash", role: .destructive) {
            workPendingDeletion = work
        }
    }

    var outlinePreparationKey: ConsoleOutlineProjectionKey {
        ConsoleOutlineProjectionKey(entityRevision: entityGroupingRevision,
            sessionRevision: outlineSort == .updated ? sessionIndexStore.outlineActivityRevision : 0,
            search: searchText, sort: outlineSort, expandedTaskIDs: expandedParentTaskIDs,
            archiveRevision: isShowingWorkerArchive ? archivedSessionIndexStore.groupingRevision : 0,
            archiveFilterRevision: isShowingWorkerArchive && !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? archivedSessionIndexStore.filterRevision : 0,
            showsArchive: isShowingWorkerArchive)
    }

    func prepareOutline() async {
        let key = outlinePreparationKey
        await outlineProjectionStore.prepare(key: key,
            tasks: entityClient.tasks, works: entityClient.works,
            sessions: outlineSort == .updated ? backendClient.sessions : [],
            archivedRows: isShowingWorkerArchive ? archivedSessionIndexStore.rows : [],
            isCurrent: { outlinePreparationKey == key })
    }

    var outlineProjection: ConsoleOutlineProjection { outlineProjectionStore.prepared }

    var outlineTasksByWorkID: [String: [CorptieTask]] { outlineProjection.tasksByWorkID }
    var orderedOutlineWorks: [Work] { outlineProjection.works }

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
