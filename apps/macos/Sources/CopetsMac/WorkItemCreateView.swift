import SwiftUI

enum WorkItemCreateExecutionMode: Equatable {
    case createOnly
    case startImmediately
}

enum WorkItemCreateFormPolicy {
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
        workspaceId: String?,
        agentId: String?
    ) -> String? {
        if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return L10n("请输入工作项标题。")
        }
        if detail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return L10n("请输入工作项描述。")
        }
        if workspaceId == nil {
            return L10n("请选择 Workspace。")
        }
        if agentId == nil {
            return L10n("请选择负责该 WorkItem 的 Agent。")
        }
        return nil
    }
}

// 新建工作项表单（sheet）。Workspace 与 Agent 均为必填；创建和执行使用独立操作。
struct WorkItemCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @Environment(\.dismiss) private var dismiss
    let objectiveId: String
    let workspaceIds: [String]
    let contributorAgentIds: [String]
    let onCreated: (WorkItem) -> Void

    @State private var title = ""
    @State private var detail = ""
    @State private var acceptanceCriteria = ""
    @State private var priority = "medium"
    @State private var workspaceId: String?
    @State private var selectedAgentId: String?
    @State private var creationId = "work_item:\(UUID().uuidString.lowercased())"
    @State private var submissionError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("新建工作项"))
                .font(.title3.bold())

            FormAssistPanel(
                formType: .workItem,
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
                TextField(L10n("工作项标题"), text: $title)
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

            WorkspacePicker(workspaceId: $workspaceId, workspaceIds: workspaceIds)

            agentSection

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
                Button(L10n("仅创建不执行")) {
                    submit(.createOnly)
                }
                .disabled(!canSubmit)
                Button(L10n("创建后立即执行")) {
                    submit(.startImmediately)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit)
            }
        }
        .padding(20)
        .frame(width: 500)
        .task {
            async let agents: Void = client.refreshAgents()
            if backendClient.agentProviders.isEmpty { await backendClient.loadProviders() }
            _ = await agents
        }
    }

    private var availableAgents: [Agent] {
        WorkItemCreateFormPolicy.availableAgents(
            from: client.agents,
            allowedAgentIds: Set(contributorAgentIds)
        )
    }

    private var validationMessage: String? {
        WorkItemCreateFormPolicy.validationMessage(
            title: title,
            detail: detail,
            workspaceId: workspaceId,
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
                Text(L10n("当前 Objective 没有可用的 Independent Contributor Agent。"))
                    .font(.caption)
                    .foregroundStyle(.red)
            } else if selectedAgentId == nil {
                Text(L10n("请选择负责该 WorkItem 的 Agent。"))
                    .font(.caption)
                    .foregroundStyle(.red)
            }
        }
    }

    private var defaultProviderId: String? {
        let providers = backendClient.agentProviders.filter { $0.supports("session.create") }
        if let preferred = backendClient.defaultSessionProviderId,
           providers.contains(where: { $0.id == preferred }) {
            return preferred
        }
        return providers.first?.id
    }

    private func submit(_ mode: WorkItemCreateExecutionMode) {
        guard validationMessage == nil, let selectedAgentId else {
            submissionError = validationMessage ?? L10n("请选择负责该 WorkItem 的 Agent。")
            return
        }
        if mode == .startImmediately, defaultProviderId == nil {
            submissionError = L10n("没有可创建 Session 的 Provider，无法立即执行。")
            return
        }

        submissionError = nil
        let requestId = creationId
        let requestObjectiveId = objectiveId
        let requestTitle = trimmedTitle
        let requestDetail = trimmedDetail
        let requestAcceptanceCriteria = acceptanceCriteria
        let requestWorkspaceId = workspaceId
        let requestPriority = priority
        let providerId = defaultProviderId
        let started = BackgroundTaskCenter.shared.start(
            id: requestId,
            title: L10nFormat("创建 WorkItem：%@", requestTitle)
        ) {
            var created = await client.workItem(id: requestId)
            if created == nil {
                created = await client.createWorkItem(
                    id: requestId,
                    objectiveId: requestObjectiveId,
                    title: requestTitle,
                    description: requestDetail,
                    acceptanceCriteria: requestAcceptanceCriteria.isEmpty ? nil : requestAcceptanceCriteria,
                    mainWorkspaceId: requestWorkspaceId,
                    mainAgentId: selectedAgentId,
                    priority: requestPriority
                )
            }
            guard let workItem = created else {
                return .failure(client.errorMessage ?? L10n("WorkItem 创建失败，可重试。"))
            }
            onCreated(workItem)

            guard mode == .startImmediately else {
                return .success(L10nFormat("WorkItem“%@”已创建。", requestTitle))
            }
            guard let providerId else {
                return .failure(L10n("WorkItem 已创建，但没有可创建 Session 的 Provider；配置 Provider 后可重试执行。"))
            }
            if let latest = await client.workItem(id: workItem.id),
               latest.currentSessionId != nil {
                return .success(L10nFormat("WorkItem“%@”已创建并开始执行。", requestTitle))
            }
            let result = await client.createSession(
                workItemId: workItem.id,
                agentId: selectedAgentId,
                providerId: providerId,
                title: workItem.title
            )
            if let session = result.session {
                backendClient.acceptCreatedSession(session, selectImmediately: false)
                return .success(L10nFormat("WorkItem“%@”已创建并开始执行。", requestTitle))
            }
            return .failure(L10nFormat(
                "WorkItem 已创建，但执行失败：%@。可重试执行，不会重复创建 WorkItem。",
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
