import Combine
import AppKit
import SwiftUI

// Sessions Tab：两栏布局（参考 Rudder 的三栏设计哲学，但对话页收敛为两栏）。
//   左 sidebar  — 会话列表（CompactSessionRow，固定窄列，纸面卡片质感）
//   中 content  — 对话（复用旧版 DetailView，吃满剩余宽度，纸面卡片质感）
//   详情信息   — 右侧竖列常驻 side panel（固定宽度，无收起按钮，模仿 Rudder IssueDetail 的 rail）
//
// Rudder 设计契约要点（IssueDetail.tsx + index.css）：
//   - 详情页是 CSS Grid 三区域布局，右侧「Properties rail」固定 280px，sticky 常驻，
//     没有收起/折叠按钮——只有 <48rem 移动端才 display:none（靠顶部 SlidersHorizontal 打开 Sheet）。
//   - 字段区标题用 11px uppercase + tracking 的小字「Properties」标签，下面竖向排列字段。
//   - 窄列固定像素宽度，主工作区吃掉剩余空间。
struct SessionsView: View {
    private let backendClient = BackendClient.shared
    @ObservedObject private var sessionListStore = BackendClient.shared.sessionListStore
    @ObservedObject private var entityClient = EntityAPIClient.shared
    @StateObject private var layoutState = PanelLayoutState()
    @StateObject private var presentationStore = SessionPresentationStore()
    @State private var composerDraftRepository = ComposerDraftRepository()
    @State private var detailRenderTask: Task<Void, Never>?
    @State private var visuallySelectedSessionID: String?
    @State private var selectedSession: TaskSession?
    @State private var pendingSelectionTask: Task<Void, Never>?
    @State private var selectedCategory: SessionCategory = .worker
    @EnvironmentObject private var router: AppTabRouter
    /// 「+」新建会话：明确选择 Assistant、Objective 或 Worker Session。
    @State private var showNewSessionCreation = false
    /// 已收起的子分类分组 key 集合（仅内存态，跟随当前页面生命周期）。
    @State private var collapsedGroupKeys: Set<String> = []
    /// 搜索交互状态。
    @State private var isSearching = false
    @State private var searchText = ""
    @FocusState private var isSearchFieldFocused: Bool
    /// 每个 Tab（SessionCategory）独立记录其上一次选中的 Session，跨窗口/重启恢复，
    /// 避免不同 Tab 的选择相互覆盖。key 形如 `sessions.lastSelectedSessionId.<category>`。
    private static func lastSelectedSessionKey(for category: SessionCategory) -> String {
        "sessions.lastSelectedSessionId.\(category.rawValue)"
    }

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            NavigationSplitView {
                sessionListSidebar
                    .toolbar(removing: .sidebarToggle)
                    .navigationSplitViewColumnWidth(
                        min: TwoPaneLayoutMetrics.sidebarWidth,
                        ideal: TwoPaneLayoutMetrics.sidebarWidth,
                        max: max(TwoPaneLayoutMetrics.sidebarWidth, w * 0.34)
                    )
            } detail: {
                sessionConversation
                    .padding(.horizontal, TwoPaneLayoutMetrics.contentPadding)
            }
            .toolbar(removing: .sidebarToggle)
        }
        .environmentObject(backendClient)
        .environmentObject(layoutState)
        .environment(\.isLiquidGlass, false)
        .onAppear {
            PerfStopwatch.event("SessionsView·onAppear", value: 1)
            activateSessions()
        }
        .onDisappear {
            deactivateSessions()
        }
        .onChange(of: router.selectedTab) { _, newTab in
            // 常驻子树后 onAppear/onDisappear 不再随 Tab 切换触发，改用
            // selectedTab 显式驱动进入/离开语义，保持轮询抑制与任务清理正确。
            if newTab == .sessions {
                activateSessions()
            } else {
                deactivateSessions()
            }
        }
        .onReceive(backendClient.sessionsDidChange) { sessions in
            let activeSessionIDs = Set(sessions.map(\.id))
            presentationStore.prune(to: activeSessionIDs)
            SessionTimelineRepository.shared.prune(to: activeSessionIDs)
            attemptPendingSelection(sessions)
            restoreLastSelectedSession(sessions)
            preloadSessionMessages(sessions)
        }
        .onChange(of: router.pendingSessionId) { _, _ in
            attemptPendingSelection(backendClient.sessions)
        }
        .onReceive(backendClient.$selectedSession) { session in
            selectedSession = session
            if let session {
                presentationStore.activateHost(for: session.id)
                Self.recordSessionId(session.id, category: selectedCategory)
                visuallySelectedSessionID = session.id
                selectedCategory = SessionCategory(session: session)
            }
            preloadSessionMessages(backendClient.sessions)
        }
        .onChange(of: selectedCategory) { _, newValue in
            restoreSelection(for: newValue)
        }
    }

    private func activateSessions() {
        // 常驻子树后 onAppear 会在启动时（selectedTab 仍为 console）就触发，
        // 只有真正处于 Sessions Tab 时才执行激活逻辑。
        guard router.selectedTab == .sessions else { return }
        selectedSession = backendClient.selectedSession
        if let selectedSession {
            presentationStore.activateHost(for: selectedSession.id)
        }
        scheduleDetailRendering()
        backendClient.suppressBackgroundPolling = true
        attemptPendingSelection(backendClient.sessions)
        restoreLastSelectedSession(backendClient.sessions)
        preloadSessionMessages(backendClient.sessions)
        Task { await entityClient.refreshAgents() }
    }

    private func deactivateSessions() {
        detailRenderTask?.cancel()
        detailRenderTask = nil
        pendingSelectionTask?.cancel()
        pendingSelectionTask = nil
        presentationStore.cancelPreheats()
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
            guard !Task.isCancelled, router.selectedTab == .sessions else { return }
            layoutState.canRenderDetailMessages = true
            PerfStopwatch.event("会话切换.scheduleDetailRendering=true", value: 1)
        }
    }

    // 控制台「打开对话」→ 切到本 Tab 后，选中目标会话（sessions 加载完成后）。
    private func attemptPendingSelection(_ sessions: [TaskSession]) {
        guard let pendingId = router.pendingSessionId else { return }
        if let session = sessionMatchingPendingSelection(pendingId, in: sessions) {
            pendingSelectionTask?.cancel()
            selectedCategory = SessionCategory(session: session)
            backendClient.select(session: session)
            router.pendingSessionId = nil
            return
        }
        guard pendingSelectionTask == nil else { return }
        pendingSelectionTask = Task { @MainActor in
            defer { pendingSelectionTask = nil }
            if let session = await AppStateSyncController.shared.hydrateSession(pendingId) {
                selectedCategory = SessionCategory(session: session)
                backendClient.select(session: session)
                router.pendingSessionId = nil
            } else {
                router.failSessionNavigation(pendingId)
            }
        }
    }

    // 未选中时恢复上次选中的会话（跨窗口/重启记忆）。
    private func restoreLastSelectedSession(_ sessions: [TaskSession]) {
        guard selectedSession == nil, !sessions.isEmpty else { return }
        restoreSelection(for: selectedCategory)
    }

    private static func recordSessionId(_ id: String, category: SessionCategory) {
        CorptieAppEnvironment.userDefaults.set(id, forKey: lastSelectedSessionKey(for: category))
    }

    private static func restoredSessionId(for category: SessionCategory) -> String? {
        CorptieAppEnvironment.userDefaults.string(forKey: lastSelectedSessionKey(for: category))
    }

    // 恢复某个 Tab（SessionCategory）下的选择：优先保留仍有效的当前选择，
    // 否则恢复该 Tab 上次选中的会话；若已删除/不属于该 Tab，则回退到第一个。
    private func restoreSelection(for category: SessionCategory) {
        let targetId = resolvedSessionSelection(
            category: category,
            rows: sessionListStore.rows,
            selectedSessionId: selectedSession?.id,
            lastSelectedId: Self.restoredSessionId(for: category)
        )
        guard let targetId, targetId != selectedSession?.id else { return }
        if let session = backendClient.sessions.first(where: { $0.id == targetId }) {
            selectSessionAfterHighlight(session)
        }
    }

    private func preloadSessionMessages(_ sessions: [TaskSession]) {
        PerfStopwatch.measure("预加载·preloadSessionMessages(\(sessions.count)会话)") {
            backendClient.preloadSessionDetails(
                sessions,
                centeredOn: selectedSession?.id
            )
            presentationStore.prune(to: Set(sessions.map(\.id)))
            let sessionsByID = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
            let prioritizedIDs = SessionDetailPreloadPolicy.prioritizedSessionIDs(
                sessions.map(\.id),
                selectedSessionID: selectedSession?.id
            )
            for sessionID in prioritizedIDs {
                guard let session = sessionsByID[sessionID] else { continue }
                presentationStore.preheat(
                    session: session,
                    backendClient: backendClient,
                    visibleMessageLimit: DetailView.initialVisibleMessageLimit
                )
            }
        }
    }

    private func selectSessionAfterHighlight(_ session: TaskSession) {
        pendingSelectionTask?.cancel()
        visuallySelectedSessionID = session.id
        pendingSelectionTask = Task { @MainActor in
            // Give AppKit one display frame to paint the row selection before
            // SwiftUI reconciles the conversation subtree.
            try? await Task.sleep(for: .milliseconds(16))
            guard !Task.isCancelled else { return }
            backendClient.select(session: session)
            pendingSelectionTask = nil
        }
    }

    // MARK: - 左：会话列表（原生 sidebar）

    private var sessionListSidebar: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                sessionCategoryPicker
                    .frame(maxWidth: .infinity)
                searchToggleButton
            }
            .padding(.horizontal, 8)
            .padding(.top, 8)

            if isSearching {
                sessionSearchBar
                    .padding(.horizontal, 8)
                    .padding(.top, 6)
            }

            newChatButton
                .padding(.horizontal, 8)
                .padding(.top, 6)
                .padding(.bottom, 4)

            List {
                if isSearching && !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && groupedSessions.isEmpty {
                    ContentUnavailableView.search(text: searchText)
                        .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                } else if groupedSessions.isEmpty {
                    Text(L10n("No Sessions in This Category"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(groupedSessions) { group in
                        Section {
                            if !collapsedGroupKeys.contains(group.key) {
                                ForEach(group.rows) { row in
                                    sessionRow(row)
                                }
                            }
                        } header: {
                            sessionGroupHeader(group)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
        }
        .sheet(isPresented: $showNewSessionCreation) {
            NewSessionCreationSheet()
        }
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
        Picker(L10n("Session Type"), selection: $selectedCategory) {
            ForEach(SessionCategory.allCases) { category in
                Label(category.title, systemImage: category.systemImage)
                    .tag(category)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .help(selectedCategory.title)
    }

    private var newChatButton: some View {
        Button {
            showNewSessionCreation = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                Text(L10n("新建会话"))
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.primary)
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(nsColor: .quaternaryLabelColor).opacity(0.4)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(L10n("Create an Assistant, Objective, or Worker Session"))
    }

    private func sessionRow(_ row: SessionRowModel) -> some View {
        let isSelected = (visuallySelectedSessionID ?? selectedSession?.id) == row.session.id
        return CompactSessionRow(
            session: row.session,
            selectionRequested: selectSessionAfterHighlight
        )
            .onHover { isHovering in
                guard isHovering else { return }
                backendClient.prefetchDetail(for: row.session)
            }
            .listRowInsets(EdgeInsets(top: 3, leading: 0, bottom: 3, trailing: 8))
            .listRowSeparator(.hidden)
            .listRowBackground(
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(isSelected ? Color.accentColor.opacity(0.09) : Color.clear)
                    if isSelected {
                        Capsule()
                            .fill(Color.accentColor)
                            .frame(width: 3, height: 22)
                            .padding(.leading, 2)
                    }
                }
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
                Spacer()
                Text("\(group.rows.count)")
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
            .padding(.top, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - 会话分组

    /// 一级分类依据 provider-neutral sessionKind；Worker 子分类依据关联 WorkItem 的业务状态。
    private var groupedSessions: [SessionGroup] {
        makeSessionGroups(
            rows: searchFilteredRows,
            agents: entityClient.agents,
            workItems: entityClient.workItems,
            category: selectedCategory
        )
    }

    // 按搜索词筛选当前 Tab 下的会话（匹配标题/摘要/Agent/工作目录）。
    private var searchFilteredRows: [SessionRowModel] {
        filteredSessionRows(sessionListStore.rows, query: searchText)
    }

    // MARK: - 中：对话（纸面卡片 + 常驻详情 side panel）

    @ViewBuilder
    private var sessionConversation: some View {
        if let session = selectedSession,
           SessionCategory(session: session) == selectedCategory {
            HStack(spacing: 8) {
                // Keep the three most recently visited timeline hosts mounted.
                // Hidden hosts retain their AppKit view tree and exact layout;
                // the selected host is revealed only as a complete frame.
                ZStack {
                    ForEach(presentationStore.hostedSessionIDs, id: \.self) { hostedSessionID in
                        DetailView(
                            sessionId: hostedSessionID,
                            presentationStore: presentationStore,
                            composerDraftRepository: composerDraftRepository,
                            initialTimelinePosition: presentationStore.position(for: hostedSessionID),
                            onTimelinePositionChange: { position in
                                presentationStore.store(position, for: hostedSessionID)
                            }
                        )
                        .opacity(hostedSessionID == session.id ? 1 : 0)
                        .allowsHitTesting(hostedSessionID == session.id)
                        .accessibilityHidden(hostedSessionID != session.id)
                        .zIndex(hostedSessionID == session.id ? 1 : 0)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)

                // 右侧竖列详情面板（固定常驻，无收起按钮，模仿 Rudder IssueDetail rail）
                SessionDetailPanel(session: session)
            }
            .padding(16)
        } else {
            ContentUnavailableView(
                L10n("Select a Session"),
                systemImage: "bubble.left.and.bubble.right",
                description: Text(L10n("从左侧选择一个会话查看对话"))
            )
        }
    }

}

func sessionMatchingPendingSelection(_ pendingSessionId: String?, in sessions: [TaskSession]) -> TaskSession? {
    guard let pendingSessionId else { return nil }
    return sessions.first { $0.id == pendingSessionId }
}

struct SessionGroup: Identifiable {
    let key: String
    let title: String
    let rows: [SessionRowModel]

    var id: String { key }
}

enum SessionCategory: String, CaseIterable, Identifiable {
    case worker
    case objective
    case assistant

    var id: String { rawValue }

    init(session: TaskSession) {
        switch session.resolvedSessionKind {
        case .worker: self = .worker
        case .objectiveChat: self = .objective
        case .assistantChat, .legacy: self = .assistant
        }
    }

    @MainActor var title: String {
        switch self {
        case .worker: L10n("Worker")
        case .objective: L10n("Objective")
        case .assistant: L10n("Assistant")
        }
    }

    var systemImage: String {
        switch self {
        case .worker: "hammer"
        case .objective: "scope"
        case .assistant: "sparkles"
        }
    }
}

@MainActor
func makeSessionGroups(
    rows: [SessionRowModel],
    agents: [Agent],
    workItems: [WorkItem],
    category: SessionCategory
) -> [SessionGroup] {
    let agentsByID = Dictionary(uniqueKeysWithValues: agents.map { ($0.agentId, $0) })
    let workItemsByID = Dictionary(uniqueKeysWithValues: workItems.map { ($0.id, $0) })
    var assistantOrder: [String] = []
    var assistantRows: [String: [SessionRowModel]] = [:]
    var activeWorkerRows: [SessionRowModel] = []
    var completedWorkerRows: [SessionRowModel] = []
    var objectiveRows: [SessionRowModel] = []
    var legacyRows: [SessionRowModel] = []

    for row in rows where SessionCategory(session: row.session) == category {
        switch row.session.resolvedSessionKind {
        case .assistantChat:
            let key = row.session.agentId ?? "__assistant_unbound__"
            if assistantRows[key] == nil { assistantOrder.append(key) }
            assistantRows[key, default: []].append(row)
        case .objectiveChat:
            objectiveRows.append(row)
        case .worker:
            let workItem = row.session.workItemId.flatMap { workItemsByID[$0] }
            if workItem.map({ WorkItemColumn.column(for: $0.status) == .done }) == true {
                completedWorkerRows.append(row)
            } else {
                activeWorkerRows.append(row)
            }
        case .legacy:
            legacyRows.append(row)
        }
    }

    var groups = assistantOrder.map { key in
        SessionGroup(
            key: "assistant:\(key)",
            title: agentsByID[key]?.name ?? L10n("Assistant Session"),
            rows: assistantRows[key] ?? []
        )
    }
    if !activeWorkerRows.isEmpty {
        groups.append(SessionGroup(
            key: "__worker_active__",
            title: L10n("In Progress"),
            rows: activeWorkerRows
        ))
    }
    if !completedWorkerRows.isEmpty {
        groups.append(SessionGroup(
            key: "__worker_completed__",
            title: L10n("Completed"),
            rows: completedWorkerRows
        ))
    }
    if !objectiveRows.isEmpty {
        groups.append(SessionGroup(
            key: "__objective__",
            title: L10n("Objective Session"),
            rows: objectiveRows
        ))
    }
    if !legacyRows.isEmpty {
        groups.append(SessionGroup(
            key: "__legacy__",
            title: L10n("Unclassified Session"),
            rows: legacyRows
        ))
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
    lastSelectedId: String?
) -> String? {
    let visibleRows = rows.filter { SessionCategory(session: $0.session) == category }
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
        VStack(spacing: 12) {
            if let workItemId = session.workItemId, !workItemId.isEmpty {
                sessionCard
                    .frame(height: 330)
                WorkItemDetailCard(workItemId: workItemId, agentName: agentDisplayName)
            } else {
                sessionCard
            }
        }
        .frame(width: Self.railWidth)
        .task(id: session.id) {
            await loadProviderCatalogIfNeeded()
        }
        .onReceive(backendClient.$selectedContextReferences) { references in
            contextReferences = references
        }
        .onReceive(backendClient.$isLoadingContextReferences) { isLoading in
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

    private var sessionCard: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(L10n("会话详情"))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()
                .opacity(0.5)

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    statusCard

                    if session.resolvedSessionKind == .assistantChat || session.resolvedSessionKind == .objectiveChat {
                        assistantSection
                        contextReferencesSection
                    }

                    detailSection(title: "运行环境", systemImage: "cpu") {
                        providerPicker
                        detailFields(primaryFields)
                    }

                    if let cwd = session.external?.cwd, !cwd.isEmpty {
                        detailSection(title: "工作空间", systemImage: "folder") {
                            Text(compactPath(cwd))
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .lineLimit(2)
                                .truncationMode(.middle)
                                .textSelection(.enabled)
                                .help(cwd)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 12)
            }
        }
        .frame(maxHeight: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(0.42), lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(0.055), radius: 9, x: 0, y: 3)
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label(session.status.label, systemImage: "circle.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(session.status.color)
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
                Label("上下文引用", systemImage: "link")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.tertiary)
                Spacer()
                Menu {
                    Button("本地文件…", systemImage: "doc") { chooseLocalFile() }
                    Button("网页链接…", systemImage: "globe") { contextReferenceAddMode = .webURL }
                    Divider()
                    Button("Objective…", systemImage: "scope") { contextReferenceAddMode = .objective }
                    Button("WorkItem…", systemImage: "checklist") { contextReferenceAddMode = .workItem }
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
            } else if contextReferences.isEmpty {
                Text("添加文件、网页或 Corptie 对象，作为这个会话的持续上下文。")
                    .font(.system(size: 11))
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(spacing: 6) {
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
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
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

    private var primaryFields: [(String, String)] {
        _ = providerCatalogRevision
        var fields = [("Agent", agentDisplayName)]
        if let model = session.external?.currentModel {
            fields.append(("模型", model))
        }
        if let reasoning = session.external?.currentReasoningLevel {
            fields.append(("推理强度", reasoning.capitalized))
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
    case objective
    case workItem
    case agent
    case session

    var id: String { rawValue }
    var title: String {
        switch self {
        case .webURL: "添加网页链接"
        case .objective: "引用 Objective"
        case .workItem: "引用 WorkItem"
        case .agent: "引用 Agent"
        case .session: "引用其他会话"
        }
    }
    var referenceType: SessionContextReferenceType {
        switch self {
        case .webURL: .webURL
        case .objective: .objective
        case .workItem: .workItem
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
    @State private var workItems: [WorkItem] = []
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
            if mode == .workItem, let error = entityClient.workItemsLoadError {
                Text(error).font(.system(size: 10)).foregroundStyle(.red).lineLimit(3)
            }
        }
        .padding(18)
        .frame(width: 430, height: mode == .webURL ? 230 : 460)
        .task {
            switch mode {
            case .objective: await entityClient.refreshObjectives()
            case .workItem:
                if let loaded = await entityClient.allWorkItems() {
                    workItems = loaded
                }
            case .agent: await entityClient.refreshAgents()
            case .session, .webURL: break
            }
        }
    }

    private var candidates: [ContextReferenceCandidate] {
        switch mode {
        case .objective:
            entityClient.objectives.map { .init(id: $0.id, title: $0.name, subtitle: $0.status, systemImage: "scope") }
        case .workItem:
            workItems.map { .init(id: $0.id, title: $0.title, subtitle: $0.status, systemImage: "checklist") }
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
        case .objective: "scope"
        case .workItem: "checklist"
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

private struct WorkItemDetailCard: View {
    @ObservedObject private var entityClient = EntityAPIClient.shared
    let workItemId: String
    let agentName: String
    @State private var workItem: WorkItem?
    @State private var isLoading = true

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(L10n("WorkItem 详情"))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()
                .opacity(0.5)

            Group {
                if let workItem {
                    ScrollView {
                        workItemContent(workItem)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                } else if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ContentUnavailableView(
                        L10n("Unable to Load WorkItem"),
                        systemImage: "exclamationmark.triangle",
                        description: Text(L10n("绑定记录可能已不存在"))
                    )
                }
            }
        }
        .frame(maxHeight: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Color(nsColor: .separatorColor).opacity(0.42), lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(0.055), radius: 9, x: 0, y: 3)
        .task(id: workItemId) {
            isLoading = true
            workItem = await entityClient.workItem(id: workItemId)
            if entityClient.objectives.isEmpty {
                await entityClient.refreshObjectives()
            }
            isLoading = false
        }
    }

    private func workItemContent(_ item: WorkItem) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                Text(item.title)
                    .font(.system(size: 13, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)

                HStack(spacing: 6) {
                    metadataPill(
                        WorkItemColumn.column(for: item.status).title,
                        systemImage: WorkItemColumn.column(for: item.status).systemImage,
                        color: workItemStatusColor(item.status)
                    )
                    metadataPill(item.priority.capitalized, systemImage: "flag", color: .secondary)
                    Spacer(minLength: 0)
                    Text(relativeDate(item.updatedAt))
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.tertiary)
                }
            }

            HStack(alignment: .top, spacing: 10) {
                workItemSection(title: "Objective", systemImage: "target") {
                    Text(objectiveName(for: item) ?? "—")
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                workItemSection(title: "执行 Agent", systemImage: "cpu") {
                    Text(agentName)
                        .font(.system(size: 11, weight: .medium))
                        .lineLimit(2)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            if !item.description.isEmpty {
                workItemSection(title: "描述", systemImage: "text.alignleft") {
                    CollapsibleDetailText(text: item.description, lineSpacing: 1)
                }
            }

            if !item.acceptanceCriteria.isEmpty {
                workItemSection(title: "验收标准", systemImage: "checkmark.circle") {
                    CollapsibleDetailText(text: item.acceptanceCriteria, lineSpacing: 1)
                }
            }
        }
    }

    private func workItemSection<Content: View>(
        title: String,
        systemImage: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(title, systemImage: systemImage)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(.tertiary)
            content()
        }
    }

    private func objectiveName(for item: WorkItem) -> String? {
        entityClient.objectives.first(where: { $0.id == item.objectiveId })?.name
    }

    private func metadataPill(_ title: String, systemImage: String, color: Color) -> some View {
        Label(title, systemImage: systemImage)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .background(color.opacity(0.08), in: Capsule())
    }

    private func relativeDate(_ rawValue: String) -> String {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = fractional.date(from: rawValue) ?? ISO8601DateFormatter().date(from: rawValue) else {
            return rawValue
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    private func workItemStatusColor(_ status: String) -> Color {
        switch WorkItemColumn.column(for: status) {
        case .todo: .secondary
        case .inProgress: .blue
        case .done: .green
        }
    }
}
