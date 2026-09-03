import SwiftUI

enum CorptieTaskCreateFormPolicy {
    static func availableAgents(from agents: [Agent], allowedAgentIds: Set<String>) -> [Agent] {
        agents.filter {
            allowedAgentIds.contains($0.agentId)
                && $0.isIndependentContributor
                && $0.status == "available"
        }
    }

    @MainActor
    static func validationMessage(
        title: String,
        detail: String,
        agentId: String?
    ) -> String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return L10n("请输入 Task 标题。")
        }
        if detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return L10n("请输入 Task 描述。")
        }
        if agentId == nil {
            return L10n("请选择负责该 CorptieTask 的 Agent。")
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
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @Environment(\.dismiss) private var dismiss
    let workId: String
    let contributorAgentIds: [String]
    let onCreated: (CorptieTask) -> Void

    @State private var title = ""
    @State private var detail = ""
    @State private var acceptanceCriteria = ""
    @State private var priority = "medium"
    @State private var selectedAgentId: String?
    @State private var selectedProviderId = ""
    @State private var creationId = "task:\(UUID().uuidString.lowercased())"
    @State private var submissionError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("新建 Task"))
                .font(.title3.bold())

            FormAssistPanel(
                formType: .task,
                promptHint: L10n("例如：重构三个创建页，共享一键生成协议和错误处理，并补充测试。"),
                currentValues: {
                    [
                        "title": title,
                        "description": detail,
                        "acceptanceCriteria": acceptanceCriteria,
                        "priority": priority
                    ]
                },
                onApply: applyGeneratedFields
            )

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("标题 *"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField(L10n("Task 标题"), text: $title)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("描述 *"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $detail)
                    .font(.body)
                    .frame(height: 70)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("验收标准"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $acceptanceCriteria)
                    .font(.body)
                    .frame(height: 70)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }

            agentSection

            providerSection

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("优先级"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("", selection: $priority) {
                    Text(L10n("低")).tag("low")
                    Text(L10n("中")).tag("medium")
                    Text(L10n("高")).tag("high")
                }
                .labelsHidden()
                .frame(maxWidth: 160, alignment: .leading)
            }

            if let submissionError {
                Label(submissionError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }

            HStack {
                Spacer()
                Button(L10n("取消")) { dismiss() }
                Button(L10n("创建")) {
                    submit()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit || selectedProviderId.isEmpty)
            }
        }
        .padding(20)
        .frame(width: 500)
        .task {
            async let agents: Void = client.refreshAgents()
            if backendClient.agentProviders.isEmpty { await backendClient.loadProviders() }
            _ = await agents
            reconcileProviderSelection()
        }
        .onChange(of: backendClient.agentProviders) { _, _ in reconcileProviderSelection() }
    }

    private var availableAgents: [Agent] {
        CorptieTaskCreateFormPolicy.availableAgents(
            from: client.agents,
            allowedAgentIds: Set(contributorAgentIds)
        )
    }

    private var validationMessage: String? {
        CorptieTaskCreateFormPolicy.validationMessage(
            title: title,
            detail: detail,
            agentId: selectedAgentId
        )
    }

    private var canSubmit: Bool { validationMessage == nil }

    @ViewBuilder
    private var agentSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L10n("负责 Agent *"))
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker(L10n("负责 Agent"), selection: $selectedAgentId) {
                Text(L10n("请选择 Agent")).tag(String?.none)
                ForEach(availableAgents) { agent in
                    Text(agent.name).tag(String?.some(agent.agentId))
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)

            if availableAgents.isEmpty {
                Text(L10n("当前 Work 没有可用的 Independent Contributor Agent。"))
                    .font(.caption)
                    .foregroundStyle(.red)
            } else if selectedAgentId == nil {
                Text(L10n("请选择负责该 CorptieTask 的 Agent。"))
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var creatableProviders: [AgentProviderDescriptor] {
        backendClient.agentProviders.filter { $0.supports("session.create") }
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
        }
    }

    private func reconcileProviderSelection() {
        selectedProviderId = CorptieTaskCreateProviderPolicy.selection(
            current: selectedProviderId,
            preferred: backendClient.defaultSessionProviderId,
            providers: backendClient.agentProviders
        )
    }

    private func submit() {
        guard validationMessage == nil, let selectedAgentId else {
            submissionError = validationMessage ?? L10n("请选择负责该 CorptieTask 的 Agent。")
            return
        }
        guard !selectedProviderId.isEmpty else {
            submissionError = L10n("没有可创建 Work Session 的 Provider，无法创建 CorptieTask。")
            return
        }

        submissionError = nil
        let requestId = creationId
        let requestWorkId = workId
        let requestTitle = trimmedTitle
        let requestDetail = trimmedDetail
        let requestAcceptanceCriteria = acceptanceCriteria
        let requestPriority = priority
        let providerId = selectedProviderId
        let started = BackgroundTaskCenter.shared.start(
            id: requestId,
            title: L10nFormat("创建 CorptieTask：%@", requestTitle)
        ) {
            var created = await PerfStopwatch.measure("CorptieTask.create.idempotencyLookup") {
                await client.task(id: requestId)
            }
            if created == nil {
                created = await PerfStopwatch.measure("CorptieTask.create.persistRequest") {
                    await client.createCorptieTask(
                        id: requestId,
                        workId: requestWorkId,
                        title: requestTitle,
                        description: requestDetail,
                        acceptanceCriteria: requestAcceptanceCriteria.isEmpty ? nil : requestAcceptanceCriteria,
                        mainAgentId: selectedAgentId,
                        priority: requestPriority
                    )
                }
            }
            guard let task = created else {
                return .failure(client.errorMessage ?? L10n("CorptieTask 创建失败，可重试。"))
            }
            onCreated(task)

            let latest = await PerfStopwatch.measure("CorptieTask.execute.existingSessionLookup") {
                await client.task(id: task.id)
            }
            if latest?.currentSessionId != nil {
                return .success(L10nFormat("CorptieTask“%@”已创建并开始执行。", requestTitle))
            }
            let result = await PerfStopwatch.measure("CorptieTask.execute.startRequest") {
                await client.createSession(
                    taskId: task.id,
                    agentId: selectedAgentId,
                    providerId: providerId,
                    title: task.title
                )
            }
            if let session = result.session {
                backendClient.acceptCreatedSession(session, selectImmediately: false)
                return .success(L10nFormat("CorptieTask“%@”已创建并开始执行。", requestTitle))
            }
            return .failure(L10nFormat(
                "CorptieTask 已创建，但执行失败：%@。可重试执行，不会重复创建 CorptieTask。",
                result.error?.message ?? L10n("未知错误")
            ))
        }
        if started { dismiss() }
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
