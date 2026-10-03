import SwiftUI
import CorptieClientCore
import CorptieConversation

/// Sidebar outline of the iPad workbench. Structure, metrics and leaf views are the
/// macOS `workOutlineList` (Chat group card → Work group cards); only the data source
/// (device inventory) and the touch affordances (larger hit
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
    let onOpenSession: (String) -> Void
    let createTask: (ClientWork) -> Void
    let onEntityRoute: (PadEntityRoute) -> Void
    @AppStorage("corptie.mobile.workOutlineSort") private var sortRaw = PadOutlineSort.standard.rawValue
    @AppStorage("corptie.mobile.workOutlineView") private var viewMode = "groups"
    @State private var orderedWorks: [ClientWork] = []
    @State private var orderedTasks: [ClientTask] = []
    @State private var tasksByWork: [String: [ClientTask]] = [:]
    @State private var workNames: [String: String] = [:]
    @State private var visibleChats: [ClientSession] = []
    @State private var isSearching = false
    @State private var searchText = ""
    @State private var showingArchived = false
    @State private var selectedArchivedTask: ClientTask?
    @FocusState private var searchFocused: Bool
    private var sort: PadOutlineSort { PadOutlineSort(rawValue: sortRaw) ?? .standard }
    private var hasSearch: Bool { !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }
    private var headerFont: Font { isPhone ? .system(size: 16, weight: .semibold) : WorkOutlineMetrics.headerTitleFont }
    private var rowFont: Font { isPhone ? .system(size: 15, weight: .semibold) : WorkOutlineMetrics.rowTitleFont }
    private var rowPadding: CGFloat { isPhone ? 8 : WorkOutlineMetrics.rowPadding }
    private var headerPadding: CGFloat { isPhone ? 8 : WorkOutlineMetrics.headerPadding }

    private var selectedWorkID: String? {
        workspace.selection.flatMap { workspace.sessionsByID[$0]?.workId }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if !showingArchived { chatGroup }
                if showingArchived && orderedTasks.isEmpty {
                    Text("没有归档 Task")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding()
                }
                if viewMode == "tasks" {
                    ForEach(orderedTasks) { task in
                        VStack(alignment: .leading, spacing: 2) {
                            taskRow(task, sessionID: workspace.sessionIDByTaskID[task.id])
                            Text(workNames[task.workId] ?? "Work")
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .padding(8)
                        .modifier(WorkGroupCardSurface())
                        .background(WorkOutlineSelectionBackground(isSelected:
                            workspace.sessionIDByTaskID[task.id].map { $0 == workspace.selection } ?? false))
                    }
                } else {
                    ForEach(orderedWorks) { work in workGroup(work) }
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
            .environment(\.layoutDirection, .leftToRight)
        }
        // The floating iPhone tab bar is outside this scroll view. Keep the
        // final row scrollable above it without adding a visible full-width bar.
        .contentMargins(.bottom, isPhone ? 82 : 0, for: .scrollContent)
        .environment(\.layoutDirection, .rightToLeft)
        .scrollIndicators(.automatic)
        .safeAreaInset(edge: .top, spacing: 0) { outlineToolbar }
        .background(WorkbenchCanvasSurface.color)
        .onChange(of: workspace.works, initial: true) { _, _ in rebuildOrder() }
        .onChange(of: workspace.tasks) { _, _ in rebuildOrder() }
        .onChange(of: sortRaw) { _, _ in rebuildOrder() }
        .onChange(of: viewMode) { _, _ in rebuildOrder() }
        .onChange(of: searchText) { _, _ in rebuildOrder() }
        .onChange(of: showingArchived) { _, _ in rebuildOrder() }
        .onChange(of: workspace.independentSessions) { _, _ in rebuildOrder() }
        .onChange(of: workspace.latestSessionActivityByWork) { _, activity in
            guard sort == .updated else { return }
            rebuildOrder()
        }
        .onChange(of: workspace.latestSessionActivityByTask) { _, activity in
            guard sort == .updated else { return }
            rebuildOrder()
        }
        .confirmationDialog("归档 Task", isPresented: Binding(
            get: { selectedArchivedTask != nil },
            set: { if !$0 { selectedArchivedTask = nil } }
        ), titleVisibility: .visible, presenting: selectedArchivedTask) { task in
            Button("恢复 Task") { toggleTaskArchive(task) }
            Button("编辑 Task") { onEntityRoute(.editTask(task)) }
        } message: { task in
            Text(task.title)
        }
    }

    private func rebuildOrder() {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        orderedWorks = sort.works(workspace.works, latestSessionActivity: workspace.latestSessionActivityByWork)
        workNames = Dictionary(workspace.works.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
        orderedTasks = sort.tasks(workspace.tasks, latestSessionActivity: workspace.latestSessionActivityByTask,
                                 showingArchived: showingArchived).filter {
            query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)
                    || ($0.description ?? "").localizedCaseInsensitiveContains(query)
                    || (workNames[$0.workId] ?? "").localizedCaseInsensitiveContains(query)
        }
        tasksByWork = Dictionary(grouping: orderedTasks, by: \.workId)
        if !query.isEmpty || showingArchived {
            orderedWorks = orderedWorks.filter {
                tasksByWork[$0.id] != nil || (!showingArchived && $0.name.localizedCaseInsensitiveContains(query))
            }
        }
        let chats = showingArchived ? [] : workspace.independentSessions.filter {
            query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)
        }
        visibleChats = sort.ordered(chats, id: { $0.id }, title: { $0.title },
                                   updatedAt: { $0.updatedAt }, activityAt: { $0.lastMessageAt })
    }

    private var outlineToolbar: some View {
        VStack(spacing: 4) {
        HStack(spacing: 8) {
            Menu {
                Picker("排序方式", selection: $sortRaw) {
                    ForEach(PadOutlineSort.allCases, id: \.rawValue) { mode in
                        Text(mode.title).tag(mode.rawValue)
                    }
                }
            } label: { toolbarGlyph("arrow.up.arrow.down") }
            .accessibilityLabel("排序方式")
            .accessibilityValue(sort.title)
            .accessibilityIdentifier("work-outline-sort")
            Menu {
                Picker("视图", selection: $viewMode) {
                    Text("Work 分组").tag("groups")
                    Text("卡片").tag("tasks")
                }
            } label: { toolbarGlyph(viewMode == "tasks" ? "rectangle.grid.2x2" : "rectangle.3.group") }
            .accessibilityLabel("切换视图")
            .accessibilityValue(viewMode == "tasks" ? "卡片" : "Work 分组")
            .accessibilityIdentifier("work-outline-view")
            Button {
                isSearching = true
                searchFocused = true
            } label: { toolbarGlyph("magnifyingglass") }
            .accessibilityLabel("搜索").accessibilityIdentifier("work-outline-search")
            Button {
                showingArchived.toggle()
            } label: { toolbarGlyph(showingArchived ? "archivebox.fill" : "archivebox") }
            .foregroundStyle(showingArchived ? Color.accentColor : Color.primary)
            .accessibilityLabel(showingArchived ? "返回活动 Task" : "查看归档 Task")
            .accessibilityIdentifier("work-outline-archive")
            Spacer(minLength: 0)
            Menu {
                Button("新增 Work", systemImage: "folder.badge.plus") { onEntityRoute(.createWork) }
                if let work = workspace.works.first(where: { $0.id == selectedWorkID }) {
                    Button("在当前 Work 新增 Task", systemImage: "plus") { createTask(work) }
                }
                Menu("选择 Work 新增 Task") {
                    ForEach(orderedWorks) { work in Button(work.name) { createTask(work) } }
                }
                .disabled(orderedWorks.isEmpty)
            } label: { toolbarGlyph("plus") }
            .disabled(entityCommands.isBusy)
            .accessibilityLabel("新增 Work 或 Task")
            .accessibilityIdentifier("work-outline-create")
        }
        if isSearching {
            HStack {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                TextField("搜索 Work、Task 和聊天", text: $searchText)
                    .textFieldStyle(.plain).focused($searchFocused)
                    .submitLabel(.search)
                Button {
                    searchText = ""
                    isSearching = false
                    searchFocused = false
                } label: { Image(systemName: "xmark.circle.fill") }
                .accessibilityLabel("关闭搜索")
            }
            .padding(8)
            .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
        }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .environment(\.layoutDirection, .leftToRight)
    }

    private func toolbarGlyph(_ symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.system(size: 16, weight: .medium))
            .frame(width: 36, height: 36)
            .padGlassSurface(in: Circle())
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
    }

    // MARK: Chat group (independent Sessions)

    private var chatGroup: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button(action: toggleChat) {
                HStack(spacing: 0) {
                    WorkOutlineDisclosureChevron(isExpanded: isChatExpanded || hasSearch)
                    HStack(spacing: 7) {
                        ChatGroupIcon()
                        Text("聊天")
                            .font(headerFont)
                            .foregroundStyle(selectedWorkID == nil ? Color.primary : Color.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                        if workspace.hasUnreadIndependentSessions {
                            UnreadSessionDot()
                        }
                    }
                }
                .padding(.vertical, headerPadding)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("聊天")
            .accessibilityValue(isChatExpanded || hasSearch ? "已展开" : "已折叠")
            .accessibilityIdentifier("outline-chat-header")
            if isChatExpanded || hasSearch {
                if visibleChats.isEmpty {
                    emptyRow(showingArchived ? "归档 Task 显示在 Work 分组中" : "暂无匹配聊天")
                } else {
                    ForEach(visibleChats) { session in
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
        guard !hasSearch else { return }
        withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) { isChatExpanded.toggle() }
    }

    private func sessionRow(_ session: ClientSession) -> some View {
        Button {
            onOpenSession(session.id)
        } label: {
            HStack(spacing: WorkOutlineMetrics.rowSpacing) {
                SessionExecutionDot(state: SessionExecutionState(executionStatus: session.executionStatus))
                Text(session.title)
                    .font(rowFont)
                    .lineLimit(1)
                Spacer(minLength: 0)
                if workspace.unreadSessionIDs.contains(session.id) {
                    UnreadSessionDot()
                }
            }
            .padding(.vertical, rowPadding)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityValue(workspace.selection == session.id ? "已选中" : "")
        .accessibilityIdentifier("outline-session-\(session.id)")
    }

    // MARK: Work group

    private func workGroup(_ work: ClientWork) -> some View {
        let isExpanded = expandedWorkIDs.contains(work.id) || hasSearch
        return VStack(alignment: .leading, spacing: 2) {
            workHeader(work, isExpanded: isExpanded)
            if isExpanded {
                ForEach(tasksByWork[work.id] ?? []) { task in
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
        let discussions = workspace.discussionsByWork[work.id] ?? []
        return HStack(spacing: 0) {
            Button(action: toggle) {
                HStack(spacing: 0) {
                    WorkOutlineDisclosureChevron(isExpanded: isExpanded)
                    HStack(spacing: 7) {
                        PadWorkAvatar(work: work, size: isPhone ? 28 : WorkOutlineMetrics.headerIconSize,
                            image: workAvatars.image(for: work))
                        ConsoleWorkTitle(title: work.name,
                            isWorking: workspace.processingWorkIDs.contains(work.id),
                            isActive: isActive)
                            .font(headerFont)
                            .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                            .lineLimit(1)
                    }
                    if discussions.isEmpty {
                        Spacer(minLength: 4)
                        if !isExpanded, workspace.unreadWorkIDs.contains(work.id) {
                            UnreadSessionDot()
                        }
                    }
                }
                .padding(.vertical, headerPadding)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(work.name)
            .accessibilityValue(isExpanded ? "已展开" : "已折叠")
            .accessibilityIdentifier("work-header-\(work.id)")

            if !discussions.isEmpty {
                ForEach(discussions) { discussion in
                    WorkDiscussionButton(isSelected: workspace.selection == discussion.id,
                        isRunning: SessionExecutionState(executionStatus: discussion.executionStatus) == .running,
                        isActive: isActive,
                        hasUnread: workspace.unreadSessionIDs.contains(discussion.id),
                        accessibilityState: workspace.selection == discussion.id ? "已选中"
                            : workspace.unreadSessionIDs.contains(discussion.id) ? "未读会话" : "",
                        minimumHitHeight: WorkOutlineMetrics.headerIconSize + WorkOutlineMetrics.headerPadding * 2) {
                            onOpenSession(discussion.id)
                        }
                        .padding(.leading, 6)
                        .accessibilityIdentifier("work-discussion-\(discussion.id)")
                }

                Button(action: toggle) {
                    HStack(spacing: 0) {
                        Spacer(minLength: 4)
                        if !isExpanded, workspace.unreadWorkIDs.contains(work.id) {
                            UnreadSessionDot()
                        }
                    }
                    .padding(.vertical, headerPadding)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHidden(true)
            }
        }
        .contextMenu {
            Button {
                createTask(work)
            } label: {
                Label("新建 Task", systemImage: "plus")
            }
            .disabled(entityCommands.isBusy)
            Divider()
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
        guard !hasSearch else { return }
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
            if showingArchived {
                selectedArchivedTask = task
            } else if let sessionID, !workspace.sessionIsKnownUnavailable(sessionID) {
                onOpenSession(sessionID)
            }
        } label: {
            HStack(spacing: WorkOutlineMetrics.rowSpacing) {
                TaskActivityIndicator(activity: activity, lifecycleState: task.lifecycleState)
                Text(task.title)
                    .font(rowFont)
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
            .padding(.vertical, rowPadding)
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
                }
            } label: {
                Label("重启 Task", systemImage: "arrow.clockwise")
            }
            .disabled(isDeleting || entityCommands.isBusy || sessionID == nil)

            Button {
                toggleTaskArchive(task)
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

    private func toggleTaskArchive(_ task: ClientTask) {
        guard !entityCommands.isBusy, task.deletionStatus != "deleting" else { return }
        let willArchive = !task.archived
        Task {
            _ = await entityCommands.run(connection, target: .task(task.id), kind: "task_archive",
                                          label: willArchive ? "归档 Task" : "恢复 Task") { api, requestID in
                try await api.taskCommand(taskId: task.id, command: .archive,
                    body: ClientTaskArchive(requestId: requestID, archived: willArchive))
            }
        }
    }

    private func emptyRow(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent + 24)
            .padding(.vertical, WorkOutlineMetrics.rowPadding)
    }
}
