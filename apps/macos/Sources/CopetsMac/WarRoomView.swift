import SwiftUI
import CorptieClientCore
import CorptieConversation

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
