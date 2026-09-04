import Combine
import AppKit
import SwiftUI

enum ConsoleNavigationCardWidthPolicy {
    static let minimumTaskColumnWidth = 220.0
    static let defaultTaskColumnWidth = 300.0
    static let maximumTaskColumnWidth = 520.0

    static func clamped(_ width: Double) -> Double {
        min(max(width, minimumTaskColumnWidth), maximumTaskColumnWidth)
    }
}

enum ConsoleNavigationMode: String, CaseIterable {
    case workRail
    case workOutline

    static func resolved(_ rawValue: String) -> Self {
        Self(rawValue: rawValue) ?? .workRail
    }

    @MainActor
    var accessibilityValue: String {
        switch self {
        case .workRail: L10n("Work icons and Task list")
        case .workOutline: L10n("Expanded Work list")
        }
    }
}

enum ConsoleWorkOutlineMetrics {
    static let childIndent: CGFloat = 24
    static let groupCornerRadius: CGFloat = 8
    static let groupHorizontalInset: CGFloat = 6
    static let disclosureAnimation = Animation.easeInOut(duration: 0.16)
    static let workingGradientDuration = 2.6
    static var workingGradientAnimation: Animation {
        .linear(duration: workingGradientDuration).repeatForever(autoreverses: false)
    }
}

enum ConsoleWorkActivityPolicy {
    static func processingWorkIDs(
        tasks: [CorptieTask],
        sessions: [TaskSession]
    ) -> Set<String> {
        Set(tasks.lazy.compactMap { task in
            CorptieTaskBoundSessionActivity.resolve(task: task, sessions: sessions) == .processing
                ? task.workId
                : nil
        })
    }
}

private struct ConsoleWorkTitle: View {
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    let title: String
    let isWorking: Bool

    var body: some View {
        if isWorking {
            ConsoleFlowingGradientWorkTitle(
                title: title,
                animates: !accessibilityReduceMotion
            )
        } else {
            Text(title)
        }
    }
}

private struct ConsoleFlowingGradientWorkTitle: View {
    let title: String
    let animates: Bool

    @State private var hasAdvancedGradient = false

    var body: some View {
        Text(title)
            .foregroundStyle(flowingGradient)
            .onAppear {
                guard animates else { return }
                withAnimation(ConsoleWorkOutlineMetrics.workingGradientAnimation) {
                    hasAdvancedGradient = true
                }
            }
    }

    private var flowingGradient: LinearGradient {
        LinearGradient(
            colors: [
                .cyan, .blue, .purple, .pink, .orange, .cyan,
                .blue, .purple, .pink, .orange, .cyan
            ],
            startPoint: UnitPoint(x: hasAdvancedGradient ? 0 : -1, y: 0.5),
            endPoint: UnitPoint(x: hasAdvancedGradient ? 2 : 1, y: 0.5)
        )
    }
}

private struct ConsoleWorkOutlineDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 0) {
                Button {
                    withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
                        configuration.isExpanded.toggle()
                    }
                } label: {
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n(
                    configuration.isExpanded ? "Collapse group" : "Expand group"
                ))

                configuration.label
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if configuration.isExpanded {
                configuration.content
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .animation(
            ConsoleWorkOutlineMetrics.disclosureAnimation,
            value: configuration.isExpanded
        )
    }
}

private struct ConsoleWorkOutlineGroupCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 6)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                Color.black.opacity(0.065),
                in: RoundedRectangle(
                    cornerRadius: ConsoleWorkOutlineMetrics.groupCornerRadius,
                    style: .continuous
                )
            )
    }
}

private extension View {
    func consoleWorkOutlineGroupCard() -> some View {
        modifier(ConsoleWorkOutlineGroupCardModifier())
    }
}

private struct HoverRevealHeaderAction<Header: View>: View {
    let accessibilityLabel: String
    let header: Header
    let action: () -> Void

    @State private var isHovering = false
    @FocusState private var isFocused: Bool

    init(
        accessibilityLabel: String,
        action: @escaping () -> Void,
        @ViewBuilder header: () -> Header
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.action = action
        self.header = header()
    }

    var body: some View {
        HStack(spacing: 0) {
            header
            Button(action: action) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focused($isFocused)
            .opacity(isHovering || isFocused ? 1 : 0)
            .accessibilityLabel(accessibilityLabel)
            .help(accessibilityLabel)
        }
        .onHover { isHovering = $0 }
    }
}

private struct ConsoleWorkOutlineHeader: View {
    let work: Work
    let isExpanded: Bool
    let isSelected: Bool
    let isWorking: Bool
    let hasUnread: Bool
    let isChatSelected: Bool
    let hasUnreadChat: Bool
    let toggleExpanded: () -> Void
    let openChat: () -> Void
    let createTask: () -> Void

    @State private var isHovering = false
    @FocusState private var isCreateTaskFocused: Bool

    var body: some View {
        HStack(spacing: 0) {
            Button(action: toggleExpanded) {
                HStack(spacing: 7) {
                    ObjectiveAvatarView(
                        objectiveID: work.id,
                        name: work.name,
                        avatarPath: work.avatarPath,
                        size: 22
                    )
                    ConsoleWorkTitle(title: work.name, isWorking: isWorking)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                        .lineLimit(1)
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(work.name)
            .accessibilityValue(accessibilityValue)
            .help(isExpanded ? L10n("Collapse Work") : L10n("Expand Work"))

            Button(action: openChat) {
                Image(systemName: "message.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(isChatSelected ? Color.accentColor : Color.secondary)
                    .frame(width: 22, height: 22)
                    .overlay(alignment: .topTrailing) {
                        if hasUnreadChat {
                            Circle()
                                .fill(Color.red)
                                .frame(width: 6, height: 6)
                        }
                    }
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.leading, 6)
            .accessibilityLabel(L10n("Open Work Chat"))
            .accessibilityValue(hasUnreadChat ? L10n("Unread Session") : "")
            .help(L10n("Open Work Chat"))

            Spacer(minLength: 4)

            if hasUnread {
                Circle()
                    .fill(Color.red)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel(L10n("Unread Session"))
            }

            Button(action: createTask) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focused($isCreateTaskFocused)
            .opacity(isHovering || isCreateTaskFocused ? 1 : 0)
            .accessibilityLabel(L10nFormat("Create Task in %@", work.name))
            .help(L10nFormat("Create Task in %@", work.name))
        }
        .onHover { isHovering = $0 }
    }

    private var accessibilityValue: String {
        let expandedValue = isExpanded ? L10n("Expanded group") : L10n("Collapsed group")
        return isWorking ? "\(expandedValue), \(L10n("Processing"))" : expandedValue
    }
}

enum ConsoleTaskSelectionPolicy {
    static func isValidSelection(
        task: CorptieTask,
        selectedWorkID: String?
    ) -> Bool {
        task.workId == selectedWorkID && task.lifecycleState != "done"
    }

    static func session(
        for task: CorptieTask,
        in sessions: [TaskSession]
    ) -> TaskSession? {
        if let currentSessionID = task.currentSessionId,
           let current = sessions.first(where: {
               $0.id == currentSessionID
                   && $0.taskId == task.id
                   && $0.archived != true
           }) {
            return current
        }
        return sessions.first { $0.taskId == task.id && $0.archived != true }
    }
}

enum ConsoleTaskOpenDecision: Equatable {
    case selectSession(id: String)
    case createSession(agentID: String)
    case showWithoutSession

    static func resolve(task: CorptieTask, session: TaskSession?) -> Self {
        if let session { return .selectSession(id: session.id) }
        guard task.lifecycleState != "done",
              let agentID = normalized(task.mainAgentId) else {
            return .showWithoutSession
        }
        return .createSession(agentID: agentID)
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

// 统一控制台：Work/Assistant 导航、Task 列、消息列和详情列。
//   左 sidebar  — 会话列表（CompactSessionRow，固定窄列，纸面卡片质感）
//   中 content  — 对话（复用旧版 DetailView，吃满剩余宽度，纸面卡片质感）
//   详情信息   — 右侧竖列常驻 side panel（固定宽度，无收起按钮，模仿 Rudder IssueDetail 的 rail）
//
// Rudder 设计契约要点（IssueDetail.tsx + index.css）：
//   - 详情页是 CSS Grid 三区域布局，右侧「Properties rail」固定 280px，sticky 常驻，
//     没有收起/折叠按钮——只有 <48rem 移动端才 display:none（靠顶部 SlidersHorizontal 打开 Sheet）。
//   - 字段区标题用 11px uppercase + tracking 的小字「Properties」标签，下面竖向排列字段。
//   - 窄列固定像素宽度，主工作区吃掉剩余空间。
struct UnifiedConsoleView: View {
    private let backendClient = BackendClient.shared
    @ObservedObject private var sessionIndexStore = BackendClient.shared.sessionIndexStore
    /// Archived rows are loaded only after the archive surface is opened and
    /// never enter the resident active State Sync index.
    @StateObject private var archivedSessionIndexStore = SessionIndexStore()
    private let entityClient = EntityAPIClient.shared
    @StateObject private var layoutState = PanelLayoutState()
    @ObservedObject private var presentationCache = SessionPresentationCache.shared
    @ObservedObject private var viewportController = SessionViewportController.shared
    @ObservedObject private var selectionController = BackendClient.shared.sessionSelectionController
    @StateObject private var sessionGroupProjectionStore = SessionGroupProjectionStore()
    @State private var composerDraftRepository = ComposerDraftRepository()
    @State private var detailRenderTask: Task<Void, Never>?
    @State private var pendingSelectionTask: Task<Void, Never>?
    @State private var selectedCategory: SessionCategory = .worker
    /// nil 表示 Assistant 空间；非 nil 表示对应 Work 的 Task 空间。
    @State private var selectedWorkId: String?
    @State private var selectedTaskId: String?
    @State private var workPendingEdit: Work?
    @State private var workPendingDeletion: Work?
    @State private var workDeletionError: String?
    @State private var taskPendingEdit: CorptieTask?
    @State private var taskPendingRename: CorptieTask?
    @State private var sessionPendingRename: TaskSession?
    @State private var taskDeletionPresentation: CorptieTaskDeletionPresentation?
    @State private var taskDeletionError: String?
    @State private var pendingTaskDeletionIds = Set<String>()
    @State private var pendingTaskRestartIds = Set<String>()
    @State private var launchingTaskSessionIds = Set<String>()
    @State private var taskSessionLaunchError: EntityLaunchError?
    @State private var isShowingWorkerArchive = false
    @State private var submittedReadSequencesBySessionID: [String: Int] = [:]
    @AppStorage(
        "sessions.workerGroupingMode",
        store: CorptieAppEnvironment.userDefaults
    ) private var workerGroupingModeRawValue = WorkerSessionGroupingMode.work.rawValue
    @EnvironmentObject private var router: AppTabRouter
    @EnvironmentObject private var sidebarState: TabSidebarState
    /// 「+」新建会话：明确选择 Assistant、Work 或 Worker Session。
    @State private var showNewSessionCreation = false
    @State private var isCreatingWork = false
    @State private var isCreatingTask = false
    @State private var taskCreationWorkID: String?
    /// 已收起的子分类分组 key 集合（仅内存态，跟随当前页面生命周期）。
    @State private var collapsedGroupKeys: Set<String> = []
    @State private var entityGroupingRevision: UInt64 = 0
    /// 搜索交互状态。
    @State private var isSearching = false
    @State private var searchText = ""
    @FocusState private var isSearchFieldFocused: Bool
    @AppStorage(
        "console.navigationCard.taskColumnWidth",
        store: CorptieAppEnvironment.userDefaults
    ) private var storedTaskColumnWidth = ConsoleNavigationCardWidthPolicy.defaultTaskColumnWidth
    @AppStorage(
        "console.navigationCard.navigationMode",
        store: CorptieAppEnvironment.userDefaults
    ) private var navigationModeRawValue = ConsoleNavigationMode.workRail.rawValue
    /// Outline mode starts expanded. Persisting only the presentation mode keeps
    /// disclosure state lightweight and prevents stale Work IDs accumulating.
    @State private var isOutlineAssistantCollapsed = false
    @State private var collapsedOutlineWorkIDs = Set<String>()
    @State private var navigationResizeStartWidth: Double?
    @State private var isHoveringNavigationResizeHandle = false
    /// 每个 Tab（SessionCategory）独立记录其上一次选中的 Session，跨窗口/重启恢复，
    /// 避免不同 Tab 的选择相互覆盖。key 形如 `sessions.lastSelectedSessionId.<category>`。
    private static let recentSessionIdsKey = "sessions.recentSessionIds"

    private static func lastSelectedSessionKey(for category: SessionCategory) -> String {
        "sessions.lastSelectedSessionId.\(category.rawValue)"
    }

    var body: some View {
        HStack(spacing: 0) {
            consoleNavigationCard
                .padding(.leading, MainWindowPageLayoutMetrics.outerPadding)
                .padding(.vertical, MainWindowPageLayoutMetrics.outerPadding)
            sessionConversation
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .toolbar(removing: .sidebarToggle)
        .environmentObject(backendClient)
        .environmentObject(layoutState)
        .environment(\.isLiquidGlass, false)
        .onAppear {
            PerfStopwatch.event("UnifiedConsoleView·onAppear", value: 1)
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
            attemptPendingSelection(sessions)
            if !recoverSelectionIfNeeded(from: sessions) {
                restoreConsoleContentIfNeeded()
            }
            if let selectedSessionID = backendClient.selectedSession?.id {
                markOpenedSessionRead(sessions.first(where: { $0.id == selectedSessionID }))
            }
        }
        .onReceive(backendClient.$archivedSessions) { sessions in
            archivedSessionIndexStore.replaceAll(with: sessions)
            guard isShowingWorkerArchive else { return }
            restoreSelection(for: .worker)
        }
        .onChange(of: router.pendingSessionId) { _, _ in
            attemptPendingSelection(backendClient.sessions)
        }
        .onReceive(selectionController.$selectedSessionID) { _ in
            let session = backendClient.selectedSession
            if let session {
                let category = SessionCategory(session: session)
                viewportController.hydrate(session.id)
                Self.recordSessionId(session.id, category: category)
                selectionController.select(session.id)
                selectedCategory = category
                if selectedCategory == .worker {
                    isShowingWorkerArchive = isArchivedWorkerSession(session)
                }
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
            restoreConsoleSpaceIfNeeded()
            if !recoverSelectionIfNeeded(from: backendClient.sessions),
               selectedCategory == .worker {
                restoreConsoleContentIfNeeded()
            }
        }
        .sheet(item: $workPendingEdit) { work in
            WorkDetailView(work: work)
        }
        .sheet(isPresented: $isCreatingWork) {
            WorkCreateView()
        }
        .sheet(isPresented: $isCreatingTask) {
            CorptieTaskCreateView(initialWorkId: taskCreationWorkID) { task in
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
            get: { workDeletionError != nil || taskDeletionError != nil },
            set: {
                if !$0 {
                    workDeletionError = nil
                    taskDeletionError = nil
                }
            }
        )) {
            Button(L10n("OK"), role: .cancel) {
                workDeletionError = nil
                taskDeletionError = nil
            }
        } message: {
            Text(workDeletionError ?? taskDeletionError ?? "")
        }
        .alert(L10n("执行失败"), isPresented: Binding(
            get: { taskSessionLaunchError != nil },
            set: { if !$0 { taskSessionLaunchError = nil } }
        )) {
            Button(L10n("好"), role: .cancel) { taskSessionLaunchError = nil }
        } message: {
            Text(taskSessionLaunchError?.message ?? "")
        }
    }

    private var consoleNavigationCard: some View {
        HStack(spacing: 0) {
            if navigationMode == .workRail {
                workRail
                    .frame(width: 64)

                unifiedTaskSidebar
                    .frame(width: taskColumnWidth)
                    .background(taskColumnBackground)
            } else {
                unifiedWorkOutlineSidebar
                    .frame(width: taskColumnWidth + 64)
                    .background(taskColumnBackground)
            }
        }
        .frame(maxHeight: .infinity)
        .clipShape(
            RoundedRectangle(
                cornerRadius: MainWindowPageLayoutMetrics.cardCornerRadius,
                style: .continuous
            )
        )
        .background(
            .regularMaterial,
            in: RoundedRectangle(
                cornerRadius: MainWindowPageLayoutMetrics.cardCornerRadius,
                style: .continuous
            )
        )
        .overlay {
            RoundedRectangle(
                cornerRadius: MainWindowPageLayoutMetrics.cardCornerRadius,
                style: .continuous
            )
            .stroke(Color(nsColor: .separatorColor).opacity(0.42), lineWidth: 1)
        }
        .shadow(
            color: Color.black.opacity(0.045),
            radius: MainWindowPageLayoutMetrics.cardShadowRadius,
            x: 0,
            y: 1
        )
        .overlay(alignment: .trailing) {
            navigationResizeHandle
        }
        .overlay(alignment: .bottomLeading) {
            navigationModeToggle
                .padding(.leading, navigationMode == .workRail ? 76 : 12)
                .padding(.bottom, 12)
        }
    }

    private var navigationMode: ConsoleNavigationMode {
        ConsoleNavigationMode.resolved(navigationModeRawValue)
    }

    private var usesWorkOutlineBinding: Binding<Bool> {
        Binding(
            get: { navigationMode == .workOutline },
            set: { navigationModeRawValue = $0
                ? ConsoleNavigationMode.workOutline.rawValue
                : ConsoleNavigationMode.workRail.rawValue }
        )
    }

    private var navigationModeToggle: some View {
        HStack(spacing: 5) {
            Image(systemName: navigationMode == .workOutline
                ? "list.bullet.indent"
                : "rectangle.split.2x1")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Toggle(L10n("Navigation layout"), isOn: usesWorkOutlineBinding)
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.mini)
        }
        .fixedSize()
        .padding(.horizontal, 7)
        .frame(height: 30)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(0.38), lineWidth: 1)
        }
        .help(navigationMode == .workOutline
            ? L10n("Show Works as icons")
            : L10n("Show Works and Tasks in one list"))
        .accessibilityValue(navigationMode.accessibilityValue)
    }

    private var taskColumnWidth: CGFloat {
        CGFloat(ConsoleNavigationCardWidthPolicy.clamped(storedTaskColumnWidth))
    }

    private var taskColumnBackground: Color {
        Color(nsColor: .controlBackgroundColor).opacity(0.58)
    }

    private var navigationResizeHandle: some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: 10)
            .contentShape(Rectangle())
            .overlay {
                Capsule()
                    .fill(Color.secondary.opacity(isHoveringNavigationResizeHandle ? 0.42 : 0))
                    .frame(width: 2, height: 34)
            }
            .onHover { hovering in
                isHoveringNavigationResizeHandle = hovering
                (hovering ? NSCursor.resizeLeftRight : NSCursor.arrow).set()
            }
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let startWidth = navigationResizeStartWidth ?? storedTaskColumnWidth
                        navigationResizeStartWidth = startWidth
                        storedTaskColumnWidth = ConsoleNavigationCardWidthPolicy.clamped(
                            startWidth + Double(value.translation.width)
                        )
                    }
                    .onEnded { _ in
                        navigationResizeStartWidth = nil
                    }
            )
            .help(L10n("Drag to resize the Work and Task card"))
    }

    private var workRail: some View {
        let unreadSummary = WorkRailUnreadSummary(
            sessions: sessionIndexStore.rows.map(\.session)
        )
        return VStack(spacing: 8) {
            Button {
                selectAssistantSpace()
            } label: {
                consoleRailIcon(
                    systemImage: "sparkles",
                    label: L10n("Assistant"),
                    isSelected: selectedWorkId == nil,
                    hasUnread: unreadSummary.hasUnreadAssistantSessions
                )
            }
            .buttonStyle(.plain)

            Divider()
                .padding(.horizontal, 10)

            ScrollViewReader { scrollProxy in
                ScrollView(.vertical, showsIndicators: false) {
                    LazyVStack(spacing: 8) {
                        ForEach(entityClient.works) { work in
                            Button {
                                selectWorkSpace(work.id)
                            } label: {
                                consoleRailIcon(
                                    text: workInitials(work.name),
                                    avatarPath: work.avatarPath,
                                    objectiveID: work.id,
                                    label: work.name,
                                    isSelected: selectedWorkId == work.id,
                                    hasUnread: unreadSummary.workIDs.contains(work.id)
                                )
                                .contextMenu {
                                    Button(L10n("编辑"), systemImage: "square.and.pencil") {
                                        workPendingEdit = work
                                    }
                                    Divider()
                                    Button(L10n("删除"), systemImage: "trash", role: .destructive) {
                                        workPendingDeletion = work
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .id(work.id)
                        }
                    }
                    .padding(.vertical, 10)
                }
                .mask(workRailScrollMask)
                .onAppear {
                    scrollSelectedWorkIntoView(using: scrollProxy, animated: false)
                }
                .onChange(of: selectedWorkId) { _, _ in
                    scrollSelectedWorkIntoView(using: scrollProxy, animated: true)
                }
            }

        }
        .padding(.vertical, 10)
    }

    private var workRailScrollMask: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                .frame(height: 10)
            Rectangle().fill(.black)
            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                .frame(height: 10)
        }
    }

    private func scrollSelectedWorkIntoView(
        using proxy: ScrollViewProxy,
        animated: Bool
    ) {
        guard let selectedWorkId else { return }
        let action = { proxy.scrollTo(selectedWorkId, anchor: .center) }
        if animated {
            withAnimation(.easeInOut(duration: 0.18), action)
        } else {
            action()
        }
    }

    @ViewBuilder
    private func consoleRailIcon(
        systemImage: String? = nil,
        text: String? = nil,
        avatarPath: String? = nil,
        objectiveID: String? = nil,
        label: String,
        isSelected: Bool,
        hasUnread: Bool
    ) -> some View {
        Group {
            if let objectiveID {
                ObjectiveAvatarView(
                    objectiveID: objectiveID,
                    name: label,
                    avatarPath: avatarPath,
                    size: 42
                )
            } else {
                ZStack {
                    Circle()
                        .fill(Color(nsColor: .controlBackgroundColor))
                        .frame(width: 42, height: 42)
                    if let systemImage {
                        Image(systemName: systemImage)
                            .font(.system(size: 16, weight: .semibold))
                    } else {
                        Text(text ?? "?")
                            .font(.system(size: 12, weight: .bold, design: .rounded))
                            .lineLimit(1)
                    }
                }
            }
        }
        .foregroundStyle(Color.primary)
        .frame(width: 64, height: 50)
        .overlay(alignment: .leading) {
            if isSelected || hasUnread {
                Capsule()
                    .fill(isSelected ? Color.accentColor.opacity(0.78) : Color.red)
                    .frame(
                        width: isSelected ? 4 : 8,
                        height: isSelected ? 24 : 8
                    )
                    .padding(.leading, 2)
                    .transition(.scale(scale: 0.72).combined(with: .opacity))
            }
        }
        .contentShape(Rectangle())
        .help(label)
        .accessibilityLabel(label)
        .accessibilityValue(
            isSelected ? L10n("Selected") : (hasUnread ? L10n("Unread Session") : "")
        )
        .animation(.easeInOut(duration: 0.15), value: isSelected)
        .animation(.easeInOut(duration: 0.15), value: hasUnread)
    }

    private func workInitials(_ name: String) -> String {
        let compact = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return compact.isEmpty ? "?" : String(compact.prefix(2)).uppercased()
    }

    private var unifiedTaskSidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(selectedWork?.name ?? L10n("Assistant Sessions"))
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                searchToggleButton
            }
            .padding(8)

            if isSearching {
                sessionSearchBar
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
            }

            if let work = selectedWork {
                workTaskList(work)
            } else {
                assistantSessionList
            }

            if isShowingWorkerArchive,
               backendClient.archivedSessionsHasMore
                || backendClient.isLoadingMoreArchivedSessions
                || backendClient.archivedSessionsLoadError != nil {
                archivedWorkerPaginationBar
            }
        }
        .overlay(alignment: .bottomTrailing) {
            floatingCreationMenu
                .padding(12)
        }
        .sheet(isPresented: $showNewSessionCreation) {
            NewSessionCreationSheet()
        }
    }

    private var unifiedWorkOutlineSidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(L10n("Work"))
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 4)
                searchToggleButton
            }
            .padding(8)

            if isSearching {
                sessionSearchBar
                    .padding(.horizontal, 8)
                    .padding(.bottom, 6)
            }

            workOutlineList

            if isShowingWorkerArchive,
               backendClient.archivedSessionsHasMore
                || backendClient.isLoadingMoreArchivedSessions
                || backendClient.archivedSessionsLoadError != nil {
                archivedWorkerPaginationBar
            }
        }
        .overlay(alignment: .bottomTrailing) {
            floatingCreationMenu
                .padding(12)
        }
        .sheet(isPresented: $showNewSessionCreation) {
            NewSessionCreationSheet()
        }
    }

    private var workOutlineList: some View {
        let unreadSummary = WorkRailUnreadSummary(
            sessions: sessionIndexStore.rows.map(\.session)
        )
        let tasksByWorkID = outlineTasksByWorkID
        let archivedRowsByWorkID = outlineArchivedRowsByWorkID
        let processingWorkIDs = ConsoleWorkActivityPolicy.processingWorkIDs(
            tasks: entityClient.tasks,
            sessions: backendClient.sessions
        )

        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                DisclosureGroup(isExpanded: outlineAssistantExpandedBinding) {
                    VStack(alignment: .leading, spacing: 2) {
                        if assistantSessionRows.isEmpty {
                            outlineGroupEmptyRow(L10n("No Assistant Sessions"))
                        } else {
                            ForEach(assistantSessionRows) { row in
                                sessionRow(row)
                                    .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                    .background(outlineChildSelectionBackground(
                                        selectionController.selectedSessionID == row.session.id
                                    ))
                            }
                        }
                    }
                } label: {
                    outlineChatHeader(
                        hasUnread: unreadSummary.hasUnreadAssistantSessions
                    )
                }
                .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
                .consoleWorkOutlineGroupCard()

                ForEach(entityClient.works) { work in
                    let tasks = tasksByWorkID[work.id] ?? []

                    DisclosureGroup(isExpanded: outlineWorkExpandedBinding(work.id)) {
                        VStack(alignment: .leading, spacing: 2) {
                            if isShowingWorkerArchive {
                                let rows = archivedRowsByWorkID[work.id] ?? []
                                if rows.isEmpty {
                                    outlineGroupEmptyRow(L10n("No Archived Sessions"))
                                } else {
                                    ForEach(rows) { row in
                                        sessionRow(row)
                                            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                            .background(outlineChildSelectionBackground(
                                                selectionController.selectedSessionID == row.session.id
                                            ))
                                    }
                                }
                            } else {
                                ForEach(tasks) { task in
                                    taskRow(task)
                                        .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                                        .background(outlineChildSelectionBackground(
                                            selectedTaskId == task.id
                                        ))
                                }
                            }
                        }
                    } label: {
                        outlineWorkHeader(
                            work,
                            hasUnread: unreadSummary.workIDs.contains(work.id),
                            isWorking: processingWorkIDs.contains(work.id)
                        )
                            .contextMenu {
                                workContextMenuContent(for: work)
                            }
                    }
                    .disclosureGroupStyle(ConsoleWorkOutlineDisclosureStyle())
                    .consoleWorkOutlineGroupCard()
                }
            }
            .padding(.horizontal, ConsoleWorkOutlineMetrics.groupHorizontalInset)
            .padding(.vertical, 4)
        }
        .scrollIndicators(.hidden)
    }

    private func outlineChatHeader(hasUnread: Bool) -> some View {
        let isExpanded = !isOutlineAssistantCollapsed || !searchText.isEmpty
        return HoverRevealHeaderAction(
            accessibilityLabel: L10n("New Assistant Session"),
            action: { showNewSessionCreation = true }
        ) {
            Button {
                if searchText.isEmpty {
                    withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
                        isOutlineAssistantCollapsed.toggle()
                    }
                }
                selectAssistantSpace()
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 12, weight: .semibold))
                        .frame(width: 22)
                    Text(L10n("Chat"))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(selectedWorkId == nil ? Color.primary : Color.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if hasUnread {
                        Circle()
                            .fill(Color.red)
                            .frame(width: 8, height: 8)
                            .accessibilityLabel(L10n("Unread Session"))
                    }
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(L10n("Chat"))
            .accessibilityValue(isExpanded ? L10n("Expanded group") : L10n("Collapsed group"))
        }
    }

    private func outlineGroupEmptyRow(_ title: String) -> some View {
        Text(title)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.leading, ConsoleWorkOutlineMetrics.childIndent + 24)
            .padding(.vertical, 4)
    }

    private func outlineChildSelectionBackground(_ isSelected: Bool) -> some View {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
            .fill(isSelected ? Color.accentColor.opacity(0.09) : Color.clear)
            .padding(.horizontal, 8)
    }

    private func outlineWorkIsExpanded(_ workID: String) -> Bool {
        !collapsedOutlineWorkIDs.contains(workID)
            || !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var outlineAssistantExpandedBinding: Binding<Bool> {
        Binding(
            get: { !isOutlineAssistantCollapsed || !searchText.isEmpty },
            set: { isExpanded in
                guard searchText.isEmpty else { return }
                isOutlineAssistantCollapsed = !isExpanded
            }
        )
    }

    private func outlineWorkExpandedBinding(_ workID: String) -> Binding<Bool> {
        Binding(
            get: { outlineWorkIsExpanded(workID) },
            set: { isExpanded in
                guard searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    return
                }
                if isExpanded {
                    collapsedOutlineWorkIDs.remove(workID)
                } else {
                    collapsedOutlineWorkIDs.insert(workID)
                }
            }
        )
    }

    private func outlineWorkHeader(
        _ work: Work,
        hasUnread: Bool,
        isWorking: Bool
    ) -> some View {
        let isExpanded = outlineWorkIsExpanded(work.id)
        let workChat = workChatSession(for: work.id)
        return ConsoleWorkOutlineHeader(
            work: work,
            isExpanded: isExpanded,
            isSelected: selectedWorkId == work.id,
            isWorking: isWorking,
            hasUnread: hasUnread,
            isChatSelected: selectionController.selectedSessionID == workChat?.id,
            hasUnreadChat: workChat.map(isSessionUnread) ?? false,
            toggleExpanded: {
                withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
                    if collapsedOutlineWorkIDs.contains(work.id) {
                        collapsedOutlineWorkIDs.remove(work.id)
                    } else {
                        collapsedOutlineWorkIDs.insert(work.id)
                    }
                }
                selectWorkSpace(work.id)
            },
            openChat: {
                guard let workChat else { return }
                openWorkChat(for: work, session: workChat)
            },
            createTask: { presentTaskCreation(for: work.id) }
        )
    }

    @ViewBuilder
    private func workContextMenuContent(for work: Work) -> some View {
        Button(L10n("编辑"), systemImage: "square.and.pencil") {
            workPendingEdit = work
        }
        Divider()
        Button(L10n("删除"), systemImage: "trash", role: .destructive) {
            workPendingDeletion = work
        }
    }

    private var outlineTasksByWorkID: [String: [CorptieTask]] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let activeTasks = entityClient.tasks.filter { $0.lifecycleState != "done" }
        let grouped = Dictionary(grouping: activeTasks, by: \.workId)
        return grouped.mapValues { tasks in
            tasks
                .filter { task in
                    query.isEmpty
                        || task.title.localizedCaseInsensitiveContains(query)
                        || task.description.localizedCaseInsensitiveContains(query)
                }
                .sorted { lhs, rhs in
                    if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
                    return lhs.id < rhs.id
                }
        }
    }

    private var outlineArchivedRowsByWorkID: [String: [SessionRowModel]] {
        let taskWorkIDs = Dictionary(uniqueKeysWithValues: entityClient.tasks.map { ($0.id, $0.workId) })
        return Dictionary(
            grouping: searchFilteredRows.filter { $0.session.resolvedSessionKind == .worker },
            by: { row in
                row.session.workId
                    ?? row.session.taskId.flatMap { taskWorkIDs[$0] }
                    ?? ""
            }
        )
    }

    private var archivedWorkerPaginationBar: some View {
        HStack(spacing: 7) {
            if backendClient.isLoadingMoreArchivedSessions {
                ProgressView().controlSize(.small)
                Text(L10n("Loading more…"))
            } else if backendClient.archivedSessionsLoadError != nil {
                Text(L10n("More sessions could not be loaded."))
                Spacer()
                Button(L10n("Retry")) {
                    Task {
                        if backendClient.archivedSessionsHasMore {
                            await backendClient.loadMoreArchivedSessions()
                        } else {
                            await backendClient.refreshArchivedSessions(sessionKind: .worker)
                        }
                    }
                }
            } else {
                Text(L10n("More archived sessions"))
                Spacer()
                Button(L10n("Load More")) {
                    Task { await backendClient.loadMoreArchivedSessions() }
                }
            }
        }
        .font(.system(size: 10, weight: .medium))
        .foregroundStyle(.secondary)
        .padding(8)
    }

    private var selectedWork: Work? {
        guard let selectedWorkId else { return nil }
        return entityClient.works.first { $0.id == selectedWorkId }
    }

    private var selectedTask: CorptieTask? {
        guard let selectedTaskId else { return nil }
        return entityClient.tasks.first { $0.id == selectedTaskId }
    }

    private var assistantSessionRows: [SessionRowModel] {
        searchFilteredRows.filter { $0.session.resolvedSessionKind == .assistantChat }
    }

    private var workChatRows: [SessionRowModel] {
        guard let selectedWorkId else { return [] }
        return searchFilteredRows.filter {
            $0.session.resolvedSessionKind == .workChat
                && $0.session.workId == selectedWorkId
        }
    }

    private var visibleWorkTasks: [CorptieTask] {
        guard let selectedWorkId else { return [] }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return entityClient.tasks
            .filter { $0.workId == selectedWorkId && $0.lifecycleState != "done" }
            .filter { task in
                query.isEmpty
                    || task.title.localizedCaseInsensitiveContains(query)
                    || task.description.localizedCaseInsensitiveContains(query)
            }
            .sorted { lhs, rhs in
                if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
                return lhs.id < rhs.id
            }
    }

    private var assistantSessionList: some View {
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
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private func workTaskList(_ work: Work) -> some View {
        if isShowingWorkerArchive {
            archivedWorkerSessionList(work)
        } else {
            activeWorkTaskList(work)
        }
    }

    private func archivedWorkerSessionList(_ work: Work) -> some View {
        let rows = searchFilteredRows.filter { row in
            guard row.session.resolvedSessionKind == .worker else { return false }
            if row.session.workId == work.id { return true }
            guard let taskId = row.session.taskId else { return false }
            return entityClient.tasks.first(where: { $0.id == taskId })?.workId == work.id
        }
        return List {
            if rows.isEmpty {
                Text(L10n("No Archived Sessions"))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(rows) { row in
                    sessionRow(row)
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
    }

    private func activeWorkTaskList(_ work: Work) -> some View {
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
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private func workChatRow(_ row: SessionRowModel, ownsContextMenu: Bool = true) -> some View {
        let session = row.session
        let isSelected = selectionController.selectedSessionID == session.id
        let rowView = Button {
            selectedTaskId = nil
            selectSessionAfterHighlight(session)
        } label: {
            HStack(spacing: 9) {
                Circle()
                    .fill(session.executionTaskStatus.color)
                    .frame(width: 7, height: 7)
                    .accessibilityLabel(session.executionTaskStatus.label)
                Text(row.listTitle)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if isSessionUnread(session) {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel(L10n("Unread Session"))
                        .help(L10n("Unread Session"))
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(isSelected ? Color.accentColor.opacity(0.09) : Color.clear)
                .padding(.horizontal, 8)
        )

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
    private func taskRow(_ task: CorptieTask, ownsContextMenu: Bool = true) -> some View {
        let session = workerSession(for: task)
        let sessionActivity = CorptieTaskBoundSessionActivity.resolve(
            task: task,
            sessions: backendClient.sessions
        )
        let rowView = Button {
            openTask(task, session: session)
        } label: {
            HStack(spacing: 9) {
                Circle()
                    .fill(taskIndicatorColor(sessionActivity, lifecycleState: task.lifecycleState))
                    .frame(width: 7, height: 7)
                    .accessibilityLabel(L10nFormat("Session: %@", sessionActivity.label))
                Text(task.title)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if let session, isSessionUnread(session) {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel(L10n("Unread Session"))
                        .help(L10n("Unread Session"))
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowBackground(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(selectedTaskId == task.id ? Color.accentColor.opacity(0.09) : Color.clear)
                .padding(.horizontal, 8)
        )

        if ownsContextMenu {
            rowView.contextMenu {
                taskContextMenuContent(for: task, session: session)
            }
        } else {
            rowView
        }
    }

    @ViewBuilder
    private func taskContextMenuContent(
        for task: CorptieTask,
        session: TaskSession?
    ) -> some View {
        Button(L10n("Rename"), systemImage: "pencil") {
            taskPendingRename = task
        }
        Button(L10n("编辑"), systemImage: "square.and.pencil") {
            taskPendingEdit = task
        }
        Button(L10n("Restart Task"), systemImage: "arrow.clockwise") {
            restartTask(task)
        }
        .disabled(session?.actions?.restart?.available != true
            || pendingTaskRestartIds.contains(task.id))
        Divider()
        Button(L10n("删除"), systemImage: "trash", role: .destructive) {
            Task { await prepareTaskDeletion(task) }
        }
        .disabled(pendingTaskDeletionIds.contains(task.id))
    }

    private func restartTask(_ task: CorptieTask) {
        guard !pendingTaskRestartIds.contains(task.id) else { return }
        pendingTaskRestartIds.insert(task.id)
        Task {
            defer { pendingTaskRestartIds.remove(task.id) }
            _ = await entityClient.restartCorptieTask(taskId: task.id)
        }
    }

    private func openTask(_ task: CorptieTask, session: TaskSession?) {
        selectedWorkId = task.workId
        selectedCategory = .worker
        selectedTaskId = task.id
        switch ConsoleTaskOpenDecision.resolve(task: task, session: session) {
        case .selectSession:
            guard let session else { return }
            selectedCategory = .worker
            selectSessionAfterHighlight(session)
        case .createSession(let agentID):
            let sourceSession = backendClient.selectedSession
            backendClient.closeDetail()
            Task {
                await createTaskSessionIfNeeded(
                    for: task,
                    agentID: agentID,
                    sourceSession: sourceSession
                )
            }
        case .showWithoutSession:
            backendClient.closeDetail()
        }
    }

    private func createTaskSessionIfNeeded(
        for task: CorptieTask,
        agentID: String,
        sourceSession: TaskSession?
    ) async {
        guard launchingTaskSessionIds.insert(task.id).inserted else { return }
        defer { launchingTaskSessionIds.remove(task.id) }

        if backendClient.agentProviders.isEmpty {
            await backendClient.loadProviders()
        }
        let providerID = CorptieTaskCreateProviderPolicy.selection(
            current: "",
            preferred: backendClient.defaultSessionProviderId,
            providers: backendClient.agentProviders
        )
        guard !providerID.isEmpty else {
            taskSessionLaunchError = EntityLaunchError(
                message: L10n("没有可创建 Session 的 Provider。"),
                code: "SESSION_PROVIDER_NOT_FOUND"
            )
            return
        }

        let result = await entityClient.createSession(
            taskId: task.id,
            agentId: agentID,
            providerId: providerID,
            title: task.title,
            sourceSession: sourceSession
        )
        guard let session = result.session else {
            taskSessionLaunchError = result.error ?? EntityLaunchError(
                message: entityClient.errorMessage ?? L10n("创建会话失败"),
                code: nil
            )
            return
        }

        backendClient.acceptCreatedSession(session, selectImmediately: false)
        if selectedTaskId == task.id {
            selectSessionAfterHighlight(session)
        }
    }

    private func deleteWork(_ work: Work) async {
        guard await entityClient.deleteWork(workId: work.id) else {
            workDeletionError = entityClient.errorMessage ?? L10n("Unable to delete Work.")
            return
        }
        if selectedWorkId == work.id {
            selectedWorkId = entityClient.works.first?.id
            selectedTaskId = nil
            selectDefaultContentForCurrentSpace()
        }
    }

    private func prepareTaskDeletion(_ task: CorptieTask) async {
        guard !pendingTaskDeletionIds.contains(task.id) else { return }
        pendingTaskDeletionIds.insert(task.id)
        defer { pendingTaskDeletionIds.remove(task.id) }
        guard let plan = await entityClient.inspectCorptieTaskDeletion(taskId: task.id) else {
            taskDeletionError = entityClient.errorMessage ?? L10n("无法检查 CorptieTask 的关联资源。")
            return
        }
        taskDeletionPresentation = CorptieTaskDeletionPresentation(task: task, plan: plan)
    }

    private func deleteTask(
        _ task: CorptieTask,
        force: Bool,
        confirmedBranchName: String?,
        deleteWorktree: Bool,
        artifactDisposition: CorptieTaskArtifactDisposition
    ) {
        guard !pendingTaskDeletionIds.contains(task.id) else { return }
        taskDeletionPresentation = nil
        BackgroundTaskCenter.shared.start(
            id: "task.deletion.\(task.id)",
            title: L10nFormat("删除 CorptieTask：%@", task.title)
        ) {
            pendingTaskDeletionIds.insert(task.id)
            let deleted = await entityClient.deleteCorptieTask(
                taskId: task.id,
                force: force,
                confirmedBranchName: confirmedBranchName,
                deleteWorktree: deleteWorktree,
                artifactDisposition: artifactDisposition
            )
            pendingTaskDeletionIds.remove(task.id)
            if deleted {
                if selectedTaskId == task.id {
                    selectedTaskId = nil
                    selectDefaultContentForCurrentSpace()
                }
                return .success(L10nFormat("CorptieTask“%@”已删除。", task.title))
            }
            return .failure(entityClient.errorMessage ?? L10n("删除失败；资源状态已保留，可修复后安全重试。"))
        }
    }

    private func workerSession(for task: CorptieTask) -> TaskSession? {
        ConsoleTaskSelectionPolicy.session(for: task, in: backendClient.sessions)
    }

    private func taskStatusColor(_ status: String) -> Color {
        switch status.lowercased() {
        case "completed", "complete": return .green
        case "blocked", "failed": return .red
        case "running", "in_progress", "active": return .blue
        default: return .secondary
        }
    }

    private func taskIndicatorColor(
        _ sessionActivity: CorptieTaskBoundSessionActivity,
        lifecycleState: String
    ) -> Color {
        switch sessionActivity {
        case .noSession, .unknown:
            taskStatusColor(lifecycleState)
        default:
            sessionActivity.color
        }
    }

    private func restoreConsoleSpaceIfNeeded() {
        if let selectedWorkId,
           entityClient.works.contains(where: { $0.id == selectedWorkId }) {
            return
        }
        if let session = backendClient.selectedSession,
           session.resolvedSessionKind != .assistantChat,
           let workId = session.workId,
           entityClient.works.contains(where: { $0.id == workId }) {
            selectedWorkId = workId
            selectedCategory = SessionCategory(session: session)
            selectedTaskId = session.taskId
            return
        }
        selectedWorkId = entityClient.works.first?.id
        selectedCategory = selectedWorkId == nil ? .assistant : .worker
        selectDefaultContentForCurrentSpace()
    }

    private func selectAssistantSpace() {
        selectedWorkId = nil
        selectedTaskId = nil
        selectedCategory = .assistant
        selectDefaultContentForCurrentSpace()
    }

    private func selectWorkSpace(_ workId: String) {
        guard selectedWorkId != workId else { return }
        selectedWorkId = workId
        selectedTaskId = nil
        selectedCategory = .worker
        selectDefaultContentForCurrentSpace()
    }

    private func workChatSession(for workId: String) -> TaskSession? {
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

    private func openWorkChat(for work: Work, session: TaskSession) {
        selectedWorkId = work.id
        selectedTaskId = nil
        selectedCategory = .work
        selectSessionAfterHighlight(session)
    }

    private func selectDefaultContentForCurrentSpace() {
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

    private func restoreConsoleContentIfNeeded() {
        // A Task without a Session is still an explicit, valid user selection.
        // Keep it authoritative across session-index refreshes instead of
        // treating the empty detail selection as a reason to jump to the
        // first Task in the Work. Once its Session appears, connect it here.
        if let selectedTask,
           ConsoleTaskSelectionPolicy.isValidSelection(
               task: selectedTask,
               selectedWorkID: selectedWorkId
           ) {
            if let session = workerSession(for: selectedTask) {
                if backendClient.selectedSession?.id != session.id {
                    selectSessionAfterHighlight(session)
                }
            } else if backendClient.selectedSession != nil {
                backendClient.closeDetail()
            }
            return
        }
        if let session = backendClient.selectedSession,
           sessionMatchesCurrentConsoleSpace(session) {
            return
        }
        selectDefaultContentForCurrentSpace()
    }

    private func sessionMatchesCurrentConsoleSpace(_ session: TaskSession) -> Bool {
        if let selectedWorkId {
            return session.workId == selectedWorkId
                && (session.resolvedSessionKind == .worker
                    || session.resolvedSessionKind == .workChat)
        }
        return session.resolvedSessionKind == .assistantChat
    }

    private func activateSessions() {
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

    private func deactivateSessions() {
        detailRenderTask?.cancel()
        detailRenderTask = nil
        pendingSelectionTask?.cancel()
        pendingSelectionTask = nil
        viewportController.persistNow()
        layoutState.canRenderDetailMessages = false
        backendClient.suppressBackgroundPolling = false
    }

    private func scheduleDetailRendering() {
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
    private func attemptPendingSelection(_ sessions: [TaskSession]) {
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

    private func selectPendingRoute(
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
        backendClient.select(session: session)
        router.consumeSessionNavigation(requestedSessionId)
    }

    // 未选中时恢复上次选中的会话（跨窗口/重启记忆）。
    private func restoreLastSelectedSession(_ sessions: [TaskSession]) {
        guard backendClient.selectedSession == nil, !sessions.isEmpty else { return }
        restoreSelection(for: selectedCategory)
    }

    private static func recordSessionId(_ id: String, category: SessionCategory) {
        CorptieAppEnvironment.userDefaults.set(id, forKey: lastSelectedSessionKey(for: category))
        let recentIds = SessionSelectionRecoveryPolicy.recording(
            id,
            in: restoredRecentSessionIds()
        )
        CorptieAppEnvironment.userDefaults.set(recentIds, forKey: recentSessionIdsKey)
    }

    private static func restoredSessionId(for category: SessionCategory) -> String? {
        CorptieAppEnvironment.userDefaults.string(forKey: lastSelectedSessionKey(for: category))
    }

    private static func restoredRecentSessionIds() -> [String] {
        CorptieAppEnvironment.userDefaults.stringArray(forKey: recentSessionIdsKey) ?? []
    }

    /// CorptieTask 完成会让其 Worker Session 离开活动列表。此时不再按列表顺序随意挑选，
    /// 而是跳到用户最近打开且仍可访问的 Session，并同步切换对应分类。
    @discardableResult
    private func recoverSelectionIfNeeded(from sessions: [TaskSession]) -> Bool {
        // An archive selection is intentionally absent from the resident
        // active collection. Active State Sync updates must not evict it.
        guard !isShowingWorkerArchive else { return false }
        guard let current = backendClient.selectedSession else { return false }
        guard !SessionSelectionRecoveryPolicy.isAccessible(current, sessions: sessions) else {
            return false
        }

        guard let targetId = SessionSelectionRecoveryPolicy.recoverySessionID(
            recentSessionIDs: Self.restoredRecentSessionIds(),
            sessions: sessions,
            excluding: current.id
        ), let target = sessions.first(where: { $0.id == targetId }) else {
            backendClient.closeDetail()
            return true
        }

        pendingSelectionTask?.cancel()
        let category = SessionCategory(session: target)
        selectedCategory = category
        isShowingWorkerArchive = false
        Self.recordSessionId(target.id, category: category)
        backendClient.select(session: target)
        return true
    }

    // 恢复某个 Tab（SessionCategory）下的选择：优先保留仍有效的当前选择，
    // 否则恢复该 Tab 上次选中的会话；若已删除/不属于该 Tab，则回退到第一个。
    private func restoreSelection(for category: SessionCategory) {
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

    private func selectSessionAfterHighlight(_ session: TaskSession) {
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
        backendClient.select(session: session)
    }

    private var searchToggleButton: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) {
                isSearching = true
            }
            isSearchFieldFocused = true
        } label: {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.secondary)
                .frame(width: 22, height: 22)
        }
        .buttonStyle(.plain)
        .help(L10n("Search sessions"))
    }

    private var sessionSearchBar: some View {
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

    private var sessionCategoryPicker: some View {
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

    private func switchSessionCategory(to category: SessionCategory) {
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

    private var floatingCreationMenu: some View {
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
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 42, height: 42)
                .contentShape(Circle())
                .modifier(FloatingCreationButtonGlassModifier())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .help(L10n("Create"))
    }

    private func presentTaskCreation(for workID: String?) {
        taskCreationWorkID = workID
        isCreatingTask = true
    }

    private var workerSessionFunctionBar: some View {
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

    private func sessionRow(_ row: SessionRowModel) -> some View {
        let isSelected = selectionController.selectedSessionID == row.session.id
        return ConsoleSessionRow(
            row: row,
            selectionRequested: selectSessionAfterHighlight
        )
            .listRowBackground(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(isSelected ? Color.accentColor.opacity(0.09) : Color.clear)
                    .padding(.horizontal, 8)
            )
    }

    @ViewBuilder
    private func sessionGroupHeader(_ group: SessionGroup) -> some View {
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

    private var workerSessionScope: WorkerSessionScope {
        isShowingWorkerArchive ? .archived : .active
    }

    private var workerGroupingMode: WorkerSessionGroupingMode {
        WorkerSessionGroupingMode(rawValue: workerGroupingModeRawValue) ?? .work
    }

    /// 一级分类依据 provider-neutral sessionKind；Worker 会话按 Work 分组。
    private var groupedSessions: [SessionGroup] {
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

    private func setWorkerArchiveVisible(_ isVisible: Bool) {
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

    private func markOpenedSessionRead(_ session: TaskSession?) {
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
    private var searchFilteredRows: [SessionRowModel] {
        filteredSessionRows(visibleSessionIndexStore.rows, query: searchText)
    }

    private var visibleSessionIndexStore: SessionIndexStore {
        isShowingWorkerArchive ? archivedSessionIndexStore : sessionIndexStore
    }

    // MARK: - 中：对话（纸面卡片 + 常驻详情 side panel）

    @ViewBuilder
    private var sessionConversation: some View {
        if let session = backendClient.selectedSession,
           session.hasValidProductClassification,
           SessionCategory(session: session) == selectedCategory,
           selectedCategory != .worker
                || isArchivedWorkerSession(session) == isShowingWorkerArchive {
            HStack(spacing: MainWindowPageLayoutMetrics.columnSpacing) {
                // One structural Detail/NSScrollView host is rebound in place.
                // Session-specific model state changes, but native cell reuse
                // queues and the scroll view itself are never multiplied.
                DetailView(
                    sessionId: session.id,
                    presentationCache: presentationCache,
                    composerDraftRepository: composerDraftRepository,
                    initialTimelinePosition: viewportController.position(for: session.id),
                    onTimelinePositionChange: { position in
                        viewportController.store(position, for: session.id)
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

                // 右侧竖列详情面板（固定常驻，无收起按钮，模仿 Rudder IssueDetail rail）
                SessionDetailPanel(session: session)
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
                    Text(L10n("The companion Work Session is being prepared."))
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: 360)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)

                SessionCorptieTaskDetailCard(taskId: task.id)
                    .frame(width: 280)
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

struct WorkRailUnreadSummary: Equatable {
    let hasUnreadAssistantSessions: Bool
    let workIDs: Set<String>

    init(sessions: [TaskSession]) {
        var hasUnreadAssistantSessions = false
        var workIDs = Set<String>()

        for session in sessions where isSessionUnread(session)
            && session.hasValidProductClassification
            && session.archived != true {
            if session.resolvedSessionKind == .assistantChat {
                hasUnreadAssistantSessions = true
            } else if let workID = session.workId, !workID.isEmpty {
                workIDs.insert(workID)
            }
        }

        self.hasUnreadAssistantSessions = hasUnreadAssistantSessions
        self.workIDs = workIDs
    }
}

private struct FloatingCreationButtonGlassModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: .circle)
        } else {
            content
                .background(.ultraThinMaterial, in: Circle())
                .overlay {
                    Circle()
                        .stroke(Color(nsColor: .separatorColor).opacity(0.38), lineWidth: 1)
                }
                .shadow(color: Color.black.opacity(0.12), radius: 7, x: 0, y: 3)
        }
    }
}

enum SessionReadAcknowledgementPolicy {
    static func sequenceForOpenedSession(
        _ session: TaskSession,
        alreadySubmittedSequence: Int?
    ) -> Int? {
        guard let sequence = session.lastAgentMessageSequence,
              sequence > (session.lastReadMessageSequence ?? 0),
              sequence > (alreadySubmittedSequence ?? 0) else { return nil }
        return sequence
    }
}

private struct SessionSidebarFunctionBarGlassModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content
                .glassEffect(.clear.interactive(), in: .capsule)
        } else {
            content
                .background(.ultraThinMaterial, in: Capsule())
        }
    }
}

/// Chat Session rows intentionally share the same visual metrics as Task rows
/// so switching between the two groups does not change navigation density. It
/// observes the stable row model directly so content-only patches stay local.
private struct ConsoleSessionRow: View {
    @ObservedObject var row: SessionRowModel
    @EnvironmentObject private var backendClient: BackendClient
    @State private var isRenaming = false
    let selectionRequested: (TaskSession) -> Void

    var body: some View {
        let session = row.session
        Button {
            selectionRequested(session)
        } label: {
            HStack(spacing: 9) {
                Circle()
                    .fill(session.executionTaskStatus.color)
                    .frame(width: 7, height: 7)
                    .accessibilityLabel(session.executionTaskStatus.label)
                Text(row.listTitle)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                Spacer(minLength: 0)
                if isSessionUnread(session) {
                    Circle()
                        .fill(Color.red)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel(L10n("Unread Session"))
                        .help(L10n("Unread Session"))
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            SessionContextMenuContent(session: session, isRenaming: $isRenaming)
        }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) { isRenaming = false }
                .environmentObject(backendClient)
                .presentationBackground(.clear)
        }
    }
}

func sessionMatchingPendingSelection(_ pendingSessionId: String?, in sessions: [TaskSession]) -> TaskSession? {
    guard let pendingSessionId = normalizedSessionRouteIdentifier(pendingSessionId) else { return nil }
    // Preserve the canonical Session id as the highest-priority match. Logical
    // and Provider ids are accepted only as route aliases so a CorptieTask created
    // before/after a workspace or Provider transition still opens the same
    // product Session instead of failing hydration or selecting another row.
    if let exact = sessions.first(where: { $0.id == pendingSessionId }) {
        return exact
    }
    return sessions.first { session in
        [
            session.external?.logicalSessionId,
            session.external?.threadId,
            session.external?.sessionId
        ]
        .compactMap(normalizedSessionRouteIdentifier)
        .contains(pendingSessionId)
    }
}

private func normalizedSessionRouteIdentifier(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !value.isEmpty else { return nil }
    return value
}

struct SessionGroup: Identifiable {
    let key: String
    let title: String
    let rows: [SessionRowModel]
    let showsHeader: Bool
    let rowSubtitles: [String: String]

    var id: String { key }

    init(
        key: String,
        title: String,
        rows: [SessionRowModel],
        showsHeader: Bool = true,
        rowSubtitles: [String: String] = [:]
    ) {
        self.key = key
        self.title = title
        self.rows = rows
        self.showsHeader = showsHeader
        self.rowSubtitles = rowSubtitles
    }
}

struct SessionCountBadge: View {
    let count: Int
    let fill: Color
    let diameter: CGFloat

    var body: some View {
        Text("\(count)")
            .font(.system(size: diameter <= 15 ? 8 : 9, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .minimumScaleFactor(0.65)
            .lineLimit(1)
            .frame(width: diameter, height: diameter)
            .background(fill, in: Circle())
            .accessibilityLabel(L10nFormat("%@ Sessions", "\(count)"))
    }
}

func isSessionUnread(_ session: TaskSession) -> Bool {
    sessionNeedsUserAttention(
        status: session.executionTaskStatus,
        lastAgentMessageSequence: session.lastAgentMessageSequence ?? 0,
        lastReadMessageSequence: session.lastReadMessageSequence ?? 0
    )
}

func countUnreadSessions(
    in sessions: [TaskSession],
    category: SessionCategory
) -> Int {
    unreadSessionCounts(in: sessions)[category, default: 0]
}

func unreadSessionCounts(in sessions: [TaskSession]) -> [SessionCategory: Int] {
    var counts: [SessionCategory: Int] = [:]
    for session in sessions where isSessionUnread(session)
        && session.hasValidProductClassification
        && session.archived != true {
        let category = SessionCategory(session: session)
        counts[category, default: 0] += 1
    }
    return counts
}

enum WorkerSessionScope: Equatable {
    case active
    case archived
}

enum WorkerSessionGroupingMode: String, CaseIterable, Identifiable {
    case work
    case none

    var id: String { rawValue }

    @MainActor var title: String {
        switch self {
        case .work: L10n("Group by Work")
        case .none: L10n("All")
        }
    }
}

enum SessionCategory: String, CaseIterable, Identifiable {
    case worker
    case work
    case assistant

    var id: String { rawValue }

    init(session: TaskSession) {
        switch session.resolvedSessionKind {
        case .worker: self = .worker
        case .workChat: self = .work
        case .assistantChat, .legacy: self = .assistant
        }
    }

    @MainActor var title: String {
        switch self {
        case .worker: L10n("Worker")
        case .work: L10n("Work")
        case .assistant: L10n("Assistant")
        }
    }

    var systemImage: String {
        switch self {
        case .worker: "hammer"
        case .work: "scope"
        case .assistant: "sparkles"
        }
    }
}

/// The sidebar projection is expensive for large Session collections, but a
/// selection change does not alter any of its inputs. Keep the immutable
/// result behind an explicit revision key so SwiftUI may reevaluate
/// `UnifiedConsoleView.body` without repeating filtering, sorting, and grouping.
struct SessionGroupProjectionKey: Equatable {
    let groupingRevision: UInt64
    let filterRevision: UInt64
    let entityRevision: UInt64
    let category: SessionCategory
    let workerScope: WorkerSessionScope
    let workerGroupingMode: WorkerSessionGroupingMode
    let searchText: String
}

@MainActor
final class SessionGroupProjectionStore: ObservableObject {
    private var cachedKey: SessionGroupProjectionKey?
    private var cachedGroups: [SessionGroup] = []
    private(set) var computationCount = 0

    func groups(
        for key: SessionGroupProjectionKey,
        make: () -> [SessionGroup]
    ) -> [SessionGroup] {
        if cachedKey == key {
            return cachedGroups
        }
        let groups = make()
        cachedKey = key
        cachedGroups = groups
        computationCount += 1
        return groups
    }
}

@MainActor
func makeSessionGroups(
    rows: [SessionRowModel],
    agents: [Agent],
    tasks: [CorptieTask],
    works: [Work],
    category: SessionCategory,
    workerScope: WorkerSessionScope = .active,
    workerGroupingMode: WorkerSessionGroupingMode = .work
) -> [SessionGroup] {
    // Read each observable row exactly once. Repeated @Published property
    // access inside lazy filter + sort comparators dominated the 2,000-row
    // path even though the actual sort is cheap.
    var candidates: [(row: SessionRowModel, session: TaskSession, timestamp: String)] = []
    candidates.reserveCapacity(rows.count)
    for row in rows {
        let session = row.session
        guard session.hasValidProductClassification,
              SessionCategory(session: session) == category else { continue }
        candidates.append((row, session, session.lastMessageAt ?? session.updatedAt))
    }
    candidates.sort { left, right in
        if left.timestamp != right.timestamp { return left.timestamp > right.timestamp }
        return left.row.id < right.row.id
    }
    let agentsByID = Dictionary(uniqueKeysWithValues: agents.map { ($0.agentId, $0) })
    let tasksByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
    let worksByID = Dictionary(uniqueKeysWithValues: works.map { ($0.id, $0) })
    var assistantOrder: [String] = []
    var assistantRows: [String: [SessionRowModel]] = [:]
    var workOrder: [String] = []
    var workTitles: [String: String] = [:]
    var visibleWorkerRows: [SessionRowModel] = []
    var workerRows: [String: [SessionRowModel]] = [:]
    var workerWorkKeysByRowID: [String: String] = [:]
    var workRows: [String: [SessionRowModel]] = [:]

    func registerWork(_ workID: String?) -> String {
        let trimmedID = workID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedID = trimmedID.flatMap { $0.isEmpty ? nil : $0 }
        let key = normalizedID ?? "__no_work__"
        if workTitles[key] == nil {
            workOrder.append(key)
            workTitles[key] = normalizedID.flatMap { worksByID[$0]?.name }
                ?? (normalizedID == nil ? L10n("No Work") : L10n("Unknown Work"))
        }
        return key
    }

    for candidate in candidates {
        let row = candidate.row
        let session = candidate.session
        switch session.resolvedSessionKind {
        case .assistantChat:
            let key = session.agentId ?? "__assistant_unbound__"
            if assistantRows[key] == nil { assistantOrder.append(key) }
            assistantRows[key, default: []].append(row)
        case .workChat:
            let workKey = registerWork(session.workId)
            workRows[workKey, default: []].append(row)
        case .worker:
            let task = session.taskId.flatMap { tasksByID[$0] }
            let isArchived = session.archived == true
            guard (workerScope == .archived) == isArchived else { continue }
            visibleWorkerRows.append(row)
            let workKey = registerWork(task?.workId ?? session.workId)
            workerWorkKeysByRowID[row.id] = workKey
            workerRows[workKey, default: []].append(row)
        case .legacy:
            continue
        }
    }

    var groups = assistantOrder.map { key in
        SessionGroup(
            key: "assistant:\(key)",
            title: agentsByID[key]?.name ?? L10n("Assistant Session"),
            rows: assistantRows[key] ?? []
        )
    }
    if category == .worker,
       workerScope == .active,
       workerGroupingMode == .none,
       !visibleWorkerRows.isEmpty {
        let rowSubtitles: [String: String] = Dictionary(
            uniqueKeysWithValues: visibleWorkerRows.compactMap { row -> (String, String)? in
                guard let workKey = workerWorkKeysByRowID[row.id],
                      let workTitle = workTitles[workKey] else { return nil }
                return (row.id, workTitle)
            }
        )
        groups.append(SessionGroup(
            key: "worker-ungrouped",
            title: "",
            rows: visibleWorkerRows,
            showsHeader: false,
            rowSubtitles: rowSubtitles
        ))
        return groups
    }
    for workKey in workOrder {
        if category == .worker,
           let rows = workerRows[workKey],
           !rows.isEmpty {
            groups.append(SessionGroup(
                key: "worker-work:\(workKey)",
                title: workTitles[workKey] ?? L10n("Unknown Work"),
                rows: rows
            ))
        } else if category == .work,
                  let rows = workRows[workKey],
                  !rows.isEmpty {
            groups.append(SessionGroup(
                key: "work:\(workKey)",
                title: workTitles[workKey] ?? L10n("Unknown Work"),
                rows: rows
            ))
        }
    }
    return groups
}

// 按搜索词筛选会话（匹配标题/摘要/Agent/工作目录，大小写不敏感）。
@MainActor
func filteredSessionRows(_ rows: [SessionRowModel], query: String) -> [SessionRowModel] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return rows }
    return rows.filter { row in
        let session = row.session
        return [session.title, session.summary, session.agent, session.external?.cwd ?? ""]
            .contains { $0.localizedCaseInsensitiveContains(trimmed) }
    }
}

// 解析某个 Tab（SessionCategory）下应选中的会话 id：
//  - 当前选择仍属于该 Tab 且存在 → 保留；
//  - 否则若该 Tab 记住的上次选择仍存在 → 恢复；
//  - 否则回退到该 Tab 的第一个会话；
//  - 该 Tab 无会话时返回 nil。
@MainActor
func resolvedSessionSelection(
    category: SessionCategory,
    rows: [SessionRowModel],
    selectedSessionId: String?,
    lastSelectedId: String?,
    workerScope: WorkerSessionScope = .active
) -> String? {
    let visibleRows = rows.filter { row in
        guard row.session.hasValidProductClassification else { return false }
        guard SessionCategory(session: row.session) == category else { return false }
        guard category == .worker else { return true }
        return (workerScope == .archived) == isArchivedWorkerSession(row.session)
    }
    if let selectedSessionId,
       visibleRows.contains(where: { $0.id == selectedSessionId }) {
        return selectedSessionId
    }
    guard let first = visibleRows.first else { return nil }
    if let lastSelectedId, visibleRows.contains(where: { $0.id == lastSelectedId }) {
        return lastSelectedId
    }
    return first.id
}

func isArchivedWorkerSession(_ session: TaskSession) -> Bool {
    session.resolvedSessionKind == .worker && session.archived == true
}

enum SessionSelectionRecoveryPolicy {
    private static let historyLimit = 50

    static func recording(_ sessionID: String, in recentSessionIDs: [String]) -> [String] {
        var result = recentSessionIDs.filter { $0 != sessionID }
        result.insert(sessionID, at: 0)
        return Array(result.prefix(historyLimit))
    }

    static func isAccessible(
        _ session: TaskSession,
        sessions: [TaskSession]
    ) -> Bool {
        return session.archived != true
            && sessions.contains(where: { $0.id == session.id && $0.archived != true })
    }

    static func recoverySessionID(
        recentSessionIDs: [String],
        sessions: [TaskSession],
        excluding excludedSessionID: String
    ) -> String? {
        let accessibleIDs = Set(sessions.lazy.filter {
            $0.id != excludedSessionID && isAccessible($0, sessions: sessions)
        }.map(\.id))
        if let recentID = recentSessionIDs.first(where: accessibleIDs.contains) {
            return recentID
        }
        return sessions.first(where: { accessibleIDs.contains($0.id) })?.id
    }
}

// 会话详细信息面板：对话区右侧一条固定竖列（参考 Rudder 的 IssueDetail rail）。
//   固定在右侧，常驻展示，无收起/展开按钮；竖向排列详情字段。
//   Rudder 契约：rail 固定 280px，sticky 顶部，仅 <48rem 移动端才隐藏。
struct SessionDetailPanel: View {
    @ObservedObject private var entityClient = EntityAPIClient.shared
    private let backendClient = BackendClient.shared
    let session: TaskSession
    @State private var contextReferenceAddMode: ContextReferenceAddMode?
    @State private var contextReferences: [SessionContextReference] = []
    @State private var isLoadingContextReferences = false
    @State private var providerCatalogRevision = 0
    @State private var pendingProviderId: String?
    @State private var showProviderSwitchConfirmation = false
    @State private var isSwitchingProvider = false
    @State private var providerSwitchError: String?
    @State private var isLoadingProviderCatalog = false
    @State private var providerCatalogLoadFailed = false

    /// 详情竖列固定宽度（对应 Rudder IssueDetail rail 280px）。
    private static let railWidth: CGFloat = 280

    private static let iso8601Formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601NoFractionFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.unitsStyle = .short
        return formatter
    }()

    var body: some View {
        Group {
            if let taskId = session.taskId, !taskId.isEmpty {
                ScrollView {
                    VStack(spacing: 0) {
                        sessionCard(decoratesSurface: false, scrollsContent: false)
                        Divider()
                            .opacity(0.5)
                        SessionCorptieTaskDetailCard(
                            taskId: taskId,
                            decoratesSurface: false,
                            showsHeader: false,
                            embedsInParentScroll: true
                        )
                    }
                }
                .modifier(DetailRailSurfaceModifier(enabled: true))
            } else {
                sessionCard(decoratesSurface: true)
            }
        }
        .frame(width: Self.railWidth)
        .task(id: session.id) {
            await loadProviderCatalogIfNeeded()
        }
        .onReceive(backendClient.supplementaryDataController.$selectedContextReferences) { references in
            contextReferences = references
        }
        .onReceive(backendClient.supplementaryDataController.$isLoadingContextReferences) { isLoading in
            isLoadingContextReferences = isLoading
        }
        .onReceive(backendClient.$agentProviders) { _ in
            providerCatalogRevision &+= 1
        }
        .sheet(item: $contextReferenceAddMode) { mode in
            ContextReferenceAddSheet(session: session, mode: mode)
        }
        .alert(L10n("切换 Provider？"), isPresented: $showProviderSwitchConfirmation) {
            Button(L10n("切换")) { performProviderSwitch() }
            Button(L10n("取消"), role: .cancel) { pendingProviderId = nil }
        } message: {
            Text(providerSwitchConfirmationMessage)
        }
    }

    private func sessionCard(decoratesSurface: Bool, scrollsContent: Bool = true) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(session.resolvedSessionKind == .worker
                    ? L10n("Task Information")
                    : L10n("Session Details"))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()
                .opacity(0.5)

            if scrollsContent {
                ScrollView {
                    sessionDetailContent
                }
            } else {
                sessionDetailContent
            }
        }
        .frame(maxHeight: scrollsContent ? .infinity : nil)
        .modifier(DetailRailSurfaceModifier(enabled: decoratesSurface))
    }

    private var sessionDetailContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            statusCard

            SessionMemoryDiagnosticsView(session: session)

            ScheduledSessionStrip(session: session)

            SessionTurnObservabilityView(sessionId: session.id)

            if session.resolvedSessionKind == .assistantChat || session.resolvedSessionKind == .workChat {
                assistantSection
                contextReferencesSection
            }

            detailSection(title: "运行环境", systemImage: "cpu") {
                providerPicker
                detailFields(runtimeFields)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label(session.executionTaskStatus.label, systemImage: "circle.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(session.executionTaskStatus.color)
                Spacer()
                Text(friendlyUpdatedAt)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(Color.accentColor.opacity(0.055), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var assistantSection: some View {
        detailSection(title: "Assistant", systemImage: "person.crop.circle") {
            HStack(alignment: .top, spacing: 9) {
                SessionAvatarView(session: session, avatarSize: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(agentDisplayName)
                        .font(.system(size: 12, weight: .semibold))
                    if let description = assistantAgent?.description, !description.isEmpty {
                        CollapsibleDetailText(
                            text: description,
                            font: .system(size: 11),
                            lineSpacing: 1
                        )
                    }
                }
            }
        }
    }

    private var contextReferencesSection: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Label(L10n("引用内容"), systemImage: "link")
                    .detailRailSectionLabelStyle()
                Spacer()
                Menu {
                    Button("本地文件…", systemImage: "doc") { chooseLocalFile() }
                    Button("网页链接…", systemImage: "globe") { contextReferenceAddMode = .webURL }
                    Divider()
                    Button("Work…", systemImage: "scope") { contextReferenceAddMode = .work }
                    Button("CorptieTask…", systemImage: "checklist") { contextReferenceAddMode = .task }
                    Button("Agent…", systemImage: "person.2") { contextReferenceAddMode = .agent }
                    Button("其他会话…", systemImage: "bubble.left.and.bubble.right") { contextReferenceAddMode = .session }
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 10, weight: .semibold))
                        .frame(width: 20, height: 18)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .help("添加上下文引用")
            }

            if isLoadingContextReferences && contextReferences.isEmpty {
                ProgressView().controlSize(.small)
            } else if !contextReferences.isEmpty {
                LazyVStack(spacing: 6) {
                    ForEach(contextReferences) { reference in
                        contextReferenceRow(reference)
                    }
                }
            }
        }
    }

    private func contextReferenceRow(_ reference: SessionContextReference) -> some View {
        HStack(spacing: 7) {
            Image(systemName: reference.targetType.systemImage)
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(reference.enabled ? Color.accentColor : Color.secondary)
                .frame(width: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(reference.displayName)
                    .font(.system(size: 11, weight: .medium))
                    .lineLimit(1)
                Text(reference.status.contextReferenceStatusLabel)
                    .font(.system(size: 9))
                    .foregroundStyle(reference.status == "available" ? Color.secondary.opacity(0.65) : Color.orange)
            }
            Spacer(minLength: 2)
            Toggle("", isOn: Binding(
                get: { reference.enabled },
                set: { enabled in Task { await backendClient.setContextReferenceEnabled(reference, enabled: enabled) } }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.mini)
            Menu {
                if reference.targetType == .webURL {
                    Button("刷新快照", systemImage: "arrow.clockwise") {
                        Task { await backendClient.refreshContextReference(reference) }
                    }
                }
                if reference.targetType == .localFile, let path = reference.locator {
                    Button("在 Finder 中显示", systemImage: "folder") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                    }
                } else if reference.targetType == .webURL, let locator = reference.locator, let url = URL(string: locator) {
                    Button("打开网页", systemImage: "safari") { NSWorkspace.shared.open(url) }
                }
                Divider()
                Button("移除引用", systemImage: "trash", role: .destructive) {
                    Task { await backendClient.deleteContextReference(reference) }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 16, height: 18)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
        }
        .detailRailReferenceRowStyle()
        .opacity(reference.enabled ? 1 : 0.55)
    }

    private func chooseLocalFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            _ = await backendClient.addContextReference(to: session, type: .localFile, locator: url.path)
        }
    }

    private func detailSection<Content: View>(
        title: String,
        systemImage: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
            content()
        }
    }

    private func detailFields(_ fields: [(String, String)]) -> some View {
        LazyVGrid(
            columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)],
            alignment: .leading,
            spacing: 9
        ) {
            ForEach(fields, id: \.0) { label, value in
                VStack(alignment: .leading, spacing: 3) {
                    Text(label)
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.tertiary)
                    Text(value)
                        .font(.system(size: 12, weight: .medium))
                        .textSelection(.enabled)
                        .lineLimit(2)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Provider")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
            if session.external?.providerSwitchInFlight == true || isSwitchingProvider {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L10n("正在切换 Provider…"))
                        .font(.system(size: 11, weight: .medium))
                }
            } else if isLoadingProviderCatalog && creatableProviders.isEmpty {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L10n("正在加载 Provider…"))
                        .font(.system(size: 11, weight: .medium))
                }
            } else if alternativeProviders.isEmpty {
                providerValueRow
                if providerCatalogLoadFailed {
                    Button(L10n("重新加载 Provider")) {
                        Task { await reloadProviderCatalog() }
                    }
                    .buttonStyle(.link)
                    .font(.system(size: 10))
                } else {
                    Text(L10n("没有其他可用 Provider"))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            } else {
                Menu {
                    ForEach(creatableProviders) { provider in
                        Button {
                            guard !provider.matches(session.external?.provider) else { return }
                            pendingProviderId = provider.id
                            showProviderSwitchConfirmation = true
                        } label: {
                            if provider.matches(session.external?.provider) {
                                Label(provider.displayName, systemImage: "checkmark")
                            } else {
                                Text(provider.displayName)
                            }
                        }
                        .disabled(provider.matches(session.external?.provider))
                    }
                } label: {
                    HStack {
                        Text(currentProviderDisplayName)
                            .font(.system(size: 12, weight: .medium))
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 28)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 7))
                }
                .menuStyle(.borderlessButton)
            }
            if let providerSwitchError {
                Text(providerSwitchError)
                    .font(.system(size: 10))
                    .foregroundStyle(.red)
            }
        }
        .padding(.bottom, 4)
    }

    private var creatableProviders: [AgentProviderDescriptor] {
        _ = providerCatalogRevision
        return backendClient.agentProviders.filter { $0.supports("session.create") }
    }

    private var alternativeProviders: [AgentProviderDescriptor] {
        _ = providerCatalogRevision
        return backendClient.agentProviders.sessionProviderAlternatives(to: session.external?.provider)
    }

    private var providerValueRow: some View {
        HStack {
            Text(currentProviderDisplayName)
                .font(.system(size: 12, weight: .medium))
            Spacer()
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 7))
    }

    private var currentProviderDisplayName: String {
        guard let provider = session.external?.provider, !provider.isEmpty else { return L10n("未知") }
        return backendClient.providerDisplayName(for: provider) ?? provider
    }

    private var pendingProviderDisplayName: String {
        guard let pendingProviderId else { return L10n("未知") }
        return backendClient.providerDisplayName(for: pendingProviderId) ?? pendingProviderId
    }

    private var providerSwitchConfirmationMessage: String {
        L10nFormat("系统会为当前会话创建新的 Provider 线程。现有聊天记录和工作空间会保留，后续消息将从 %@ 切换到 %@。", currentProviderDisplayName, pendingProviderDisplayName)
    }

    private func performProviderSwitch() {
        guard let target = pendingProviderId else { return }
        pendingProviderId = nil
        providerSwitchError = nil
        isSwitchingProvider = true
        Task {
            let success = await backendClient.switchProvider(session: session, to: target)
            isSwitchingProvider = false
            if !success {
                providerSwitchError = backendClient.lastError ?? L10n("Provider 切换失败")
            }
        }
    }

    private func loadProviderCatalogIfNeeded() async {
        guard backendClient.agentProviders.isEmpty else {
            providerCatalogLoadFailed = false
            return
        }
        await reloadProviderCatalog()
    }

    private func reloadProviderCatalog() async {
        guard !isLoadingProviderCatalog else { return }
        isLoadingProviderCatalog = true
        providerCatalogLoadFailed = false
        await backendClient.loadProviders()
        isLoadingProviderCatalog = false
        providerCatalogLoadFailed = backendClient.agentProviders.isEmpty
    }

    private var runtimeFields: [(String, String)] {
        _ = providerCatalogRevision
        var fields = [("Agent", agentDisplayName)]
        if let cwd = session.external?.cwd, !cwd.isEmpty {
            fields.append(("工作空间", compactPath(cwd)))
        }
        return fields
    }

    private var agentDisplayName: String {
        sessionAgentDisplayName(session: session, agents: entityClient.agents)
    }

    private var assistantAgent: Agent? {
        guard let agentId = session.agentId else { return nil }
        return entityClient.agents.first { $0.agentId == agentId }
    }

    private var friendlyUpdatedAt: String {
        let date = Self.iso8601Formatter.date(from: session.updatedAt)
            ?? Self.iso8601NoFractionFormatter.date(from: session.updatedAt)
        guard let date else {
            return session.updatedAt
        }
        return Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    private func compactPath(_ path: String) -> String {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let components = url.pathComponents.filter { $0 != "/" }
        guard components.count > 3 else { return url.path }
        return "…/" + components.suffix(3).joined(separator: "/")
    }

}

private enum ContextReferenceAddMode: String, Identifiable {
    case webURL
    case work
    case task
    case agent
    case session

    var id: String { rawValue }
    var title: String {
        switch self {
        case .webURL: "添加网页链接"
        case .work: "引用 Work"
        case .task: "引用 CorptieTask"
        case .agent: "引用 Agent"
        case .session: "引用其他会话"
        }
    }
    var referenceType: SessionContextReferenceType {
        switch self {
        case .webURL: .webURL
        case .work: .work
        case .task: .task
        case .agent: .agent
        case .session: .session
        }
    }
}

private struct ContextReferenceCandidate: Identifiable {
    let id: String
    let title: String
    let subtitle: String
    let systemImage: String
}

private struct ContextReferenceAddSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var backendClient = BackendClient.shared
    @ObservedObject private var entityClient = EntityAPIClient.shared
    let session: TaskSession
    let mode: ContextReferenceAddMode
    @State private var urlText = ""
    @State private var searchText = ""
    @State private var tasks: [CorptieTask] = []
    @State private var isSubmitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(mode.title).font(.system(size: 16, weight: .semibold))
                Spacer()
                Button("取消") { dismiss() }.buttonStyle(.plain)
            }

            if mode == .webURL {
                Text("网页会在添加时保存正文快照；之后可以从引用菜单手动刷新。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                TextField("https://example.com/document", text: $urlText)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { addWebURL() }
                Spacer()
                HStack {
                    Spacer()
                    Button("添加") { addWebURL() }
                        .buttonStyle(.borderedProminent)
                        .disabled(urlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSubmitting)
                }
            } else {
                TextField("搜索", text: $searchText)
                    .textFieldStyle(.roundedBorder)
                if candidates.isEmpty {
                    ContentUnavailableView("没有可引用的对象", systemImage: mode.referenceType.systemImage)
                } else {
                    List(filteredCandidates) { candidate in
                        Button {
                            add(candidate)
                        } label: {
                            HStack(spacing: 10) {
                                Image(systemName: candidate.systemImage)
                                    .frame(width: 20)
                                    .foregroundStyle(Color.accentColor)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(candidate.title).font(.system(size: 12, weight: .medium))
                                    if !candidate.subtitle.isEmpty {
                                        Text(candidate.subtitle)
                                            .font(.system(size: 10))
                                            .foregroundStyle(.secondary)
                                            .lineLimit(1)
                                    }
                                }
                                Spacer()
                                Image(systemName: "plus.circle")
                                    .foregroundStyle(.secondary)
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isSubmitting)
                    }
                    .listStyle(.inset)
                }
            }

            if let error = backendClient.lastError, !error.isEmpty {
                Text(error).font(.system(size: 10)).foregroundStyle(.red).lineLimit(2)
            }
            if mode == .task, let error = entityClient.tasksLoadError {
                Text(error).font(.system(size: 10)).foregroundStyle(.red).lineLimit(3)
            }
        }
        .padding(18)
        .frame(width: 430, height: mode == .webURL ? 230 : 460)
        .task {
            switch mode {
            case .work: await entityClient.refreshWorks()
            case .task:
                if let loaded = await entityClient.allCorptieTasks() {
                    tasks = loaded
                }
            case .agent: await entityClient.refreshAgents()
            case .session, .webURL: break
            }
        }
    }

    private var candidates: [ContextReferenceCandidate] {
        switch mode {
        case .work:
            entityClient.works.map { .init(id: $0.id, title: $0.name, subtitle: $0.status, systemImage: "scope") }
        case .task:
            tasks.map { .init(id: $0.id, title: $0.title, subtitle: $0.lifecycleState, systemImage: "checklist") }
        case .agent:
            entityClient.agents
                .filter { $0.agentId != session.agentId }
                .map { .init(id: $0.agentId, title: $0.name, subtitle: $0.description, systemImage: "person.2") }
        case .session:
            backendClient.sessions
                .filter { $0.id != session.id }
                .map { .init(id: $0.id, title: $0.title, subtitle: $0.agent, systemImage: "bubble.left.and.bubble.right") }
        case .webURL:
            []
        }
    }

    private var filteredCandidates: [ContextReferenceCandidate] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return candidates }
        return candidates.filter { $0.title.localizedCaseInsensitiveContains(query) || $0.subtitle.localizedCaseInsensitiveContains(query) }
    }

    private func addWebURL() {
        let locator = urlText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !locator.isEmpty else { return }
        isSubmitting = true
        Task {
            let added = await backendClient.addContextReference(to: session, type: .webURL, locator: locator)
            isSubmitting = false
            if added { dismiss() }
        }
    }

    private func add(_ candidate: ContextReferenceCandidate) {
        isSubmitting = true
        Task {
            let added = await backendClient.addContextReference(
                to: session,
                type: mode.referenceType,
                targetId: candidate.id,
                displayName: candidate.title
            )
            isSubmitting = false
            if added { dismiss() }
        }
    }
}

private extension SessionContextReferenceType {
    var systemImage: String {
        switch self {
        case .localFile: "doc"
        case .webURL: "globe"
        case .work: "scope"
        case .task: "checklist"
        case .agent: "person.2"
        case .session: "bubble.left.and.bubble.right"
        }
    }
}

private extension String {
    var contextReferenceStatusLabel: String {
        switch self {
        case "available": "可用"
        case "changed": "内容已变更"
        case "missing": "文件不存在"
        case "unavailable": "暂不可用"
        default: self
        }
    }
}

func sessionAgentDisplayName(session: TaskSession, agents: [Agent]) -> String {
    guard let agentId = session.agentId?.trimmingCharacters(in: .whitespacesAndNewlines),
          !agentId.isEmpty else {
        return "未挂载"
    }
    return agents.first(where: { $0.agentId == agentId })?.name ?? agentId
}

private struct SessionCorptieTaskDetailCard: View {
    @ObservedObject private var entityClient = EntityAPIClient.shared
    let taskId: String
    var decoratesSurface = true
    var showsHeader = true
    var embedsInParentScroll = false
    @State private var task: CorptieTask?
    @State private var isLoading = true

    var body: some View {
        Group {
            if let task {
                let work = entityClient.works.first { $0.id == task.workId }
                CorptieTaskDetailView(
                    task: task,
                    contributorAgentIds: work?.contributorAgentIds ?? [],
                    onRequestReload: {
                        Task { await entityClient.refreshWorks() }
                    },
                    showsHeader: showsHeader,
                    embedsInParentScroll: embedsInParentScroll
                )
            } else if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ContentUnavailableView(
                    L10n("Unable to Load CorptieTask"),
                    systemImage: "exclamationmark.triangle",
                    description: Text(L10n("绑定记录可能已不存在"))
                )
            }
        }
        .frame(maxHeight: embedsInParentScroll ? nil : .infinity)
        .modifier(DetailRailSurfaceModifier(enabled: decoratesSurface))
        .task(id: taskId) {
            isLoading = true
            if entityClient.works.isEmpty {
                await entityClient.refreshWorks()
            }
            if entityClient.repositories.isEmpty {
                await entityClient.refreshRepositories()
            }
            if let cached = entityClient.tasks.first(where: { $0.id == taskId }) {
                task = cached
            } else {
                task = await entityClient.task(id: taskId)
            }
            isLoading = false
        }
        .onChange(of: entityClient.tasksRevision) { _, _ in
            if let refreshed = entityClient.tasks.first(where: { $0.id == taskId }) {
                task = refreshed
            }
        }
    }
}

private struct DetailRailSurfaceModifier: ViewModifier {
    let enabled: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if enabled {
            content
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(Color(nsColor: .separatorColor).opacity(0.42), lineWidth: 1)
                }
                .shadow(color: Color.black.opacity(0.055), radius: 9, x: 0, y: 3)
        } else {
            content
        }
    }
}
