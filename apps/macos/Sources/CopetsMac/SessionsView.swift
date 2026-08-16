import Combine
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
    @ObservedObject private var backendClient = BackendClient.shared
    @ObservedObject private var sessionListStore = BackendClient.shared.sessionListStore
    @ObservedObject private var entityClient = EntityAPIClient.shared
    @StateObject private var layoutState = PanelLayoutState()
    @State private var composerDraftRepository = ComposerDraftRepository()
    @EnvironmentObject private var router: AppTabRouter
    /// 「+」新建会话：选择 Assistant 开聊（会话只能由 Assistant 创建）。
    @State private var showNewChatPicker = false
    /// 记录用户最后选中的 Session，跨窗口/重启恢复，避免再次打开时无默认选中。
    private static let lastSelectedSessionKey = "sessions.lastSelectedSessionId"

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
            layoutState.canRenderDetailMessages = true
            backendClient.suppressBackgroundPolling = true
            attemptPendingSelection(backendClient.sessions)
            restoreLastSelectedSession(backendClient.sessions)
        }
        .onDisappear {
            backendClient.suppressBackgroundPolling = false
        }
        .onReceive(backendClient.sessionsDidChange) { sessions in
            attemptPendingSelection(sessions)
            restoreLastSelectedSession(sessions)
        }
        .onChange(of: backendClient.selectedSession?.id) { _, newValue in
            if let newValue {
                Self.recordSessionId(newValue)
            }
        }
    }

    // 控制台「打开对话」→ 切到本 Tab 后，选中目标会话（sessions 加载完成后）。
    private func attemptPendingSelection(_ sessions: [TaskSession]) {
        guard let pendingId = router.pendingSessionId else { return }
        guard let session = sessions.first(where: { $0.id == pendingId }) else { return }
        backendClient.select(session: session)
        router.pendingSessionId = nil
    }

    // 未选中时恢复上次选中的会话（跨窗口/重启记忆）。
    private func restoreLastSelectedSession(_ sessions: [TaskSession]) {
        guard backendClient.selectedSession == nil, !sessions.isEmpty else { return }
        let lastId = Self.restoredSessionId()
        if let last = sessions.first(where: { $0.id == lastId }) {
            backendClient.select(session: last)
        } else if let first = sessions.first {
            backendClient.select(session: first)
        }
    }

    private static func recordSessionId(_ id: String) {
        CorptieAppEnvironment.userDefaults.set(id, forKey: lastSelectedSessionKey)
    }

    private static func restoredSessionId() -> String? {
        CorptieAppEnvironment.userDefaults.string(forKey: lastSelectedSessionKey)
    }

    // MARK: - 左：会话列表（原生 sidebar）

    private var sessionListSidebar: some View {
        VStack(spacing: 0) {
            newChatButton
                .padding(.horizontal, 8)
                .padding(.top, 8)
                .padding(.bottom, 4)

            List {
                if sessionListStore.rows.isEmpty {
                    Text(L10n("暂无会话"))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .listRowInsets(EdgeInsets(top: 4, leading: 8, bottom: 4, trailing: 8))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                } else {
                    ForEach(groupedSessions) { group in
                        Section {
                            ForEach(group.rows) { row in
                                sessionRow(row)
                            }
                        } header: {
                            sessionGroupHeader(group)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
        }
        .sheet(isPresented: $showNewChatPicker) {
            NewChatPickerSheet { agent in
                showNewChatPicker = false
                startNewSession(with: agent)
            }
        }
    }

    @State private var startingAgentId: String?

    // 直接为选中的 Assistant 开新会话（不询问首条消息），成功后跳转并选中新会话。
    private func startNewSession(with agent: Agent) {
        guard startingAgentId == nil else { return }
        startingAgentId = agent.agentId
        Task {
            let sessionId = await entityClient.startAgentSession(agentId: agent.agentId)
            startingAgentId = nil
            if let sessionId {
                router.openSession(sessionId)
            }
        }
    }

    private var newChatButton: some View {
        Button {
            showNewChatPicker = true
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
        .help(L10n("新建会话（选择一个 Assistant）"))
    }

    private func sessionRow(_ row: SessionRowModel) -> some View {
        let isSelected = backendClient.selectedSession?.id == row.session.id
        return CompactSessionRow(session: row.session)
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
        HStack(spacing: 6) {
            if group.isAssistant {
                Image(systemName: "sparkles")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
            }
            Text(group.title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.top, 4)
    }

    // MARK: - 会话分组（仅 Assistant 按 Agent 聚合）

    /// 会话分组：仅 Assistant 类 Agent 各自成组并置顶；其余（独立贡献者 + 未绑定）统一归入「Work Session」大类。
    private var groupedSessions: [SessionGroup] {
        let rows = sessionListStore.rows
        let agentsByID = Dictionary(uniqueKeysWithValues: entityClient.agents.map { ($0.agentId, $0) })

        // 助手按 Agent 归组；其余（独立贡献者 + 未绑定）统一归入 Work Session。
        var assistantByKey: [String: [SessionRowModel]] = [:]
        var workRows: [SessionRowModel] = []
        for row in rows {
            if let agentId = row.session.agentId,
               let agent = agentsByID[agentId],
               agent.isAssistant {
                assistantByKey[agent.agentId, default: []].append(row)
            } else {
                workRows.append(row)
            }
        }

        var groups: [SessionGroup] = []

        // 助手各自成组并置顶（平台预置单例，若有多个助手也全部靠前）。
        let assistantAgents = entityClient.agents
            .filter { $0.isAssistant && assistantByKey[$0.agentId] != nil }
        for agent in assistantAgents {
            groups.append(SessionGroup(
                key: agent.agentId,
                title: agent.name,
                isAssistant: true,
                rows: assistantByKey[agent.agentId] ?? []
            ))
        }

        // 独立贡献者 + 未分配会话，统一归入「Work Session」大类。
        if !workRows.isEmpty {
            groups.append(SessionGroup(
                key: "__work__",
                title: "Work Session",
                isAssistant: false,
                rows: workRows
            ))
        }

        return groups
    }

    // MARK: - 中：对话（纸面卡片 + 常驻详情 side panel）

    @ViewBuilder
    private var sessionConversation: some View {
        if let session = backendClient.selectedSession {
            HStack(spacing: 8) {
                // 主对话区：直接平铺，吃满剩余宽度（参考 Rudder 聊天主区）
                DetailView(
                    sessionId: session.id,
                    preheatedDisplayCache: nil,
                    composerDraftRepository: composerDraftRepository,
                    renderer: .swiftUIVStack
                )
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

// 会话分组：仅 Assistant 各自成组置顶，其余（独立贡献者 + 未分配）统一归入「Work Session」。
private struct SessionGroup: Identifiable {
    let key: String
    let title: String
    let isAssistant: Bool
    let rows: [SessionRowModel]

    var id: String { key }
}

// 会话详细信息面板：对话区右侧一条固定竖列（参考 Rudder 的 IssueDetail rail）。
//   固定在右侧，常驻展示，无收起/展开按钮；竖向排列详情字段。
//   Rudder 契约：rail 固定 280px，sticky 顶部，仅 <48rem 移动端才隐藏。
struct SessionDetailPanel: View {
    let session: TaskSession

    /// 详情竖列固定宽度（对应 Rudder IssueDetail rail 280px）。
    private static let railWidth: CGFloat = 280

    var body: some View {
        VStack(spacing: 12) {
            if let workItemId = session.workItemId, !workItemId.isEmpty {
                sessionCard
                    .frame(height: 330)
                WorkItemDetailCard(workItemId: workItemId, agentName: session.agent)
            } else {
                sessionCard
            }
        }
        .frame(width: Self.railWidth)
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

                    if !session.summary.isEmpty {
                        detailSection(title: "摘要", systemImage: "text.alignleft") {
                            Text(session.summary)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                                .lineSpacing(1)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                    }

                    detailSection(title: "运行环境", systemImage: "cpu") {
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

    private var primaryFields: [(String, String)] {
        var fields = [("Agent", session.agent)]
        if let model = session.external?.currentModel {
            fields.append(("模型", model))
        }
        if let reasoning = session.external?.currentReasoningLevel {
            fields.append(("推理强度", reasoning.capitalized))
        }
        if let provider = session.external?.provider {
            fields.append(("Provider", friendlyProvider(provider)))
        }
        return fields
    }

    private var friendlyUpdatedAt: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = formatter.date(from: session.updatedAt)
            ?? ISO8601DateFormatter().date(from: session.updatedAt)
        guard let date else {
            return session.updatedAt
        }
        let relativeFormatter = RelativeDateTimeFormatter()
        relativeFormatter.locale = Locale(identifier: "zh_CN")
        relativeFormatter.unitsStyle = .short
        return relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    private func compactPath(_ path: String) -> String {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let components = url.pathComponents.filter { $0 != "/" }
        guard components.count > 3 else { return url.path }
        return "…/" + components.suffix(3).joined(separator: "/")
    }

    private func friendlyProvider(_ provider: String) -> String {
        provider
            .replacingOccurrences(of: "-app-server", with: "")
            .replacingOccurrences(of: "-", with: " ")
            .capitalized
    }
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
                    Text(item.description)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineSpacing(1)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !item.acceptanceCriteria.isEmpty {
                workItemSection(title: "验收标准", systemImage: "checkmark.circle") {
                    Text(item.acceptanceCriteria)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineSpacing(1)
                        .fixedSize(horizontal: false, vertical: true)
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
