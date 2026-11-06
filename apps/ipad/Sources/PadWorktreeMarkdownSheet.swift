import SwiftUI
import CorptieClientCore

struct PadWorktreeMarkdownSheet: View {
    let jobID: String
    @Bindable var manager: PadWorktreeStore
    let connection: PadConnection
    @Environment(\.dismiss) private var dismiss
    @State private var decisions: [String: String] = [:]

    private var job: ClientWorktreeJob? { manager.job?.id == jobID ? manager.job : nil }
    private var paths: [String] { job?.commitPolicyBlocker?.files.map(\.path) ?? job?.commitPolicyResidue?.paths ?? [] }
    private var blockerID: String? { job?.commitPolicyBlocker?.id ?? job?.commitPolicyResidue?.id }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("逐个处理计划外 Markdown，确认后继续提交和合并。")
                    Text("转为 Artifact 会移除工作区文件；允许 Git 跟踪仅授权当前文件版本。删除操作会删除所列文件。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("文件处理") {
                    ForEach(paths, id: \.self) { path in
                        let file = job?.commitPolicyBlocker?.files.first { $0.path == path }
                        let actions = file?.supportedActions ?? job?.commitPolicyResidue?.supportedActions ?? []
                        Picker(path, selection: Binding(
                            get: { file?.appliedAction ?? decisions[path] ?? "" },
                            set: { decisions[path] = $0 }
                        )) {
                            Text("请选择处理方式").tag("")
                            ForEach(actions, id: \.self) { action in Text(title(action)).tag(action) }
                        }
                        .disabled(file?.appliedAction != nil || manager.jobBusy)
                    }
                    if paths.isEmpty { Text("正在读取文件处理要求…") }
                }
                if let error = manager.errorMessage { Section { Text(error).textSelection(.enabled).foregroundStyle(.red) } }
                Section {
                    Button("确认文件处理并继续") {
                        let selected = paths.compactMap { path -> ClientWorktreeMarkdownDecision? in
                            let applied = job?.commitPolicyBlocker?.files.first { $0.path == path }?.appliedAction
                            guard let action = applied ?? decisions[path] else { return nil }
                            return .init(path: path, action: action)
                        }
                        Task {
                            if await manager.handleMarkdown(jobID: jobID, decisions: selected, connection: connection) { dismiss() }
                        }
                    }
                    .disabled(manager.jobBusy || paths.isEmpty || !paths.allSatisfy { path in
                        job?.commitPolicyBlocker?.files.first { $0.path == path }?.appliedAction != nil || decisions[path] != nil
                    })
                    .accessibilityIdentifier("worktree.commit-policy.confirm-and-continue")
                    Button("重新读取处理要求") {
                        Task { _ = await manager.handleMarkdown(jobID: jobID, connection: connection) }
                    }.disabled(manager.jobBusy || job?.commitPolicyResidue != nil)
                }
            }
            .navigationTitle("处理 Markdown 文件")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
            .task {
                if job?.commitPolicyBlocker == nil, job?.commitPolicyResidue == nil {
                    _ = await manager.handleMarkdown(jobID: jobID, connection: connection)
                }
            }
            .onChange(of: blockerID) { _, _ in decisions.removeAll(keepingCapacity: true) }
        }
    }

    private func title(_ action: String) -> String {
        switch action {
        case "ignore": "加入忽略"
        case "keep_ignore": "保留忽略"
        case "delete": "删除文件"
        case "artifact": "转为 Artifact"
        case "track": "允许 Git 跟踪当前版本"
        default: action
        }
    }
}
