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
        ConsoleNativeOutline(groups: { nativeOutlineGroups }) { entry in
            switch entry {
            case .session(let row):
                sessionRow(row, showsHoverFeedback: false)
                    .consoleOutlineRowSurface(isSelected: selectionController.presentationSessionID == row.session.id)
            case .task(let task):
                hierarchyTaskRow(task, showsHoverFeedback: false, nativeDisclosure: !isShowingWorkerArchive)
                    .consoleOutlineRowSurface(isSelected: selectedTaskId == task.id)
            case .empty(_, let title):
                outlineGroupEmptyRow(title)
            case .more(let workID, let count):
                outlineShowAllTasksButton(workID: workID, hiddenCount: count)
            }
        }
    }

    var nativeOutlineGroups: [ConsoleNativeOutlineGroup<ConsoleNativeOutlineEntry>] {
        let unreadSummary = sessionIndexStore.workUnreadSummary
        let processingWorkIDs = sessionIndexStore.processingWorkIDs
        let assistantRows = assistantSessionRows
        let queryIsActive = !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        var groups = [ConsoleNativeOutlineGroup(
            id: "assistant",
            header: AnyView(outlineChatHeader(hasUnread: unreadSummary.hasUnreadAssistantSessions,
                isProcessing: sessionIndexStore.hasProcessingAssistantSessions)),
            rows: assistantRows.isEmpty
                ? [ConsoleNativeOutlineEntry.empty("assistant-empty", L10n("No Assistant Sessions"))]
                : assistantRows.map { .session($0) },
            isExpanded: outlineAssistantExpandedBinding.wrappedValue,
            allowsCollapse: !queryIsActive,
            showsDisclosureIndicator: false,
            expansionChanged: { outlineAssistantExpandedBinding.wrappedValue = $0 }
        )]
        groups.append(.init(id: "projects-heading", header: AnyView(Text(L10n("Projects"))
            .font(.system(size: 12, weight: .medium)).foregroundStyle(.secondary)), isSection: true))
        for work in orderedOutlineWorks {
            let workRows = outlineProjection.workRowsByWorkID[work.id] ?? .empty
            let showsAll = outlineFullyExpandedWorkIDs.contains(work.id)
            let visibleTaskCount = WorkOutlineTaskDisclosurePolicy.visibleCount(
                totalCount: workRows.rootCount, showsAll: showsAll,
                isSearching: queryIsActive, isShowingArchive: isShowingWorkerArchive)
            let hiddenTaskCount = workRows.rootCount - visibleTaskCount
            var rows: [ConsoleNativeOutlineEntry]
            if isShowingWorkerArchive {
                rows = (outlineProjection.archivedTasksByWorkID[work.id] ?? []).map { .task($0) }
                    + (outlineProjection.archivedRowsByWorkID[work.id] ?? []).map { .session($0) }
                if rows.isEmpty { rows = [.empty("archive-empty", L10n("No Archived Sessions"))] }
            } else {
                rows = (showsAll || queryIsActive ? workRows.nativeRoots : workRows.nativePreviewRoots).map { .task($0) }
                if hiddenTaskCount > 0 { rows.append(.more(work.id, hiddenTaskCount)) }
            }
            groups.append(.init(id: work.id,
                header: AnyView(outlineWorkHeader(work,
                    hasUnread: unreadSummary.workIDs.contains(work.id),
                    isWorking: processingWorkIDs.contains(work.id))
                    .contextMenu { workContextMenuContent(for: work) }),
                rows: rows, isExpanded: outlineWorkIsExpanded(work.id),
                allowsCollapse: !queryIsActive,
                showsDisclosureIndicator: false,
                expansionChanged: { outlineWorkExpandedBinding(work.id).wrappedValue = $0 },
                structureRevision: workRows.structureRevision, dataRevision: outlineProjectionStore.computationCount,
                childRows: { entry in
                    guard !isShowingWorkerArchive, case .task(let task) = entry else { return [] }
                    return (workRows.nativeChildren[task.id] ?? []).map { .task($0) }
                }, rowIsExpanded: { entry in
                    guard case .task(let task) = entry else { return false }
                    return queryIsActive || expandedParentTaskIDs.contains(task.id)
                }, rowExpansionChanged: { entry, expanded in
                    guard case .task(let task) = entry else { return }
                    if expanded {
                        expandedParentTaskIDs.insert(task.id)
                        Task { await entityClient.loadTaskChildren(task) }
                    } else { expandedParentTaskIDs.remove(task.id) }
                }, rowIsExpandable: { entry in
                    guard !isShowingWorkerArchive, case .task(let task) = entry else { return false }
                    return (task.hierarchy?.childCount ?? 0) > 0 || workRows.nativeChildren[task.id] != nil
                }))
        }
        return groups
    }

    func outlineChatHeader(hasUnread: Bool, isProcessing: Bool) -> some View {
        ConsoleAssistantExpansionScope(preferences: outlineExpansionPreferences,
            forceExpanded: !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) { isExpanded in
            Button {
                let expanded = outlineAssistantExpandedBinding
                expanded.wrappedValue = !expanded.wrappedValue
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: isExpanded ? "bubble.left.and.bubble.right.fill" : "bubble.left.and.bubble.right")
                        .font(.system(size: 14))
                        .foregroundStyle(.secondary)
                        .frame(width: 18)
                    ConsoleWorkTitle(title: L10n("Chat"), isWorking: isProcessing && !isExpanded,
                        isActive: sidebarState.isSelected)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    ConsoleGroupStatusIndicators(isExpanded: isExpanded, isProcessing: isProcessing,
                        hasUnread: hasUnread)
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
        .accessibilityLabel("展开全部 Task，还剩 \(hiddenCount) 个")
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
                if !isExpanded {
                    outlineFullyExpandedWorkIDs.remove(workID)
                }
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
            search: searchText, sort: outlineSort, expandedTaskIDs: isShowingWorkerArchive ? expandedParentTaskIDs : [],
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

/// Stable resource identities cross the AppKit row boundary; existing SwiftUI
/// controls continue to own task/session selection and context menus.
enum ConsoleNativeOutlineEntry: Identifiable {
    case session(SessionRowModel)
    case task(CorptieTask)
    case empty(String, String)
    case more(String, Int)

    var id: String {
        switch self {
        case .session(let row): "session:" + row.id
        case .task(let task): "task:" + task.id
        case .empty(let id, _): "empty:" + id
        case .more(let workID, _): "more:" + workID
        }
    }
}
