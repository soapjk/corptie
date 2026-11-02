import SwiftUI
import CorptieClientCore

enum CorptieTaskCreateFormPolicy {
    static func availableAgents(from roles: [Role], allowedAgentIds: Set<String>) -> [Role] {
        roles.filter {
            allowedAgentIds.contains($0.roleId)
                && $0.status == "available"
        }
    }

    @MainActor
    static func validationMessage(
        title: String,
        detail: String,
        workId: String?,
        roleId: String?
    ) -> String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return L10n("请输入 Task 标题。")
        }
        if !EntityNamePolicy.isValid(title) {
            return EntityNamePolicy.validationMessage
        }
        if detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return L10n("请输入 Task 描述。")
        }
        if workId == nil {
            return L10n("请选择 Work。")
        }
        if roleId == nil {
            return L10n("请选择负责该 CorptieTask 的角色。")
        }
        return nil
    }
}

enum CorptieTaskCreateProviderPolicy {
    static func selection(
        current: String,
        preferred: String?,
        providers: [AgentProviderDescriptor]
    ) -> String {
        let creatable = providers.filter { $0.supports("session.create") }
        if creatable.contains(where: { $0.id == current }) { return current }
        if let preferred, creatable.contains(where: { $0.id == preferred }) { return preferred }
        return creatable.first?.id ?? ""
    }
}

// 新建 Task 表单（sheet）。Task 与 Work Session 伴生，创建成功后立即启动其 Session。
struct CorptieTaskCreateView: View {
    @ObservedObject private var modelCatalog = BackendClient.shared.modelCatalog
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @Environment(\.dismiss) private var dismiss
    let initialWorkId: String?
    let onCreated: (CorptieTask) -> Void

    @State private var title = ""
    @State private var detail = ""
    @State private var acceptanceCriteria = ""
    @State private var priority = "medium"
    @State private var selectedWorkId: String?
    @State private var selectedRoleId: String?
    @State private var selectedProviderId = ""
    @State private var selectedModelId = ""
    @State private var selectedReasoningLevel = ""
    @State private var models: [CodexModel] = []
    @State private var modelProviderId = ""
    @State private var modelLoading = false
    @State private var modelError: String?
    @State private var defaultReasoningLevel: String?
    @State private var creationId = "task:\(UUID().uuidString.lowercased())"
    @State private var submissionError: String?
    @State private var isSubmitting = false
    @State private var showsAdvanced = false
    @State private var taskDefaults = TaskCreationDefaults()
    @State private var defaultsLoaded = false
    @State private var parentTaskId: String?
    private var parentChoices: [CorptieTask] {
        client.tasks.filter { $0.workId == selectedWorkId && $0.hierarchy?.canCreateChild == true }
    }

    init(initialWorkId: String? = nil, parentTaskId: String? = nil, onCreated: @escaping (CorptieTask) -> Void) {
        self.initialWorkId = initialWorkId
        self.onCreated = onCreated
        _selectedWorkId = State(initialValue: initialWorkId)
        _parentTaskId = State(initialValue:parentTaskId)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(L10n("新建 Task")).font(.title3.bold())
                Spacer()
            }.padding(20)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    FormAssistPanel(
                        formType: .task,
                        promptHint: L10n("例如：重构三个创建页，共享一键生成协议和错误处理，并补充测试。"),
                        currentValues: {
                            ["title": title, "description": detail,
                             "acceptanceCriteria": acceptanceCriteria, "priority": priority]
                        }, onApply: applyGeneratedFields)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L10n("标题 *")).font(.caption).foregroundStyle(.secondary)
                        TextField(L10n("Task 标题"), text: $title)
                        EntityNameValidationMessage(value: title)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L10n("描述 *")).font(.caption).foregroundStyle(.secondary)
                        TextEditor(text: $detail).font(.body).frame(height: 90).padding(6)
                            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                    }
                    workSection
                    agentSection
                    if let parentTaskId, let parent = parentChoices.first(where: { $0.id == parentTaskId }) {
                        Label(parent.title, systemImage: "arrow.turn.down.right").font(.callout)
                    }
                    DisclosureGroup(L10n("验收标准")) {
                        TextEditor(text: $acceptanceCriteria).font(.body).frame(height: 70).padding(6)
                            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
                    }
                    DisclosureGroup(L10n("执行配置与更多选项"), isExpanded: $showsAdvanced) {
                        VStack(alignment: .leading, spacing: 16) {
                            providerSection
                            if !parentChoices.isEmpty {
                                Picker(L10n("父任务"), selection: $parentTaskId) {
                                    Text(L10n("独立 Task")).tag(String?.none)
                                    ForEach(parentChoices) { Text($0.title).tag(Optional($0.id)) }
                                }
                            }
                            Picker(L10n("优先级"), selection: $priority) {
                                Text(L10n("低")).tag("low")
                                Text(L10n("中")).tag("medium")
                                Text(L10n("高")).tag("high")
                            }
                        }.padding(.top, 10)
                    }
                    if !showsAdvanced {
                        Text("\(L10n("执行配置"))：\(selectedProvider?.displayName ?? L10n(defaultsLoaded ? "无可用执行引擎，请检查设置" : "加载中…")) · \(selectedModelId.isEmpty ? L10n("默认模型") : selectedModelId)")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(20).disabled(isSubmitting)
            }
            Divider()
            VStack(alignment: .leading, spacing: 10) {
                if let submissionError {
                    Label(submissionError, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout).foregroundStyle(.red).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    if isSubmitting { ProgressView().controlSize(.small) }
                    Spacer()
                    Button(L10n("取消")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(isSubmitting)
                    Button(L10n(isSubmitting ? "正在创建…" : "创建并启动")) { submit() }
                        .keyboardShortcut(.defaultAction)
                        .disabled(isSubmitting || !defaultsLoaded || selectedProviderId.isEmpty || modelLoading)
                }
            }.padding(16)
        }
        .frame(width: 520)
        .frame(minHeight: 420, idealHeight: 660, maxHeight: 740)
        .interactiveDismissDisabled(isSubmitting)
        .task {
            async let roles: Void = client.refreshRoles()
            async let works: Void = client.refreshWorks()
            if modelCatalog.agentProviders.isEmpty { await backendClient.loadProviders() }
            _ = await (roles, works)
            if let settings = try? await ProviderSettingsAPI.readTaskDefaults() {
                taskDefaults = settings.value
            }
            defaultsLoaded = true
            reconcileWorkSelection()
            reconcileProviderSelection()
        }
        .onChange(of: client.works) { _, _ in reconcileWorkSelection() }
        .onChange(of: selectedWorkId) { _, _ in reconcileAgentSelection(); parentTaskId=nil }
        .onChange(of: modelCatalog.agentProviders) { _, _ in reconcileProviderSelection() }
        .task(id: selectedProviderId) { await loadModelChoices() }
        .task(id: selectedWorkId) {
            if let selectedWorkId { await client.loadTaskParentChoices(workID:selectedWorkId) }
        }
        .onChange(of: selectedModelId) { _, _ in reconcileReasoning() }
    }

    private var availableWorks: [Work] {
        client.works.sorted { lhs, rhs in
            lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private var selectedWork: Work? {
        guard let selectedWorkId else { return nil }
        return client.works.first(where: { $0.id == selectedWorkId })
    }

    private var availableAgents: [Role] {
        CorptieTaskCreateFormPolicy.availableAgents(
            from: client.roles,
            allowedAgentIds: Set(selectedWork?.contributorRoleIds ?? [])
        )
    }

    private var validationMessage: String? {
        CorptieTaskCreateFormPolicy.validationMessage(
            title: title,
            detail: detail,
            workId: selectedWorkId,
            roleId: selectedRoleId
        )
    }

    private var canSubmit: Bool {
        guard validationMessage == nil, defaultsLoaded, selectedProvider != nil else { return false }
        if let parentTaskId {
            guard let parent = parentChoices.first(where: { $0.id == parentTaskId }),
                  parent.resourceVersion > 0 else { return false }
        }
        if !selectedModelId.isEmpty && modelProviderId == selectedProviderId {
            guard let model = models.first(where: { $0.id == selectedModelId }) else { return false }
            if !selectedReasoningLevel.isEmpty,
               !(model.reasoningLevels ?? []).contains(selectedReasoningLevel) { return false }
        }
        return true
    }

    private var workSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L10n("Work *"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker(L10n("Work"), selection: $selectedWorkId) {
                Text(L10n("请选择 Work")).tag(String?.none)
                ForEach(availableWorks) { work in
                    Text(work.name).tag(String?.some(work.id))
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)

            if defaultsLoaded && availableWorks.isEmpty {
                Text(L10n("当前没有可用的 Work。"))
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private var agentSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L10n("负责角色 *"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker(L10n("负责角色"), selection: $selectedRoleId) {
                Text(L10n("请选择角色")).tag(String?.none)
                ForEach(availableAgents) { agent in
                    Text(agent.name).tag(String?.some(agent.roleId))
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)

            if defaultsLoaded && selectedWorkId != nil && availableAgents.isEmpty {
                Text(L10n("当前 Work 没有可用角色，请先在 Work 详情中添加角色。"))
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var creatableProviders: [AgentProviderDescriptor] {
        modelCatalog.agentProviders.filter { $0.supports("session.create") }
    }

    private var providerSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L10n("执行 Provider"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker(L10n("Provider"), selection: $selectedProviderId) {
                ForEach(creatableProviders) { provider in
                    Text(provider.displayName).tag(provider.id)
                }
                if !selectedProviderId.isEmpty, selectedProvider == nil {
                    Text("\(selectedProviderId)（不可用）").tag(selectedProviderId)
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)

            if creatableProviders.isEmpty {
                Text(L10n("没有可创建 Work Session 的 Provider，暂时无法创建 CorptieTask。"))
                    .font(.caption)
                    .foregroundStyle(.red)
            } else {
                Text(L10n("创建 CorptieTask 后会立即创建并启动其伴生 Work Session。"))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if modelLoading {
                ProgressView("加载模型…").controlSize(.small)
            } else if modelProviderId == selectedProviderId, !models.isEmpty {
                Picker("模型", selection: $selectedModelId) {
                    Text("Provider 默认").tag("")
                    ForEach(models) { Text($0.name).tag($0.id) }
                    if !selectedModelId.isEmpty, !models.contains(where: { $0.id == selectedModelId }) {
                        Text("\(selectedModelId)（不可用）").tag(selectedModelId)
                    }
                }
                if selectedProvider?.supports("configuration.reasoning.switch") == true,
                   let levels = models.first(where: { $0.id == selectedModelId })?.reasoningLevels, !levels.isEmpty {
                    Picker("推理强度", selection: $selectedReasoningLevel) {
                        Text("模型默认").tag("")
                        ForEach(levels, id: \.self) { Text($0).tag($0) }
                        if !selectedReasoningLevel.isEmpty, !levels.contains(selectedReasoningLevel) {
                            Text("\(selectedReasoningLevel)（不可用）").tag(selectedReasoningLevel)
                        }
                    }
                }
            }
            if let modelError {
                Text(modelError).font(.caption).foregroundStyle(.secondary)
                Button("重试加载模型") { Task { await loadModelChoices() } }
            }
        }
    }

    private var selectedProvider: AgentProviderDescriptor? {
        creatableProviders.first { $0.id == selectedProviderId }
    }

    private func loadModelChoices() async {
        let provider = selectedProviderId
        models = []; selectedModelId = ""; selectedReasoningLevel = ""
        defaultReasoningLevel = nil; modelProviderId = ""; modelError = nil
        modelLoading = false
        guard selectedProvider?.supports("configuration.model.list") == true else { return }
        modelLoading = true
        do {
            let url = CorptieAppEnvironment.backendBaseURL.appending(path: "providers/\(provider)/models")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let result = try JSONDecoder().decode(CodexModelsResponse.self, from: data)
            guard !Task.isCancelled, selectedProviderId == provider else { return }
            models = result.models
            modelProviderId = provider
            defaultReasoningLevel = result.currentReasoningLevel
            selectedModelId = (taskDefaults.providerId == provider ? taskDefaults.model : nil)
                ?? NewSessionModelSelection.preferredModelId(savedModelId: nil,
                providerDefaultModelId: result.currentModel, models: models)
            reconcileReasoning()
            modelLoading = false
        } catch {
            guard !Task.isCancelled, selectedProviderId == provider else { return }
            modelLoading = false
            modelError = "模型列表暂不可用；可重试，或使用 Provider 默认配置创建。"
        }
    }

    private func reconcileReasoning() {
        let model = models.first { $0.id == selectedModelId }
        guard selectedProvider?.supports("configuration.reasoning.switch") == true,
              !(model?.reasoningLevels?.isEmpty ?? true) else { selectedReasoningLevel = ""; return }
        selectedReasoningLevel = (taskDefaults.providerId == selectedProviderId && taskDefaults.model == selectedModelId ? taskDefaults.reasoningLevel : nil)
            ?? NewSessionModelSelection.preferredReasoningLevel(savedReasoningLevel: nil,
            providerDefaultReasoningLevel: defaultReasoningLevel, model: model)
    }

    private func reconcileProviderSelection() {
        guard defaultsLoaded else { return }
        if selectedProviderId.isEmpty, let configured = taskDefaults.providerId {
            selectedProviderId = configured
            return
        }
        if selectedProviderId == taskDefaults.providerId { return }
        selectedProviderId = CorptieTaskCreateProviderPolicy.selection(
            current: selectedProviderId,
            preferred: taskDefaults.providerId ?? modelCatalog.defaultSessionProviderId,
            providers: modelCatalog.agentProviders
        )
    }

    private func reconcileWorkSelection() {
        guard !availableWorks.isEmpty else { return }
        if let selectedWorkId,
           availableWorks.contains(where: { $0.id == selectedWorkId }) {
            return
        }
        selectedWorkId = availableWorks.first(where: { $0.id == initialWorkId })?.id
            ?? availableWorks.first?.id
    }

    private func reconcileAgentSelection() {
        if let selectedRoleId,
           availableAgents.contains(where: { $0.roleId == selectedRoleId }) {
            return
        }
        selectedRoleId = nil
    }

    private func submit() {
        guard !isSubmitting else { return }
        guard canSubmit else {
            submissionError = validationMessage ?? L10n("执行配置尚未就绪，请检查后重试。")
            return
        }
        guard validationMessage == nil,
              let selectedWorkId,
              let selectedRoleId else {
            submissionError = validationMessage ?? L10n("请选择负责该 CorptieTask 的角色。")
            return
        }
        guard !selectedProviderId.isEmpty else {
            submissionError = L10n("没有可创建 Work Session 的 Provider，无法创建 CorptieTask。")
            return
        }

        submissionError = nil
        let requestId = creationId
        let requestWorkId = selectedWorkId
        let requestTitle = trimmedTitle
        let requestDetail = trimmedDetail
        let requestAcceptanceCriteria = acceptanceCriteria
        let requestPriority = priority
        let parent=parentChoices.first{$0.id == parentTaskId}
        guard parentTaskId == nil || (parent != nil && parent?.resourceVersion != nil) else {
            submissionError = L10n("父任务已变化，请重新选择父任务。")
            return
        }
        let providerId = selectedProviderId
        let model = modelProviderId == providerId ? selectedModelId : ""
        let reasoningLevel = modelProviderId == providerId ? selectedReasoningLevel : ""
        // Keep the existing app-wide operation ownership and stable request ID,
        // while retaining this sheet until success so a failure keeps its draft.
        BackgroundTaskCenter.shared.dismiss(id: requestId)
        isSubmitting = true
        let started = BackgroundTaskCenter.shared.start(id: requestId,
            title: L10nFormat("创建 CorptieTask：%@", requestTitle)) {
            isSubmitting = true
            defer { isSubmitting = false }
            let created = await PerfStopwatch.measure("CorptieTask.create.request") {
                await client.createCorptieTask(
                    id: requestId,
                    workId: requestWorkId,
                    title: requestTitle,
                    description: requestDetail,
                    acceptanceCriteria: requestAcceptanceCriteria.isEmpty ? nil : requestAcceptanceCriteria,
                    mainRoleId: selectedRoleId,
                    priority: requestPriority,
                    providerId: providerId,
                    model: model.isEmpty ? nil : model,
                    reasoningLevel: reasoningLevel.isEmpty ? nil : reasoningLevel,
                    parentTaskId:parent?.id,expectedParentResourceVersion:parent?.resourceVersion
                )
            }
            guard let task = created else {
                submissionError = client.errorMessage ?? L10n("CorptieTask 创建失败，可重试。")
                return .failure(submissionError ?? L10n("CorptieTask 创建失败，可重试。"))
            }

            onCreated(task)
            dismiss()
            return .success(L10nFormat("CorptieTask“%@”已创建。发送第一条消息后开始执行。", requestTitle))
        }
        if !started { isSubmitting = false }
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedDetail: String {
        detail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func applyGeneratedFields(_ fields: [String: String]) {
        title = fields["title"] ?? title
        detail = fields["description"] ?? detail
        acceptanceCriteria = fields["acceptanceCriteria"] ?? acceptanceCriteria
        priority = fields["priority"] ?? priority
    }
}
