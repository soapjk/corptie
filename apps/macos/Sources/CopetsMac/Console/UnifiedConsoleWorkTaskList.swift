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

    func hierarchyTaskRow(_ task: CorptieTask) -> some View {
        HStack(spacing: 4) {
            taskRow(task)
            if let hierarchy = task.hierarchy, hierarchy.childCount > 0 {
                Text("\(hierarchy.completedChildCount)/\(hierarchy.childCount)")
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    .accessibilityLabel(L10n("子任务完成进度"))
            }
            if (task.hierarchy?.childCount ?? 0) > 0 {
                Button {
                    if !expandedParentTaskIDs.insert(task.id).inserted {
                        expandedParentTaskIDs.remove(task.id)
                    } else {
                        Task { await entityClient.loadTaskChildren(task) }
                    }
                } label: {
                    Image(systemName: expandedParentTaskIDs.contains(task.id) ? "chevron.down" : "chevron.right")
                        .frame(width: 20, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n(expandedParentTaskIDs.contains(task.id) ? "收起子任务" : "展开子任务"))
                if expandedParentTaskIDs.contains(task.id), entityClient.taskChildrenCursors[task.id] != nil {
                    Button { Task { await entityClient.loadTaskChildren(task, more: true) } } label: {
                        Image(systemName: "ellipsis")
                    }
                    .buttonStyle(.plain).accessibilityLabel(L10n("加载更多子任务"))
                }
            }
        }
        .padding(.leading, task.parentTaskId == nil ? 0 : 24)
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
    func taskRow(_ task: CorptieTask, ownsContextMenu: Bool = true) -> some View {
        let session = workerSession(for: task)
            ?? archivedSessionIndexStore.taskSessionLookup.firstSession(for: task.id)
        let sessionActivity = sessionIndexStore.taskSessionLookup.activity(for: task)
        let rowView = ConsoleTaskRowContent(
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

    @ViewBuilder
    func taskContextMenuContent(
        for task: CorptieTask,
        session: TaskSession?
    ) -> some View {
        TaskFixedDisplayMenuItem(task: task)
        if session == nil && task.deletionStatus == nil {
            Button(L10n("启动状态与恢复"), systemImage: "arrow.clockwise") { taskStartupRecoveryTarget = task }
        }
        if task.hierarchy?.canCreateChild == true {
            Button(L10n("新建子任务"),systemImage:"plus") { taskCreationTarget=TaskCreationTarget(workID:task.workId,parentTaskId:task.id) }
        }
        if let id=task.parentTaskId,let parent=entityClient.tasks.first(where:{$0.id == id}) {
            Button(L10n("打开父任务"),systemImage:"arrow.turn.up.left") {openTask(parent,session:workerSession(for:parent))}
        }
        Divider()
        Button(L10n("Rename"), systemImage: "pencil") {
            taskPendingRename = task
        }
        .disabled(task.deletionStatus == "deleting")
        Button(L10n("编辑"), systemImage: "square.and.pencil") {
            taskPendingEdit = task
        }
        .disabled(task.deletionStatus == "deleting")
        Button(L10n("Restart Task"), systemImage: "arrow.clockwise") {
            restartTask(task)
        }
        .disabled(session?.actions?.restart?.available != true
            || pendingTaskRestartIds.contains(task.id)
            || task.deletionStatus == "deleting")
        DetachedChatWindowMenuButton(session: session)
            .disabled(task.deletionStatus == "deleting")
        Button(task.archived == true ? L10n("恢复 Task") : L10n("归档 Task"), systemImage: "archivebox") {
            Task { await setTaskArchived(task.archived != true, task: task) }
        }
        .disabled(task.deletionStatus == "deleting")
        Divider()
        Button(L10n("删除"), systemImage: "trash", role: .destructive) {
            Task { await prepareTaskDeletion(task) }
        }
        .disabled(pendingTaskDeletionIds.contains(task.id) || task.deletionStatus == "deleting")
    }
}
