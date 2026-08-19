import SwiftUI

// 控制台主视图：三栏布局。
// 净新增独立文件，不碰 FloatingRootView.swift 巨石。
//
// 左栏使用原生 Objective Sidebar；中栏平铺 WorkItem 看板；右栏是独立的详情卡片。

struct WarRoomView: View {
    @StateObject private var client = EntityAPIClient.shared
    @StateObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    @State private var selectedObjectiveId: String?
    @State private var selectedWorkItemId: String?
    @State private var workItems: [WorkItem] = []
    @State private var workItemsReloadToken = 0
    @State private var objectiveExpanded = true
    @State private var isCreatingObjective = false
    @State private var objectivePendingEdit: Objective?
    /// 记录用户最后选中的 Objective，跨窗口/重启恢复，避免有 Objective 时看板空白。
    private static let lastSelectedObjectiveKey = "warRoom.lastSelectedObjectiveId"
    /// 记录用户最后选中的 WorkItem；与 Objective 一起恢复，重启后直接展示其详情。
    private static let lastSelectedWorkItemKey = "warRoom.lastSelectedWorkItemId"

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            NavigationSplitView(columnVisibility: $router.sidebarVisibility) {
                objectiveSidebar
                    .toolbar(removing: .sidebarToggle)
                    .navigationSplitViewColumnWidth(
                        min: TwoPaneLayoutMetrics.sidebarWidth,
                        ideal: TwoPaneLayoutMetrics.sidebarWidth,
                        max: max(TwoPaneLayoutMetrics.sidebarWidth, w * 0.34)
                    )
            } detail: {
                consoleWorkspace
            }
            .toolbar(removing: .sidebarToggle)
        }
        .task {
            await client.refreshObjectives()
            // WorkItem 只持久化绑定的 repository id；详情页需要仓库目录将其解析为名称。
            // App 重启后 repositories 缓存为空，若不主动刷新会把有效绑定误显示为“未绑定”。
            if client.repositories.isEmpty {
                await client.refreshRepositories()
            }
        }
        .onAppear {
            // 切 Tab 会重建视图、@State 重置为 nil，这里恢复上次选中的 Objective。
            restoreSelectionIfNeeded(client.objectives)
        }
        .task(id: selectedObjectiveId) {
            // 选中目标变化时拉取其工作项（三栏共享同一份 workItems）
            if let objectiveId = selectedObjectiveId,
               let objective = client.objectives.first(where: { $0.id == objectiveId }) {
                if let loaded = await client.workItems(for: objective) {
                    workItems = loaded
                }
            } else {
                workItems = []
                client.clearWorkItemsLoadError()
            }
        }
        .task(id: workItemsReloadToken) {
            // 执行/换 Agent/保存后强制重新拉取，看板列与「当前执行」才能反映真实状态。
            guard workItemsReloadToken != 0 else { return }
            if let objectiveId = selectedObjectiveId,
               let objective = client.objectives.first(where: { $0.id == objectiveId }) {
                if let loaded = await client.workItems(for: objective) {
                    workItems = loaded
                }
            }
        }
        .onChange(of: client.objectives) { _, objectives in
            // 优先恢复上次选中的 Objective；否则回退到第一个。
            restoreSelectionIfNeeded(objectives)
        }
        .onChange(of: selectedObjectiveId) { _, newValue in
            selectedWorkItemId = nil
            if let newValue {
                Self.recordObjectiveId(newValue)
            }
        }
        .onChange(of: workItems) { _, items in
            restoreWorkItemSelectionIfNeeded(items)
        }
        .onChange(of: client.workItemsRevision) { _, _ in
            workItemsReloadToken &+= 1
        }
        .onChange(of: selectedWorkItemId) { _, newValue in
            if let newValue {
                Self.recordWorkItemId(newValue)
            }
        }
        .sheet(item: $objectivePendingEdit) { objective in
            ObjectiveDetailView(objective: objective)
        }
    }

    // MARK: - 右侧 WorkItem 详情卡片

    private var consoleWorkspace: some View {
        HStack(spacing: TwoPaneLayoutMetrics.contentPadding) {
            warRoomContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            workItemDetailCard
        }
        .padding(.trailing, TwoPaneLayoutMetrics.contentPadding)
    }

    private var workItemDetailCard: some View {
        workItemDetail
            .frame(width: TwoPaneLayoutMetrics.detailCardWidth)
            .frame(maxHeight: .infinity)
        .clipShape(
            RoundedRectangle(
                cornerRadius: TwoPaneLayoutMetrics.cardCornerRadius,
                style: .continuous
            )
        )
        .background(
            .regularMaterial,
            in: RoundedRectangle(
                cornerRadius: TwoPaneLayoutMetrics.cardCornerRadius,
                style: .continuous
            )
        )
        .overlay {
            RoundedRectangle(
                cornerRadius: TwoPaneLayoutMetrics.cardCornerRadius,
                style: .continuous
            )
            .stroke(Color(nsColor: .separatorColor).opacity(0.42), lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(0.055), radius: 9, x: 0, y: 3)
        .padding(.vertical, TwoPaneLayoutMetrics.contentPadding)
    }

    // MARK: - Sidebar

    private var objectiveSidebar: some View {
        List(selection: $selectedObjectiveId) {
            Section {
                DisclosureGroup(isExpanded: $objectiveExpanded) {
                    if client.isLoading && client.objectives.isEmpty {
                        ProgressView()
                            .frame(maxWidth: .infinity, alignment: .center)
                    } else if client.objectives.isEmpty {
                        sidebarEmptyState(L10n("No Objectives"))
                    } else {
                        ForEach(client.objectives) { objective in
                            Label(objective.name, systemImage: "target")
                                .tag(objective.id)
                                .contextMenu {
                                    Button(L10n("编辑")) {
                                        objectivePendingEdit = objective
                                    }
                                }
                        }
                    }
                } label: {
                    sidebarSectionHeader("Objective", systemImage: "target", action: { isCreatingObjective = true })
                }
            }
        }
        .listStyle(.sidebar)
        .overlay(alignment: .bottom) {
            if let error = client.objectivesLoadError {
                if backendClient.isOnline {
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Label(L10n("Connecting to the server…"), systemImage: "network")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .sheet(isPresented: $isCreatingObjective) {
            ObjectiveCreateView()
        }
    }

    // 展开区 header：名称 + 右侧加号
    private func sidebarSectionHeader(_ title: String, systemImage: String, action: @escaping () -> Void) -> some View {
        HStack {
            Label(title, systemImage: systemImage)
            Spacer()
            Button(action: action) {
                Image(systemName: "plus")
            }
            .buttonStyle(.borderless)
            .help(L10nFormat("New %@", title))
        }
    }

    // 空状态：仅提示文字（header 已有常驻加号）
    private func sidebarEmptyState(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(.vertical, 2)
    }

    // MARK: - Content（控制台看板）

    @ViewBuilder
    private var warRoomContent: some View {
        if let error = client.workItemsLoadError,
           client.objectives.contains(where: { $0.id == selectedObjectiveId }) {
            ContentUnavailableView {
                Label(L10n("WorkItem 加载失败"), systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button(L10n("重试")) {
                    workItemsReloadToken &+= 1
                }
            }
        } else if let objective = client.objectives.first(where: { $0.id == selectedObjectiveId }) {
            WorkItemBoardView(
                objective: objective,
                items: workItems,
                selectedWorkItemId: $selectedWorkItemId,
                onRequestReload: { workItemsReloadToken &+= 1 }
            )
        } else if client.objectives.isEmpty {
            ContentUnavailableView(
                L10n("No Objectives"),
                systemImage: "target",
                description: Text(L10n("通过助手对话或快捷输入创建第一个目标"))
            )
        } else {
            ContentUnavailableView(L10n("选择目标"), systemImage: "sidebar.left")
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var workItemDetail: some View {
        if let workItem = workItems.first(where: { $0.id == selectedWorkItemId }) {
            WorkItemDetailView(
                workItem: workItem,
                workspaceIds: client.objectives.first(where: { $0.id == selectedObjectiveId })?.workspaceIds ?? [],
                contributorAgentIds: client.objectives.first(where: { $0.id == selectedObjectiveId })?.contributorAgentIds ?? [],
                onRequestReload: { workItemsReloadToken &+= 1 }
            )
        } else {
            ContentUnavailableView(L10n("选择工作项"), systemImage: "square.grid.2x2")
        }
    }

    // MARK: - 上次选中 Objective 的持久化

    private func restoreSelectionIfNeeded(_ objectives: [Objective]) {
        guard selectedObjectiveId == nil, !objectives.isEmpty else { return }
        let lastId = Self.restoredObjectiveId()
        if let last = objectives.first(where: { $0.id == lastId }) {
            selectedObjectiveId = last.id
        } else if let first = objectives.first {
            selectedObjectiveId = first.id
        }
    }

    private static func recordObjectiveId(_ id: String) {
        CorptieAppEnvironment.userDefaults.set(id, forKey: lastSelectedObjectiveKey)
    }

    private static func restoredObjectiveId() -> String? {
        CorptieAppEnvironment.userDefaults.string(forKey: lastSelectedObjectiveKey)
    }

    // MARK: - 上次选中 WorkItem 的持久化

    private func restoreWorkItemSelectionIfNeeded(_ items: [WorkItem]) {
        guard !items.isEmpty else {
            selectedWorkItemId = nil
            return
        }

        // 刷新列表时保留仍然有效的当前选择；首次进入或切换 Objective 时，
        // 优先恢复上次选择。若它已删除，则选择当前 Objective 的第一个工作项，
        // 保证详情栏不会停留在无效的空状态。
        if let selectedWorkItemId,
           items.contains(where: { $0.id == selectedWorkItemId }) {
            return
        }
        if let lastId = Self.restoredWorkItemId(),
           let last = items.first(where: { $0.id == lastId }) {
            selectedWorkItemId = last.id
        } else {
            selectedWorkItemId = items.first?.id
        }
    }

    private static func recordWorkItemId(_ id: String) {
        CorptieAppEnvironment.userDefaults.set(id, forKey: lastSelectedWorkItemKey)
    }

    private static func restoredWorkItemId() -> String? {
        CorptieAppEnvironment.userDefaults.string(forKey: lastSelectedWorkItemKey)
    }
}

// MARK: - WorkItem 混合看板

struct WorkItemBoardView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    let objective: Objective
    let items: [WorkItem]
    @Binding var selectedWorkItemId: String?
    var onRequestReload: () -> Void = {}
    @State private var boardItems: [WorkItem] = []
    @State private var isCreating = false
    @State private var isCreatingObjectiveChat = false
    @State private var collapsedColumns: Set<WorkItemColumn> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(objective.name)
                    .font(.title3.bold())
                Spacer()
                Button {
                    isCreatingObjectiveChat = true
                } label: {
                    Label(L10n("讨论 Objective"), systemImage: "bubble.left.and.bubble.right")
                }
                Button {
                    isCreating = true
                } label: {
                    Label(L10n("新建工作项"), systemImage: "plus")
                }
            }
            HStack(alignment: .top, spacing: 12) {
                ForEach(WorkItemColumn.allCases) { column in
                    WorkItemColumnView(
                        column: column,
                        items: boardItems.filter { WorkItemColumn.column(for: $0.status) == column },
                        selectedWorkItemId: $selectedWorkItemId,
                        isCollapsed: Binding(
                            get: { collapsedColumns.contains(column) },
                            set: { isCollapsed in
                                if isCollapsed { collapsedColumns.insert(column) }
                                else { collapsedColumns.remove(column) }
                            }
                        )
                    )
                }
            }
        }
        .padding()
        .onAppear { boardItems = items }
        .onChange(of: items) { _, newValue in boardItems = newValue }
        .sheet(isPresented: $isCreating) {
            WorkItemCreateView(objectiveId: objective.id, workspaceIds: objective.workspaceIds) { created in
                boardItems.append(created)
                onRequestReload()
            }
        }
        .sheet(isPresented: $isCreatingObjectiveChat) {
            NewSessionCreationSheet(fixedObjective: objective)
        }
    }
}

// MARK: - 单列

struct WorkItemColumnView: View {
    let column: WorkItemColumn
    let items: [WorkItem]
    @Binding var selectedWorkItemId: String?
    @Binding var isCollapsed: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Button {
                    withAnimation(.easeInOut(duration: 0.15)) {
                        isCollapsed.toggle()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                        Text(column.title)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer()

                Text("\(items.count)")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 8)

            Divider()

            if !isCollapsed {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                            WorkItemCard(item: item, isSelected: selectedWorkItemId == item.id)
                                .onTapGesture { selectedWorkItemId = item.id }

                            if index < items.count - 1 {
                                Divider()
                                    .padding(.leading, 12)
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.horizontal, 4)
    }
}

// MARK: - 工作项卡片

struct WorkItemCard: View {
    let item: WorkItem
    let isSelected: Bool

    var body: some View {
        HStack(spacing: 10) {
            Capsule()
                .fill(isSelected ? Color.accentColor : Color.secondary.opacity(0.28))
                .frame(width: 3, height: 28)

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.body.weight(isSelected ? .semibold : .medium))
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 4) {
                    Text(item.priority)
                    if let agentId = item.mainAgentId {
                        Text("·")
                        Text(agentId)
                            .lineLimit(1)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isSelected ? Color.accentColor.opacity(0.08) : Color.clear)
        .contentShape(Rectangle())
    }
}

// MARK: - Agent 行（侧栏 Agent 一览）

struct AgentRow: View {
    let agent: Agent

    var body: some View {
        HStack(spacing: 8) {
            Text(avatarInitial)
                .font(.caption.bold())
                .foregroundStyle(.white)
                .frame(width: 22, height: 22)
                .background(avatarColor, in: Circle())

            VStack(alignment: .leading, spacing: 1) {
                Text(agent.name)
                    .font(.callout)
                Text(L10n(agent.isAssistant ? "Assistant" : "Independent Contributor"))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
        }
        .padding(.vertical, 2)
    }

    private var avatarInitial: String {
        String(agent.name.prefix(1)).uppercased()
    }

    private var avatarColor: Color {
        agent.isAssistant ? .accentColor : .blue
    }

    private var statusColor: Color {
        switch agent.status {
        case "available": .green
        case "busy": .orange
        case "offline", "inactive": Color.secondary.opacity(0.5)
        default: Color.secondary.opacity(0.5)
        }
    }
}

// MARK: - 工作项详情（占位）

enum WorkItemExecutionStartDecision: Equatable {
    case resume(sessionId: String)
    case createSession(agentId: String)
    case chooseAgent

    static func resolve(currentSessionId: String?, mainAgentId: String?) -> Self {
        if let currentSessionId = normalized(currentSessionId) {
            return .resume(sessionId: currentSessionId)
        }
        if let mainAgentId = normalized(mainAgentId) {
            return .createSession(agentId: mainAgentId)
        }
        return .chooseAgent
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return nil
        }
        return value
    }
}

enum WorkItemStatusAdvanceDecision: Equatable {
    case advance(to: String)
    case unavailable

    static func resolve(status: String) -> Self {
        switch status {
        case "todo", "pending", "ready":
            .advance(to: "in_progress")
        case "in_progress", "doing", "running":
            .advance(to: "done")
        default:
            .unavailable
        }
    }
}

struct WorkItemDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    let workItem: WorkItem
    let workspaceIds: [String]
    let contributorAgentIds: [String]
    var onRequestReload: () -> Void = {}

    @State private var currentSession: WorkItemSessionSummary?
    @State private var memories: [MemoryItem] = []
    @State private var showAgentPicker = false
    @State private var showAgentSwitch = false
    @State private var executionAgentIds = Set<String>()
    @State private var executionError: EntityLaunchError?
    @State private var showWorkspaceBind = false
    @State private var bindWorkspaceId: String?
    @State private var showEdit = false
    @State private var showCompleteConfirmation = false
    @State private var isLaunchingExecution = false
    @State private var notifiedSuggestionKey: String?
    @State private var pendingStatusAdvance: String?
    @State private var showStatusAdvanceConfirmation = false
    @State private var isAdvancingStatus = false
    @State private var isConfirmingCompletion = false
    @State private var sessionCreationAgent: Agent?
    @State private var worktreeStatus: WorkItemWorktreeStatus?
    @State private var isLoadingWorktree = false
    @State private var isReclaimingWorktree = false
    @State private var showReclaimConfirmation = false

    var body: some View {
        VStack(spacing: 0) {
            detailHeader

            Divider()
                .opacity(0.5)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    overviewSection

                    detailTextSection(
                        title: L10n("Description"),
                        systemImage: "text.alignleft",
                        text: workItem.description
                    )

                    detailTextSection(
                        title: L10n("Acceptance Criteria"),
                        systemImage: "checklist",
                        text: workItem.acceptanceCriteria
                    )

                    Divider()

                    executionSection

                    if isCompleted {
                        Divider()

                        worktreeSection
                    }

                    Divider()

                    memorySection
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
            }
        }
        .task(id: workItem) {
            // 以 workItem 作为 task 标识：当父层重新拉取、currentSessionId 等字段变化时，
            // 本视图会拿到新的 workItem 值并重新刷新「当前执行」，避免依赖陈旧的 currentSessionId。
            await refreshExecution()
            if isCompleted { await refreshWorktree() }
            presentCompletionSuggestionIfEligible()
        }
        .onChange(of: workItem.completionSuggestion) { _, _ in
            presentCompletionSuggestionIfEligible()
        }
        .sheet(isPresented: $showEdit) {
            WorkItemEditView(workItem: workItem, workspaceIds: workspaceIds) {
                onRequestReload()
            }
        }
        .sheet(isPresented: $showAgentPicker) {
            AgentPickerView(
                selectedIds: $executionAgentIds,
                roleFilter: .independentContributor,
                allowedAgentIds: Set(contributorAgentIds),
                onDone: { selection in
                if let agentId = selection.first {
                    Task {
                        await createExecutionSession(agentId: agentId)
                    }
                }
            })
        }
        .sheet(isPresented: $showAgentSwitch) {
            AgentPickerView(
                selectedIds: $executionAgentIds,
                roleFilter: .independentContributor,
                allowedAgentIds: Set(contributorAgentIds),
                onDone: { selection in
                if let agentId = selection.first {
                    Task {
                        _ = await client.updateWorkItem(workItemId: workItem.id, mainAgentId: agentId)
                        await refreshExecution()
                        onRequestReload()
                    }
                }
            })
        }
        .sheet(item: $sessionCreationAgent) { agent in
            NewSessionCreationSheet(fixedAgent: agent, fixedWorkItem: workItem) { session in
                backendClient.acceptCreatedSession(session, selectImmediately: false)
                Task {
                    await refreshExecution()
                    onRequestReload()
                }
            }
        }
        .alert(L10n("执行失败"), isPresented: Binding(
            get: { executionError != nil },
            set: { if !$0 { executionError = nil } }
        )) {
            if executionError?.code == "WORKSPACE_REQUIRED" {
                Button(L10n("绑定 Workspace")) {
                    executionError = nil
                    showWorkspaceBind = true
                }
            }
            Button(L10n("好"), role: .cancel) { executionError = nil }
        } message: {
            Text(executionError?.message ?? "")
        }
        .sheet(isPresented: $showCompleteConfirmation) {
            WorkItemCompletionConfirmationView(
                workItem: workItem,
                suggestion: workItem.completionSuggestion,
                isConfirming: isConfirmingCompletion,
                onConfirm: { Task { await confirmComplete() } },
                onCancel: {
                    showCompleteConfirmation = false
                    pendingStatusAdvance = nil
                }
            )
        }
        .alert(L10n("Advance WorkItem Status"), isPresented: $showStatusAdvanceConfirmation) {
            Button(L10n("Confirm")) {
                if let pendingStatusAdvance {
                    Task { await advanceStatus(to: pendingStatusAdvance) }
                }
            }
            Button(L10n("取消"), role: .cancel) {
                pendingStatusAdvance = nil
            }
        } message: {
            if let pendingStatusAdvance {
                Text(L10nFormat(
                    "Change WorkItem status from “%@” to “%@”? This manually overrides the execution-managed status.",
                    workItemStatusLabel(workItem.status),
                    workItemStatusLabel(pendingStatusAdvance)
                ))
            }
        }
        .sheet(isPresented: $showWorkspaceBind) {
            WorkspaceBindSheet(workspaceId: $bindWorkspaceId, workspaceIds: workspaceIds) {
                Task {
                    await client.updateWorkItem(workItemId: workItem.id, mainWorkspaceId: bindWorkspaceId)
                    await refreshExecution()
                    onRequestReload()
                }
            }
        }
        .confirmationDialog(
            L10n("Reclaim this Worktree?"),
            isPresented: $showReclaimConfirmation,
            titleVisibility: .visible
        ) {
            Button(L10n("Reclaim Worktree"), role: .destructive) {
                Task { await reclaimWorktree() }
            }
            Button(L10n("Cancel"), role: .cancel) {}
        } message: {
            Text(L10n("The merged Worktree and its local branch will be removed. Session history will be archived and preserved."))
        }
    }

    private var detailHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.text.square")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(L10n("WorkItem 详情"))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                showEdit = true
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .help(L10n("编辑工作项"))
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.vertical, 9)
    }

    private var overviewSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(workItem.title)
                .font(.system(size: 16, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 7) {
                compactStatusBadge(workItem.status)
                metadataPill(priorityLabel, systemImage: "flag")
            }

            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "folder")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .frame(width: 14)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("WORKSPACE"))
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                    Text(workspaceName ?? L10n("No Workspace Bound"))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(workspaceResolution.isUnresolved ? Color.orange : (workspaceName == nil ? Color.secondary : Color.primary))
                        .lineLimit(2)
                }
            }
        }
    }

    private func detailTextSection(title: String, systemImage: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.secondary)
            CollapsibleDetailText(
                text: text.isEmpty ? L10n("No Content") : text,
                color: text.isEmpty ? .secondary.opacity(0.6) : .secondary
            )
        }
    }

    private var executionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !isCompleted {
                HStack {
                    Label(L10n("执行"), systemImage: "play.circle")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    executionControlButton
                }
            }

            HStack(spacing: 10) {
                Button {
                    executionAgentIds = []
                    showAgentSwitch = true
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: currentAgent?.isAssistant == true ? "sparkles" : "person.fill")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 22, height: 22)
                            .background(currentAgent?.isAssistant == true ? Color.accentColor : Color.blue, in: Circle())
                        Text(currentAgent?.name ?? L10n("Select an Agent"))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(currentAgent == nil ? .secondary : .primary)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer(minLength: 4)

                if let currentSession {
                    Text(statusLabel(currentSession.status))
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)

                    Button {
                        router.openSession(currentSession.id)
                    } label: {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.plain)
                    .help(currentSession.title.isEmpty ? L10n("Open Session") : L10nFormat("Open: %@", currentSession.title))
                } else {
                    Text(L10n("无会话"))
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    private var memorySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(L10n("工作项记忆"), systemImage: "brain.head.profile")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if !memories.isEmpty {
                    Text("\(memories.count)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
            }
            if memories.isEmpty {
                Text(L10n("暂无记忆"))
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
            } else {
                ForEach(memories) { memory in
                    VStack(alignment: .leading, spacing: 3) {
                        CollapsibleDetailText(
                            text: memory.content,
                            font: .system(size: 11),
                            color: .primary,
                            lineSpacing: 1
                        )
                        Text(kindLabel(memory.kind))
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    // 当前 WorkItem 绑定的 Agent（依据 mainAgentId 从 agents 列表解析）。
    private var currentAgent: Agent? {
        guard let agentId = workItem.mainAgentId else { return nil }
        return client.agents.first { $0.agentId == agentId }
    }

    // 是否已完成：只看 WorkItem 自身状态。Session complete 只代表一次执行落定，
    // 只有证据支持的验收建议经用户确认后 status 才为 done。
    private var isCompleted: Bool {
        ["done", "complete", "completed"].contains(workItem.status)
    }

    // 是否存在有逐条证据支撑的完成建议。Session complete 本身永远不满足该条件。
    private var isPendingReview: Bool {
        workItem.completionSuggestion?.recommended == true
    }

    // 是否正在运行（当前会话正在执行或等待输入）。
    private var isRunning: Bool {
        guard let s = currentSession?.status else { return false }
        return ["running", "blocked"].contains(s)
    }

    @ViewBuilder
    private var worktreeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(L10n("Worktree"), systemImage: "arrow.triangle.branch")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if isLoadingWorktree || isReclaimingWorktree {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if let status = worktreeStatus {
                switch status.status {
                case "retired":
                    Label(L10n("Worktree reclaimed"), systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.green)
                case "available":
                    if let worktree = status.worktree {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(worktree.branchName ?? worktree.path)
                                .font(.system(size: 10.5, design: .monospaced))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            HStack(spacing: 6) {
                                worktreeBadge(
                                    worktree.mergedIntoMain == true ? L10n("Merged") : L10n("Not merged"),
                                    color: worktree.mergedIntoMain == true ? .green : .orange
                                )
                                if worktree.dirty == true {
                                    worktreeBadge(L10n("Uncommitted changes"), color: .orange)
                                }
                            }
                        }
                        if status.canReclaim {
                            Button {
                                showReclaimConfirmation = true
                            } label: {
                                Label(L10n("Reclaim Worktree"), systemImage: "trash")
                            }
                            .buttonStyle(.bordered)
                            .disabled(isReclaimingWorktree)
                        } else if let blocker = status.blocker {
                            Text(worktreeBlockerMessage(blocker))
                                .font(.system(size: 10.5))
                                .foregroundStyle(.orange)
                        }
                    }
                case "none":
                    Text(L10n("No dedicated Worktree"))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                default:
                    Text(status.detail ?? L10n("Worktree unavailable"))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.orange)
                }
            } else if !isLoadingWorktree {
                Text(L10n("Unable to inspect the Worktree."))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.orange)
            }
        }
    }

    private func worktreeBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9.5, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(color.opacity(0.09), in: Capsule())
    }

    private func worktreeBlockerMessage(_ blocker: String) -> String {
        switch blocker {
        case "UNCOMMITTED_CHANGES": L10n("Commit the Worktree changes before reclaiming it.")
        case "NOT_MERGED_INTO_MAIN", "INTEGRATION_PENDING": L10n("Merge this Worktree into main before reclaiming it.")
        case "SESSION_BUSY": L10n("Wait for the Session to finish before reclaiming its Worktree.")
        case "SHARED_WITH_ACTIVE_WORK_ITEM": L10n("This Worktree is still used by an active WorkItem.")
        default: L10n("This Worktree is not safe to reclaim yet.")
        }
    }

    private func refreshWorktree() async {
        guard !isLoadingWorktree else { return }
        isLoadingWorktree = true
        defer { isLoadingWorktree = false }
        worktreeStatus = await client.worktreeStatus(workItemId: workItem.id)
    }

    private func reclaimWorktree() async {
        guard !isReclaimingWorktree else { return }
        isReclaimingWorktree = true
        defer { isReclaimingWorktree = false }
        if let status = await client.reclaimWorktree(workItemId: workItem.id) {
            worktreeStatus = status
            await refreshExecution()
            onRequestReload()
        } else {
            executionError = EntityLaunchError(
                message: client.errorMessage ?? L10n("Unable to reclaim the Worktree."),
                code: nil
            )
        }
    }

    // 执行/终止/确认完成控制按钮：圆形、仅图标。
    // - 已完成 → 不显示控制按钮，完成状态由概览区的状态徽标表达。
    // - 待确认完成（review）→ 绿色对勾按钮，点击弹确认框，确认后变已完成。
    // - 运行中 → 终止按钮（红色停止图标）。
    // - 其它（待开始 / 会话已存在但已停止）→ 执行按钮（播放图标）。
    @ViewBuilder
    private var executionControlButton: some View {
        if isCompleted {
            EmptyView()
        } else if isPendingReview {
            Button {
                showCompleteConfirmation = true
            } label: {
                Image(systemName: "checkmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Color.green, in: Circle())
            }
            .buttonStyle(.plain)
            .help(L10n("确认完成"))
        } else if isRunning {
            Button {
                Task { await interruptExecution() }
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Color.red, in: Circle())
            }
            .buttonStyle(.plain)
            .help(L10n("终止执行"))
        } else {
            Button {
                Task { await startOrResumeExecution() }
            } label: {
                Image(systemName: "play.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 28, height: 28)
                    .background(Color.accentColor, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(isLaunchingExecution)
            .help(L10n(currentSession == nil ? "Run" : "Resume"))
        }
    }

    // 开始执行：已有会话则恢复；否则优先使用 WorkItem 已绑定的 Agent，未绑定时才让用户选择。
    private func startOrResumeExecution() async {
        switch WorkItemExecutionStartDecision.resolve(
            currentSessionId: currentSession?.id,
            mainAgentId: workItem.mainAgentId
        ) {
        case .resume(let sessionId):
            guard !isLaunchingExecution else { return }
            isLaunchingExecution = true
            defer { isLaunchingExecution = false }
            if await client.resumeSession(sessionId: sessionId) {
                await refreshExecution()
                onRequestReload()
            } else {
                executionError = EntityLaunchError(message: client.errorMessage ?? "恢复会话失败", code: nil)
            }
        case .createSession(let agentId):
            await createExecutionSession(agentId: agentId)
        case .chooseAgent:
            executionAgentIds = []
            showAgentPicker = true
        }
    }

    private func createExecutionSession(agentId: String) async {
        if client.agents.isEmpty { await client.refreshAgents() }
        guard let agent = client.agents.first(where: { $0.agentId == agentId }) else {
            executionError = EntityLaunchError(message: L10n("Agent 不存在"), code: "AGENT_NOT_FOUND")
            return
        }
        sessionCreationAgent = agent
    }

    // 终止当前运行中的会话。
    private func interruptExecution() async {
        guard let session = currentSession else { return }
        if await client.interruptSession(sessionId: session.id) {
            await refreshExecution()
            onRequestReload()
        } else {
            executionError = EntityLaunchError(message: client.errorMessage ?? "终止失败", code: nil)
        }
    }

    // 用户确认「待确认完成」→ 真正标记为已完成。
    private func confirmComplete() async {
        guard !isConfirmingCompletion else { return }
        isConfirmingCompletion = true
        defer { isConfirmingCompletion = false }
        if await client.confirmWorkItemCompletion(workItemId: workItem.id) != nil {
            showCompleteConfirmation = false
            pendingStatusAdvance = nil
            onRequestReload()
        } else {
            showCompleteConfirmation = false
            executionError = EntityLaunchError(
                message: client.errorMessage ?? L10n("Unable to confirm WorkItem completion"),
                code: nil
            )
        }
    }

    private func presentCompletionSuggestionIfEligible() {
        guard !isCompleted else { return }
        guard let suggestion = workItem.completionSuggestion, suggestion.recommended else { return }
        let key = "\(workItem.id):\(suggestion.assessedAt)"
        guard notifiedSuggestionKey != key else { return }
        notifiedSuggestionKey = key
        showCompleteConfirmation = true
    }

    private var priorityLabel: String {
        switch workItem.priority {
        case "low": L10n("Low")
        case "medium": L10n("Medium")
        case "high": L10n("High")
        default: workItem.priority
        }
    }

    private var workspaceName: String? {
        workspaceResolution.displayName
    }

    private var workspaceResolution: WorkspaceAssociationResolution {
        EntityAssociationResolver.workspace(
            id: workItem.mainWorkspaceId,
            repositories: client.repositories
        )
    }

    private func refreshExecution() async {
        if client.agents.isEmpty { await client.refreshAgents() }
        let sessions = await client.sessions(for: workItem)
        // 优先用 workItem.currentSessionId 匹配；匹配不到（例如旧 workItem 值仍为 nil）时，
        // 取后端返回列表里 updatedAt 最新的那一条，避免因陈旧 currentSessionId 导致「当前执行」显示为空。
        currentSession = sessions.first { $0.id == workItem.currentSessionId }
            ?? sessions.max(by: { $0.updatedAt < $1.updatedAt })
        memories = await client.memories(ownerType: "work_item", ownerId: workItem.id)
    }

    private func kindLabel(_ kind: String) -> String {
        switch kind {
        case "fact": L10n("Fact")
        case "lesson": L10n("Lesson")
        case "feedback": L10n("Feedback")
        case "preference": L10n("Preference")
        case "procedure": L10n("Procedure")
        case "skill": L10n("Skill")
        case "dev_experience": L10n("Development Experience")
        case "episodic": L10n("Experience")
        default: kind
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "running": L10n("Running")
        case "blocked": L10n("Waiting for Input")
        case "completed", "complete", "done": L10n("Complete")
        case "failed": L10n("Failed")
        default: status
        }
    }

    @ViewBuilder
    private func compactStatusBadge(_ status: String) -> some View {
        switch WorkItemStatusAdvanceDecision.resolve(status: status) {
        case .advance(let targetStatus):
            Button {
                pendingStatusAdvance = targetStatus
                if targetStatus == "done" {
                    showCompleteConfirmation = true
                } else {
                    showStatusAdvanceConfirmation = true
                }
            } label: {
                statusBadgeLabel(status)
            }
            .buttonStyle(.plain)
            .disabled(isAdvancingStatus)
            .help(L10nFormat("Advance status to %@", workItemStatusLabel(targetStatus)))
        case .unavailable:
            statusBadgeLabel(status)
        }
    }

    private func statusBadgeLabel(_ status: String) -> some View {
        let (label, color): (String, Color) = {
            switch status {
            case "in_progress": (L10n("In Progress"), .orange)
            case "review", "reviewing": (L10n("Awaiting Completion Approval"), .blue)
            case "done", "complete", "completed": (L10n("Completed"), .green)
            case "failed": (L10n("Failed"), .red)
            default: (L10n("Not Started"), .secondary)
            }
        }()
        return Label(label, systemImage: "circle.fill")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.11), in: Capsule())
    }

    private func workItemStatusLabel(_ status: String) -> String {
        switch status {
        case "todo", "pending", "ready": L10n("Not Started")
        case "in_progress", "doing", "running": L10n("In Progress")
        case "review", "reviewing": L10n("Awaiting Completion Approval")
        case "done", "complete", "completed": L10n("Completed")
        case "failed": L10n("Failed")
        default: status
        }
    }

    private func advanceStatus(to status: String) async {
        guard !isAdvancingStatus else { return }
        isAdvancingStatus = true
        defer {
            isAdvancingStatus = false
            pendingStatusAdvance = nil
        }

        if await client.updateWorkItem(workItemId: workItem.id, status: status) != nil {
            onRequestReload()
        } else {
            executionError = EntityLaunchError(message: client.errorMessage ?? L10n("Unable to update WorkItem status"), code: nil)
        }
    }

    private func metadataPill(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.primary.opacity(0.045), in: Capsule())
    }
}

private struct WorkItemCompletionConfirmationView: View {
    let workItem: WorkItem
    let suggestion: WorkItemCompletionSuggestion?
    let isConfirming: Bool
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(L10n("确认完成"))
                    .font(.title3.weight(.semibold))
                Text(workItem.title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let suggestion, suggestion.recommended {
                        Label(
                            L10n("以下验收标准已有可核验证据。请人工确认是否标记为完成。"),
                            systemImage: "checkmark.seal.fill"
                        )
                        .foregroundStyle(.green)

                        ForEach(Array(suggestion.results.enumerated()), id: \.offset) { index, result in
                            VStack(alignment: .leading, spacing: 8) {
                                Text("\(index + 1). \(result.criterion)")
                                    .font(.system(size: 12, weight: .semibold))
                                    .textSelection(.enabled)
                                ForEach(Array(result.evidence.enumerated()), id: \.offset) { _, evidence in
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text("• \(evidence.summary)")
                                            .font(.system(size: 11))
                                        Text(evidence.reference)
                                            .font(.system(size: 10, design: .monospaced))
                                            .foregroundStyle(.secondary)
                                    }
                                    .textSelection(.enabled)
                                }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
                        }
                    } else {
                        Label(
                            L10n("自动验收尚未给出通过结论。你仍可作为用户作出最终裁决并确认完成。"),
                            systemImage: "person.crop.circle.badge.checkmark"
                        )
                        .foregroundStyle(.orange)

                        if !workItem.acceptanceCriteria.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(L10n("Acceptance Criteria"))
                                    .font(.system(size: 11, weight: .semibold))
                                Text(workItem.acceptanceCriteria)
                                    .font(.system(size: 11))
                                    .textSelection(.enabled)
                            }
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }

            Divider()

            HStack(spacing: 10) {
                Spacer()
                Button(L10n("取消"), action: onCancel)
                    .keyboardShortcut(.cancelAction)
                    .disabled(isConfirming)
                Button(action: onConfirm) {
                    if isConfirming {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Text(L10n("确认完成"))
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(isConfirming)
            }
            .padding(16)
        }
        .frame(width: 520, height: 480)
        .interactiveDismissDisabled(isConfirming)
    }
}

// MARK: - 工作项编辑（弹出小窗）

struct WorkItemEditView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let workItem: WorkItem
    let workspaceIds: [String]
    let onSaved: () -> Void

    @State private var title: String
    @State private var detail: String
    @State private var acceptanceCriteria: String
    @State private var priority: String
    @State private var workspaceId: String?
    @State private var status: String
    @State private var showStatusConfirm = false
    @State private var assistAgentId: String?

    init(workItem: WorkItem, workspaceIds: [String], onSaved: @escaping () -> Void) {
        self.workItem = workItem
        self.workspaceIds = workspaceIds
        self.onSaved = onSaved
        _title = State(initialValue: workItem.title)
        _detail = State(initialValue: workItem.description)
        _acceptanceCriteria = State(initialValue: workItem.acceptanceCriteria)
        _priority = State(initialValue: workItem.priority)
        _workspaceId = State(initialValue: workItem.mainWorkspaceId)
        _status = State(initialValue: workItem.status)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("编辑工作项"))
                .font(.title3.bold())

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("标题"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField(L10n("工作项标题"), text: $title)
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(L10n("描述"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    AgentAssistButton(fieldLabel: "描述", text: $detail, selectedAgentId: $assistAgentId, context: "工作项标题：\(title)")
                    Spacer()
                }
                TextEditor(text: $detail)
                    .font(.body)
                    .frame(height: 90)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(L10n("验收标准"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    AgentAssistButton(fieldLabel: "验收标准", text: $acceptanceCriteria, selectedAgentId: $assistAgentId, context: "工作项标题：\(title)；描述：\(detail)")
                    Spacer()
                }
                TextEditor(text: $acceptanceCriteria)
                    .font(.body)
                    .frame(height: 90)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }

            WorkspacePicker(workspaceId: $workspaceId, workspaceIds: workspaceIds)

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("优先级"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("", selection: $priority) {
                    Text(L10n("低")).tag("low")
                    Text(L10n("中")).tag("medium")
                    Text(L10n("高")).tag("high")
                }
                .labelsHidden()
                .frame(maxWidth: 160, alignment: .leading)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("状态"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(L10n("手动修改状态将覆盖由执行流程自动维护的状态，请谨慎操作。"))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Picker("", selection: $status) {
                    Text(L10n("待开始")).tag("todo")
                    Text(L10n("进行中")).tag("in_progress")
                    Text(L10n("已完成")).tag("done")
                }
                .labelsHidden()
                .frame(maxWidth: 160, alignment: .leading)
            }

            HStack {
                Spacer()
                Button(L10n("取消")) { dismiss() }
                Button(L10n("保存")) {
                    save()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(trimmedTitle.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 440)
        .alert(L10n("确认修改状态"), isPresented: $showStatusConfirm) {
            Button(L10n("确认修改"), role: .destructive) {
                persist()
            }
            Button(L10n("取消"), role: .cancel) { }
        } message: {
            Text(L10nFormat("You are manually overriding the WorkItem status (%@), bypassing execution-managed status. Continue?", statusLabel(status)))
        }
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // 是否强制修改了状态（与原始状态不同）。
    private var statusChanged: Bool {
        status != workItem.status
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "todo": L10n("Not Started")
        case "in_progress": L10n("In Progress")
        case "review", "reviewing": L10n("Awaiting Completion Approval")
        case "done", "complete", "completed": L10n("Completed")
        case "failed": L10n("Failed")
        default: s
        }
    }

    private func save() {
        guard !trimmedTitle.isEmpty else { return }
        // 强制改状态 → 先弹二次确认，确认后才真正落库。
        if statusChanged {
            showStatusConfirm = true
            return
        }
        persist()
    }

    private func persist() {
        Task {
            await client.updateWorkItem(
                workItemId: workItem.id,
                title: trimmedTitle,
                description: detail.trimmingCharacters(in: .whitespacesAndNewlines),
                acceptanceCriteria: acceptanceCriteria.trimmingCharacters(in: .whitespacesAndNewlines),
                priority: priority,
                status: status,
                mainWorkspaceId: workspaceId
            )
            onSaved()
            dismiss()
        }
    }
}
