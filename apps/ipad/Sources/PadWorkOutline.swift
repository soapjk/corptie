import SwiftUI
import CorptieClientCore
import CorptieConversation

/// Sidebar outline of the iPad workbench. Structure, metrics and leaf views are the
/// macOS `workOutlineList` (Chat group card → Work group cards); only the data source
/// (device inventory) and the touch affordances (always-visible "+", larger hit
/// shapes) differ. Rows read pre-indexed sets from `PadWorkspace` so a render never
/// scans the inventory.
struct PadWorkOutline: View {
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let workAvatars: PadWorkAvatarStore
    let entityCommands: PadEntityCommandState
    let isActive: Bool
    @Binding var expandedWorkIDs: Set<String>
    @Binding var isChatExpanded: Bool
    let createTask: (ClientWork) -> Void
    let onEntityRoute: (PadEntityRoute) -> Void

    private var selectedWorkID: String? {
        workspace.selection.flatMap { workspace.sessionsByID[$0]?.workId }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                chatGroup
                ForEach(workspace.works) { work in
                    workGroup(work)
                }
                if workspace.workCursor != nil || workspace.taskCursor != nil || workspace.sessionCursor != nil {
                    Color.clear
                        .frame(height: 16)
                        .task {
                            guard !connection.busy else { return }
                            await workspace.inventory(connection, more: true)
                        }
                }
            }
            .padding(.horizontal, ConsoleWorkOutlineMetrics.groupHorizontalInset)
            .padding(.vertical, 4)
        }
        .scrollIndicators(.automatic)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    // MARK: Chat group (independent Sessions)

    private var chatGroup: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 0) {
                disclosureButton(isExpanded: isChatExpanded) { toggleChat() }
                Button(action: toggleChat) {
                    HStack(spacing: 7) {
                        ChatGroupIcon()
                        Text("聊天")
                            .font(WorkOutlineMetrics.headerTitleFont)
                            .foregroundStyle(selectedWorkID == nil ? Color.primary : Color.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if workspace.hasUnreadIndependentSessions {
                            UnreadSessionDot()
                        }
                    }
                    .padding(.vertical, WorkOutlineMetrics.headerPadding)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("聊天")
                .accessibilityValue(isChatExpanded ? "已展开" : "已折叠")
                .accessibilityIdentifier("outline-chat-header")
            }
            if isChatExpanded {
                if workspace.independentSessions.isEmpty {
                    emptyRow("暂无独立聊天")
                } else {
                    ForEach(workspace.independentSessions) { session in
                        sessionRow(session)
                            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                            .background(WorkOutlineSelectionBackground(isSelected: workspace.selection == session.id))
                    }
                }
            }
        }
        .modifier(WorkGroupCardSurface())
    }

    private func toggleChat() {
        withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) { isChatExpanded.toggle() }
    }

    private func sessionRow(_ session: ClientSession) -> some View {
        Button {
            workspace.selection = session.id
        } label: {
            HStack(spacing: WorkOutlineMetrics.rowSpacing) {
                SessionExecutionDot(state: SessionExecutionState(executionStatus: session.executionStatus))
                Text(session.title)
                    .font(WorkOutlineMetrics.rowTitleFont)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if workspace.unreadSessionIDs.contains(session.id) {
                    UnreadSessionDot()
                }
            }
            .padding(.vertical, WorkOutlineMetrics.rowPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(workspace.selection == session.id ? "已选中" : "")
        .accessibilityIdentifier("outline-session-\(session.id)")
    }

    // MARK: Work group

    private func workGroup(_ work: ClientWork) -> some View {
        let isExpanded = expandedWorkIDs.contains(work.id)
        return VStack(alignment: .leading, spacing: 2) {
            workHeader(work, isExpanded: isExpanded)
            if isExpanded {
                ForEach(workspace.tasksByWork[work.id] ?? []) { task in
                    let sessionID = workspace.sessionIDByTaskID[task.id]
                    taskRow(task, sessionID: sessionID)
                        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                        .background(WorkOutlineSelectionBackground(
                            isSelected: sessionID != nil && workspace.selection == sessionID))
                }
            }
        }
        .modifier(WorkGroupCardSurface())
        // Lazy per-card fetch; the store dedups by (work, updatedAt) so re-appearance is free.
        .onChange(of: work.updatedAt, initial: true) { workAvatars.ensure(work, connection: connection) }
    }

    private func workHeader(_ work: ClientWork, isExpanded: Bool) -> some View {
        let toggle = { toggleWork(work.id) }
        let isSelected = selectedWorkID == work.id
        return HStack(spacing: 0) {
            disclosureButton(isExpanded: isExpanded, action: toggle)
            Button(action: toggle) {
                HStack(spacing: 7) {
                    PadWorkAvatar(work: work, size: WorkOutlineMetrics.headerIconSize, image: workAvatars.image(for: work))
                    ConsoleWorkTitle(title: work.name,
                        isWorking: workspace.processingWorkIDs.contains(work.id),
                        isActive: isActive)
                        .font(WorkOutlineMetrics.headerTitleFont)
                        .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                        .lineLimit(1)
                }
                .padding(.vertical, WorkOutlineMetrics.headerPadding)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(work.name)
            .accessibilityValue(isExpanded ? "已展开" : "已折叠")
            .accessibilityIdentifier("work-header-\(work.id)")

            ForEach(workspace.discussionsByWork[work.id] ?? []) { discussion in
                WorkDiscussionButton(isSelected: workspace.selection == discussion.id,
                    isRunning: SessionExecutionState(executionStatus: discussion.executionStatus) == .running,
                    isActive: isActive,
                    hasUnread: workspace.unreadSessionIDs.contains(discussion.id),
                    accessibilityState: workspace.selection == discussion.id ? "已选中"
                        : workspace.unreadSessionIDs.contains(discussion.id) ? "未读会话" : "",
                    minimumHitHeight: WorkOutlineMetrics.headerIconSize + WorkOutlineMetrics.headerPadding * 2) {
                        workspace.selection = discussion.id
                    }
                    .padding(.leading, 6)
                    .accessibilityIdentifier("work-discussion-\(discussion.id)")
            }

            Spacer(minLength: 4)

            if !isExpanded, workspace.unreadWorkIDs.contains(work.id) {
                UnreadSessionDot()
            }

            // macOS reveals this on hover; touch has no hover, so it stays visible but quiet.
            Button { createTask(work) } label: {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle().inset(by: -4))
            }
            .buttonStyle(.plain)
            .accessibilityLabel("在 \(work.name) 中创建 Task")
            .accessibilityIdentifier("work-create-task-\(work.id)")
        }
        .contextMenu {
            Button {
                onEntityRoute(.editWork(work))
            } label: {
                Label("编辑", systemImage: "square.and.pencil")
            }
            .disabled(entityCommands.isBusy)
            Divider()
            Button(role: .destructive) {
                onEntityRoute(.deleteWork(work))
            } label: {
                Label("删除", systemImage: "trash")
            }
            .disabled(entityCommands.isBusy)
        }
    }

    private func toggleWork(_ id: String) {
        withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
            if expandedWorkIDs.contains(id) { expandedWorkIDs.remove(id) } else { expandedWorkIDs.insert(id) }
        }
    }

    private func taskRow(_ task: ClientTask, sessionID: String?) -> some View {
        let activity = workspace.activityByTaskID[task.id]
            ?? .resolve(hasBinding: sessionID != nil, sessionExecutionStatus: workspace.executionByTaskID[task.id],
                        taskExecutionStatus: task.executionStatus)
        let isDeleting = task.deletionStatus == "deleting"
        return Button {
            if let sessionID, !workspace.sessionIsKnownUnavailable(sessionID) {
                workspace.selection = sessionID
            }
        } label: {
            HStack(spacing: WorkOutlineMetrics.rowSpacing) {
                TaskActivityIndicator(activity: activity, lifecycleState: task.lifecycleState)
                Text(task.title)
                    .font(WorkOutlineMetrics.rowTitleFont)
                    .lineLimit(1)
                if task.hasPendingScheduledWake {
                    ScheduledWakeIcon(isActive: isActive)
                }
                Spacer(minLength: 0)
                if isDeleting {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityLabel("后台处理中")
                }
                if let sessionID, workspace.unreadSessionIDs.contains(sessionID) {
                    UnreadSessionDot()
                }
            }
            .padding(.vertical, WorkOutlineMetrics.rowPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDeleting)
        .accessibilityValue(activity.labelKey)
        .accessibilityIdentifier("work-task-\(task.id)")
        .contextMenu {
            Button {
                onEntityRoute(.renameTask(task))
            } label: {
                Label("重命名", systemImage: "pencil")
            }
            .disabled(isDeleting || entityCommands.isBusy)

            Button {
                onEntityRoute(.editTask(task))
            } label: {
                Label("编辑", systemImage: "square.and.pencil")
            }
            .disabled(isDeleting || entityCommands.isBusy)

            Button {
                Task {
                    _ = await entityCommands.run(connection, target: .task(task.id), kind: "task_restart", label: "重启 Task") { api, requestID in
                        try await api.taskCommand(taskId: task.id, command: .restart, body: ClientEntityRequest(requestId: requestID))
                    }
                    await workspace.inventory(connection)
                }
            } label: {
                Label("重启 Task", systemImage: "arrow.clockwise")
            }
            .disabled(isDeleting || entityCommands.isBusy || sessionID == nil)

            Button {
                let willArchive = !task.archived
                Task {
                    _ = await entityCommands.run(connection, target: .task(task.id), kind: "task_archive", label: willArchive ? "归档 Task" : "恢复 Task") { api, requestID in
                        try await api.taskCommand(taskId: task.id, command: .archive, body: ClientTaskArchive(requestId: requestID, archived: willArchive))
                    }
                    await workspace.inventory(connection)
                }
            } label: {
                Label(task.archived ? "恢复 Task" : "归档 Task", systemImage: "archivebox")
            }
            .disabled(isDeleting || entityCommands.isBusy)

            Divider()

            Button(role: .destructive) {
                onEntityRoute(.deleteTask(task))
            } label: {
                Label("删除", systemImage: "trash")
            }
            .disabled(isDeleting || entityCommands.isBusy)
        }
    }

    // MARK: Shared pieces

    private func disclosureButton(isExpanded: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            WorkOutlineDisclosureChevron(isExpanded: isExpanded)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isExpanded ? "折叠分组" : "展开分组")
    }

    private func emptyRow(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent + 24)
            .padding(.vertical, WorkOutlineMetrics.rowPadding)
    }
}
