import SwiftUI

// 控制台主视图（03 §13.2 默认主视图：NavigationSplitView 三栏 + master-detail）。
// 净新增独立文件，不碰 FloatingRootView.swift 巨石。
//
// 三栏：
//   sidebar  — Objective 导航列表
//   content  — 选中 Objective 的 WorkItem 混合看板（按状态分四列）
//   detail   — 选中 WorkItem 的详情（占位，后续替换为完整编辑 + Session 历史）

struct WarRoomView: View {
    @StateObject private var client = EntityAPIClient.shared
    @State private var selectedObjectiveId: String?
    @State private var selectedWorkItemId: String?
    @State private var workItems: [WorkItem] = []
    @State private var workItemsReloadToken = 0
    @State private var objectiveExpanded = true
    @State private var isCreatingObjective = false
    @State private var objectivePendingEdit: Objective?

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            NavigationSplitView {
                objectiveSidebar
                    .navigationSplitViewColumnWidth(min: w * 0.22, ideal: w * 0.30, max: w * 0.42)
            } content: {
                warRoomContent
                    .navigationSplitViewColumnWidth(min: w * 0.28, ideal: w * 0.40, max: w * 0.55)
            } detail: {
                workItemDetail
                    .navigationSplitViewColumnWidth(min: w * 0.22, ideal: w * 0.30, max: w * 0.42)
            }
        }
        .task {
            if client.objectives.isEmpty {
                await client.refreshObjectives()
            }
        }
        .task(id: selectedObjectiveId) {
            // 选中目标变化时拉取其工作项（三栏共享同一份 workItems）
            if let objectiveId = selectedObjectiveId,
               let objective = client.objectives.first(where: { $0.id == objectiveId }) {
                workItems = await client.workItems(for: objective)
            } else {
                workItems = []
            }
        }
        .task(id: workItemsReloadToken) {
            // 执行/换 Agent/保存后强制重新拉取，看板列与「当前执行」才能反映真实状态。
            guard workItemsReloadToken != 0 else { return }
            if let objectiveId = selectedObjectiveId,
               let objective = client.objectives.first(where: { $0.id == objectiveId }) {
                workItems = await client.workItems(for: objective)
            }
        }
        .onChange(of: client.objectives) { _, objectives in
            if selectedObjectiveId == nil, let first = objectives.first {
                selectedObjectiveId = first.id
            }
        }
        .onChange(of: selectedObjectiveId) { _, _ in
            selectedWorkItemId = nil
        }
        .sheet(item: $objectivePendingEdit) { objective in
            ObjectiveDetailView(objective: objective)
        }
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
                        sidebarEmptyState("当前没有 Objective")
                    } else {
                        ForEach(client.objectives) { objective in
                            Label(objective.name, systemImage: "target")
                                .tag(objective.id)
                                .contextMenu {
                                    Button("编辑") {
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
            if let error = client.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
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
            .help("新建 \(title)")
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
        if let objective = client.objectives.first(where: { $0.id == selectedObjectiveId }) {
            WorkItemBoardView(
                objective: objective,
                items: workItems,
                selectedWorkItemId: $selectedWorkItemId,
                onRequestReload: { workItemsReloadToken &+= 1 }
            )
        } else if client.objectives.isEmpty {
            ContentUnavailableView(
                "暂无目标",
                systemImage: "target",
                description: Text("通过助手对话或快捷输入创建第一个目标")
            )
        } else {
            ContentUnavailableView("选择目标", systemImage: "sidebar.left")
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var workItemDetail: some View {
        if let workItem = workItems.first(where: { $0.id == selectedWorkItemId }) {
            WorkItemDetailView(
                workItem: workItem,
                workspaceIds: client.objectives.first(where: { $0.id == selectedObjectiveId })?.workspaceIds ?? [],
                onRequestReload: { workItemsReloadToken &+= 1 }
            )
        } else {
            ContentUnavailableView("选择工作项", systemImage: "square.grid.2x2")
        }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(objective.name)
                    .font(.title3.bold())
                Spacer()
                Button {
                    isCreating = true
                } label: {
                    Label("新建工作项", systemImage: "plus")
                }
            }
            HStack(alignment: .top, spacing: 12) {
                ForEach(WorkItemColumn.allCases) { column in
                    WorkItemColumnView(
                        column: column,
                        items: boardItems.filter { WorkItemColumn.column(for: $0.status) == column },
                        selectedWorkItemId: $selectedWorkItemId
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
    }
}

// MARK: - 单列

struct WorkItemColumnView: View {
    let column: WorkItemColumn
    let items: [WorkItem]
    @Binding var selectedWorkItemId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(column.title, systemImage: column.systemImage)
                    .font(.headline)
                Spacer()
                Text("\(items.count)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(items) { item in
                        WorkItemCard(item: item, isSelected: selectedWorkItemId == item.id)
                            .onTapGesture { selectedWorkItemId = item.id }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

// MARK: - 工作项卡片

struct WorkItemCard: View {
    let item: WorkItem
    let isSelected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title)
                .font(.body.weight(.semibold))
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
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.15) : Color.primary.opacity(0.04))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(isSelected ? Color.accentColor : Color.clear, lineWidth: 1)
        )
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
                Text(agent.isAssistant ? "助手" : "独立贡献者")
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

struct WorkItemDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @EnvironmentObject private var router: AppTabRouter
    let workItem: WorkItem
    let workspaceIds: [String]
    var onRequestReload: () -> Void = {}

    @State private var title: String
    @State private var detail: String
    @State private var priority: String
    @State private var workspaceId: String?
    @State private var didSave = false
    @State private var currentSession: WorkItemSessionSummary?
    @State private var memories: [MemoryItem] = []
    @State private var showAgentPicker = false
    @State private var executionAgentIds = Set<String>()
    @State private var executionError: EntityLaunchError?
    @State private var showWorkspaceBind = false

    init(workItem: WorkItem, workspaceIds: [String], onRequestReload: @escaping () -> Void = {}) {
        self.workItem = workItem
        self.workspaceIds = workspaceIds
        self.onRequestReload = onRequestReload
        _title = State(initialValue: workItem.title)
        _detail = State(initialValue: workItem.description)
        _priority = State(initialValue: workItem.priority)
        _workspaceId = State(initialValue: workItem.mainWorkspaceId)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                TextField("标题", text: $title)
                    .font(.title3.bold())
                    .textFieldStyle(.plain)

                VStack(alignment: .leading, spacing: 4) {
                    Text("描述")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $detail)
                        .font(.body)
                        .frame(minHeight: 120)
                        .padding(6)
                        .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                }

                WorkspacePicker(workspaceId: $workspaceId, workspaceIds: workspaceIds)

                HStack(spacing: 24) {
                    // 状态由「执行/会话落定」自动驱动，用户不可手改；此处仅展示。
                    statusBadge(workItem.status)
                    pickerField("优先级", selection: $priority) {
                        Text("低").tag("low")
                        Text("中").tag("medium")
                        Text("高").tag("high")
                    }
                }

                HStack(spacing: 12) {
                    Button("保存") {
                        Task {
                            await client.updateWorkItem(
                                workItemId: workItem.id,
                                title: title,
                                description: detail,
                                priority: priority,
                                mainWorkspaceId: workspaceId
                            )
                        }
                        didSave = true
                        onRequestReload()
                    }
                    .keyboardShortcut(.defaultAction)
                    if didSave {
                        Text("已保存")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("当前执行")
                            .font(.headline)
                        Spacer()
                        Button(currentSession == nil ? "执行" : "换 Agent") {
                            executionAgentIds = []
                            showAgentPicker = true
                        }
                        .buttonStyle(.borderless)
                    }
                    if let currentSession {
                        HStack {
                            Text(currentSession.title.isEmpty ? "未命名会话" : currentSession.title)
                                .lineLimit(1)
                            Spacer()
                            Text(statusLabel(currentSession.status))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Button("打开对话") {
                                router.openSession(currentSession.id)
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 3)
                    } else {
                        Text("尚未开始执行")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }

                Divider()

                VStack(alignment: .leading, spacing: 6) {
                    Text("工作项记忆")
                        .font(.headline)
                    if memories.isEmpty {
                        Text("暂无记忆")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(memories) { memory in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(memory.content)
                                    .font(.callout)
                                Text(kindLabel(memory.kind))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 3)
                        }
                    }
                }
            }
            .padding()
        }
        .task {
            await refreshExecution()
        }
        .sheet(isPresented: $showAgentPicker) {
            AgentPickerView(selectedIds: $executionAgentIds, onDone: { selection in
                if let agentId = selection.first {
                    Task {
                        let error = await client.createSession(workItemId: workItem.id, agentId: agentId, title: workItem.title)
                        if let error { executionError = error }
                        await refreshExecution()
                        onRequestReload()
                    }
                }
            })
        }
        .alert("执行失败", isPresented: Binding(
            get: { executionError != nil },
            set: { if !$0 { executionError = nil } }
        )) {
            if executionError?.code == "WORKSPACE_REQUIRED" {
                Button("绑定 Workspace") {
                    executionError = nil
                    showWorkspaceBind = true
                }
            }
            Button("好", role: .cancel) { executionError = nil }
        } message: {
            Text(executionError?.message ?? "")
        }
        .sheet(isPresented: $showWorkspaceBind) {
            WorkspaceBindSheet(workspaceId: $workspaceId, workspaceIds: workspaceIds) {
                Task {
                    await client.updateWorkItem(workItemId: workItem.id, mainWorkspaceId: workspaceId)
                    await refreshExecution()
                }
            }
        }
    }

    private func refreshExecution() async {
        let sessions = await client.sessions(for: workItem)
        currentSession = sessions.first { $0.id == workItem.currentSessionId } ?? sessions.last
        memories = await client.memories(ownerType: "work_item", ownerId: workItem.id)
    }

    private func kindLabel(_ kind: String) -> String {
        switch kind {
        case "fact": "事实"
        case "lesson": "教训"
        case "feedback": "反馈"
        case "preference": "偏好"
        case "procedure": "流程"
        case "skill": "技能"
        case "dev_experience": "开发经验"
        case "episodic": "经历"
        default: kind
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "running": "运行中"
        case "blocked": "待输入"
        case "completed", "complete", "done": "完成"
        case "failed": "失败"
        default: status
        }
    }

    private func pickerField<SelectionValue: Hashable, Content: View>(
        _ label: String,
        selection: Binding<SelectionValue>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("", selection: selection, content: content)
                .labelsHidden()
                .frame(maxWidth: 160, alignment: .leading)
        }
    }

    // 只读状态徽标（状态由执行动作自动驱动）。
    private func statusBadge(_ status: String) -> some View {
        let (label, color): (String, Color) = {
            switch status {
            case "in_progress": ("进行中", .orange)
            case "done", "complete", "completed": ("已完成", .green)
            case "failed": ("失败", .red)
            default: ("待开始", .secondary)
            }
        }()
        return VStack(alignment: .leading, spacing: 4) {
            Text("状态")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(label)
                .font(.callout.weight(.semibold))
                .foregroundStyle(color)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(color.opacity(0.15), in: Capsule())
        }
    }
}
