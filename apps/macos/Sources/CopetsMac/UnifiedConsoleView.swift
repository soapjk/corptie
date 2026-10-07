import Combine
import CorptieConversation
import AppKit
import SwiftUI

struct UnifiedConsoleView: View {
    @ObservedObject var modelCatalog = BackendClient.shared.modelCatalog
    let backendClient = BackendClient.shared
    @ObservedObject var sessionIndexStore = BackendClient.shared.sessionIndexStore
    @ObservedObject var archivedSessionState = BackendClient.shared.archivedSessionController
    /// Archived rows are loaded only after the archive surface is opened and
    /// never enter the resident active State Sync index.
    @StateObject var archivedSessionIndexStore = SessionIndexStore()
    let entityClient = EntityAPIClient.shared
    @StateObject var layoutState = PanelLayoutState()
    @ObservedObject var presentationCache = SessionPresentationCache.shared
    @ObservedObject var viewportController = SessionViewportController.shared
    @ObservedObject var selectionController = BackendClient.shared.sessionSelectionController
    @StateObject var sessionGroupProjectionStore = SessionGroupProjectionStore()
    @State var composerDraftRepository = ComposerDraftRepository()
    @State var detailRenderTask: Task<Void, Never>?
    @State var pendingSelectionTask: Task<Void, Never>?
    @State var selectedCategory: SessionCategory = .worker
    /// nil 表示 Assistant 空间；非 nil 表示对应 Work 的 Task 空间。
    @State var selectedWorkId: String?
    @State var selectedTaskId: String?
    @State var workPendingEdit: Work?
    @State var workPendingDeletion: Work?
    @State var workDeletionError: String?
    @State var taskArchiveError: String?
    @State var taskPendingEdit: CorptieTask?
    @State var taskPendingRename: CorptieTask?
    @State var sessionPendingRename: TaskSession?
    @State var taskDeletionPresentation: CorptieTaskDeletionPresentation?
    @State var taskDeletionError: String?
    @State var taskRestartError: String?
    @State var pendingTaskDeletionIds = Set<String>()
    @State var pendingTaskRestartIds = Set<String>()
    @State var pendingTaskChatIds = Set<String>()
    @State var isShowingWorkerArchive = false
    @State var submittedReadSequencesBySessionID: [String: Int] = [:]
    @AppStorage(
        "sessions.workerGroupingMode",
        store: CorptieAppEnvironment.userDefaults
    ) var workerGroupingModeRawValue = WorkerSessionGroupingMode.work.rawValue
    @EnvironmentObject var router: AppTabRouter
    @EnvironmentObject var sidebarState: TabSidebarState
    /// Chat「+」只创建 Assistant Chat；Work Chat 与 Task Session 由系统伴生创建。
    @State var showNewSessionCreation = false
    @State var isCreatingWork = false
    struct TaskCreationTarget: Identifiable {
        let id = UUID()
        let workID: String?
    }
    @State var taskCreationTarget: TaskCreationTarget?
    /// 已收起的子分类分组 key 集合（仅内存态，跟随当前页面生命周期）。
    @State var collapsedGroupKeys: Set<String> = []
    @State var entityGroupingRevision: UInt64 = 0
    /// 搜索交互状态。
    @State var isSearching = false
    @State var searchText = ""
    @FocusState var isSearchFieldFocused: Bool
    @AppStorage(
        "console.navigationCard.navigationMode",
        store: CorptieAppEnvironment.userDefaults
    ) var navigationModeRawValue = ConsoleNavigationMode.workOutline.rawValue
    @AppStorage("console.workOutline.sort", store: CorptieAppEnvironment.userDefaults)
    var outlineSortRaw = WorkOutlineSort.standard.rawValue
    @StateObject var outlineExpansionPreferences = ConsoleOutlineExpansionPreferences()
    @State var cardAttentionCount = 0
    @State var cardSelectionExplicitlyCleared = false
    @State private var didResolveDevelopmentPreviewStart = false
    /// 每个 Tab（SessionCategory）独立记录其上一次选中的 Session，跨窗口/重启恢复，
    /// 避免不同 Tab 的选择相互覆盖。key 形如 `sessions.lastSelectedSessionId.<category>`。
    static let recentSessionIdsKey = "sessions.recentSessionIds"

    static func lastSelectedSessionKey(for category: SessionCategory) -> String {
        "sessions.lastSelectedSessionId.\(category.rawValue)"
    }

    var body: some View {
        ConsoleWindowSplitView(mode: navigationMode, isActive: sidebarState.isSelected) {
            consoleNavigationContent
                .ignoresSafeArea(.container, edges: .top)
                .environmentObject(router)
                .environmentObject(sidebarState)
                .environmentObject(backendClient)
                .environmentObject(layoutState)
        } detail: {
            sessionConversation
                .ignoresSafeArea(.container, edges: .top)
                .environmentObject(router)
                .environmentObject(sidebarState)
                .environmentObject(backendClient)
                .environmentObject(layoutState)
        }
        .ignoresSafeArea(.container, edges: .top)
        .environmentObject(backendClient)
        .environmentObject(layoutState)
        .environment(\.isLiquidGlass, false)
        .onAppear {
            PerfStopwatch.event("UnifiedConsoleView·onAppear", value: 1)
            selectDevelopmentPreviewAtStartupIfAvailable(backendClient.sessions)
            restoreConsoleSpaceIfNeeded()
            activateSessions()
        }
        .onDisappear {
            deactivateSessions()
        }
        .onChange(of: sidebarState.isSelected) { _, isSelected in
            // 常驻子树后 onAppear/onDisappear 不再随 Tab 切换触发，改用
            // 每 Tab 独立激活状态驱动进入/离开语义，避免让其他四页失效。
            if isSelected {
                activateSessions()
            } else {
                deactivateSessions()
            }
        }
        .onReceive(backendClient.sessionsDidChange) { sessions in
            guard sidebarState.isSelected else { return }
            attemptPendingSelection(sessions)
            selectDevelopmentPreviewAtStartupIfAvailable(sessions)
            restoreConsoleContentIfNeeded()
            if let selectedSessionID = backendClient.selectedSession?.id {
                markOpenedSessionRead(sessions.first(where: { $0.id == selectedSessionID }))
            }
        }
        .onReceive(archivedSessionState.$sessions) { sessions in
            archivedSessionIndexStore.replaceAll(with: sessions)
            guard sidebarState.isSelected, router.pendingSessionId == nil,
                  isShowingWorkerArchive else { return }
            restoreSelection(for: .worker)
        }
        .onChange(of: router.pendingSessionId) { _, _ in
            attemptPendingSelection(backendClient.sessions)
        }
        .onReceive(selectionController.$selectedSessionID) { sessionID in
            // @Published emits before storing the new value. Use the emitted
            // identity and never write back into the selection publisher.
            guard let sessionID,
                  let session = backendClient.sessions.first(where: { $0.id == sessionID })
                    ?? backendClient.archivedSessions.first(where: { $0.id == sessionID }) else { return }
            synchronizeConsoleSelection(with: session)
            Self.recordSessionId(session.id, category: SessionCategory(session: session))
            if sidebarState.isSelected {
                viewportController.hydrate(session.id)
                markOpenedSessionRead(session)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            markOpenedSessionRead(backendClient.selectedSession)
        }
        .onChange(of: selectedCategory) { _, newValue in
            if newValue != .worker {
                isShowingWorkerArchive = false
            }
        }
        .onReceive(entityClient.sessionGroupingDidChange) { _ in
            entityGroupingRevision &+= 1
            guard sidebarState.isSelected, router.pendingSessionId == nil else { return }
            restoreConsoleSpaceIfNeeded()
            if selectedCategory == .worker {
                restoreConsoleContentIfNeeded()
            }
        }
        .sheet(item: $workPendingEdit) { work in
            WorkDetailView(work: work)
        }
        .sheet(isPresented: $isCreatingWork) {
            WorkCreateView()
        }
        .sheet(item: $taskCreationTarget) { target in
            CorptieTaskCreateView(initialWorkId: target.workID) { task in
                selectedWorkId = task.workId
                selectedTaskId = task.id
            }
        }
        .sheet(item: $taskPendingEdit) { task in
            CorptieTaskEditView(task: task) {}
        }
        .sheet(item: $taskPendingRename) { task in
            RenameCorptieTaskSheet(task: task) {
                taskPendingRename = nil
            }
            .presentationBackground(.clear)
        }
        .sheet(item: $sessionPendingRename) { session in
            RenameSessionSheet(session: session) {
                sessionPendingRename = nil
            }
            .environmentObject(backendClient)
            .presentationBackground(.clear)
        }
        .sheet(item: $taskDeletionPresentation) { presentation in
            CorptieTaskDeletionConfirmationView(
                task: presentation.task,
                plan: presentation.plan,
                onCancel: { taskDeletionPresentation = nil },
                onMergeFirst: {
                    taskDeletionPresentation = nil
                    taskDeletionError = L10nFormat(
                        "CorptieTask 未删除。请先在项目 Worktree 管理中将分支 %@ 合并到目标主分支，确认无待提交文件后再重试删除。",
                        presentation.plan.worktree?.branchName ?? ""
                    )
                },
                onDelete: { force, branch, deleteWorktree, artifactDisposition in
                    deleteTask(
                        presentation.task,
                        force: force,
                        confirmedBranchName: branch,
                        deleteWorktree: deleteWorktree,
                        artifactDisposition: artifactDisposition
                    )
                }
            )
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
        .alert(L10n("操作失败"), isPresented: Binding(
            get: {
                workDeletionError != nil || taskDeletionError != nil || taskRestartError != nil || taskArchiveError != nil
            },
            set: {
                if !$0 {
                    workDeletionError = nil
                    taskDeletionError = nil
                    taskArchiveError = nil
                    taskRestartError = nil
                }
            }
        )) {
            Button(L10n("OK"), role: .cancel) {
                workDeletionError = nil
                taskDeletionError = nil
                taskRestartError = nil
                taskArchiveError = nil
            }
        } message: {
            Text(
                workDeletionError
                    ?? taskDeletionError
                    ?? taskRestartError
                    ?? taskArchiveError
                    ?? ""
            )
        }
    }


    var consoleNavigationContent: some View {
        HStack(spacing: 0) {
            if navigationMode == .workOutline {
                unifiedWorkOutlineSidebar
                    .frame(maxWidth: .infinity)
            }
            cardWorkspaceSidebar
                .frame(maxWidth: .infinity)
                .frame(width: navigationMode == .taskCards ? nil : 0)
                .clipped()
                .allowsHitTesting(navigationMode == .taskCards)
                .accessibilityHidden(navigationMode != .taskCards)
        }
        .frame(maxHeight: .infinity)
        .modifier(ConsoleTopEdgeEffectModifier())
        .safeAreaInset(edge: .top, spacing: 0) {
            PlatformWorkOutlineToolbar {
                outlineSortMenu
                navigationModeToggle.labelsHidden()
                searchToggleButton
                taskArchiveToggle
            } trailing: {
                outlineCreationMenu
            }
        }
    }

    var navigationMode: ConsoleNavigationMode {
        ConsoleNavigationMode.resolved(navigationModeRawValue)
    }

    var outlineSort: WorkOutlineSort {
        WorkOutlineSort(rawValue: outlineSortRaw) ?? .standard
    }

    var outlineSortMenu: some View {
        Menu {
            Picker("排序方式", selection: $outlineSortRaw) {
                ForEach(WorkOutlineSort.allCases, id: \.rawValue) { mode in
                    Text(mode.title).tag(mode.rawValue)
                }
            }
        } label: {
            PlatformWorkOutlineToolbarGlyph(symbol: "arrow.up.arrow.down")
        }
        .platformWorkOutlineToolbarControl()
        .menuIndicator(.hidden)
        .accessibilityLabel("排序方式").accessibilityValue(outlineSort.title)
        .accessibilityIdentifier("work-outline-sort")
        .help("排序方式")
    }

    var navigationModeToggle: some View {
        Menu {
            navigationModeOption(.workOutline, title: "分组")
            navigationModeOption(.taskCards, title: "卡片 · 实验")
        } label: {
            PlatformWorkOutlineToolbarGlyph(
                symbol: navigationMode == .taskCards ? "rectangle.grid.2x2" : "rectangle.3.group"
            )
        }
        .platformWorkOutlineToolbarControl()
        .menuIndicator(.hidden)
        .accessibilityLabel("视图")
        .accessibilityValue(navigationMode.accessibilityValue)
        .accessibilityIdentifier("work-outline-view")
        .help(navigationModeTitle)
    }

    private var navigationModeTitle: String {
        switch navigationMode {
        case .workOutline: "分组"
        case .taskCards: "卡片 · 实验"
        }
    }

    private func navigationModeOption(_ mode: ConsoleNavigationMode, title: String) -> some View {
        Button {
            navigationModeRawValue = mode.rawValue
        } label: {
            if navigationMode == mode {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    var cardWorkspaceSidebar: some View {
        VStack(spacing: 8) {
            if cardAttentionCount > 0 {
                Text("\(cardAttentionCount) 待处理")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10).padding(.top, 10)
            }
            if isSearching { sessionSearchBar.padding(.horizontal, 10) }
            ConsoleCardWorkspace(isActive: navigationMode == .taskCards, works: entityClient.works, tasks: entityClient.tasks,
                sessions: sessionIndexStore.rows.map(\.session), selectedTaskID: selectedTaskId,
                selectedSessionID: selectionController.selectedSessionID, query: searchText,
                sortMode: outlineSort, showsArchive: isShowingWorkerArchive,
                attentionCount: $cardAttentionCount,
                openChat: { selectSessionAfterHighlight($0) }, createChat: { showNewSessionCreation = true },
                openTask: { task, session in
                    openTask(task, session: session)
                    if session == nil, let id = task.currentSessionId {
                        Task { @MainActor in
                            var hydrated = await AppStateSyncController.shared.hydrateSession(id)
                            if hydrated == nil { hydrated = await backendClient.loadArchivedSession(id: id) }
                            guard selectedTaskId == task.id, let hydrated else { return }
                            // A delayed history load may open the explicitly
                            // selected Task, but must not steal a newer focus.
                            selectSessionAfterHighlight(hydrated)
                        }
                    }
                }, clearSelection: {
                    cardSelectionExplicitlyCleared = true
                    pendingSelectionTask?.cancel()
                    pendingSelectionTask = nil
                    selectedTaskId = nil
                    backendClient.closeDetail()
                }, discuss: { work in
                    if let session = workChatSession(for: work.id) { openWorkChat(for: work, session: session) }
                }, createTask: { presentTaskCreation(for: $0.id) },
                taskMenu: { task in taskContextMenuContent(for: task, session: workerSession(for: task)) })
        }
        .sheet(isPresented: Binding(
            get: { navigationMode == .taskCards && showNewSessionCreation },
            set: { if navigationMode == .taskCards { showNewSessionCreation = $0 } }
        )) { NewSessionCreationSheet(fixedKind: .assistantChat) }
    }





    func restoreConsoleSpaceIfNeeded() {
        guard sidebarState.isSelected, router.pendingSessionId == nil else { return }
        if let session = backendClient.selectedSession {
            synchronizeConsoleSelection(with: session)
            return
        }
        if let selectedWorkId,
           entityClient.works.contains(where: { $0.id == selectedWorkId }) {
            return
        }
        guard selectionController.selectedSessionID == nil else { return }
        selectedWorkId = entityClient.works.first?.id
        selectedCategory = selectedWorkId == nil ? .assistant : .worker
        selectDefaultContentForCurrentSpace()
    }

    private func selectDevelopmentPreviewAtStartupIfAvailable(_ sessions: [TaskSession]) {
        guard !didResolveDevelopmentPreviewStart, !sessions.isEmpty else { return }
        didResolveDevelopmentPreviewStart = true
        guard router.pendingSessionId == nil,
              let previewID = ProcessInfo.processInfo.environment["CORPTIE_DEVELOPMENT_PREVIEW_SESSION_ID"],
              let session = sessions.first(where: { $0.id == previewID }) else { return }
        selectSessionAfterHighlight(session)
    }

    func selectAssistantSpace() {
        selectedWorkId = nil
        selectedTaskId = nil
        selectedCategory = .assistant
        selectDefaultContentForCurrentSpace()
    }

    func selectWorkSpace(_ workId: String) {
        guard selectedWorkId != workId else { return }
        selectedWorkId = workId
        selectedTaskId = nil
        selectedCategory = .worker
        selectDefaultContentForCurrentSpace()
    }

    func workChatSession(for workId: String) -> TaskSession? {
        let indexedSession = sessionIndexStore.rows.lazy
            .map(\.session)
            .first {
                $0.resolvedSessionKind == .workChat
                    && $0.workId == workId
                    && $0.archived != true
            }
        return indexedSession ?? backendClient.sessions.first {
            $0.resolvedSessionKind == .workChat
                && $0.workId == workId
                && $0.archived != true
        }
    }

    func openWorkChat(for work: Work, session: TaskSession) {
        selectedWorkId = work.id
        selectedTaskId = nil
        selectedCategory = .work
        selectSessionAfterHighlight(session)
    }

    func selectDefaultContentForCurrentSpace() {
        if selectedWorkId == nil {
            if let session = assistantSessionRows.first?.session {
                selectSessionAfterHighlight(session)
            } else {
                backendClient.closeDetail()
            }
            return
        }
        if let task = visibleWorkTasks.first {
            selectedTaskId = task.id
            if let session = workerSession(for: task) {
                selectSessionAfterHighlight(session)
            } else {
                backendClient.closeDetail()
            }
        } else if let session = workChatRows.first?.session {
            selectedCategory = .work
            selectSessionAfterHighlight(session)
        } else {
            backendClient.closeDetail()
        }
    }

    func restoreConsoleContentIfNeeded() {
        guard sidebarState.isSelected, router.pendingSessionId == nil else { return }
        // A committed Session selection wins over stale page-local Task state.
        // Only attach a newly created Session when no Session is selected.
        if let session = backendClient.selectedSession {
            synchronizeConsoleSelection(with: session)
            return
        }
        // Keep an unresolved selected identity while its data is hydrating.
        guard selectionController.selectedSessionID == nil else { return }
        // A Task without a Session is still an explicit, valid user selection.
        // Keep it authoritative across session-index refreshes instead of
        // treating the empty detail selection as a reason to jump to the
        // first Task in the Work. Once its Session appears, connect it here.
        if let selectedTask, selectedTask.workId == selectedWorkId {
            if ConsoleTaskSelectionPolicy.isValidSelection(
                task: selectedTask,
                selectedWorkID: selectedWorkId
            ), let session = workerSession(for: selectedTask) {
                if backendClient.selectedSession?.id != session.id {
                    selectSessionAfterHighlight(session)
                }
            }
            return
        }
        guard ConsoleSelectionRefreshPolicy.permitsAutomaticDefaultSelection(
            selectedTaskID: selectedTaskId,
            selectedSessionID: selectionController.selectedSessionID,
            explicitlyCleared: navigationMode == .taskCards && cardSelectionExplicitlyCleared
        ) else { return }
        selectDefaultContentForCurrentSpace()
    }

    func synchronizeConsoleSelection(with session: TaskSession) {
        selectedCategory = SessionCategory(session: session)
        selectedWorkId = session.resolvedSessionKind == .assistantChat ? nil : session.workId
        selectedTaskId = session.resolvedSessionKind == .worker ? session.taskId : nil
        isShowingWorkerArchive = selectedCategory == .worker && isArchivedWorkerSession(session)
    }

    func activateSessions() {
        // 常驻子树后 onAppear 会在启动时（selectedTab 仍为 console）就触发，
        // 只有真正处于 Console Tab 时才执行激活逻辑。
        guard sidebarState.isSelected else { return }
        if let selectedSession = backendClient.selectedSession {
            viewportController.hydrate(selectedSession.id)
            markOpenedSessionRead(selectedSession)
        }
        scheduleDetailRendering()
        backendClient.suppressBackgroundPolling = true
        attemptPendingSelection(backendClient.sessions)
        if router.pendingSessionId == nil {
            restoreConsoleContentIfNeeded()
        }
        Task { await entityClient.refreshAgents() }
    }

    func deactivateSessions() {
        detailRenderTask?.cancel()
        detailRenderTask = nil
        pendingSelectionTask?.cancel()
        pendingSelectionTask = nil
        viewportController.persistNow()
        layoutState.canRenderDetailMessages = false
        backendClient.suppressBackgroundPolling = false
    }

    func scheduleDetailRendering() {
        detailRenderTask?.cancel()
        layoutState.canRenderDetailMessages = false
        PerfStopwatch.event("会话切换.scheduleDetailRendering=false", value: 1)
        detailRenderTask = Task { @MainActor in
            // Let NavigationSplitView establish its columns and paint the
            // lightweight shell before constructing Markdown/process cards.
            // This keeps the tab click responsive without adding a visible
            // loading delay on a normal display refresh.
            try? await Task.sleep(for: .milliseconds(80))
            guard !Task.isCancelled, sidebarState.isSelected else { return }
            layoutState.canRenderDetailMessages = true
            PerfStopwatch.event("会话切换.scheduleDetailRendering=true", value: 1)
        }
    }

    // 控制台「打开对话」→ 切到本 Tab 后，选中目标会话（sessions 加载完成后）。
    func attemptPendingSelection(_ sessions: [TaskSession]) {
        guard let pendingId = router.pendingSessionId else { return }
        let pendingTaskId = router.pendingTaskId
        if let session = sessionMatchingPendingSelection(pendingId, in: sessions) {
            pendingSelectionTask?.cancel()
            selectPendingRoute(session, requestedSessionId: pendingId, taskId: pendingTaskId)
            return
        }
        guard pendingSelectionTask == nil else { return }
        pendingSelectionTask = Task { @MainActor in
            defer { pendingSelectionTask = nil }
            var resolved = await AppStateSyncController.shared.hydrateSession(pendingId)
            if resolved == nil {
                // A global snapshot intentionally contains active Sessions
                // only. A deep link may explicitly target an archive, so fall
                // back to the Corptie-local archive endpoint on demand.
                resolved = await backendClient.loadArchivedSession(id: pendingId)
            }
            guard router.pendingSessionId == pendingId,
                  router.pendingTaskId == pendingTaskId else { return }
            if let session = resolved {
                selectPendingRoute(session, requestedSessionId: pendingId, taskId: pendingTaskId)
            } else {
                router.failSessionNavigation(pendingId)
            }
        }
    }

    func selectPendingRoute(
        _ session: TaskSession,
        requestedSessionId: String,
        taskId: String?
    ) {
        selectedCategory = SessionCategory(session: session)
        if selectedCategory == .worker {
            selectedWorkId = session.workId
            selectedTaskId = taskId ?? session.taskId
            isShowingWorkerArchive = isArchivedWorkerSession(session)
        } else {
            selectedWorkId = nil
            selectedTaskId = nil
        }
        backendClient.select(session: session, focusComposer: router.pendingSessionNavigationSource == .userSelection
            || router.pendingSessionNavigationSource == .createdSession)
        router.consumeSessionNavigation(requestedSessionId)
    }

    // 未选中时恢复上次选中的会话（跨窗口/重启记忆）。
    func restoreLastSelectedSession(_ sessions: [TaskSession]) {
        guard backendClient.selectedSession == nil, !sessions.isEmpty else { return }
        restoreSelection(for: selectedCategory)
    }

    static func recordSessionId(_ id: String, category: SessionCategory) {
        CorptieAppEnvironment.userDefaults.set(id, forKey: lastSelectedSessionKey(for: category))
        let recentIds = SessionSelectionRecoveryPolicy.recording(
            id,
            in: restoredRecentSessionIds()
        )
        CorptieAppEnvironment.userDefaults.set(recentIds, forKey: recentSessionIdsKey)
    }

    static func restoredSessionId(for category: SessionCategory) -> String? {
        CorptieAppEnvironment.userDefaults.string(forKey: lastSelectedSessionKey(for: category))
    }

    static func restoredRecentSessionIds() -> [String] {
        CorptieAppEnvironment.userDefaults.stringArray(forKey: recentSessionIdsKey) ?? []
    }

    // 恢复某个 Tab（SessionCategory）下的选择：优先保留仍有效的当前选择，
    // 否则恢复该 Tab 上次选中的会话；若已删除/不属于该 Tab，则回退到第一个。
    func restoreSelection(for category: SessionCategory) {
        let index = visibleSessionIndexStore
        let targetId = resolvedSessionSelection(
            category: category,
            rows: index.rows,
            selectedSessionId: backendClient.selectedSession?.id,
            lastSelectedId: Self.restoredSessionId(for: category),
            workerScope: workerSessionScope
        )
        guard let targetId else {
            if let selectedSession = backendClient.selectedSession,
               SessionCategory(session: selectedSession) == category {
                backendClient.closeDetail()
            }
            return
        }
        guard targetId != backendClient.selectedSession?.id else { return }
        if let session = index.sessions.first(where: { $0.id == targetId }) {
            selectSessionAfterHighlight(session)
        }
    }

    func selectSessionAfterHighlight(_ session: TaskSession, focusComposer: Bool = false) {
        cardSelectionExplicitlyCleared = false
        pendingSelectionTask?.cancel()
        pendingSelectionTask = nil
        // Commit the lightweight local selection synchronously. The native
        // row highlight and a warm timeline host can therefore paint in the
        // same event turn; provider/network work starts only after the target
        // content identity is already correct.
        selectedCategory = SessionCategory(session: session)
        if session.resolvedSessionKind == .assistantChat {
            selectedWorkId = nil
            selectedTaskId = nil
        } else {
            selectedWorkId = session.workId
            selectedTaskId = session.taskId
        }
        viewportController.hydrate(session.id)
        backendClient.select(session: session, focusComposer: focusComposer)
    }

    var searchToggleButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                isSearching = true
            }
            isSearchFieldFocused = true
        } label: {
            PlatformWorkOutlineToolbarGlyph(symbol: "magnifyingglass")
        }
        .platformWorkOutlineToolbarControl()
        .help(L10n("Search sessions"))
        .accessibilityLabel("搜索").accessibilityIdentifier("work-outline-search")
    }

    var sessionSearchBar: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
            TextField(L10n("Search sessions"), text: $searchText)
                .textFieldStyle(.plain)
                .focused($isSearchFieldFocused)
            Button {
                searchText = ""
                withAnimation(.easeInOut(duration: 0.15)) {
                    isSearching = false
                }
                isSearchFieldFocused = false
            } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 12, weight: .medium))
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(nsColor: .quaternaryLabelColor).opacity(0.4))
        }
    }

    var sessionCategoryPicker: some View {
        let unreadCounts = unreadSessionCounts(in: sessionIndexStore.rows.map(\.session))
        return HStack(spacing: 2) {
            ForEach(SessionCategory.allCases) { category in
                Button {
                    switchSessionCategory(to: category)
                } label: {
                    Label(category.title, systemImage: category.systemImage)
                        .font(.system(size: 10, weight: .semibold))
                        .labelStyle(.titleAndIcon)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, minHeight: 24)
                        .contentShape(Rectangle())
                        .overlay(alignment: .topTrailing) {
                            let count = unreadCounts[category, default: 0]
                            if count > 0 {
                                SessionCountBadge(count: count, fill: .red, diameter: 15)
                                    .padding(.top, 1)
                                    .padding(.trailing, 1)
                            }
                        }
                        .background {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(selectedCategory == category
                                    ? Color(nsColor: .controlBackgroundColor)
                                    : Color.clear)
                        }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(Color(nsColor: .quaternaryLabelColor).opacity(0.35))
        }
        .help(selectedCategory.title)
    }

    func switchSessionCategory(to category: SessionCategory) {
        guard category != selectedCategory else { return }
        if category != .worker {
            isShowingWorkerArchive = false
        }
        let targetId = resolvedSessionSelection(
            category: category,
            rows: sessionIndexStore.rows,
            selectedSessionId: backendClient.selectedSession?.id,
            lastSelectedId: Self.restoredSessionId(for: category),
            workerScope: workerSessionScope
        )

        // Commit the category and its restored Session in one button action.
        // This prevents sessionConversation from observing the temporary state
        // where the new category is active but the old category's Session is
        // still selected.
        selectedCategory = category
        guard let targetId,
              let session = backendClient.sessions.first(where: { $0.id == targetId }) else {
            return
        }
        pendingSelectionTask?.cancel()
        pendingSelectionTask = nil
        viewportController.hydrate(session.id)
        backendClient.select(session: session)
    }

    var outlineCreationMenu: some View {
        Menu {
            if selectedWork == nil {
                Button(L10n("New Assistant Session"), systemImage: "bubble.left.and.bubble.right") {
                    showNewSessionCreation = true
                }
            }
            Button(L10n("New Task"), systemImage: "checklist") {
                presentTaskCreation(for: selectedWorkId)
            }

            Divider()

            Button(L10n("New Work"), systemImage: "scope") {
                isCreatingWork = true
            }
        } label: {
            PlatformWorkOutlineToolbarGlyph(symbol: "plus")
        }
        .platformWorkOutlineToolbarControl()
        .menuIndicator(.hidden)
        .fixedSize()
        .help(L10n("Create"))
        .accessibilityLabel("新增 Work 或 Task").accessibilityIdentifier("work-outline-create")
    }

    func presentTaskCreation(for workID: String?) {
        taskCreationTarget = TaskCreationTarget(workID: workID)
    }

    var taskArchiveToggle: some View {
        Button {
            setWorkerArchiveVisible(!isShowingWorkerArchive)
        } label: {
            PlatformWorkOutlineToolbarGlyph(
                symbol: isShowingWorkerArchive ? "archivebox.fill" : "archivebox",
                color: isShowingWorkerArchive ? .accentColor : .primary
            )
        }
        .platformWorkOutlineToolbarControl()
        .help(isShowingWorkerArchive ? L10n("返回活动 Task") : L10n("查看归档 Task"))
        .accessibilityLabel(isShowingWorkerArchive ? L10n("返回活动 Task") : L10n("查看归档 Task"))
        .accessibilityIdentifier("work-outline-archive")
    }

    var workerSessionFunctionBar: some View {
        HStack(spacing: 7) {
            Menu {
                ForEach(WorkerSessionGroupingMode.allCases) { mode in
                    Button {
                        workerGroupingModeRawValue = mode.rawValue
                    } label: {
                        if mode == workerGroupingMode {
                            Label(mode.title, systemImage: "checkmark")
                        } else {
                            Text(mode.title)
                        }
                    }
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "rectangle.3.group")
                        .font(.system(size: 11, weight: .semibold))
                    Text(workerGroupingMode.title)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(.secondary)
                }
                .foregroundStyle(.primary)
                .padding(.leading, 10)
                .padding(.trailing, 6)
                .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
                .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .frame(maxWidth: .infinity)
            .help(L10n("Work Session Grouping"))

            Divider()
                .frame(height: 16)

            Button {
                setWorkerArchiveVisible(true)
            } label: {
                Image(systemName: "archivebox")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(L10n("View Archived Work Sessions"))
        }
        .font(.system(size: 11, weight: .semibold))
        .padding(.leading, 3)
        .padding(.trailing, 3)
        .frame(height: 38)
        .contentShape(Capsule())
        .modifier(SessionSidebarFunctionBarGlassModifier())
    }

    func sessionRow(_ row: SessionRowModel) -> some View {
        let isSelected = selectionController.selectedSessionID == row.session.id
        return ConsoleSessionRow(
            row: row,
            selectionRequested: { selectSessionAfterHighlight($0, focusComposer: true) }
        )
            .listRowBackground(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(isSelected ? Color.accentColor.opacity(0.09) : Color.clear)
                    .padding(.horizontal, 8)
            )
    }

    @ViewBuilder
    func sessionGroupHeader(_ group: SessionGroup) -> some View {
        let isCollapsed = collapsedGroupKeys.contains(group.key)
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                if isCollapsed {
                    collapsedGroupKeys.remove(group.key)
                } else {
                    collapsedGroupKeys.insert(group.key)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 12)
                Text(group.title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                SessionCountBadge(
                    count: group.rows.count,
                    fill: Color.secondary.opacity(0.82),
                    diameter: 16
                )
                let unreadCount = group.rows.lazy.filter { isSessionUnread($0.session) }.count
                if unreadCount > 0 {
                    SessionCountBadge(count: unreadCount, fill: .red, diameter: 15)
                }
                Spacer()
            }
            .padding(.top, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - 会话分组

    var workerSessionScope: WorkerSessionScope {
        isShowingWorkerArchive ? .archived : .active
    }

    var workerGroupingMode: WorkerSessionGroupingMode {
        WorkerSessionGroupingMode(rawValue: workerGroupingModeRawValue) ?? .work
    }

    /// 一级分类依据 provider-neutral sessionKind；Worker 会话按 Work 分组。
    var groupedSessions: [SessionGroup] {
        let index = visibleSessionIndexStore
        let key = SessionGroupProjectionKey(
            groupingRevision: index.groupingRevision,
            filterRevision: index.filterRevision,
            entityRevision: entityGroupingRevision,
            category: selectedCategory,
            workerScope: workerSessionScope,
            workerGroupingMode: workerGroupingMode,
            searchText: searchText
        )
        return sessionGroupProjectionStore.groups(for: key) {
            makeSessionGroups(
                rows: searchFilteredRows,
                agents: entityClient.agents,
                tasks: entityClient.tasks,
                works: entityClient.works,
                category: selectedCategory,
                workerScope: workerSessionScope,
                workerGroupingMode: workerGroupingMode
            )
        }
    }

    func setWorkerArchiveVisible(_ isVisible: Bool) {
        guard isShowingWorkerArchive != isVisible else { return }
        isShowingWorkerArchive = isVisible
        searchText = ""
        isSearching = false
        isSearchFieldFocused = false
        if isVisible {
            if archivedSessionIndexStore.rows.isEmpty {
                backendClient.closeDetail()
            } else {
                restoreSelection(for: .worker)
            }
            Task { await backendClient.refreshArchivedSessions(sessionKind: .worker) }
        } else {
            restoreSelection(for: .worker)
        }
    }

    func markOpenedSessionRead(_ session: TaskSession?) {
        guard sidebarState.isSelected,
              NSApp.isActive,
              let session,
              let sequence = SessionReadAcknowledgementPolicy.sequenceForOpenedSession(
                  session,
                  alreadySubmittedSequence: submittedReadSequencesBySessionID[session.id]
              ) else { return }
        submittedReadSequencesBySessionID[session.id] = sequence
        Task { @MainActor in
            await Task.yield()
            let succeeded = await backendClient.markSessionMessagesRead(
                sessionID: session.id,
                throughSequence: sequence
            )
            if !succeeded, submittedReadSequencesBySessionID[session.id] == sequence {
                submittedReadSequencesBySessionID.removeValue(forKey: session.id)
            }
        }
    }

    // 按搜索词筛选当前 Tab 下的会话（匹配标题/摘要/Agent/工作目录）。
    var searchFilteredRows: [SessionRowModel] {
        filteredSessionRows(visibleSessionIndexStore.rows, query: searchText)
    }

    var visibleSessionIndexStore: SessionIndexStore {
        isShowingWorkerArchive ? archivedSessionIndexStore : sessionIndexStore
    }

    // MARK: - 中：对话（纸面卡片 + 常驻详情 side panel）

    @ViewBuilder
    var sessionConversation: some View {
        if let session = backendClient.selectedSession,
           session.hasValidProductClassification,
           SessionCategory(session: session) == selectedCategory,
           navigationMode == .taskCards || selectedCategory != .worker
                || isArchivedWorkerSession(session) == isShowingWorkerArchive {
            HStack(spacing: MainWindowPageLayoutMetrics.columnSpacing) {
                // All navigation modes share the full conversation surface.
                // Keep details present without replacing the editor or timeline.
                DetailView(
                    sessionId: session.id,
                    presentationCache: presentationCache,
                    composerDraftRepository: composerDraftRepository,
                    initialTimelinePosition: viewportController.position(for: session.id),
                    onTimelinePositionChange: { position in
                        viewportController.store(position, for: session.id)
                    }
                )
                .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity, alignment: .top)

                SessionDetailPanel(session: session, railWidth: 320)
                    .frame(maxHeight: .infinity)
            }
            .padding(MainWindowPageLayoutMetrics.outerPadding)
        } else if let task = selectedTask {
            HStack(spacing: MainWindowPageLayoutMetrics.columnSpacing) {
                VStack(spacing: 12) {
                    Image(systemName: "bubble.left.and.exclamationmark.bubble.right")
                        .font(.system(size: 32, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(task.title)
                        .font(.system(size: 18, weight: .semibold))
                        .multilineTextAlignment(.center)
                    Text(pendingTaskChatIds.contains(task.id)
                         ? L10n("正在准备聊天…")
                         : L10n("此 Task 的聊天会话尚未就绪。"))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                    if task.currentSessionId == nil && task.archived != true
                        && task.deletionStatus == nil && task.lifecycleState == "todo" {
                        Button(L10n("准备聊天"), systemImage: "bubble.left") {
                            prepareTaskChat(task)
                        }
                        .disabled(pendingTaskChatIds.contains(task.id))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .modifier(ConversationDetailCardSurface(enabled: navigationMode == .taskCards))

                SessionCorptieTaskDetailCard(taskId: task.id)
                    .frame(width: 320)
                    .frame(maxHeight: .infinity)
            }
            .padding(MainWindowPageLayoutMetrics.outerPadding)
        } else {
            ContentUnavailableView(
                L10n("Select a Session"),
                systemImage: "bubble.left.and.bubble.right",
                description: Text(L10n("从左侧选择一个会话查看对话"))
            )
        }
    }

}

private struct ConsoleTopEdgeEffectModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content.scrollEdgeEffectHidden(true, for: .top)
        } else {
            content
        }
    }
}
