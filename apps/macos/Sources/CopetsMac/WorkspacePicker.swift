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
            Text(L10n("Workspace（Git 仓库）"))
                .font(.caption)
                .foregroundStyle(.secondary)
            if candidates.isEmpty {
                Text(L10n("所属 Objective 尚未挂靠仓库，请先在 Objective 中添加"))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, 2)
            } else {
                Picker("", selection: $workspaceId) {
                    Text(L10n("未选择")).tag(String?.none)
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
    let onSave: () async -> Bool
    @State private var isSaving = false
    @State private var saveError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("绑定 Workspace"))
                .font(.title3.bold())
            WorkspacePicker(workspaceId: $workspaceId, workspaceIds: workspaceIds)
            if let saveError {
                Text(saveError).font(.caption).foregroundStyle(.red)
            }
            HStack {
                if isSaving { ProgressView().controlSize(.small) }
                Spacer()
                Button(L10n("取消")) { dismiss() }.disabled(isSaving)
                Button(L10n("保存")) {
                    guard !isSaving else { return }
                    isSaving = true
                    saveError = nil
                    Task {
                        if await onSave() {
                            dismiss()
                        } else {
                            saveError = EntityAPIClient.shared.errorMessage ?? L10n("Workspace 绑定失败，请重试。")
                        }
                        isSaving = false
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(workspaceId == nil || isSaving)
            }
        }
        .padding(20)
        .frame(width: 360)
    }
}
