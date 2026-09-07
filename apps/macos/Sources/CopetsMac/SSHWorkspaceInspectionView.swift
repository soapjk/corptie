import SwiftUI

/// Reads saved observations on appearance; SSH requires the user's explicit action.
struct SSHWorkspaceInspectionView: View {
    let workspaceId: String
    let location: SSHWorkspaceLocation
    var client: any SSHWorkspaceAPI = SSHWorkspaceHTTPClient()
    @State private var observation: SSHWorkspaceObservation?
    @State private var error: String?
    @State private var inspecting = false
    @State private var showConfirmation = false
    @State private var operation: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(L10n("验证远端仓库")) { showConfirmation = true }
                .disabled(inspecting)
            if inspecting { ProgressView().controlSize(.small) }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            if let observation {
                DisclosureGroup(L10n("上次观测的远端 Worktree")) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(observation.observedAt).font(.caption).foregroundStyle(.secondary)
                        ForEach(observation.worktrees.prefix(20)) { tree in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(tree.path).textSelection(.enabled)
                                Text(tree.branchRef ?? String(tree.headOid.prefix(12)))
                                    .font(.caption).foregroundStyle(.secondary)
                                if tree.locked { Text(L10n("已锁定")).font(.caption) }
                                if tree.prunable { Text(L10n("目录状态待核实")).font(.caption) }
                            }
                        }
                        if observation.worktrees.count > 20 {
                            Text(L10n("仅显示前 20 项观测记录")).font(.caption)
                        }
                    }
                }
            }
        }
        .task(id: workspaceId) {
            observation = nil
            do {
                let result = try await client.observation(workspaceId: workspaceId)
                try Task.checkCancellation()
                observation = result.observation
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
        .onDisappear { operation?.cancel() }
        .confirmationDialog(L10n("连接并读取远端仓库？"), isPresented: $showConfirmation, titleVisibility: .visible) {
            Button(L10n("连接并验证")) { inspect() }
            Button(L10n("取消"), role: .cancel) {}
        } message: {
            Text("\(location.hostLabel) · \(location.hostAlias)\n\(location.rootPath)\n\n\(L10n("将发送只读 Python 检查代码，通过 SSH 运行 Git 读取仓库及 Worktree 清单。不会安装文件或绑定工作树；结果保存在本机，远端可能保留连接审计记录。"))")
        }
    }

    private func inspect() {
        guard !inspecting else { return }
        inspecting = true
        error = nil
        operation = Task { @MainActor in
            defer { inspecting = false }
            do {
                let result = try await client.probe(workspaceId: workspaceId)
                try Task.checkCancellation()
                observation = result.observation
            } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            await EntityAPIClient.shared.refreshWorkspaces()
        }
    }
}
