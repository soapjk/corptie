import SwiftUI

// 控制台主视图：三栏布局。
// 净新增独立文件，不碰 FloatingRootView.swift 巨石。
//
// 左栏使用原生 Work Sidebar；中栏平铺 CorptieTask 看板；右栏是独立的详情卡片。

enum WarRoomWorkScope {
    static let allSelectionId = "war-room:all-works"

    static func restoredSelection(savedId: String?, works: [Work]) -> String {
        if savedId == allSelectionId { return allSelectionId }
        if let savedId, works.contains(where: { $0.id == savedId }) { return savedId }
        return allSelectionId
    }
}

struct WarRoomView: View {
    @StateObject private var client = EntityAPIClient.shared
    @StateObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    @EnvironmentObject private var sidebarState: TabSidebarState
    @State private var selectedWorkId: String?
    @State private var selectedCorptieTaskId: String?
    @State private var tasks: [CorptieTask] = []
    @State private var tasksReloadToken = 0
    @State private var isCreatingWork = false
    @State private var workPendingEdit: Work?
    @State private var workPendingDeletion: Work?
    @State private var workDeletionError: String?
    @State private var taskPendingEdit: CorptieTask?
    @State private var deletionPresentation: CorptieTaskDeletionPresentation?
    @State private var deletionNotice: CorptieTaskDeletionNotice?
    @State private var inspectingDeletionIds = Set<String>()
    @State private var deletingCorptieTaskIds = Set<String>()
    /// 记录用户最后选中的 Work，跨窗口/重启恢复，避免有 Work 时看板空白。
    private static let lastSelectedWorkKey = "warRoom.lastSelectedWorkId"
    /// 记录用户最后选中的 CorptieTask；与 Work 一起恢复，重启后直接展示其详情。
    private static let lastSelectedCorptieTaskKey = "warRoom.lastSelectedTaskId"

    var body: some View {
        NavigationSplitView(columnVisibility: $sidebarState.visibility) {
            workSidebar
                .toolbar(removing: .sidebarToggle)
                .navigationSplitViewColumnWidth(
                    min: TwoPaneLayoutMetrics.sidebarWidth,
                    ideal: TwoPaneLayoutMetrics.sidebarWidth,
                    max: TwoPaneLayoutMetrics.sidebarMaximumWidth
                )
        } detail: {
            consoleWorkspace
        }
        .toolbar(removing: .sidebarToggle)
        .task {
            await client.refreshWorks()
            // CorptieTask 只持久化绑定的 repository id；详情页需要仓库目录将其解析为名称。
            // App 重启后 repositories 缓存为空，若不主动刷新会把有效绑定误显示为“未绑定”。
            if client.repositories.isEmpty {
                await client.refreshRepositories()
            }
        }
        .onAppear {
            // 切 Tab 会重建视图、@State 重置为 nil，这里恢复上次选中的 Work。
            restoreSelectionIfNeeded(client.works)
        }
        .task(id: selectedWorkId) {
            // 选中目标变化时拉取其工作项（三栏共享同一份 tasks）
            if selectedWorkId == WarRoomWorkScope.allSelectionId {
                if let loaded = await client.allCorptieTasks() {
                    tasks = loaded
                }
            } else if let workId = selectedWorkId,
               let work = client.works.first(where: { $0.id == workId }) {
                if let loaded = await client.tasks(for: work) {
                    tasks = loaded
                }
            } else {
                tasks = []
                client.clearCorptieTasksLoadError()
            }
        }
        .task(id: tasksReloadToken) {
            // 执行/换 Agent/保存后强制重新拉取，看板列与「当前执行」才能反映真实状态。
            guard tasksReloadToken != 0 else { return }
            if selectedWorkId == WarRoomWorkScope.allSelectionId {
                if let loaded = await client.allCorptieTasks() {
                    tasks = loaded
                }
            } else if let workId = selectedWorkId,
               let work = client.works.first(where: { $0.id == workId }) {
                if let loaded = await client.tasks(for: work) {
                    tasks = loaded
                }
            }
        }
        .onChange(of: client.works) { _, works in
            // 优先恢复仍存在的 Work；已删除或无记录时回到“全部”。
            restoreSelectionIfNeeded(works)
        }
        .onChange(of: selectedWorkId) { _, newValue in
            selectedCorptieTaskId = nil
            if let newValue {
                Self.recordWorkId(newValue)
            }
        }
        .onChange(of: tasks) { _, items in
            restoreCorptieTaskSelectionIfNeeded(items)
        }
        .onChange(of: client.tasksRevision) { _, _ in
            tasksReloadToken &+= 1
        }
        .onChange(of: selectedCorptieTaskId) { _, newValue in
            if let newValue {
                Self.recordCorptieTaskId(newValue)
            }
        }
        .sheet(item: $workPendingEdit) { work in
            WorkDetailView(work: work)
        }
        .sheet(item: $taskPendingEdit) { task in
            CorptieTaskEditView(task: task) {
                tasksReloadToken &+= 1
            }
        }
        .alert(L10n("删除 Work"), isPresented: Binding(
            get: { workPendingDeletion != nil },
            set: { if !$0 { workPendingDeletion = nil } }
        )) {
            Button(L10n("删除"), role: .destructive) {
                guard let work = workPendingDeletion else { return }
                workPendingDeletion = nil
                Task { await deleteWork(work) }
            }
            Button(L10n("取消"), role: .cancel) { workPendingDeletion = nil }
        } message: {
            Text(L10nFormat(
                "Delete “%@”? All of its CorptieTasks will be deleted. This action cannot be undone.",
                workPendingDeletion?.name ?? ""
            ))
        }
        .alert(L10n("Work deletion failed"), isPresented: Binding(
            get: { workDeletionError != nil },
            set: { if !$0 { workDeletionError = nil } }
        )) {
            Button(L10n("OK"), role: .cancel) { workDeletionError = nil }
        } message: {
            Text(workDeletionError ?? "")
        }
        .sheet(item: $deletionPresentation) { presentation in
            CorptieTaskDeletionConfirmationView(
                task: presentation.task,
                plan: presentation.plan,
                onCancel: { deletionPresentation = nil },
                onMergeFirst: {
                    deletionPresentation = nil
                    deletionNotice = CorptieTaskDeletionNotice(
                        phase: .guidance,
                        message: L10nFormat(
                            "CorptieTask 未删除。请先在项目 Worktree 管理中将分支 %@ 合并到目标主分支，确认无待提交文件后再重试删除。",
                            presentation.plan.worktree?.branchName ?? ""
                        ),
                        retryItem: presentation.task
                    )
                },
                onDelete: { force, branch, deleteWorktree, artifactDisposition in
                    enqueueDeletion(
                        presentation.task,
                        force: force,
                        confirmedBranchName: branch,
                        deleteWorktree: deleteWorktree,
                        artifactDisposition: artifactDisposition
                    )
                }
            )
        }
    }

    // MARK: - 右侧 CorptieTask 详情卡片

    private var consoleWorkspace: some View {
        HStack(spacing: TwoPaneLayoutMetrics.contentPadding) {
            warRoomContent
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            taskDetailCard
        }
        .padding(.trailing, TwoPaneLayoutMetrics.contentPadding)
        .overlay(alignment: .bottomTrailing) {
            if let deletionNotice {
                deletionNoticeView(deletionNotice)
                    .padding(.trailing, TwoPaneLayoutMetrics.contentPadding)
                    .padding(.bottom, TwoPaneLayoutMetrics.contentPadding + 4)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeOut(duration: 0.18), value: deletionNotice?.id)
    }

    private var taskDetailCard: some View {
        taskDetail
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

    private var workSidebar: some View {
        List(selection: $selectedWorkId) {
            Label(L10n("All"), systemImage: "square.grid.2x2")
                .tag(WarRoomWorkScope.allSelectionId)

            if client.isLoading && client.works.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, alignment: .center)
            } else if client.works.isEmpty {
                sidebarEmptyState(L10n("No Works"))
            } else {
                ForEach(client.works) { work in
                    workSidebarLabel(work)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .tag(work.id)
                        .contextMenu {
                            Button(L10n("View Tasks"), systemImage: "rectangle.grid.1x2") {
                                selectedWorkId = work.id
                            }
                            Button(L10n("编辑"), systemImage: "square.and.pencil") {
                                workPendingEdit = work
                            }
                            Divider()
                            Button(L10n("删除"), systemImage: "trash", role: .destructive) {
                                workPendingDeletion = work
                            }
                        }
                }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .bottom) {
            Button {
                isCreatingWork = true
            } label: {
                Label(L10n("New Work"), systemImage: "plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(.regularMaterial)
        }
        .overlay(alignment: .top) {
            if let error = client.worksLoadError, backendClient.isOnline {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .sheet(isPresented: $isCreatingWork) {
            WorkCreateView()
        }
    }

    private func workSidebarLabel(_ work: Work) -> some View {
        HStack(spacing: 8) {
            ObjectiveAvatarView(
                objectiveID: work.id,
                name: work.name,
                avatarPath: work.avatarPath,
                size: 20
            )
            Text(work.name)
                .lineLimit(1)
        }
    }

    // 空状态：新建入口常驻在 Sidebar 底部。
    private func sidebarEmptyState(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .padding(.vertical, 2)
    }

    // MARK: - Content（控制台看板）

    @ViewBuilder
    private var warRoomContent: some View {
        if let error = client.tasksLoadError,
           (selectedWorkId == WarRoomWorkScope.allSelectionId
            || client.works.contains(where: { $0.id == selectedWorkId })) {
            ContentUnavailableView {
                Label(L10n("CorptieTask 加载失败"), systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button(L10n("重试")) {
                    tasksReloadToken &+= 1
                }
            }
        } else if client.works.isEmpty {
            ContentUnavailableView(
                L10n("No Works"),
                systemImage: "target",
                description: Text(L10n("通过助手对话或快捷输入创建第一个目标"))
            )
        } else if selectedWorkId == WarRoomWorkScope.allSelectionId {
            CorptieTaskBoardView(
                work: nil,
                items: tasks,
                selectedCorptieTaskId: $selectedCorptieTaskId,
                pendingDeletionIds: pendingDeletionIds,
                onRequestEdit: { taskPendingEdit = $0 },
                onRequestDeletion: { item in Task { await prepareDeletion(item) } },
                onRequestReload: { tasksReloadToken &+= 1 },
                onRequestLoadMore: loadMoreTasks
            )
        } else if let work = client.works.first(where: { $0.id == selectedWorkId }) {
            CorptieTaskBoardView(
                work: work,
                items: tasks,
                selectedCorptieTaskId: $selectedCorptieTaskId,
                pendingDeletionIds: pendingDeletionIds,
                onRequestEdit: { taskPendingEdit = $0 },
                onRequestDeletion: { item in Task { await prepareDeletion(item) } },
                onRequestReload: { tasksReloadToken &+= 1 },
                onRequestLoadMore: loadMoreTasks
            )
        } else {
            ContentUnavailableView(L10n("选择目标"), systemImage: "sidebar.left")
        }
    }

    private func loadMoreTasks() async {
        if let loaded = await client.loadMoreBrowsedTasks() {
            tasks = loaded
        }
    }

    // MARK: - Detail

    @ViewBuilder
    private var taskDetail: some View {
        if let task = tasks.first(where: { $0.id == selectedCorptieTaskId }) {
            let owningWork = client.works.first(where: { $0.id == task.workId })
            CorptieTaskDetailView(
                task: task,
                contributorAgentIds: owningWork?.contributorAgentIds ?? [],
                isDeletionPending: pendingDeletionIds.contains(task.id),
                onRequestDeletion: { Task { await prepareDeletion(task) } },
                onRequestReload: { tasksReloadToken &+= 1 }
            )
        } else {
            ContentUnavailableView(L10n("选择工作项"), systemImage: "square.grid.2x2")
        }
    }

    // MARK: - 上次选中 Work 的持久化

    private func restoreSelectionIfNeeded(_ works: [Work]) {
        if selectedWorkId == WarRoomWorkScope.allSelectionId { return }
        if let selectedWorkId,
           works.contains(where: { $0.id == selectedWorkId }) {
            return
        }
        let savedId = Self.restoredWorkId()
        // 初次进入时快照可能尚未返回；先保留 Work 选择，避免把它过早覆盖为“全部”。
        if works.isEmpty,
           let savedId,
           savedId != WarRoomWorkScope.allSelectionId {
            return
        }
        selectedWorkId = WarRoomWorkScope.restoredSelection(
            savedId: savedId,
            works: works
        )
    }

    private static func recordWorkId(_ id: String) {
        CorptieAppEnvironment.userDefaults.set(id, forKey: lastSelectedWorkKey)
    }

    private static func restoredWorkId() -> String? {
        CorptieAppEnvironment.userDefaults.string(forKey: lastSelectedWorkKey)
    }

    // MARK: - 上次选中 CorptieTask 的持久化

    private func restoreCorptieTaskSelectionIfNeeded(_ items: [CorptieTask]) {
        guard !items.isEmpty else {
            selectedCorptieTaskId = nil
            return
        }

        // 刷新列表时保留仍然有效的当前选择；首次进入或切换 Work 时，
        // 优先恢复上次选择。若它已删除，则选择当前 Work 的第一个工作项，
        // 保证详情栏不会停留在无效的空状态。
        if let selectedCorptieTaskId,
           items.contains(where: { $0.id == selectedCorptieTaskId }) {
            return
        }
        if let lastId = Self.restoredCorptieTaskId(),
           let last = items.first(where: { $0.id == lastId }) {
            selectedCorptieTaskId = last.id
        } else {
            selectedCorptieTaskId = items.first?.id
        }
    }

    private static func recordCorptieTaskId(_ id: String) {
        CorptieAppEnvironment.userDefaults.set(id, forKey: lastSelectedCorptieTaskKey)
    }

    private static func restoredCorptieTaskId() -> String? {
        CorptieAppEnvironment.userDefaults.string(forKey: lastSelectedCorptieTaskKey)
    }

    private var pendingDeletionIds: Set<String> {
        inspectingDeletionIds.union(deletingCorptieTaskIds)
    }

    private func deleteWork(_ work: Work) async {
        guard await client.deleteWork(workId: work.id) else {
            workDeletionError = client.errorMessage ?? L10n("Unable to delete Work.")
            return
        }
        if selectedWorkId == work.id {
            selectedWorkId = WarRoomWorkScope.allSelectionId
        }
    }

    private func prepareDeletion(_ task: CorptieTask) async {
        guard !pendingDeletionIds.contains(task.id) else { return }
        inspectingDeletionIds.insert(task.id)
        deletionNotice = CorptieTaskDeletionNotice(
            phase: .checking,
            message: L10nFormat("正在检查 CorptieTask“%@”的关联资源…", task.title)
        )
        defer { inspectingDeletionIds.remove(task.id) }

        guard let plan = await client.inspectCorptieTaskDeletion(taskId: task.id) else {
            deletionNotice = CorptieTaskDeletionNotice(
                phase: .failure,
                message: client.errorMessage ?? L10n("无法检查 CorptieTask 的关联资源。"),
                retryItem: task
            )
            return
        }
        deletionNotice = nil
        deletionPresentation = CorptieTaskDeletionPresentation(task: task, plan: plan)
    }

    private func enqueueDeletion(
        _ task: CorptieTask,
        force: Bool,
        confirmedBranchName: String?,
        deleteWorktree: Bool,
        artifactDisposition: CorptieTaskArtifactDisposition
    ) {
        guard !deletingCorptieTaskIds.contains(task.id) else { return }

        // 用户确认后立即收起模态窗口。清理在后台 Task 中继续，控制台仅展示非阻塞状态。
        deletionPresentation = nil
        BackgroundTaskCenter.shared.start(
            id: "task.deletion.\(task.id)",
            title: L10nFormat("删除 CorptieTask：%@", task.title)
        ) {
            deletingCorptieTaskIds.insert(task.id)
            let deleted = await client.deleteCorptieTask(
                taskId: task.id,
                force: force,
                confirmedBranchName: confirmedBranchName,
                deleteWorktree: deleteWorktree,
                artifactDisposition: artifactDisposition
            )
            deletingCorptieTaskIds.remove(task.id)

            if deleted {
                tasks.removeAll { $0.id == task.id }
                if selectedCorptieTaskId == task.id { selectedCorptieTaskId = nil }
                tasksReloadToken &+= 1
                return .success(L10nFormat("CorptieTask“%@”已删除。", task.title))
            }
            return .failure(client.errorMessage ?? L10n("删除失败；资源状态已保留，可修复后安全重试。"))
        }
    }

    private func deletionNoticeView(_ notice: CorptieTaskDeletionNotice) -> some View {
        HStack(spacing: 10) {
            if notice.phase.isInProgress {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: notice.phase.systemImage)
                    .foregroundStyle(notice.phase.color)
            }
            Text(notice.message)
                .font(.callout)
                .lineLimit(3)
                .frame(maxWidth: 360, alignment: .leading)
            if let retryItem = notice.retryItem, notice.phase != .guidance {
                Button(L10n("重试")) {
                    Task { await prepareDeletion(retryItem) }
                }
                .buttonStyle(.borderless)
            }
            Button {
                deletionNotice = nil
            } label: {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .help(L10n("关闭"))
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(0.45), lineWidth: 1)
        }
        .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
    }
}

struct CorptieTaskDeletionPresentation: Identifiable {
    let id = UUID()
    let task: CorptieTask
    let plan: CorptieTaskDeletionPlan
}

private struct CorptieTaskDeletionNotice: Identifiable {
    enum Phase: Equatable {
        case checking
        case deleting
        case success
        case failure
        case guidance

        var isInProgress: Bool { self == .checking || self == .deleting }
        var systemImage: String {
            switch self {
            case .checking, .deleting: "hourglass"
            case .success: "checkmark.circle.fill"
            case .failure: "exclamationmark.triangle.fill"
            case .guidance: "arrow.triangle.merge"
            }
        }
        var color: Color {
            switch self {
            case .success: .green
            case .failure: .red
            case .guidance: .orange
            case .checking, .deleting: .secondary
            }
        }
    }

    let id = UUID()
    let phase: Phase
    let message: String
    var retryItem: CorptieTask?
}

// MARK: - CorptieTask 混合看板

enum WorkDiscussionRouteDecision: Equatable {
    case open(sessionId: String)
    case create

    static func resolve(workId: String, sessions: [TaskSession]) -> Self {
        if let session = sessions.first(where: {
            $0.workId == workId && $0.resolvedSessionKind == .workChat
        }) {
            return .open(sessionId: session.id)
        }
        return .create
    }
}

enum CorptieTaskAcceptancePresentationDecision {
    static func canOpenCompletionConfirmation(status: String) -> Bool {
        ["in_progress", "doing", "running"].contains(status)
    }
}

struct CorptieTaskAutomaticAcceptancePresentation: Equatable {
    enum State: Equatable {
        case passed
        case notPassed
        case notAssessed
    }

    let state: State
    let results: [CorptieTaskAcceptanceResult]

    static func resolve(
        assessment: CorptieTaskAcceptanceAssessment?,
        suggestion: CorptieTaskCompletionSuggestion?
    ) -> Self {
        if let assessment {
            return Self(
                state: assessment.status == "passed" ? .passed : .notPassed,
                results: assessment.results
            )
        }
        if let suggestion, suggestion.recommended {
            return Self(state: .passed, results: suggestion.results)
        }
        return Self(state: .notAssessed, results: [])
    }
}

enum CorptieTaskAcceptanceReviewState: Equatable {
    case passed
    case manuallyRejected
    case unavailable

    static func resolve(_ task: CorptieTask) -> Self {
        if task.acceptanceAssessment?.status == "rejected" {
            return .manuallyRejected
        }
        if task.completionSuggestion?.recommended == true {
            return .passed
        }
        return .unavailable
    }
}

enum CorptieTaskBoundSessionActivity: Equatable {
    case noSession
    case processing
    case waitingForInput
    case idle
    case paused
    case interrupted
    case failed
    case unknown

    static func resolve(task: CorptieTask, sessions: [TaskSession]) -> Self {
        let currentSessionId = task.currentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let boundSession = currentSessionId.flatMap { sessionId in
            sessions.first(where: { $0.id == sessionId })
        }
            ?? sessions
                .filter { $0.taskId == task.id && $0.archived != true }
                .max(by: { $0.updatedAt < $1.updatedAt })

        guard currentSessionId?.isEmpty == false || boundSession != nil else { return .noSession }

        if let status = boundSession?.status {
            switch status {
            case .running: return .processing
            case .blocked: return .waitingForInput
            case .complete: return .idle
            case .cancelled: return .interrupted
            case .failed: return .failed
            }
        }

        switch task.executionStatus {
        case "running": return .processing
        case "blocked": return .waitingForInput
        case "idle", "completed": return .idle
        case "paused": return .paused
        case "cancelled", "canceled": return .interrupted
        case "failed": return .failed
        default: return .unknown
        }
    }

    @MainActor var label: String {
        switch self {
        case .noSession: L10n("No Session")
        case .processing: L10n("Processing")
        case .waitingForInput: L10n("Waiting for Input")
        case .idle: L10n("Idle")
        case .paused: L10n("Paused")
        case .interrupted: L10n("Interrupted")
        case .failed: L10n("Failed")
        case .unknown: L10n("Unknown")
        }
    }

    var color: Color {
        switch self {
        case .processing: CorptiePalette.connected
        case .waitingForInput, .paused: .orange
        case .idle: .orange
        case .interrupted, .failed: .red
        case .noSession, .unknown: .secondary
        }
    }
}

struct CorptieTaskBoardView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    let work: Work?
    let items: [CorptieTask]
    @Binding var selectedCorptieTaskId: String?
    let pendingDeletionIds: Set<String>
    let onRequestEdit: (CorptieTask) -> Void
    let onRequestDeletion: (CorptieTask) -> Void
    var onRequestReload: () -> Void = {}
    var onRequestLoadMore: () async -> Void = {}
    @State private var boardItems: [CorptieTask] = []
    @State private var isCreating = false
    @State private var isCreatingWorkChat = false
    @State private var collapsedColumns: Set<CorptieTaskColumn> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(work?.name ?? L10n("All"))
                    .font(.title3.bold())
                Spacer()
                if work != nil {
                    Button {
                        openOrCreateWorkDiscussion()
                    } label: {
                        Label(L10n("讨论"), systemImage: "bubble.left.and.bubble.right")
                    }
                    Button {
                        isCreating = true
                    } label: {
                        Label(L10n("新建工作项"), systemImage: "plus")
                    }
                }
            }
            HStack(alignment: .top, spacing: 12) {
                ForEach(CorptieTaskColumn.allCases) { column in
                    CorptieTaskColumnView(
                        column: column,
                        items: boardItems.filter { CorptieTaskColumn.column(for: $0.lifecycleState) == column },
                        sessions: backendClient.sessions,
                        selectedCorptieTaskId: $selectedCorptieTaskId,
                        pendingDeletionIds: pendingDeletionIds,
                        onRequestEdit: onRequestEdit,
                        onRequestDeletion: onRequestDeletion,
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
            if client.browsedTasksHasMore {
                Button(L10n("加载更多工作项")) {
                    Task { await onRequestLoadMore() }
                }
                .frame(maxWidth: .infinity, alignment: .center)
            }
        }
        .padding()
        .onAppear { boardItems = items }
        .onChange(of: items) { _, newValue in boardItems = newValue }
        .sheet(isPresented: $isCreating) {
            if let work {
                CorptieTaskCreateView(
                    workId: work.id,
                    contributorAgentIds: work.contributorAgentIds
                ) { created in
                    if !boardItems.contains(where: { $0.id == created.id }) {
                        boardItems.append(created)
                    }
                    onRequestReload()
                }
            }
        }
        .sheet(isPresented: $isCreatingWorkChat) {
            if let work {
                NewSessionCreationSheet(fixedWork: work) { session in
                    router.openSession(session.id)
                }
            }
        }
    }

    private func openOrCreateWorkDiscussion() {
        guard let work else { return }
        switch WorkDiscussionRouteDecision.resolve(
            workId: work.id,
            sessions: backendClient.sessions
        ) {
        case .open(let sessionId):
            router.openSession(sessionId)
        case .create:
            isCreatingWorkChat = true
        }
    }
}

// MARK: - 单列

struct CorptieTaskColumnView: View {
    let column: CorptieTaskColumn
    let items: [CorptieTask]
    let sessions: [TaskSession]
    @Binding var selectedCorptieTaskId: String?
    let pendingDeletionIds: Set<String>
    let onRequestEdit: (CorptieTask) -> Void
    let onRequestDeletion: (CorptieTask) -> Void
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
                            CorptieTaskCard(
                                item: item,
                                sessions: sessions,
                                isSelected: selectedCorptieTaskId == item.id,
                                isDeletionPending: pendingDeletionIds.contains(item.id)
                            )
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                                .onTapGesture { selectedCorptieTaskId = item.id }
                                .contextMenu {
                                    Button(L10n("编辑"), systemImage: "square.and.pencil") {
                                        onRequestEdit(item)
                                    }
                                    Divider()
                                    Button(role: .destructive) {
                                        onRequestDeletion(item)
                                    } label: {
                                        Label(L10n("删除 CorptieTask"), systemImage: "trash")
                                    }
                                    .disabled(pendingDeletionIds.contains(item.id))
                                }

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

struct CorptieTaskCard: View {
    let item: CorptieTask
    let sessions: [TaskSession]
    let isSelected: Bool
    let isDeletionPending: Bool

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

                if isDeletionPending {
                    HStack(spacing: 5) {
                        ProgressView().controlSize(.mini)
                        Text(L10n("后台处理中"))
                    }
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(.secondary)
                } else {
                    sessionStatusPill
                }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isSelected ? Color.accentColor.opacity(0.08) : Color.clear)
        .contentShape(Rectangle())
    }

    private var sessionActivity: CorptieTaskBoundSessionActivity {
        CorptieTaskBoundSessionActivity.resolve(task: item, sessions: sessions)
    }

    private var sessionStatusPill: some View {
        statusPill(
            L10nFormat("Session: %@", sessionActivity.label),
            color: sessionActivity.color
        )
    }

    private func statusPill(_ label: String, color: Color) -> some View {
        HStack(spacing: 4) {
            Circle()
                .fill(color)
                .frame(width: 6, height: 6)
            Text(label)
                .lineLimit(1)
        }
        .font(.system(size: 9.5, weight: .medium))
        .foregroundStyle(color)
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(color.opacity(0.1), in: Capsule())
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

enum CorptieTaskExecutionStartDecision: Equatable {
    case restoreCompleted
    case resume(sessionId: String)
    case createSession(agentId: String)
    case chooseAgent

    static func resolve(status: String, currentSessionId: String?, mainAgentId: String?) -> Self {
        if ["done", "complete", "completed"].contains(status) {
            return .restoreCompleted
        }
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

enum CorptieTaskCompletionBackgroundDecision: Equatable {
    case submit
    case alreadyCompleted

    static func resolve(status: String) -> Self {
        ["done", "complete", "completed"].contains(status) ? .alreadyCompleted : .submit
    }

    static func requiresExplicitUserConfirmation(status: String) -> Bool {
        ["in_progress", "doing", "running"].contains(status)
    }
}

enum CorptieTaskEditSubmissionPolicy {
    static func submitsInBackground(statusChanged: Bool) -> Bool {
        statusChanged
    }
}

struct CorptieTaskDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    let task: CorptieTask
    let contributorAgentIds: [String]
    var isDeletionPending = false
    var onRequestDeletion: (() -> Void)?
    var onRequestReload: () -> Void = {}
    var showsHeader = true
    var embedsInParentScroll = false

    @State private var currentSession: CorptieTaskSessionSummary?
    @State private var memories: [MemoryItem] = []
    @State private var showAgentPicker = false
    @State private var showAgentSwitch = false
    @State private var executionAgentIds = Set<String>()
    @State private var executionError: EntityLaunchError?
    @State private var showEdit = false
    @State private var showCompleteConfirmation = false
    @State private var isLaunchingExecution = false
    @State private var sessionCreationAgent: Agent?
    @State private var worktreeStatus: CorptieTaskWorktreeStatus?
    @State private var isLoadingWorktree = false
    @State private var isReclaimingWorktree = false
    @State private var showReclaimConfirmation = false
    @State private var deletionPlan: CorptieTaskDeletionPlan?
    @State private var showDeletion = false
    @State private var isInspectingDeletion = false
    @State private var isDeletingCorptieTask = false
    @State private var deletionFeedback: String?
    @State private var showMemoryInspector = false
    @State private var showAcceptanceReview = false
    @State private var isRejectingAcceptance = false
    @State private var acceptanceRejectionError: String?

    var body: some View {
        VStack(spacing: 0) {
            if showsHeader {
                detailHeader

                Divider()
                    .opacity(0.5)
            }

            if embedsInParentScroll {
                detailContent
            } else {
                ScrollView {
                    detailContent
                }
            }
        }
        .task(id: task) {
            // 以 task 作为 task 标识：当父层重新拉取、currentSessionId 等字段变化时，
            // 本视图会拿到新的 task 值并重新刷新「当前执行」，避免依赖陈旧的 currentSessionId。
            await refreshExecution()
            await ensureCompanionSessionIfNeeded()
            if isCompleted { await refreshWorktree() }
        }
        .sheet(isPresented: $showEdit) {
            CorptieTaskEditView(task: task) {
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
                        _ = await client.updateCorptieTask(taskId: task.id, mainAgentId: agentId)
                        await refreshExecution()
                        onRequestReload()
                    }
                }
            })
        }
        .sheet(item: $sessionCreationAgent) { agent in
            NewSessionCreationSheet(
                fixedAgent: agent,
                fixedCorptieTask: task,
                submitsInBackground: true
            ) { _ in
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
            Button(L10n("好"), role: .cancel) { executionError = nil }
        } message: {
            Text(executionError?.message ?? "")
        }
        .sheet(isPresented: $showCompleteConfirmation) {
            CorptieTaskCompletionConfirmationView(
                task: task,
                assessment: task.acceptanceAssessment,
                suggestion: task.completionSuggestion,
                onConfirm: { enqueueCompletion() },
                onCancel: {
                    showCompleteConfirmation = false
                }
            )
        }
        .sheet(isPresented: $showAcceptanceReview) {
            CorptieTaskAcceptanceReviewView(
                task: task,
                isRejecting: isRejectingAcceptance,
                rejectionError: acceptanceRejectionError,
                onClose: { showAcceptanceReview = false },
                onReject: { rejectAutomaticAcceptance() }
            )
        }
        .sheet(isPresented: $showDeletion) {
            if let deletionPlan {
                CorptieTaskDeletionConfirmationView(
                    task: task,
                    plan: deletionPlan,
                    onCancel: { showDeletion = false },
                    onMergeFirst: {
                        showDeletion = false
                        deletionFeedback = L10n("Merge the Task Worktree into the target branch before deleting it.")
                    },
                    onDelete: { force, branch, deleteWorktree, artifactDisposition in
                        deleteTask(
                            force: force,
                            confirmedBranchName: branch,
                            deleteWorktree: deleteWorktree,
                            artifactDisposition: artifactDisposition
                        )
                    }
                )
            }
        }
        .alert(L10n("Task deletion"), isPresented: Binding(
            get: { deletionFeedback != nil },
            set: { if !$0 { deletionFeedback = nil } }
        )) {
            Button(L10n("OK"), role: .cancel) { deletionFeedback = nil }
        } message: {
            Text(deletionFeedback ?? "")
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

    private var detailContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            overviewSection

            detailTextSection(
                title: L10n("Goal"),
                systemImage: "scope",
                text: task.goal
            )

            detailTextSection(
                title: L10n("Description"),
                systemImage: "text.alignleft",
                text: task.description
            )

            detailTextSection(
                title: L10n("Acceptance Criteria"),
                systemImage: "checklist",
                text: task.acceptanceCriteria
            )

            detailTextSection(
                title: L10n("Verification Criteria"),
                systemImage: "checkmark.seal",
                text: task.verificationCriteria
            )

            ArtifactSectionView(workId: task.workId, taskId: task.id)

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

    private var detailHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.text.square")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(L10n("CorptieTask 详情"))
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
            Menu {
                if let currentSession,
                   let liveSession = backendClient.sessions.first(where: { $0.id == currentSession.id }) {
                    Button(L10n("Restart"), systemImage: "arrow.clockwise") {
                        backendClient.restart(session: liveSession)
                    }
                    .disabled(liveSession.actions?.restart?.available != true)
                    Button(L10n("Archive"), systemImage: "archivebox") {
                        backendClient.setArchived(true, session: liveSession)
                    }
                }
                Divider()
                Button(L10n("Delete Task"), systemImage: "trash", role: .destructive) {
                    if let onRequestDeletion {
                        onRequestDeletion()
                    } else {
                        inspectDeletion()
                    }
                }
                .disabled(isDeletionPending || isInspectingDeletion || isDeletingCorptieTask)
            } label: {
                if isDeletionPending || isInspectingDeletion || isDeletingCorptieTask {
                    ProgressView().controlSize(.small).frame(width: 24, height: 24)
                } else {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 12, weight: .medium))
                        .frame(width: 24, height: 24)
                }
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .help(L10n("Task Actions"))
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.vertical, 9)
    }

    private var overviewSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(task.title)
                .font(.system(size: 16, weight: .semibold))
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 7) {
                compactStatusBadge(task.lifecycleState)
                metadataPill(priorityLabel, systemImage: "flag")
                if let origin = task.creationOrigin {
                    metadataPill(creationOriginLabel(origin), systemImage: "arrow.turn.down.right")
                        .help(creationOriginHelp(origin))
                }
            }


            switch acceptanceReviewState {
            case .passed:
                Button {
                    acceptanceRejectionError = nil
                    showAcceptanceReview = true
                } label: {
                    Label(L10n("自动验收已通过"), systemImage: "checkmark.seal.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.green)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(Color.green.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n("自动验收已通过"))
                .accessibilityHint(L10n("查看自动验收情况"))
            case .manuallyRejected:
                Label(L10n("人工验收未通过"), systemImage: "xmark.seal.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.red.opacity(0.1), in: Capsule())
                    .accessibilityLabel(L10n("人工验收未通过"))
            case .unavailable:
                EmptyView()
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
                        .foregroundStyle(workspaceName == nil ? Color.secondary : Color.primary)
                        .lineLimit(2)
                }
            }
        }
    }

    private func creationOriginLabel(_ origin: CorptieTaskCreationOrigin) -> String {
        switch origin.originType {
        case "direct_user": L10n("用户创建")
        case "session": L10n("Session 创建")
        case "system": L10n("系统创建")
        default: L10n("历史来源未知")
        }
    }

    private func creationOriginHelp(_ origin: CorptieTaskCreationOrigin) -> String {
        guard origin.originType == "session", let sessionID = origin.creatorSessionId else {
            return creationOriginLabel(origin)
        }
        return L10nFormat("创建 Session：%@；仅为来源记录，不构成父子或协作关系", sessionID)
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
            HStack {
                Label(L10n("执行状态"), systemImage: "waveform.path.ecg")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                executionControlButton
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

                Text(CorptieTaskExecutionPresentation.label(
                    executionStatus: task.executionStatus,
                    sessionStatus: currentSession?.status
                ))
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)

                if let currentSession {
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
                Button {
                    showMemoryInspector = true
                } label: {
                    Image(systemName: "arrow.up.right.square")
                }
                .buttonStyle(.borderless)
                .help(L10n("Open Memory Inspector"))
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
        .sheet(isPresented: $showMemoryInspector) {
            VStack(alignment: .leading, spacing: 12) {
                Text(L10n("CorptieTask Memories")).font(.headline)
                MemoryManagementView(scope: .owner(type: "task", id: task.id))
            }
            .padding(20)
            .frame(width: 760, height: 580)
        }
    }

    // 当前 CorptieTask 绑定的 Agent（依据 mainAgentId 从 agents 列表解析）。
    private var currentAgent: Agent? {
        guard let agentId = task.mainAgentId else { return nil }
        return client.agents.first { $0.agentId == agentId }
    }

    // 是否已完成：只看 CorptieTask 自身状态。Session complete 只代表一次执行落定，
    // 只有证据支持的验收建议经用户确认后 status 才为 done。
    private var isCompleted: Bool {
        task.lifecycleState == "done"
    }

    private var acceptanceReviewState: CorptieTaskAcceptanceReviewState {
        .resolve(task)
    }

    private func rejectAutomaticAcceptance() {
        guard !isRejectingAcceptance else { return }
        isRejectingAcceptance = true
        acceptanceRejectionError = nil
        Task {
            defer { isRejectingAcceptance = false }
            guard await client.rejectCorptieTaskAcceptance(taskId: task.id) != nil else {
                acceptanceRejectionError = client.errorMessage ?? L10n("Unable to reject automated acceptance")
                return
            }
            showAcceptanceReview = false
            onRequestReload()
        }
    }

    private func inspectDeletion() {
        guard !isInspectingDeletion, !isDeletingCorptieTask else { return }
        isInspectingDeletion = true
        Task {
            defer { isInspectingDeletion = false }
            guard let plan = await client.inspectCorptieTaskDeletion(taskId: task.id) else {
                deletionFeedback = client.errorMessage ?? L10n("Unable to inspect Task deletion.")
                return
            }
            deletionPlan = plan
            showDeletion = true
        }
    }

    private func deleteTask(
        force: Bool,
        confirmedBranchName: String?,
        deleteWorktree: Bool,
        artifactDisposition: CorptieTaskArtifactDisposition
    ) {
        guard !isDeletingCorptieTask else { return }
        showDeletion = false
        BackgroundTaskCenter.shared.start(
            id: "task.deletion.\(task.id)",
            title: L10nFormat("删除 CorptieTask：%@", task.title)
        ) {
            isDeletingCorptieTask = true
            let deleted = await client.deleteCorptieTask(
                taskId: task.id,
                force: force,
                confirmedBranchName: confirmedBranchName,
                deleteWorktree: deleteWorktree,
                artifactDisposition: artifactDisposition
            )
            isDeletingCorptieTask = false
            if deleted {
                await client.refreshWorks()
                onRequestReload()
                return .success(L10nFormat("CorptieTask“%@”已删除。", task.title))
            }
            return .failure(client.errorMessage ?? L10n("Unable to delete Task."))
        }
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
        case "SHARED_WITH_ACTIVE_TASK": L10n("This Worktree is still used by an active CorptieTask.")
        default: L10n("This Worktree is not safe to reclaim yet.")
        }
    }

    private func refreshWorktree() async {
        guard !isLoadingWorktree else { return }
        isLoadingWorktree = true
        defer { isLoadingWorktree = false }
        worktreeStatus = await client.worktreeStatus(taskId: task.id)
    }

    private func reclaimWorktree() async {
        guard !isReclaimingWorktree else { return }
        isReclaimingWorktree = true
        defer { isReclaimingWorktree = false }
        if let status = await client.reclaimWorktree(taskId: task.id) {
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

    // Task 创建时已经自动启动伴生 Work Session，因此这里不再提供手动开始按钮。
    // 仅保留运行中的终止操作，以及已完成 Task 的显式恢复操作。
    @ViewBuilder
    private var executionControlButton: some View {
        if isCompleted {
            Button {
                Task { await startOrResumeExecution() }
            } label: {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Color.accentColor, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(isLaunchingExecution)
            .help(L10n("Resume"))
        } else if isRunning {
            Button {
                Task { await interruptExecution() }
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Color.red, in: Circle())
            }
            .buttonStyle(.plain)
            .help(L10n("终止执行"))
        }
    }

    // 开始执行：已有会话则恢复；否则优先使用 CorptieTask 已绑定的 Agent，未绑定时才让用户选择。
    private func startOrResumeExecution() async {
        switch CorptieTaskExecutionStartDecision.resolve(
            status: task.lifecycleState,
            currentSessionId: currentSession?.id,
            mainAgentId: task.mainAgentId
        ) {
        case .restoreCompleted:
            guard !isLaunchingExecution else { return }
            isLaunchingExecution = true
            defer { isLaunchingExecution = false }
            let result = await client.restoreCorptieTaskExecution(taskId: task.id)
            if result.task != nil {
                await refreshExecution()
                onRequestReload()
            } else {
                executionError = result.error ?? EntityLaunchError(
                    message: client.errorMessage ?? L10n("Unable to restore CorptieTask execution"),
                    code: nil
                )
            }
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

    // 用户在前台完成证据审阅与最终裁决；确认后立即关闭审阅窗，
    // 专用完成接口由全局后台任务执行。重试前先查询权威状态，防止
    // 首次请求已落库但客户端丢失响应时重复提交。
    private func enqueueCompletion() {
        let target = task
        let requestId = "completion-request:\(UUID().uuidString.lowercased())"
        let interactionId = "completion-click:\(UUID().uuidString.lowercased())"
        let idempotencyKey = "completion:\(UUID().uuidString.lowercased())"
        Task {
            guard let receipt = await client.issueCorptieTaskCompletionIntent(
                task: target,
                interactionId: interactionId,
                requestId: requestId,
                uiSurface: "task_completion_confirmation"
            ) else {
                executionError = EntityLaunchError(
                    message: client.errorMessage ?? L10n("Unable to authorize CorptieTask completion"),
                    code: "COMPLETION_INTENT_FAILED"
                )
                return
            }
            guard let submission = CorptieTaskCompletionSubmission.freeze(
                task: target, receipt: receipt, requestId: requestId, idempotencyKey: idempotencyKey
            ) else { return }
            startCompletionBackgroundTask(submission: submission)
        }
    }

    private func startCompletionBackgroundTask(submission: CorptieTaskCompletionSubmission) {
        let taskId = "task.complete:\(submission.taskId)"
        let title = submission.displayedTitle
        let started = BackgroundTaskCenter.shared.start(
            id: taskId,
            title: L10nFormat("完成 CorptieTask：%@", title)
        ) {
            if let latest = await client.task(id: submission.taskId),
               CorptieTaskCompletionBackgroundDecision.resolve(status: latest.lifecycleState) == .alreadyCompleted {
                onRequestReload()
                return .success(L10nFormat("CorptieTask“%@”已完成。", title))
            }
            guard await client.confirmCorptieTaskCompletion(submission: submission) != nil else {
                return .failure(client.errorMessage ?? L10n("Unable to confirm CorptieTask completion"))
            }
            onRequestReload()
            return .success(L10nFormat("CorptieTask“%@”已完成。", title))
        }
        if started || BackgroundTaskCenter.shared.records.contains(where: { $0.id == taskId }) {
            showCompleteConfirmation = false
        }
    }

    private var priorityLabel: String {
        switch task.priority {
        case "low": L10n("Low")
        case "medium": L10n("Medium")
        case "high": L10n("High")
        default: task.priority
        }
    }

    private var workspaceName: String? {
        guard let work = client.works.first(where: { $0.id == task.workId }) else { return nil }
        return client.repositories.first(where: { $0.workspaceId == work.workspaceId })?.name
            ?? work.workspaceId
    }

    private func refreshExecution() async {
        if client.agents.isEmpty { await client.refreshAgents() }
        let sessions = await client.sessions(for: task)
        // 优先用 task.currentSessionId 匹配；匹配不到（例如旧 task 值仍为 nil）时，
        // 取后端返回列表里 updatedAt 最新的那一条，避免因陈旧 currentSessionId 导致「当前执行」显示为空。
        currentSession = sessions.first { $0.id == task.currentSessionId }
            ?? sessions.max(by: { $0.updatedAt < $1.updatedAt })
        if CorptieTaskMemoryPresentationPolicy.shouldLoad(currentSessionId: task.currentSessionId) {
            if let loaded = await client.memories(ownerType: "task", ownerId: task.id) {
                memories = loaded.filter {
                    $0.ownerType == "task" && $0.ownerId == task.id && $0.taskId == task.id
                }
            }
        } else {
            memories = []
        }
    }

    /// A non-completed Task without a Worker Session is an incomplete product
    /// state, not a user decision. Opening its detail repairs that state in the
    /// background through the same idempotent startup endpoint used at creation.
    private func ensureCompanionSessionIfNeeded() async {
        guard !isCompleted, currentSession == nil, !isLaunchingExecution else { return }
        guard let agentId = task.mainAgentId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !agentId.isEmpty else {
            executionError = EntityLaunchError(
                message: L10n("CorptieTask 没有负责 Agent，无法自动创建伴生 Session。"),
                code: "START_ASSIGNEE_REQUIRED"
            )
            return
        }
        isLaunchingExecution = true
        defer { isLaunchingExecution = false }

        if backendClient.agentProviders.isEmpty {
            await backendClient.loadProviders()
        }
        let providerId = CorptieTaskCreateProviderPolicy.selection(
            current: "",
            preferred: backendClient.defaultSessionProviderId,
            providers: backendClient.agentProviders
        )
        guard !providerId.isEmpty else {
            executionError = EntityLaunchError(
                message: L10n("没有可创建 Session 的 Provider。"),
                code: "SESSION_PROVIDER_NOT_FOUND"
            )
            return
        }

        let result = await client.createSession(
            taskId: task.id,
            agentId: agentId,
            providerId: providerId,
            title: task.title
        )
        guard let session = result.session else {
            executionError = result.error ?? EntityLaunchError(
                message: client.errorMessage ?? L10n("创建伴生 Session 失败"),
                code: nil
            )
            return
        }
        backendClient.acceptCreatedSession(session, selectImmediately: false)
        await refreshExecution()
        onRequestReload()
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
        if CorptieTaskAcceptancePresentationDecision.canOpenCompletionConfirmation(status: status) {
            Button {
                showCompleteConfirmation = true
            } label: {
                statusBadgeLabel(status)
            }
            .buttonStyle(.plain)
            .help(L10n("打开完成确认"))
        } else {
            statusBadgeLabel(status)
        }
    }

    private func statusBadgeLabel(_ status: String) -> some View {
        let (label, color): (String, Color) = {
            switch status {
            case "in_progress", "doing", "running": (L10n("In Progress"), .orange)
            case "review", "reviewing": (L10n("Awaiting Completion Approval"), .blue)
            case "done", "complete", "completed": (L10n("Completed"), .green)
            case "failed": (L10n("Failed"), .red)
            default: (L10n("Preparing"), .secondary)
            }
        }()
        return Label(label, systemImage: "circle.fill")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.11), in: Capsule())
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

struct CorptieTaskDeletionConfirmationView: View {
    let task: CorptieTask
    let plan: CorptieTaskDeletionPlan
    let onCancel: () -> Void
    let onMergeFirst: () -> Void
    let onDelete: (
        _ force: Bool,
        _ branch: String?,
        _ deleteWorktree: Bool,
        _ artifactDisposition: CorptieTaskArtifactDisposition
    ) -> Void

    @State private var showForceConfirmation = false
    @State private var confirmedBranch = ""
    @State private var acknowledgesDataLoss = false
    @State private var deleteWorktree = true
    @State private var artifactDisposition: CorptieTaskArtifactDisposition = .delete

    private var artifacts: [CorptieTaskDeletionArtifact] { plan.artifacts ?? [] }
    private var effectiveBlockers: [CorptieTaskDeletionRisk] {
        deleteWorktree ? plan.blockers : plan.blockers.filter { $0.code == "START_IN_PROGRESS" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label(
                showForceConfirmation ? L10n("二次确认强制删除") : L10n("删除 CorptieTask"),
                systemImage: "exclamationmark.triangle.fill"
            )
            .font(.title3.weight(.semibold))
            .foregroundStyle(showForceConfirmation ? Color.red : Color.primary)

            Text(task.title).font(.headline)

            Text(L10nFormat(
                "删除此 CorptieTask 将永久删除 %d 个关联会话及完整会话历史。Worktree 和 Artifact 将按下方选项处理。此操作无法撤销。",
                plan.associatedSessionCount
            ))
            .font(.callout.weight(.semibold))
            .foregroundStyle(.red)

            if let worktree = plan.worktree {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("关联的专属 Worktree")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    Text(worktree.path).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    Text(worktree.branchName ?? L10n("未知分支")).font(.system(.caption, design: .monospaced))
                }
                .padding(10)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
                Toggle(L10n("删除关联的 Worktree 和分支"), isOn: $deleteWorktree)
            } else {
                Text(L10n("此 CorptieTask 没有关联专属 Worktree；不会执行 Worktree 或分支清理。"))
                    .font(.callout).foregroundStyle(.secondary)
            }

            if !artifacts.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L10nFormat("Artifact 处理（%d 个）", artifacts.count))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Picker(L10n("Artifact 处理"), selection: $artifactDisposition) {
                        Text(L10n("删除")).tag(CorptieTaskArtifactDisposition.delete)
                        Text(L10n("移入 Work 层级")).tag(CorptieTaskArtifactDisposition.work)
                        Text(L10n("留在原地")).tag(CorptieTaskArtifactDisposition.retain)
                    }
                    .pickerStyle(.radioGroup)
                    ForEach(artifacts.prefix(5)) { artifact in
                        Text(artifact.title).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
            }

            if !effectiveBlockers.isEmpty {
                riskList(title: L10n("当前无法安全删除"), risks: effectiveBlockers, color: .red)
            }
            if deleteWorktree, !plan.risks.isEmpty {
                riskList(title: L10n("可能丢失的内容"), risks: plan.risks, color: .orange)
            }

            if showForceConfirmation {
                Text(L10n("强制删除将永久丢弃上述未提交修改、未跟踪文件和未合并提交，且无法从 Corptie 恢复。"))
                    .font(.callout.weight(.semibold)).foregroundStyle(.red)
                TextField(L10n("输入完整分支名以确认"), text: $confirmedBranch)
                    .textFieldStyle(.roundedBorder)
                Toggle(L10n("我理解这些内容可能永久丢失"), isOn: $acknowledgesDataLoss)
            }

            HStack {
                Spacer()
                Button(L10n("取消"), role: .cancel, action: onCancel)
                if !showForceConfirmation, deleteWorktree, !plan.risks.isEmpty, effectiveBlockers.isEmpty {
                    Button(L10n("先合并"), action: onMergeFirst)
                    Button(L10n("强制删除"), role: .destructive) { showForceConfirmation = true }
                } else if showForceConfirmation {
                    Button(L10n("确认强制删除"), role: .destructive) {
                        onDelete(true, confirmedBranch, deleteWorktree, artifactDisposition)
                    }
                    .disabled(!acknowledgesDataLoss || confirmedBranch != plan.worktree?.branchName)
                } else if effectiveBlockers.isEmpty {
                    Button(L10n("确认删除"), role: .destructive) {
                        onDelete(false, nil, deleteWorktree, artifactDisposition)
                    }
                }
            }
        }
        .padding(20)
        .frame(width: 520)
        .onChange(of: deleteWorktree) { _, enabled in
            if !enabled {
                showForceConfirmation = false
                confirmedBranch = ""
                acknowledgesDataLoss = false
            }
        }
    }

    private func riskList(title: String, risks: [CorptieTaskDeletionRisk], color: Color) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(color)
            ForEach(risks) { risk in
                VStack(alignment: .leading, spacing: 3) {
                    Label(risk.message, systemImage: "exclamationmark.circle")
                    ForEach((risk.files ?? []).prefix(8), id: \.self) { file in
                        Text(file).font(.system(.caption2, design: .monospaced)).foregroundStyle(.secondary)
                    }
                }
                .font(.callout)
            }
        }
    }
}

private struct CorptieTaskAcceptanceReviewView: View {
    let task: CorptieTask
    let isRejecting: Bool
    let rejectionError: String?
    let onClose: () -> Void
    let onReject: () -> Void

    private var results: [CorptieTaskAcceptanceResult] {
        task.completionSuggestion?.results ?? task.acceptanceAssessment?.results ?? []
    }

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Text(L10n("自动验收结论详情"))
                    .font(.headline)

                HStack {
                    Button(action: onClose) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .symbolRenderingMode(.hierarchical)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(L10n("关闭"))
                    .disabled(isRejecting)
                    Spacer()
                }
            }
            .padding(16)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(task.title)
                        .font(.system(size: 13, weight: .semibold))
                    if results.isEmpty {
                        ContentUnavailableView(
                            L10n("暂无自动验收结论详情"),
                            systemImage: "doc.text.magnifyingglass"
                        )
                        .frame(maxWidth: .infinity, minHeight: 150)
                    } else {
                        ForEach(Array(results.enumerated()), id: \.offset) { index, result in
                            acceptanceResult(result, index: index)
                        }
                    }
                    if let rejectionError {
                        Label(rejectionError, systemImage: "exclamationmark.triangle.fill")
                            .font(.system(size: 11))
                            .foregroundStyle(.red)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }

            Divider()

            HStack {
                Spacer()
                Button(role: .destructive, action: onReject) {
                    if isRejecting {
                        HStack(spacing: 6) {
                            ProgressView().controlSize(.small)
                            Text(L10n("取消验收通过"))
                        }
                    } else {
                        Text(L10n("取消验收通过"))
                    }
                }
                .disabled(isRejecting)
            }
            .padding(16)
        }
        .frame(width: 480, height: 430)
        .interactiveDismissDisabled(isRejecting)
    }

    private func acceptanceResult(_ result: CorptieTaskAcceptanceResult, index: Int) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(index + 1). \(result.criterion)")
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(result.verdict == "passed" ? L10n("已通过") : L10n("未通过"))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(result.verdict == "passed" ? Color.green : Color.red)
            }
            ForEach(Array(result.evidence.enumerated()), id: \.offset) { _, evidence in
                VStack(alignment: .leading, spacing: 3) {
                    Text("• \(evidence.summary)")
                        .font(.system(size: 11))
                    Text(evidence.reference)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(11)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct CorptieTaskCompletionConfirmationView: View {
    let task: CorptieTask
    let assessment: CorptieTaskAcceptanceAssessment?
    let suggestion: CorptieTaskCompletionSuggestion?
    let onConfirm: () -> Void
    let onCancel: () -> Void

    private var acceptance: CorptieTaskAutomaticAcceptancePresentation {
        .resolve(assessment: assessment, suggestion: suggestion)
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(L10n("确认完成"))
                    .font(.title3.weight(.semibold))
                Text(task.title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(task.id)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)

            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    switch acceptance.state {
                    case .passed:
                        Label(
                            L10n("自动验收：已通过"),
                            systemImage: "checkmark.seal.fill"
                        )
                        .foregroundStyle(.green)
                    case .notPassed:
                        Label(
                            L10n("自动验收：未通过"),
                            systemImage: "xmark.seal.fill"
                        )
                        .foregroundStyle(.orange)
                    case .notAssessed:
                        Label(
                            L10n("自动验收：尚未验收"),
                            systemImage: "questionmark.circle.fill"
                        )
                        .foregroundStyle(.secondary)
                    }

                    Text(L10n("无论自动验收结果如何，你都可以将此 CorptieTask 标记为完成。"))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)

                    VStack(alignment: .leading, spacing: 10) {
                        Text(L10n("自动验收结论详情"))
                            .font(.system(size: 11, weight: .semibold))

                        if acceptance.results.isEmpty {
                            ContentUnavailableView(
                                L10n("暂无自动验收结论详情"),
                                systemImage: "doc.text.magnifyingglass"
                            )
                            .frame(maxWidth: .infinity, minHeight: 120)
                        } else {
                            ForEach(Array(acceptance.results.enumerated()), id: \.offset) { index, result in
                                VStack(alignment: .leading, spacing: 8) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text("\(index + 1). \(result.criterion)")
                                            .font(.system(size: 12, weight: .semibold))
                                        Spacer()
                                        Text(acceptanceVerdictLabel(result.verdict))
                                            .font(.system(size: 10, weight: .semibold))
                                            .foregroundStyle(acceptanceVerdictColor(result.verdict))
                                    }
                                    .textSelection(.enabled)
                                    if result.evidence.isEmpty {
                                        Text(L10n("该结论暂无证据详情"))
                                            .font(.system(size: 11))
                                            .foregroundStyle(.tertiary)
                                    } else {
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
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(12)
                                .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
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
                Button(L10n("标记为完成"), action: onConfirm)
                .keyboardShortcut(.defaultAction)
            }
            .padding(16)
        }
        .frame(width: 520, height: 480)
    }

    private func acceptanceVerdictLabel(_ verdict: String) -> String {
        switch verdict {
        case "passed": L10n("已通过")
        case "failed": L10n("未通过")
        default: L10n("未知")
        }
    }

    private func acceptanceVerdictColor(_ verdict: String) -> Color {
        switch verdict {
        case "passed": .green
        case "failed": .red
        default: .secondary
        }
    }
}

// MARK: - 工作项编辑（弹出小窗）

struct CorptieTaskEditView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let task: CorptieTask
    let onSaved: () -> Void

    @State private var title: String
    @State private var detail: String
    @State private var acceptanceCriteria: String
    @State private var priority: String
    @State private var status: String
    @State private var showStatusConfirm = false
    @State private var assistAgentId: String?
    @State private var saveError: String?
    @State private var updateTaskId = "task.update:\(UUID().uuidString.lowercased())"

    init(task: CorptieTask, onSaved: @escaping () -> Void) {
        self.task = task
        self.onSaved = onSaved
        _title = State(initialValue: task.title)
        _detail = State(initialValue: task.description)
        _acceptanceCriteria = State(initialValue: task.acceptanceCriteria)
        _priority = State(initialValue: task.priority)
        _status = State(initialValue: task.lifecycleState)
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
                    Text(L10n("Preparing")).tag("todo")
                    Text(L10n("进行中")).tag("in_progress")
                    Text(L10n("已完成")).tag("done")
                }
                .labelsHidden()
                .frame(maxWidth: 160, alignment: .leading)
            }

            HStack {
                if let saveError {
                    Text(saveError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(2)
                }
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
            Button(L10n(targetsCompletedStatus ? "确认完成" : "确认修改"), role: .destructive) {
                enqueuePersist()
            }
            Button(L10n("取消"), role: .cancel) { }
        } message: {
            Text(statusConfirmationMessage)
        }
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // 是否强制修改了状态（与原始状态不同）。
    private var statusChanged: Bool {
        status != task.lifecycleState
    }

    private var targetsCompletedStatus: Bool {
        CorptieTaskCompletionBackgroundDecision.resolve(status: status) == .alreadyCompleted
    }

    private var statusConfirmationMessage: String {
        guard targetsCompletedStatus else {
            return L10nFormat(
                "You are manually overriding the CorptieTask status (%@), bypassing execution-managed status. Continue?",
                statusLabel(status)
            )
        }
        let acceptanceStatus: String
        if task.completionSuggestion?.recommended == true {
            acceptanceStatus = L10n("已通过")
        } else if task.acceptanceAssessment == nil {
            acceptanceStatus = L10n("尚未验收")
        } else {
            acceptanceStatus = L10n("未通过")
        }
        return "\(task.title)\n\(task.id)\n\(L10n("自动验收"))：\(acceptanceStatus)"
    }

    private func statusLabel(_ s: String) -> String {
        switch s {
        case "todo": L10n("Preparing")
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
        persistForeground()
    }

    private func persistForeground() {
        saveError = nil
        Task {
            guard await client.updateCorptieTask(
                taskId: task.id,
                title: trimmedTitle,
                description: detail.trimmingCharacters(in: .whitespacesAndNewlines),
                acceptanceCriteria: acceptanceCriteria.trimmingCharacters(in: .whitespacesAndNewlines),
                priority: priority,
                lifecycleState: status
            ) != nil else {
                saveError = client.errorMessage ?? L10n("CorptieTask 保存失败。")
                return
            }
            onSaved()
            dismiss()
        }
    }

    private func enqueuePersist() {
        guard CorptieTaskEditSubmissionPolicy.submitsInBackground(statusChanged: statusChanged) else {
            persistForeground()
            return
        }
        let targetsCompleted = CorptieTaskCompletionBackgroundDecision.resolve(
            status: status
        ) == .alreadyCompleted
        if targetsCompleted {
            let target = task
            let requestId = "completion-request:\(UUID().uuidString.lowercased())"
            let interactionId = "edit-completion-click:\(UUID().uuidString.lowercased())"
            Task {
                guard let receipt = await client.issueCorptieTaskCompletionIntent(
                    task: target,
                    interactionId: interactionId,
                    requestId: requestId,
                    uiSurface: "task_edit_status_confirmation"
                ) else {
                    saveError = client.errorMessage ?? L10n("Unable to authorize CorptieTask completion")
                    return
                }
                guard let submission = CorptieTaskCompletionSubmission.freeze(
                    task: target,
                    receipt: receipt,
                    requestId: requestId,
                    idempotencyKey: "completion:\(UUID().uuidString.lowercased())"
                ) else { return }
                startPersistBackground(completionSubmission: submission)
            }
            return
        }
        startPersistBackground()
    }

    private func startPersistBackground(completionSubmission: CorptieTaskCompletionSubmission? = nil) {
        let requestTitle = trimmedTitle
        let requestDescription = detail.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestAcceptanceCriteria = acceptanceCriteria.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestPriority = priority
        let requestStatus = status
        let taskId = updateTaskId
        let started = BackgroundTaskCenter.shared.start(
            id: taskId,
            title: L10nFormat("更新 CorptieTask：%@", requestTitle)
        ) {
            if let latest = await client.task(id: task.id),
               latest.title == requestTitle,
               latest.description == requestDescription,
               latest.acceptanceCriteria == requestAcceptanceCriteria,
               latest.priority == requestPriority,
               latest.lifecycleState == requestStatus {
                onSaved()
                return .success(L10nFormat("CorptieTask“%@”已更新。", requestTitle))
            }

            let targetsCompleted = CorptieTaskCompletionBackgroundDecision.resolve(
                status: requestStatus
            ) == .alreadyCompleted
            guard await client.updateCorptieTask(
                taskId: task.id,
                title: requestTitle,
                description: requestDescription,
                acceptanceCriteria: requestAcceptanceCriteria,
                priority: requestPriority,
                lifecycleState: targetsCompleted ? nil : requestStatus
            ) != nil else {
                return .failure(client.errorMessage ?? L10n("CorptieTask 保存失败，可重试。"))
            }

            if targetsCompleted {
                guard let latest = await client.task(id: task.id) else {
                    return .failure(client.errorMessage ?? L10n("无法确认 CorptieTask 的最新状态，可重试。"))
                }
                if CorptieTaskCompletionBackgroundDecision.resolve(status: latest.lifecycleState) != .alreadyCompleted {
                    guard let completionSubmission else {
                        return .failure(L10n("Completion authorization is missing; reopen the CorptieTask and try again."))
                    }
                    let completed = await client.confirmCorptieTaskCompletion(submission: completionSubmission)
                    guard completed != nil else {
                        return .failure(client.errorMessage ?? L10n("CorptieTask 完成失败，可重试。"))
                    }
                }
            }
            onSaved()
            return .success(L10nFormat("CorptieTask“%@”已更新。", requestTitle))
        }
        if started || BackgroundTaskCenter.shared.records.contains(where: { $0.id == taskId }) {
            dismiss()
        }
    }
}
