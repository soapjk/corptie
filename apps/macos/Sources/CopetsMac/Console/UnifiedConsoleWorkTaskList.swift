import AppKit
import CorptieConversation
import SwiftUI

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
            ForEach(archivedTasks) { task in
                taskRow(task)
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
                ForEach(visibleWorkTasks) { task in
                    taskRow(task)
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
            ?? backendClient.archivedSessions.first { $0.taskId == task.id }
        let sessionActivity = CorptieTaskBoundSessionActivity.resolve(
            task: task,
            sessions: backendClient.sessions
        )
        let rowView = ConsoleTaskRowContent(
            task: task,
            sessionActivity: sessionActivity,
            isSelected: selectedTaskId == task.id,
            isUnread: session.map(isSessionUnread) ?? false
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
