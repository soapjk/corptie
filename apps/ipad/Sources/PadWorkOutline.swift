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
    let showsPersistentSelection: Bool
    let onOpenSession: (String) -> Void
    let createTask: (ClientWork) -> Void
    var createChild: (ClientTask) -> Void = {_ in}
    let onEntityRoute: (PadEntityRoute) -> Void
    @AppStorage("corptie.mobile.workOutlineSort") private var sortRaw = PadOutlineSort.standard.rawValue
    @AppStorage("corptie.mobile.workOutlineView") private var viewMode = "groups"
    @State private var orderedWorks: [ClientWork] = []
    @State private var orderedTasks: [ClientTask] = []
    @State private var tasksByWork: [String: [ClientTask]] = [:]
    @State private var expandedParentIDs: Set<String> = []
    @State private var workNames: [String: String] = [:]
    @State private var visibleChats: [ClientSession] = []
    @State private var isSearching = false
    @State private var searchText = ""
    @State private var showingArchived = false
    @State private var selectedArchivedTask: ClientTask?
    @State private var startupRecoveryTask: ClientTask?
    @State private var fullyExpandedWorkIDs = Set<String>()
    @FocusState private var searchFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .headline) private var phoneHeaderFontSize: CGFloat = 16
    @ScaledMetric(relativeTo: .caption) private var tabletHeaderFontSize: CGFloat = 11
    private var sort: PadOutlineSort { PadOutlineSort(rawValue: sortRaw) ?? .standard }
    private var hasSearch: Bool { !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var isPhone: Bool { UIDevice.current.userInterfaceIdiom == .phone }
    private var headerFont: Font { .system(size: isPhone ? phoneHeaderFontSize : tabletHeaderFontSize, weight: .semibold) }
    private var rowFont: Font { isPhone ? .system(size: 15, weight: .semibold) : WorkOutlineMetrics.rowTitleFont }
    private var rowPadding: CGFloat { isPhone ? 8 : WorkOutlineMetrics.rowPadding }
    private var headerPadding: CGFloat { isPhone ? 8 : WorkOutlineMetrics.headerPadding }

    private var selectedWorkID: String? {
        workspace.selection.flatMap { workspace.sessionsByID[$0]?.workId }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if let notice = connection.connectionStatusNotice(reconnectFailed: workspace.realtimeReconnectFailed) {
                    HStack {
                        Label(notice, systemImage: "wifi.slash")
                        Spacer(minLength: 8)
                        if connection.connected, connection.networkAvailable, connection.recoveryBlockedMessage == nil {
                            Button("重试") { connection.retryRealtimeRecovery() }
                                .buttonStyle(.plain)
                                .frame(minHeight: 44)
                                .accessibilityLabel("重新连接服务器")
                        }
                    }
                        .font(.subheadline)
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(Color(uiColor: .secondarySystemBackground),
                                    in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityIdentifier("server-connection-status")
                }
                if !showingArchived { chatGroup }
                if showingArchived && orderedTasks.isEmpty {
                    Text("没有归档 Task")
                        .font(.caption).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding()
                }
                if viewMode == "tasks" {
                    ForEach(orderedTasks) { task in
                        VStack(alignment: .leading, spacing: 2) {
                            hierarchyTaskRow(task, sessionID: workspace.sessionIDByTaskID[task.id])
                            Text(workNames[task.workId] ?? "Work")
                                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        .padding(8)
                        .modifier(WorkGroupCardSurface())
                        .background(WorkOutlineSelectionBackground(isSelected:
                            showsPersistentSelection
                                && (workspace.sessionIDByTaskID[task.id].map { $0 == workspace.selection } ?? false)))
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
        .sheet(item: $startupRecoveryTask) { task in
            ConversationTaskStartupRecovery(taskId: task.id, api: {
                guard let source = workspace.sessions.first(where: { $0.workId == task.workId && $0.sessionKind == "workChat" })
                    ?? workspace.sessions.first(where: { $0.workId == task.workId && $0.taskId == (task.parentTaskId ?? task.id) }) else {
                    throw ClientConnectionError.invalidResponse
                }
                return ClientTaskStartupAPI(transport: try await connection.transport(), route: .paired, sourceSessionId: source.id)
            }, openSession: onOpenSession, openParent: { parentId in
                if let sessionId = workspace.sessionIDByTaskID[parentId] { onOpenSession(sessionId) }
            })
        }
        .onChange(of: workspace.works, initial: true) { _, _ in rebuildOrder() }
        .onChange(of: workspace.tasks) { _, _ in rebuildOrder() }
        .onChange(of: expandedParentIDs) { _, _ in rebuildOrder() }
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
        let needed=Set(orderedTasks.compactMap(\.parentTaskId)).subtracting(Set(orderedTasks.map(\.id)))
        orderedTasks.append(contentsOf:workspace.tasks.filter{needed.contains($0.id)})
        let byID=Dictionary(orderedTasks.map{($0.id,$0)},uniquingKeysWith:{$1})
        orderedTasks=TaskHierarchyIndex.visibleOrder(nodes:orderedTasks.map{.init(id:$0.id,workId:$0.workId,parentTaskId:$0.parentTaskId)},
            expanded:query.isEmpty ? expandedParentIDs : Set(orderedTasks.map(\.id))).compactMap{byID[$0]}
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
        PlatformWorkOutlineToolbar(
            topInset: isPhone ? 0 : PlatformWorkOutlineLayout.verticalInset
        ) {
            Menu {
                Picker("排序方式", selection: $sortRaw) {
                    ForEach(PadOutlineSort.allCases, id: \.rawValue) { mode in
                        Text(mode.title).tag(mode.rawValue)
                    }
                }
            } label: { PlatformWorkOutlineToolbarGlyph(symbol: "arrow.up.arrow.down") }
            .platformWorkOutlineToolbarControl()
            .accessibilityLabel("排序方式")
            .accessibilityValue(sort.title)
            .accessibilityIdentifier("work-outline-sort")
            Menu {
                Picker("视图", selection: $viewMode) {
                    Text("Work 分组").tag("groups")
                    Text("卡片").tag("tasks")
                }
            } label: {
                PlatformWorkOutlineToolbarGlyph(
                    symbol: viewMode == "tasks" ? "rectangle.grid.2x2" : "rectangle.3.group"
                )
            }
            .platformWorkOutlineToolbarControl()
            .accessibilityLabel("切换视图")
            .accessibilityValue(viewMode == "tasks" ? "卡片" : "Work 分组")
            .accessibilityIdentifier("work-outline-view")
            Button {
                isSearching = true
                searchFocused = true
            } label: { PlatformWorkOutlineToolbarGlyph(symbol: "magnifyingglass") }
            .platformWorkOutlineToolbarControl()
            .accessibilityLabel("搜索").accessibilityIdentifier("work-outline-search")
            Button {
                showingArchived.toggle()
            } label: {
                PlatformWorkOutlineToolbarGlyph(
                    symbol: showingArchived ? "archivebox.fill" : "archivebox",
                    color: showingArchived ? .accentColor : .primary
                )
            }
            .platformWorkOutlineToolbarControl()
            .accessibilityLabel(showingArchived ? "返回活动 Task" : "查看归档 Task")
            .accessibilityIdentifier("work-outline-archive")
        } trailing: {
            Menu {
                Button("新增 Work", systemImage: "folder.badge.plus") { onEntityRoute(.createWork) }
                if let work = workspace.works.first(where: { $0.id == selectedWorkID }) {
                    Button("在当前 Work 新增 Task", systemImage: "plus") { createTask(work) }
                }
                Menu("选择 Work 新增 Task") {
                    ForEach(orderedWorks) { work in Button(work.name) { createTask(work) } }
                }
                .disabled(orderedWorks.isEmpty)
            } label: { PlatformWorkOutlineToolbarGlyph(symbol: "plus") }
            .platformWorkOutlineToolbarControl()
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
            .padding(.horizontal, PlatformWorkOutlineLayout.horizontalInset)
            .padding(.bottom, PlatformWorkOutlineLayout.verticalInset)
        }
        }
        .buttonStyle(.plain)
        .environment(\.layoutDirection, .leftToRight)
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
            .contextMenu {
                Button {
                    onEntityRoute(.createChat)
                } label: {
                    Label("新建 Chat", systemImage: "plus.bubble")
                }
                .disabled(!connection.connected || entityCommands.isBusy)
                .accessibilityIdentifier("outline-create-chat")
            }
            if isChatExpanded || hasSearch {
                if visibleChats.isEmpty {
                    emptyRow(showingArchived ? "归档 Task 显示在 Work 分组中" : "暂无匹配聊天")
                } else {
                    ForEach(visibleChats) { session in
                        sessionRow(session)
                            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                            .background(WorkOutlineSelectionBackground(
                                isSelected: showsPersistentSelection && workspace.selection == session.id))
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
        .accessibilityValue(showsPersistentSelection && workspace.selection == session.id ? "已选中" : "")
        .accessibilityIdentifier("outline-session-\(session.id)")
    }

    // MARK: Work group

    private func workGroup(_ work: ClientWork) -> some View {
        let isExpanded = expandedWorkIDs.contains(work.id) || hasSearch
        let tasks = tasksByWork[work.id] ?? []
        let visibleTaskCount = WorkOutlineTaskDisclosurePolicy.visibleCount(
            totalCount: tasks.count,
            showsAll: fullyExpandedWorkIDs.contains(work.id),
            isSearching: hasSearch,
            isShowingArchive: showingArchived
        )
        let hiddenTaskCount = tasks.count - visibleTaskCount
        return VStack(alignment: .leading, spacing: 2) {
            workHeader(work, isExpanded: isExpanded)
            if isExpanded {
                ForEach(tasks.prefix(visibleTaskCount)) { task in
                    let sessionID = workspace.sessionIDByTaskID[task.id]
                    hierarchyTaskRow(task, sessionID: sessionID)
                        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                        .background(WorkOutlineSelectionBackground(
                            isSelected: showsPersistentSelection
                                && sessionID != nil && workspace.selection == sessionID))
                }
                if hiddenTaskCount > 0 {
                    showAllTasksButton(workID: work.id, hiddenCount: hiddenTaskCount)
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
        return WorkOutlineHeaderRow(minimumHeight: 44, toggleExpanded: toggle) {
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
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    }
                }
                .padding(.vertical, headerPadding)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(work.name)
            .accessibilityValue(isExpanded ? "已展开" : "已折叠")
            .accessibilityIdentifier("work-header-\(work.id)")

        } discussion: {
            if discussions.count == 1, let discussion = discussions.first {
                workDiscussionButton(discussion).padding(.leading, 6)
            } else if !discussions.isEmpty {
              ViewThatFits(in: .horizontal) {
                HStack(spacing: 6) {
                  ForEach(discussions) { discussion in
                    workDiscussionButton(discussion)
                  }
                }
                .fixedSize(horizontal: true, vertical: false)
                Menu {
                    ForEach(discussions) { discussion in
                        let states = [showsPersistentSelection && workspace.selection == discussion.id ? "已选中" : "",
                            workspace.unreadSessionIDs.contains(discussion.id) ? "未读" : "",
                            SessionExecutionState(executionStatus: discussion.executionStatus) == .running ? "运行中" : ""]
                            .filter { !$0.isEmpty }.joined(separator: " · ")
                        Button { onOpenSession(discussion.id) } label: {
                            Label(states.isEmpty ? discussion.title : "\(discussion.title) · \(states)", systemImage: "bubble.left")
                        }
                    }
                } label: {
                    WorkDiscussionLabel(isSelected: showsPersistentSelection && discussions.contains { workspace.selection == $0.id },
                        isRunning: discussions.contains { SessionExecutionState(executionStatus: $0.executionStatus) == .running },
                        isActive: isActive, hasUnread: discussions.contains { workspace.unreadSessionIDs.contains($0.id) },
                        title: discussions.count > 1 ? "讨论 \(discussions.count)" : "讨论", minimumHitHeight: 44)
                }
                .buttonStyle(.plain)
                .frame(minWidth: 44, minHeight: 44)
                .contentShape(Rectangle())
                .fixedSize()
                .accessibilityLabel("选择 Work 讨论")
                .accessibilityIdentifier("work-discussions-menu-\(work.id)")
              }
              .padding(.leading, 6)
            }
        } actions: {
            if !isExpanded, workspace.unreadWorkIDs.contains(work.id) {
                UnreadSessionDot()
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

    private func workDiscussionButton(_ discussion: ClientSession) -> some View {
        WorkDiscussionButton(isSelected: showsPersistentSelection && workspace.selection == discussion.id,
            isRunning: SessionExecutionState(executionStatus: discussion.executionStatus) == .running,
            isActive: isActive, hasUnread: workspace.unreadSessionIDs.contains(discussion.id),
            accessibilityState: showsPersistentSelection && workspace.selection == discussion.id ? "已选中"
                : workspace.unreadSessionIDs.contains(discussion.id) ? "未读会话" : "",
            minimumHitHeight: 44) { onOpenSession(discussion.id) }
            .accessibilityIdentifier("work-discussion-\(discussion.id)")
    }

    private func toggleWork(_ id: String) {
        guard !hasSearch else { return }
        withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
            if expandedWorkIDs.contains(id) {
                fullyExpandedWorkIDs.remove(id)
                expandedWorkIDs.remove(id)
            } else {
                expandedWorkIDs.insert(id)
            }
        }
    }

    private func showAllTasksButton(workID: String, hiddenCount: Int) -> some View {
        Button {
            fullyExpandedWorkIDs.insert(workID)
        } label: {
            Label("展开其余 \(hiddenCount) 个 Task", systemImage: "chevron.down")
                .font(isPhone ? .caption : .system(size: 10, weight: .medium))
                .foregroundStyle(.secondary)
                .padding(.vertical, rowPadding)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent + 24)
        .accessibilityLabel("展开全部 Task，还剩 \(hiddenCount) 个")
    }

    private func hierarchyTaskRow(_ task: ClientTask, sessionID: String?) -> some View {
        HStack(spacing:4) {
            if (task.hierarchy?.childCount ?? 0)>0 {
                Button {
                    if !expandedParentIDs.insert(task.id).inserted {expandedParentIDs.remove(task.id)}
                    else { Task { await workspace.loadTaskChildren(task,connection:connection) } }
                } label: {Image(systemName:expandedParentIDs.contains(task.id) ? "chevron.down" : "chevron.right").frame(minWidth:24,minHeight:32)}
                .buttonStyle(.plain).accessibilityLabel("展开子任务")
                if expandedParentIDs.contains(task.id), workspace.taskChildrenCursors[task.id] != nil {
                    Button { Task { await workspace.loadTaskChildren(task,connection:connection,more:true) } }
                    label: { Image(systemName:"ellipsis").frame(minWidth:24,minHeight:32) }
                    .buttonStyle(.plain).accessibilityLabel("加载更多子任务")
                }
            }
            taskRow(task,sessionID:sessionID)
            if let hierarchy=task.hierarchy, hierarchy.childCount > 0 {
                Text("\(hierarchy.completedChildCount)/\(hierarchy.childCount)")
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    .accessibilityLabel("子任务完成进度")
            }
        }.padding(.leading,task.parentTaskId == nil ? 0 : 14)
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
            if sessionID == nil && task.deletionStatus == nil {
                Button("启动状态与恢复", systemImage: "arrow.clockwise") { startupRecoveryTask = task }
            }
            if task.hierarchy?.canCreateChild == true {
                Button("新建子任务",systemImage:"plus") {createChild(task)}
            }
            if let parentID=task.parentTaskId,let sessionID=workspace.sessionIDByTaskID[parentID] {
                Button("打开父任务",systemImage:"arrow.turn.up.left") {onOpenSession(sessionID)}
            }
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
