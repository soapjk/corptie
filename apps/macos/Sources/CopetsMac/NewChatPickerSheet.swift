import SwiftUI

enum NewSessionKind: String, CaseIterable, Identifiable {
    case assistantChat
    case workChat
    case worker

    var id: String { rawValue }

    @MainActor var title: String {
        switch self {
        case .assistantChat: L10n("Assistant Chat")
        case .workChat: L10n("Work Chat")
        case .worker: L10n("Worker Session")
        }
    }
}

enum SessionCreationTitlePolicy {
    static func defaultTitle(
        taskTitle: String?,
        suggestedAgentTitle: String?,
        agentName: String?
    ) -> String {
        let taskTitle = taskTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !taskTitle.isEmpty { return taskTitle }
        let suggestedAgentTitle = suggestedAgentTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !suggestedAgentTitle.isEmpty { return suggestedAgentTitle }
        let agentName = agentName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return "\(agentName.isEmpty ? "Agent" : agentName)_Session"
    }
}

enum WorkerSessionBackgroundRetryDecision: Equatable {
    case create
    case alreadyCreated

    static func resolve(baselineSessionId: String?, currentSessionId: String?) -> Self {
        let baseline = normalized(baselineSessionId)
        let current = normalized(currentSessionId)
        guard let current, current != baseline else { return .create }
        return .alreadyCreated
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

/// 统一 Session 创建入口。
/// Assistant Chat 只绑定 Assistant；Work Chat 绑定 Work 与其 Contributor；
/// Worker Session 强制同时绑定 CorptieTask 与 IC Agent。
struct NewSessionCreationSheet: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @Environment(\.dismiss) private var dismiss

    let fixedAgent: Agent?
    let fixedWork: Work?
    let fixedCorptieTask: CorptieTask?
    let submitsInBackground: Bool
    var onCreated: (TaskSession) -> Void

    @State private var kind: NewSessionKind
    @State private var selectedAgentId: String?
    @State private var selectedCorptieTaskId: String?
    @State private var selectedWorkId: String?
    @State private var sessionTitle = ""
    @State private var selectedProviderId = ""
    @State private var titleWasEdited = false
    @State private var tasks: [CorptieTask] = []
    @State private var isLoadingCorptieTasks = false
    @State private var isCreating = false
    @State private var creationError: String?

    init(
        fixedAgent: Agent? = nil,
        fixedWork: Work? = nil,
        fixedCorptieTask: CorptieTask? = nil,
        submitsInBackground: Bool = false,
        onCreated: @escaping (TaskSession) -> Void = { _ in }
    ) {
        self.fixedAgent = fixedAgent
        self.fixedWork = fixedWork
        self.fixedCorptieTask = fixedCorptieTask
        self.submitsInBackground = submitsInBackground
        self.onCreated = onCreated
        _kind = State(initialValue: fixedCorptieTask != nil ? .worker : (fixedWork != nil ? .workChat : (fixedAgent?.isAssistant == false ? .worker : .assistantChat)))
        _selectedAgentId = State(initialValue: fixedAgent?.agentId)
        _selectedWorkId = State(initialValue: fixedWork?.id)
        _selectedCorptieTaskId = State(initialValue: fixedCorptieTask?.id)
        _sessionTitle = State(initialValue: SessionCreationTitlePolicy.defaultTitle(
            taskTitle: fixedCorptieTask?.title,
            suggestedAgentTitle: fixedAgent?.suggestedSessionTitle,
            agentName: fixedAgent?.name
        ))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("新建会话"))
                .font(.title3.bold())

            if fixedAgent == nil, fixedWork == nil {
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
            case .workChat:
                workSection
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
            if kind == .worker, fixedCorptieTask == nil, tasks.isEmpty {
                await loadCorptieTasks()
            }
            if kind == .workChat, client.works.isEmpty {
                await client.refreshWorks()
                if selectedWorkId == nil { selectedWorkId = client.works.first?.id }
            }
        }
        .onChange(of: selectedAgentId) { _, _ in applySuggestedTitle() }
        .onChange(of: selectedCorptieTaskId) { _, _ in applySuggestedTitle() }
        .onChange(of: selectedWorkId) { _, _ in
            if kind == .workChat { normalizeAgentSelection() }
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
            Text(L10n("Assistant Chat Session 不绑定 CorptieTask。"))
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
            Text(L10n("选择 CorptieTask"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            if let fixedCorptieTask {
                selectedRow(
                    title: fixedCorptieTask.title,
                    subtitle: fixedCorptieTask.description,
                    systemImage: "checklist"
                )
            } else if isLoadingCorptieTasks {
                ProgressView()
                    .frame(maxWidth: .infinity, minHeight: 100)
            } else if let error = client.tasksLoadError {
                ContentUnavailableView {
                    Label(L10n("CorptieTask 加载失败"), systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error)
                } actions: {
                    Button(L10n("重试")) {
                        Task { await loadCorptieTasks() }
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 120)
            } else if tasks.isEmpty {
                ContentUnavailableView(
                    L10n("暂无 CorptieTask"),
                    systemImage: "checklist",
                    description: Text(L10n("Worker Session 必须绑定一个 CorptieTask。"))
                )
                .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                List(tasks, selection: $selectedCorptieTaskId) { task in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(task.title)
                            .font(.body.weight(.medium))
                        HStack(spacing: 6) {
                            Text(task.lifecycleState)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    .tag(task.id)
                }
                .listStyle(.inset)
                .frame(minHeight: 150)
            }
        }
    }

    private func loadCorptieTasks() async {
        isLoadingCorptieTasks = true
        defer { isLoadingCorptieTasks = false }
        guard let loaded = await client.allCorptieTasks() else { return }
        tasks = loaded
        if selectedCorptieTaskId == nil {
            selectedCorptieTaskId = loaded.first?.id
        }
    }

    @ViewBuilder
    private var workSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n("选择 Work"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let fixedWork {
                selectedRow(
                    title: fixedWork.name,
                    subtitle: fixedWork.description.isEmpty ? fixedWork.status : fixedWork.description,
                    systemImage: "target"
                )
            } else if client.works.isEmpty {
                ContentUnavailableView(
                    L10n("暂无 Work"),
                    systemImage: "scope",
                    description: Text(L10n("Work Chat 必须绑定一个 Work。"))
                )
                .frame(maxWidth: .infinity, minHeight: 120)
            } else {
                List(client.works, selection: $selectedWorkId) { work in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(work.name).font(.body.weight(.medium))
                        Text(work.description.isEmpty ? work.status : work.description)
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    .tag(work.id)
                }
                .listStyle(.inset)
                .frame(minHeight: 150)
            }
        }
        if fixedAgent == nil {
            choiceSection(
                title: L10n("选择 Work Agent"),
                emptyTitle: L10n("Work 暂无可用 Agent"),
                emptyDescription: L10n("请先在 Work 详情中挂载 Independent Contributor。"),
                rows: workAgents
            ) { agent in agentChoiceRow(agent) }
        }
    }

    private var independentContributors: [Agent] {
        client.agents.filter(\.isIndependentContributor)
    }

    private var workAgents: [Agent] {
        let work = fixedWork ?? client.works.first(where: { $0.id == selectedWorkId })
        guard let work else { return [] }
        let contributorIds = Set(work.contributorAgentIds)
        return client.agents.filter { contributorIds.contains($0.agentId) }
    }

    private var canCreate: Bool {
        guard selectedAgentId != nil, !selectedProviderId.isEmpty else { return false }
        switch kind {
        case .assistantChat: return true
        case .workChat: return selectedWorkId != nil
        case .worker: return selectedCorptieTaskId != nil
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
            if let fixedWork {
                kind = .workChat
                selectedWorkId = fixedWork.id
                selectedAgentId = fixedWork.contributorAgentIds.contains(fixedAgent.agentId) ? fixedAgent.agentId : nil
            } else {
                selectedAgentId = fixedAgent.agentId
                kind = fixedAgent.isAssistant ? .assistantChat : .worker
            }
            return
        }
        let candidates: [Agent]
        switch kind {
        case .assistantChat: candidates = client.assistantAgents
        case .workChat: candidates = workAgents
        case .worker: candidates = independentContributors
        }
        if !candidates.contains(where: { $0.agentId == selectedAgentId }) {
            selectedAgentId = candidates.first?.agentId
        }
    }

    private func applySuggestedTitle() {
        guard !titleWasEdited, let agent = selectedAgent else { return }
        sessionTitle = SessionCreationTitlePolicy.defaultTitle(
            taskTitle: selectedCorptieTask?.title,
            suggestedAgentTitle: agent.suggestedSessionTitle,
            agentName: agent.name
        )
    }

    private var selectedAgent: Agent? {
        if let fixedAgent { return client.agents.first(where: { $0.agentId == fixedAgent.agentId }) ?? fixedAgent }
        return client.agents.first(where: { $0.agentId == selectedAgentId })
    }

    private var selectedCorptieTask: CorptieTask? {
        let id = fixedCorptieTask?.id ?? selectedCorptieTaskId
        return id.flatMap { selectedID in
            client.tasks.first(where: { $0.id == selectedID })
        }
            ?? fixedCorptieTask
            ?? tasks.first(where: { $0.id == selectedCorptieTaskId })
    }

    private func createSession() {
        guard let agentId = selectedAgentId, !isCreating else { return }
        let trimmedTitle = sessionTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let requestedTitle = titleWasEdited && !trimmedTitle.isEmpty ? trimmedTitle : nil
        if submitsInBackground, kind == .worker, let task = selectedCorptieTask {
            enqueueWorkerSession(
                task: task,
                agentId: agentId,
                providerId: selectedProviderId,
                title: requestedTitle
            )
            return
        }
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
            case .workChat:
                guard let workId = selectedWorkId else {
                    isCreating = false
                    return
                }
                result = await client.startWorkChat(
                    workId: workId,
                    agentId: agentId,
                    providerId: selectedProviderId,
                    title: requestedTitle
                )
            case .worker:
                guard let taskId = selectedCorptieTaskId else {
                    isCreating = false
                    return
                }
                result = await client.createSession(
                    taskId: taskId,
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

    private func enqueueWorkerSession(
        task: CorptieTask,
        agentId: String,
        providerId: String,
        title: String?
    ) {
        let baselineSessionId = task.currentSessionId
        let taskId = "task-session:\(task.id):\(baselineSessionId ?? "none")"
        let started = BackgroundTaskCenter.shared.start(
            id: taskId,
            title: L10nFormat("启动 CorptieTask：%@", task.title)
        ) {
            if let latest = await client.task(id: task.id),
               WorkerSessionBackgroundRetryDecision.resolve(
                   baselineSessionId: baselineSessionId,
                   currentSessionId: latest.currentSessionId
               ) == .alreadyCreated {
                await AppStateSyncController.shared.refreshSnapshot()
                return .success(L10nFormat("CorptieTask“%@”已开始执行。", task.title))
            }

            let result = await client.createSession(
                taskId: task.id,
                agentId: agentId,
                providerId: providerId,
                title: title
            )
            guard let session = result.session else {
                return .failure(L10nFormat(
                    "CorptieTask 会话启动失败：%@",
                    result.error?.message ?? L10n("未知错误")
                ))
            }
            backendClient.acceptCreatedSession(session, selectImmediately: false)
            onCreated(session)
            return .success(L10nFormat("CorptieTask“%@”已开始执行。", task.title))
        }
        if started || BackgroundTaskCenter.shared.records.contains(where: { $0.id == taskId }) {
            dismiss()
        }
    }

}
