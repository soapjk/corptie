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

    /// 详情竖列固定宽度（对应 Rudder IssueDetail rail 280px）。

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
        sessionCard(decoratesSurface: true)
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

    private func sessionCard(decoratesSurface: Bool, scrollsContent: Bool = true) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(verbatim: "Detail")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                Menu {
                    Button("本地文件…") { chooseLocalFile() }
                    Button("网页链接…") { contextReferenceAddMode = .webURL }
                    Button("Work…") { contextReferenceAddMode = .work }
                    Button("Task…") { contextReferenceAddMode = .task }
                    Button("Agent…") { contextReferenceAddMode = .agent }
                    Button("其他会话…") { contextReferenceAddMode = .session }
                } label: {
                    Image(systemName: "link.badge.plus")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .help("添加引用")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()
                .opacity(0.5)

            if scrollsContent {
                ScrollView {
                    sessionDetailContent
                        .background(ConsoleOverlayScroller())
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
            if detailKind == .taskDetail, let taskId = session.taskId, !taskId.isEmpty {
                SessionCorptieTaskDetailCard(
                    taskId: taskId,
                    decoratesSurface: false,
                    showsHeader: false,
                    embedsInParentScroll: true
                )
            }

            if detailKind == .chatDetail,
               let summary = ConversationDetailKind.nonempty(session.summary) {
                detailSection(title: "会话摘要", systemImage: "text.alignleft") {
                    CollapsibleDetailText(text: summary, color: .secondary)
                }
            }

            if detailKind == .workDetail { workDetailContent }

            if !contextReferences.isEmpty || isLoadingContextReferences {
                contextReferencesSection
            }

            ScheduledSessionStrip(session: session)

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
            SessionTurnObservabilityView(sessionId: session.id)

            detailSection(title: "运行环境", systemImage: "cpu") {
                compactProviderPicker
                if let cwd = session.external?.cwd, !cwd.isEmpty {
                    detailFields([("工作空间", compactPath(cwd))])
                }
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

    @ViewBuilder
    private var workDetailContent: some View {
        if let work = entityClient.works.first(where: { $0.id == session.workId }) {
            if let description = ConversationDetailKind.nonempty(work.description) {
                detailSection(title: "Work 概述", systemImage: "scope") {
                    CollapsibleDetailText(text: description, color: .secondary)
                }
            }
            let relevantTasks = entityClient.tasks.filter {
                $0.workId == work.id && $0.archived != true && $0.deletionStatus == nil
                    && $0.lifecycleState != "done"
            }.sorted {
                if $0.summaryNeedsIntervention != $1.summaryNeedsIntervention {
                    return $0.summaryNeedsIntervention
                }
                return $0.updatedAt > $1.updatedAt
            }
            if !relevantTasks.isEmpty {
                detailSection(title: "重点 Task", systemImage: "checklist") {
                    ForEach(Array(relevantTasks.prefix(3))) { task in
                        VStack(alignment: .leading, spacing: 4) {
                            if let sessionID = task.currentSessionId {
                                Button {
                                    AppTabRouter.shared.openTaskSession(taskId: task.id, sessionId: sessionID, source: .userSelection)
                                } label: {
                                    Text(task.title).font(.system(size: 11, weight: .medium))
                                }.buttonStyle(.plain)
                            } else {
                                Text(task.title).font(.system(size: 11, weight: .medium))
                            }
                            if task.userSummary?.content != nil {
                                TaskSummaryView(task: task, compact: true)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            ArtifactSectionView(workId: work.id, taskId: nil)
                .id(work.id)
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
                    ForEach(showsAllContextReferences ? contextReferences : Array(contextReferences.prefix(2))) { reference in
                        contextReferenceRow(reference)
                    }
                }
                if contextReferences.count > 2 {
                    Button(showsAllContextReferences ? "收起" : "展开全部（\(contextReferences.count)）") {
                        showsAllContextReferences.toggle()
                    }.buttonStyle(.borderless).font(.caption)
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
        ConversationInspectorSection(title: title, systemImage: systemImage, content: content)
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

    private var compactProviderPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                Menu {
                    providerMenuItems
                    if alternativeProviders.isEmpty {
                        Text(isLoadingProviderCatalog ? L10n("正在加载 Provider…") : L10n("没有其他可用 Provider"))
                        Button(L10n("重新加载 Provider")) {
                            Task { await reloadProviderCatalog() }
                        }
                    }
                } label: {
                    Text("Provider: \(currentProviderDisplayName)")
                        .lineLimit(1)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(isSwitchingProvider || session.external?.providerSwitchInFlight == true)
                .accessibilityLabel(L10n("切换 Provider"))
                Text("· Agent: \(agentDisplayName)").lineLimit(1)
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
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
