import SwiftUI

enum NewSessionKind: String, CaseIterable, Identifiable {
    case assistantChat
    case objectiveChat
    case worker

    var id: String { rawValue }

    @MainActor var title: String {
        switch self {
        case .assistantChat: L10n("Assistant Chat")
        case .objectiveChat: L10n("Objective Chat")
        case .worker: L10n("Worker Session")
        }
    }
}

enum SessionCreationTitlePolicy {
    static func defaultTitle(
        workItemTitle: String?,
        suggestedAgentTitle: String?,
        agentName: String?
    ) -> String {
        let workItemTitle = workItemTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !workItemTitle.isEmpty { return workItemTitle }
        let suggestedAgentTitle = suggestedAgentTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !suggestedAgentTitle.isEmpty { return suggestedAgentTitle }
        let agentName = agentName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return "\(agentName.isEmpty ? "Agent" : agentName)_Session"
    }
}

/// 统一 Session 创建入口。
/// Assistant Chat 只绑定 Assistant；Objective Chat 绑定 Objective 与其 Contributor；
/// Worker Session 强制同时绑定 WorkItem 与 IC Agent。
struct NewSessionCreationSheet: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @Environment(\.dismiss) private var dismiss

    let fixedAgent: Agent?
    let fixedObjective: Objective?
    let fixedWorkItem: WorkItem?
    var onCreated: (TaskSession) -> Void

    @State private var kind: NewSessionKind
    @State private var selectedAgentId: String?
    @State private var selectedWorkItemId: String?
    @State private var selectedObjectiveId: String?
    @State private var sessionTitle = ""
    @State private var selectedProviderId = ""
    @State private var titleWasEdited = false
    @State private var workItems: [WorkItem] = []
    @State private var isLoadingWorkItems = false
    @State private var isCreating = false
    @State private var creationError: String?

    init(
        fixedAgent: Agent? = nil,
        fixedObjective: Objective? = nil,
        fixedWorkItem: WorkItem? = nil,
        onCreated: @escaping (TaskSession) -> Void = { _ in }
    ) {
        self.fixedAgent = fixedAgent
        self.fixedObjective = fixedObjective
        self.fixedWorkItem = fixedWorkItem
        self.onCreated = onCreated
        _kind = State(initialValue: fixedWorkItem != nil ? .worker : (fixedObjective != nil ? .objectiveChat : (fixedAgent?.isAssistant == false ? .worker : .assistantChat)))
        _selectedAgentId = State(initialValue: fixedAgent?.agentId)
        _selectedObjectiveId = State(initialValue: fixedObjective?.id)
        _selectedWorkItemId = State(initialValue: fixedWorkItem?.id)
        _sessionTitle = State(initialValue: SessionCreationTitlePolicy.defaultTitle(
            workItemTitle: fixedWorkItem?.title,
            suggestedAgentTitle: fixedAgent?.suggestedSessionTitle,
            agentName: fixedAgent?.name
        ))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("新建会话"))
                .font(.title3.bold())

            if fixedAgent == nil, fixedObjective == nil {
                Picker(L10n("会话类型"), selection: $kind) {
                    ForEach(NewSessionKind.allCases) { option in
                        Text(option.title).tag(option)
                    }
                }
                .pickerStyle(.segmented)
            } else if let fixedAgent {
                selectedRow(
                    title: fixedAgent.name,
                    subtitle: fixedAgent.isAssistant ? L10n("Assistant") : L10n("Independent Contributor"),
                    systemImage: fixedAgent.isAssistant ? "sparkles" : "person.fill"
                )
            }

            sessionIdentitySection
            providerSection

            switch kind {
            case .assistantChat:
                assistantSection
            case .objectiveChat:
                objectiveSection
            case .worker:
                workerSection
            }

            Spacer(minLength: 0)
            Divider()

            HStack(spacing: 12) {
                if let creationError {
                    Text(creationError)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(3)
                }
                Spacer()
                Button(L10n("取消")) { dismiss() }
                    .disabled(isCreating)
                Button {
                    createSession()
                } label: {
                    if isCreating {
                        ProgressView().controlSize(.small)
                    } else {
                        Text(L10n("创建"))
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canCreate || isCreating)
            }
        }
        .padding(20)
        .frame(width: 500, height: 620)
        .task {
            async let agents: Void = client.refreshAgents()
            if backendClient.agentProviders.isEmpty { await backendClient.loadProviders() }
            _ = await agents
            reconcileProviderSelection()
            normalizeAgentSelection()
            applySuggestedTitle()
        }
        .task(id: kind) {
            creationError = nil
            normalizeAgentSelection()
            if kind == .worker, fixedWorkItem == nil, workItems.isEmpty {
                await loadWorkItems()
            }
            if kind == .objectiveChat, client.objectives.isEmpty {
                await client.refreshObjectives()
                if selectedObjectiveId == nil { selectedObjectiveId = client.objectives.first?.id }
            }
        }
        .onChange(of: selectedAgentId) { _, _ in applySuggestedTitle() }
        .onChange(of: selectedWorkItemId) { _, _ in applySuggestedTitle() }
        .onChange(of: selectedObjectiveId) { _, _ in
            if kind == .objectiveChat { normalizeAgentSelection() }
        }
        .onChange(of: backendClient.agentProviders) { _, _ in reconcileProviderSelection() }
    }

    private var sessionIdentitySection: some View {
        TextField(L10n("会话名称"), text: Binding(
            get: { sessionTitle },
            set: {
                sessionTitle = $0
                titleWasEdited = true
            }
        ))
            .textFieldStyle(.roundedBorder)
    }

    private var providerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n("Provider"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Picker(L10n("Provider"), selection: $selectedProviderId) {
                ForEach(creatableProviders) { provider in
                    Text(provider.displayName).tag(provider.id)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
            if creatableProviders.isEmpty {
                Text(L10n("没有可创建 Session 的 Provider。"))
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private var assistantSection: some View {
        if fixedAgent == nil {
            choiceSection(
                title: L10n("选择 Assistant"),
                emptyTitle: L10n("暂无可用 Assistant"),
                emptyDescription: L10n("请先在 Agent 管理页创建 Assistant。"),
                rows: client.assistantAgents
            ) { agent in
                agentChoiceRow(agent)
            }
        } else {
            Text(L10n("Assistant Chat Session 不绑定 WorkItem。"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var workerSection: some View {
        if fixedAgent == nil {
            choiceSection(
                title: L10n("选择 Independent Contributor"),
                emptyTitle: L10n("暂无可用 Independent Contributor"),
                emptyDescription: L10n("请先在 Agent 管理页创建 Independent Contributor。"),
                rows: independentContributors
            ) { agent in
                agentChoiceRow(agent)
            }
        }

        VStack(alignment: .leading, spacing: 8) {
            Text(L10n("选择 WorkItem"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            if let fixedWorkItem {
                selectedRow(
                    title: fixedWorkItem.title,
                    subtitle: fixedWorkItem.description,
                    systemImage: "checklist"
                )
            } else if isLoadingWorkItems {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 100)
            } else if let error = client.workItemsLoadError {
                ContentUnavailableView {
                    Label(L10n("WorkItem 加载失败"), systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button(L10n("重试")) {
                        Task { await loadWorkItems() }
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 120)
            } else if workItems.isEmpty {
                ContentUnavailableView(
                    L10n("暂无 WorkItem"),
                    systemImage: "checklist",
                    description: Text(L10n("Worker Session 必须绑定一个 WorkItem。"))
                )
                .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                List(workItems, selection: $selectedWorkItemId) { workItem in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(workItem.title)
                            .font(.body.weight(.medium))
                        HStack(spacing: 6) {
                            Text(workItem.status)
                            if workItem.mainWorkspaceId == nil {
                                Text(L10n("未绑定 Workspace"))
                                    .foregroundStyle(.orange)
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .tag(workItem.id)
                }
                .listStyle(.inset)
                .frame(minHeight: 150)
            }
        }
    }

    private func loadWorkItems() async {
        isLoadingWorkItems = true
        defer { isLoadingWorkItems = false }
        guard let loaded = await client.allWorkItems() else { return }
        workItems = loaded
        if selectedWorkItemId == nil {
            selectedWorkItemId = loaded.first?.id
        }
    }

    @ViewBuilder
    private var objectiveSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n("选择 Objective"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let fixedObjective {
                selectedRow(
                    title: fixedObjective.name,
                    subtitle: fixedObjective.description.isEmpty ? fixedObjective.status : fixedObjective.description,
                    systemImage: "target"
                )
            } else if client.objectives.isEmpty {
                ContentUnavailableView(
                    L10n("暂无 Objective"),
                    systemImage: "scope",
                    description: Text(L10n("Objective Chat 必须绑定一个 Objective。"))
                )
                .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                List(client.objectives, selection: $selectedObjectiveId) { objective in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(objective.name).font(.body.weight(.medium))
                        Text(objective.description.isEmpty ? objective.status : objective.description)
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    .tag(objective.id)
                }
                .listStyle(.inset)
                .frame(minHeight: 150)
            }
        }
        if fixedAgent == nil {
            choiceSection(
                title: L10n("选择 Objective Agent"),
                emptyTitle: L10n("Objective 暂无可用 Agent"),
                emptyDescription: L10n("请先在 Objective 详情中挂载 Independent Contributor。"),
                rows: objectiveAgents
            ) { agent in agentChoiceRow(agent) }
        }
    }

    private var independentContributors: [Agent] {
        client.agents.filter(\.isIndependentContributor)
    }

    private var objectiveAgents: [Agent] {
        let objective = fixedObjective ?? client.objectives.first(where: { $0.id == selectedObjectiveId })
        guard let objective else { return [] }
        let contributorIds = Set(objective.contributorAgentIds)
        return client.agents.filter { contributorIds.contains($0.agentId) }
    }

    private var canCreate: Bool {
        guard selectedAgentId != nil, !selectedProviderId.isEmpty else { return false }
        switch kind {
        case .assistantChat: return true
        case .objectiveChat: return selectedObjectiveId != nil
        case .worker: return selectedWorkItemId != nil
        }
    }

    private var creatableProviders: [AgentProviderDescriptor] {
        backendClient.agentProviders.filter { $0.supports("session.create") }
    }

    private func reconcileProviderSelection() {
        guard !creatableProviders.contains(where: { $0.id == selectedProviderId }) else { return }
        if let preferred = backendClient.defaultSessionProviderId,
           creatableProviders.contains(where: { $0.id == preferred }) {
            selectedProviderId = preferred
        } else {
            selectedProviderId = creatableProviders.first?.id ?? ""
        }
    }

    @ViewBuilder
    private func choiceSection<Row: View>(
        title: String,
        emptyTitle: String,
        emptyDescription: String,
        rows: [Agent],
        @ViewBuilder row: @escaping (Agent) -> Row
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if rows.isEmpty {
                ContentUnavailableView(
                    emptyTitle,
                    systemImage: "person.crop.circle.badge.exclamationmark",
                    description: Text(emptyDescription)
                )
                .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                List(rows, selection: $selectedAgentId) { agent in
                    row(agent).tag(agent.agentId)
                }
                .listStyle(.inset)
                .frame(minHeight: 150)
            }
        }
    }

    private func agentChoiceRow(_ agent: Agent) -> some View {
        HStack(spacing: 10) {
            Image(systemName: agent.isAssistant ? "sparkles" : "person.fill")
                .foregroundStyle(agent.isAssistant ? Color.accentColor : Color.blue)
                .frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(agent.name).font(.body.weight(.medium))
                if !agent.description.isEmpty {
                    Text(agent.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }

    private func selectedRow(title: String, subtitle: String, systemImage: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage).foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 10))
    }

    private func normalizeAgentSelection() {
        if let fixedAgent {
            if let fixedObjective {
                kind = .objectiveChat
                selectedObjectiveId = fixedObjective.id
                selectedAgentId = fixedObjective.contributorAgentIds.contains(fixedAgent.agentId) ? fixedAgent.agentId : nil
            } else {
                selectedAgentId = fixedAgent.agentId
                kind = fixedAgent.isAssistant ? .assistantChat : .worker
            }
            return
        }
        let candidates: [Agent]
        switch kind {
        case .assistantChat: candidates = client.assistantAgents
        case .objectiveChat: candidates = objectiveAgents
        case .worker: candidates = independentContributors
        }
        if !candidates.contains(where: { $0.agentId == selectedAgentId }) {
            selectedAgentId = candidates.first?.agentId
        }
    }

    private func applySuggestedTitle() {
        guard !titleWasEdited, let agent = selectedAgent else { return }
        sessionTitle = SessionCreationTitlePolicy.defaultTitle(
            workItemTitle: selectedWorkItem?.title,
            suggestedAgentTitle: agent.suggestedSessionTitle,
            agentName: agent.name
        )
    }

    private var selectedAgent: Agent? {
        if let fixedAgent { return client.agents.first(where: { $0.agentId == fixedAgent.agentId }) ?? fixedAgent }
        return client.agents.first(where: { $0.agentId == selectedAgentId })
    }

    private var selectedWorkItem: WorkItem? {
        fixedWorkItem ?? workItems.first(where: { $0.id == selectedWorkItemId })
    }

    private func createSession() {
        guard let agentId = selectedAgentId, !isCreating else { return }
        let trimmedTitle = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedTitle = titleWasEdited && !trimmedTitle.isEmpty ? trimmedTitle : nil
        isCreating = true
        creationError = nil
        Task {
            let result: EntitySessionLaunchResult
            switch kind {
            case .assistantChat:
                result = await client.startAgentSession(
                    agentId: agentId,
                    providerId: selectedProviderId,
                    title: requestedTitle
                )
            case .objectiveChat:
                guard let objectiveId = selectedObjectiveId else {
                    isCreating = false
                    return
                }
                result = await client.startObjectiveChat(
                    objectiveId: objectiveId,
                    agentId: agentId,
                    providerId: selectedProviderId,
                    title: requestedTitle
                )
            case .worker:
                guard let workItemId = selectedWorkItemId else {
                    isCreating = false
                    return
                }
                result = await client.createSession(
                    workItemId: workItemId,
                    agentId: agentId,
                    providerId: selectedProviderId,
                    title: requestedTitle
                )
            }
            isCreating = false
            if let session = result.session {
                backendClient.acceptCreatedSession(session)
                onCreated(session)
                dismiss()
            } else {
                creationError = result.error?.message ?? L10n("创建会话失败")
            }
        }
    }

}
