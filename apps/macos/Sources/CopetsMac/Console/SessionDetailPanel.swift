import Combine
import CorptieConversation
import AppKit
import SwiftUI

struct SessionDetailPanel: View {
    @ObservedObject private var modelCatalog = BackendClient.shared.modelCatalog
    @ObservedObject private var entityClient = EntityAPIClient.shared
    private let backendClient = BackendClient.shared
    let session: TaskSession
    var railWidth: CGFloat = 280
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
    @State private var showsAllContextReferences = false

    private var detailKind: ConversationDetailKind? {
        ConversationDetailKind.resolve(session.resolvedSessionKind)
    }

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
        sessionCard
        .frame(width: railWidth)
        .task(id: session.id) {
            showsAllContextReferences = false
            await loadProviderCatalogIfNeeded()
        }
        .onReceive(backendClient.supplementaryDataController.$selectedContextReferences) { references in
            contextReferences = references
        }
        .onReceive(backendClient.supplementaryDataController.$isLoadingContextReferences) { isLoading in
            isLoadingContextReferences = isLoading
        }
        .onReceive(modelCatalog.$agentProviders) { _ in
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
        ConversationDetailDashboard {
            sessionDetailContent.background(ConsoleOverlayScroller())
        }
    }

    private var sessionDetailContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            ConversationSessionInformationCard(sessionID: session.id,
                workName: entityClient.works.first(where: { $0.id == session.workId })?.name)
            if detailKind == .taskDetail, let taskId = session.taskId, !taskId.isEmpty {
                SessionCorptieTaskDetailCard(
                    taskId: taskId,
                    decoratesSurface: false,
                    showsHeader: false,
                    embedsInParentScroll: true
                )
            }

            if detailKind == .chatDetail {
                ConversationChatSummaryCard(summary: session.summary)
            }

            if detailKind == .workDetail { workDetailContent }

            contextReferencesSection

            if backendClient.supplementaryDataController.isLoadingScheduledTasks
                || !backendClient.supplementaryDataController.selectedScheduledTasks.isEmpty
                || backendClient.scheduledTaskError != nil {
                ScheduledSessionStrip(session: session)
                    .modifier(ConversationDetailModuleSurface())
            }

            if detailKind == .workDetail,
               let work = entityClient.works.first(where: { $0.id == session.workId }) {
                Button {
                    TaskMemoryWindowManager.shared.show(workID: work.id, title: work.name)
                } label: {
                    Label("Work 记忆", systemImage: "brain")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
            }

            SessionMemoryDiagnosticsView(session: session)
                .modifier(ConversationDetailModuleSurface())
            SessionTurnObservabilityView(sessionId: session.id)
                .modifier(ConversationDetailModuleSurface())

            ConversationEnvironmentCard(provider: currentProviderDisplayName,
                agent: agentDisplayName, model: session.external?.currentModel,
                reasoning: session.external?.currentReasoningLevel,
                workspacePath: session.external?.cwd,
                actions: { compactProviderMenu }, statusContent: { providerSwitchStatus })
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

    @ViewBuilder
    private var workDetailContent: some View {
        if let work = entityClient.works.first(where: { $0.id == session.workId }) {
            ConversationWorkOverviewCard(description: work.description)
            let relevantTasks = entityClient.tasks.filter {
                $0.workId == work.id && $0.archived != true && $0.deletionStatus == nil
                    && $0.lifecycleState != "done"
            }.sorted {
                if $0.summaryNeedsIntervention != $1.summaryNeedsIntervention {
                    return $0.summaryNeedsIntervention
                }
                return $0.updatedAt > $1.updatedAt
            }
            let focusTasks = relevantTasks.prefix(3).map { task in
                ConversationFocusTask(id: task.id, title: task.title,
                    sessionID: task.currentSessionId, summary: task.conversationDetailSummary)
            }
            ConversationFocusTasksCard(tasks: focusTasks) { taskID, sessionID in
                AppTabRouter.shared.openTaskSession(taskId: taskID, sessionId: sessionID, source: .userSelection)
            }
            ArtifactSectionView(workId: work.id, taskId: nil)
                .id(work.id)
                .modifier(ConversationDetailModuleSurface())
        }
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
        ConversationDetailModuleCard(title: L10n("引用内容"), systemImage: "link", headerActions: {
            Menu {
                    Button("本地文件…", systemImage: "doc") { chooseLocalFile() }
                    Button("网页链接…", systemImage: "globe") { contextReferenceAddMode = .webURL }
                    Divider()
                    Button("Work…", systemImage: "scope") { contextReferenceAddMode = .work }
                    Button("CorptieTask…", systemImage: "checklist") { contextReferenceAddMode = .task }
                    Button("Agent…", systemImage: "person.2") { contextReferenceAddMode = .agent }
                    Button("其他会话…", systemImage: "bubble.left.and.bubble.right") { contextReferenceAddMode = .session }
            } label: { ConversationDetailHeaderIcon(systemName: "plus") }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .help("添加上下文引用")
            .accessibilityLabel("添加上下文引用")
            if contextReferences.count > 2 {
                Button { showsAllContextReferences.toggle() } label: {
                    ConversationDetailHeaderIcon(systemName: showsAllContextReferences ? "chevron.up" : "chevron.down")
                }
                .buttonStyle(.plain)
                .help(showsAllContextReferences ? "收起引用" : "展开全部引用")
                .accessibilityLabel(showsAllContextReferences ? "收起引用" : "展开全部引用（\(contextReferences.count)）")
            }
        }) {
            if isLoadingContextReferences && contextReferences.isEmpty {
                ProgressView().controlSize(.small)
            } else if !contextReferences.isEmpty {
                LazyVStack(spacing: 6) {
                    ForEach(showsAllContextReferences ? contextReferences : Array(contextReferences.prefix(2))) { reference in
                        contextReferenceRow(reference)
                    }
                }
            }
        }
    }

    private func contextReferenceRow(_ reference: SessionContextReference) -> some View {
        ConversationReferenceRow(title: reference.displayName,
            status: ConversationReferenceStatus.label(for: reference.status),
            systemImage: reference.targetType.systemImage,
            enabled: reference.enabled, statusAvailable: reference.status == "available") {
            Toggle("启用引用", isOn: Binding(
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
            .accessibilityLabel("引用操作")
        }
        .detailRailReferenceRowStyle()
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
        ConversationDetailModuleCard(title: title, systemImage: systemImage, content: content)
    }

    private var compactProviderMenu: some View {
        Menu {
            providerMenuItems
            if alternativeProviders.isEmpty {
                Text(isLoadingProviderCatalog ? L10n("正在加载 Provider…") : L10n("没有其他可用 Provider"))
                Button(L10n("重新加载 Provider")) {
                    Task { await reloadProviderCatalog() }
                }
            }
        } label: { ConversationDetailHeaderIcon(systemName: "arrow.triangle.2.circlepath") }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .disabled(isSwitchingProvider || session.external?.providerSwitchInFlight == true)
        .help(L10n("切换 Provider"))
        .accessibilityLabel(L10n("切换 Provider"))
    }

    @ViewBuilder private var providerSwitchStatus: some View {
            if isSwitchingProvider || session.external?.providerSwitchInFlight == true {
                Text(L10n("正在切换 Provider…")).font(.caption2)
            }
            if providerCatalogLoadFailed {
                Text(L10n("Provider 列表加载失败，请点击菜单重试")).font(.caption2).foregroundStyle(.secondary)
            }
            if let providerSwitchError {
                Text(providerSwitchError).font(.caption2).foregroundStyle(.red)
            }
    }

    private var providerMenuItems: some View {
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
                    providerMenuItems
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
        return modelCatalog.agentProviders.filter { $0.supports("session.create") }
    }

    private var alternativeProviders: [AgentProviderDescriptor] {
        _ = providerCatalogRevision
        return modelCatalog.agentProviders.sessionProviderAlternatives(to: session.external?.provider)
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
        guard modelCatalog.agentProviders.isEmpty else {
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
        providerCatalogLoadFailed = modelCatalog.agentProviders.isEmpty
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
