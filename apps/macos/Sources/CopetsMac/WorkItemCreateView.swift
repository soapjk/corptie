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
    @State private var priority = "medium"
    @State private var workspaceId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("新建工作项")
                .font(.title3.bold())

            VStack(alignment: .leading, spacing: 4) {
                Text("标题 *")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("工作项标题", text: $title)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("描述")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextEditor(text: $detail)
                    .font(.body)
                    .frame(height: 70)
                    .padding(6)
                    .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
            }

            WorkspacePicker(workspaceId: $workspaceId, workspaceIds: workspaceIds)

            VStack(alignment: .leading, spacing: 4) {
                Text("优先级")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Picker("", selection: $priority) {
                    Text("低").tag("low")
                    Text("中").tag("medium")
                    Text("高").tag("high")
                }
                .labelsHidden()
                .frame(maxWidth: 160, alignment: .leading)
            }

            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("创建") {
                    create()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(trimmedTitle.isEmpty || workspaceId == nil)
            }
        }
        .padding(20)
        .frame(width: 440)
    }

    private var trimmedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func create() {
        guard !trimmedTitle.isEmpty else { return }
        Task {
            if let created = await client.createWorkItem(
                objectiveId: objectiveId,
                title: trimmedTitle,
                description: detail.isEmpty ? nil : detail,
                mainWorkspaceId: workspaceId,
                priority: priority
            ) {
                onCreated(created)
                dismiss()
            }
        }
    }
}
