import SwiftUI

// 新建工作项表单（sheet）。Workspace 为必填（执行依赖 Git 仓库），未选则「创建」置灰。
struct WorkItemCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let objectiveId: String
    let workspaceIds: [String]
    let onCreated: (WorkItem) -> Void

    @State private var title = ""
    @State private var detail = ""
    @State private var acceptanceCriteria = ""
    @State private var priority = "medium"
    @State private var workspaceId: String?
    @State private var assistAgentId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("新建工作项"))
                .font(.title3.bold())

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("标题 *"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField(L10n("工作项标题"), text: $title)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(L10n("描述 *"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    AgentAssistButton(fieldLabel: "描述", text: $detail, selectedAgentId: $assistAgentId, context: "工作项标题：\(title)")
                    Spacer()
                }
                TextEditor(text: $detail)
                    .font(.body)
                    .frame(height: 70)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Text(L10n("验收标准"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    AgentAssistButton(fieldLabel: "验收标准", text: $acceptanceCriteria, selectedAgentId: $assistAgentId, context: "工作项标题：\(title)；描述：\(detail)")
                    Spacer()
                }
                TextEditor(text: $acceptanceCriteria)
                    .font(.body)
                    .frame(height: 70)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }

            WorkspacePicker(workspaceId: $workspaceId, workspaceIds: workspaceIds)

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

            HStack {
                Spacer()
                Button(L10n("取消")) { dismiss() }
                Button(L10n("创建")) {
                    create()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(trimmedTitle.isEmpty || trimmedDetail.isEmpty || workspaceId == nil)
            }
        }
        .padding(20)
        .frame(width: 440)
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var trimmedDetail: String {
        detail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func create() {
        guard !trimmedTitle.isEmpty, !trimmedDetail.isEmpty else { return }
        Task {
            if let created = await client.createWorkItem(
                objectiveId: objectiveId,
                title: trimmedTitle,
                description: trimmedDetail,
                acceptanceCriteria: acceptanceCriteria.isEmpty ? nil : acceptanceCriteria,
                mainWorkspaceId: workspaceId,
                priority: priority
            ) {
                onCreated(created)
                dismiss()
            }
        }
    }
}
