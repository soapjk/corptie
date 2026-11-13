import AppKit
import CorptieConversation
import SwiftUI
import CorptieClientCore

extension UnifiedConsoleView {
    var assistantSessionList: some View {
        List {
            if assistantSessionRows.isEmpty {
                Text(L10n("No Assistant Sessions"))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(assistantSessionRows) { row in
                    sessionRow(row)
                }
            }
        }
        .listStyle(.sidebar)
        .scrollIndicators(.hidden)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 40, for: .scrollContent)
    }

    @ViewBuilder
    func workTaskList(_ work: Work) -> some View {
        if isShowingWorkerArchive {
            archivedWorkerSessionList(work)
        } else {
            activeWorkTaskList(work)
        }
    }

    func archivedTasks(for workID: String, activity: [String: String]? = nil) -> [CorptieTask] {
        sortedOutlineTasks(entityClient.tasks.filter {
            $0.workId == workID && $0.archived == true
                && (searchText.isEmpty || $0.title.localizedCaseInsensitiveContains(searchText))
        }, activity: activity)
    }

    func archivedWorkerSessionList(_ work: Work) -> some View {
        let archivedTasks = archivedTasks(for: work.id)
        let taskIDs = Set(archivedTasks.map(\.id))
        let rows = searchFilteredRows.filter { row in
            guard row.session.resolvedSessionKind == .worker else { return false }
            guard !taskIDs.contains(row.session.taskId ?? "") else { return false }
            if row.session.workId == work.id { return true }
            guard let taskId = row.session.taskId else { return false }
            return entityClient.tasks.first(where: { $0.id == taskId })?.workId == work.id
        }
        return List {
            ForEach(hierarchyTasks(archivedTasks)) { task in
                hierarchyTaskRow(task)
            }
            if rows.isEmpty && archivedTasks.isEmpty {
                Text(L10n("No Archived Sessions"))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(rows) { row in
                    sessionRow(row)
                }
            }
        }
        .listStyle(.sidebar)
        .scrollIndicators(.hidden)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 40, for: .scrollContent)
    }

    func activeWorkTaskList(_ work: Work) -> some View {
        List {
            Section {
                if let row = workChatRows.first {
                    workChatRow(row)
                } else {
                    Label(L10n("Start Work Chat"), systemImage: "scope")
                        .foregroundStyle(.secondary)
                }
            } header: {
                Text(L10n("Work Chat"))
            }

            Section {
                ForEach(hierarchyTasks(visibleWorkTasks)) { task in
                    hierarchyTaskRow(task)
                }
            } header: {
                Text(L10n("Tasks"))
            }
        }
        .listStyle(.sidebar)
        .scrollIndicators(.hidden)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 40, for: .scrollContent)
    }

    func hierarchyTaskRow(_ task: CorptieTask, showsHoverFeedback: Bool = true, nativeDisclosure: Bool = false) -> some View {
        let isExpanded = expandedParentTaskIDs.contains(task.id)
            || (nativeDisclosure && !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        let hasChildren = (task.hierarchy?.childCount ?? 0) > 0
            || (nativeDisclosure && outlineProjection.workRowsByWorkID[task.workId]?.nativeChildren[task.id]?.isEmpty == false)
        return HStack(spacing: 4) {
            taskRow(task, showsHoverFeedback: showsHoverFeedback)
            if let hierarchy = task.hierarchy, hierarchy.childCount > 0 {
                Text("\(hierarchy.completedChildCount)/\(hierarchy.childCount)")
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    .accessibilityLabel(L10n("子任务完成进度"))
            }
            if hasChildren {
                Button {
                    let wasExpanded = expandedParentTaskIDs.contains(task.id)
                    withAnimation(reduceOutlineMotion ? nil : .default) {
                        if wasExpanded { expandedParentTaskIDs.remove(task.id) }
                        else { expandedParentTaskIDs.insert(task.id) }
                    }
                    if !wasExpanded {
                        Task { await entityClient.loadTaskChildren(task) }
                    }
                } label: {
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(isExpanded ? 90 : 0))
                        .animation(reduceOutlineMotion ? nil : .default, value: isExpanded)
                        .frame(width: 20, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .consoleHoverFeedback()
                .accessibilityLabel(L10n(isExpanded ? "收起子任务" : "展开子任务"))
                .accessibilityIdentifier("task.subtasks.toggle.\(task.id)")
                .disabled(nativeDisclosure && !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if expandedParentTaskIDs.contains(task.id), entityClient.taskChildrenCursors[task.id] != nil {
                Button { Task { await entityClient.loadTaskChildren(task, more: true) } } label: {
                    Image(systemName: "ellipsis")
                }
                .buttonStyle(.plain).consoleHoverFeedback().accessibilityLabel(L10n("加载更多子任务"))
            }
        }
        .padding(.leading, nativeDisclosure ? 0 : CGFloat(min(task.hierarchy?.depth ?? (task.parentTaskId == nil ? 0 : 1), 6)) * 24)
    }

    func hierarchyTasks(_ tasks: [CorptieTask]) -> [CorptieTask] {
        var all=tasks
        let ids=Set(tasks.map(\.id))
        let needed=Set(tasks.compactMap(\.parentTaskId)).subtracting(ids)
        if !needed.isEmpty {
            all.append(contentsOf: entityClient.tasks.filter { needed.contains($0.id) })
        }
        let byID=Dictionary(all.map{($0.id,$0)},uniquingKeysWith:{$1})
        let expanded=searchText.isEmpty ? expandedParentTaskIDs : Set(all.map(\.id))
        return TaskHierarchyIndex.visibleOrder(nodes:all.map{.init(id:$0.id,workId:$0.workId,parentTaskId:$0.parentTaskId)},expanded:expanded).compactMap{byID[$0]}
    }

    @ViewBuilder
    func workChatRow(_ row: SessionRowModel, ownsContextMenu: Bool = true) -> some View {
        let session = row.session
        let rowView = ConsoleWorkChatRowContent(
            isActive: sidebarState.isSelected,
            row: row,
            isSelected: selectionController.selectedSessionID == session.id
        ) {
            selectedTaskId = nil
            selectSessionAfterHighlight(session)
        }

        if ownsContextMenu {
            rowView.contextMenu {
                SessionContextMenuContent(
                    session: session,
                    isRenaming: Binding(
                        get: { sessionPendingRename?.id == session.id },
                        set: { sessionPendingRename = $0 ? session : nil }
                    )
                )
            }
        } else {
            rowView
        }
    }

    @ViewBuilder
    func taskRow(_ task: CorptieTask, ownsContextMenu: Bool = true, showsHoverFeedback: Bool = true) -> some View {
        let session = workerSession(for: task)
            ?? archivedSessionIndexStore.taskSessionLookup.firstSession(for: task.id)
        let sessionActivity = sessionIndexStore.taskSessionLookup.activity(for: task)
        let rowView = ConsoleTaskRowContent(
            showsHoverFeedback: showsHoverFeedback,
            task: task,
            sessionActivity: sessionActivity,
            session: session,
            isSelected: selectedTaskId == task.id,
            isUnread: session.map(isSessionUnread) ?? false,
            isActive: sidebarState.isSelected
        ) {
            openTask(task, session: session)
        }

        if ownsContextMenu {
            rowView.contextMenu {
                taskContextMenuContent(for: task, session: session)
            }
        } else {
            rowView
        }
    }

    /// One resource menu for Worker entries in both flat and grouped navigation.
    @ViewBuilder
    func sessionContextMenuContent(for session: TaskSession, isRenaming: Binding<Bool>) -> some View {
        if session.resolvedSessionKind == .worker,
           let taskID = session.taskId, let task = entityClient.task(taskID) {
            taskContextMenuContent(for: task, session: session)
        } else {
            if session.resolvedSessionKind == .worker {
                Text(L10n("Associated Task Unavailable"))
            }
            SessionContextMenuContent(session: session, isRenaming: isRenaming,
                usesExplicitTargetLabels: session.resolvedSessionKind == .worker)
        }
    }

    @ViewBuilder
    func taskContextMenuContent(
        for task: CorptieTask,
        session: TaskSession?
    ) -> some View {
        let currentSession = sessionIndexStore.taskSessionLookup.currentSession(for: task)
        TaskFixedDisplayMenuItem(task: task)
        if session == nil && task.deletionStatus == nil {
            Button(L10n("启动状态与恢复"), systemImage: "arrow.clockwise") { taskStartupRecoveryTarget = task }
        }
        if task.hierarchy?.canCreateChild == true {
            Button(L10n("新建子任务"),systemImage:"plus") { taskCreationTarget=TaskCreationTarget(workID:task.workId,parentTaskId:task.id) }
        }
        if let id = task.parentTaskId, let parent = entityClient.task(id) {
            Button(L10n("打开父任务"),systemImage:"arrow.turn.up.left") {openTask(parent,session:workerSession(for:parent))}
        }
        Divider()
        Button(L10n("Rename Task"), systemImage: "pencil") {
            taskPendingRename = task
        }
        .disabled(task.deletionStatus == "deleting")
        Button(L10n("编辑"), systemImage: "square.and.pencil") {
            taskPendingEdit = task
        }
        .disabled(task.deletionStatus == "deleting")
        SessionRestartMenuButton(commandState: backendClient.sessionCommandController, session: currentSession, title: L10n("Restart Task Current Session"),
            isPending: pendingTaskRestartIds.contains(task.id) || task.deletionStatus == "deleting") {
            restartTask(task)
        }
        Button(task.archived == true ? L10n("恢复 Task") : L10n("归档 Task"), systemImage: "archivebox") {
            Task { await setTaskArchived(task.archived != true, task: task) }
        }
        .disabled(task.deletionStatus == "deleting")
        Divider()
        if let session {
            Menu(L10n("This Session")) {
                SessionContextMenuContent(session: session, isRenaming: .constant(false),
                    usesExplicitTargetLabels: true,
                    isRestartPending: pendingTaskRestartIds.contains(task.id) && session.id == currentSession?.id)
            }
            .disabled(task.deletionStatus == "deleting" || pendingTaskDeletionIds.contains(task.id))
            Divider()
        }
        Button(L10n("Delete Task and Associated Sessions…"), systemImage: "trash", role: .destructive) {
            Task { await prepareTaskDeletion(task) }
        }
        .disabled(pendingTaskDeletionIds.contains(task.id) || task.deletionStatus == "deleting")
    }
}
