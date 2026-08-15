import SwiftUI

// WorkItem 的 Workspace 单选选择器。
// WorkItem 从属于 Objective，绑定 Workspace 时从所属 Objective 已挂靠的仓库里选（不再弹文件浏览器选任意目录）。
struct WorkspacePicker: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @Binding var workspaceId: String?
    /// 候选：所属 Objective 挂靠的仓库 id 列表
    var workspaceIds: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Workspace（Git 仓库）")
                .font(.caption)
                .foregroundStyle(.secondary)
            if candidates.isEmpty {
                Text("所属 Objective 尚未挂靠仓库，请先在 Objective 中添加")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)
            } else {
                Picker("", selection: $workspaceId) {
                    Text("未选择").tag(String?.none)
                    ForEach(candidates) { repo in
                        Text(repo.name).tag(String?.some(repo.id))
                    }
                }
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onAppear {
            Task { await client.refreshRepositories() }
        }
    }

    private var candidates: [GitRepository] {
        client.repositories.filter { workspaceIds.contains($0.id) }
    }
}

// 从 Objective 的仓库里选一个绑定（执行失败弹窗「绑定 Workspace」时弹出）。
struct WorkspaceBindSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var workspaceId: String?
    let workspaceIds: [String]
    let onSave: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("绑定 Workspace")
                .font(.title3.bold())
            WorkspacePicker(workspaceId: $workspaceId, workspaceIds: workspaceIds)
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                Button("保存") {
                    onSave()
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
                .disabled(workspaceId == nil)
            }
        }
        .padding(20)
        .frame(width: 360)
    }
}
