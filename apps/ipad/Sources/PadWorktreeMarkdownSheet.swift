import SwiftUI
import CorptieClientCore

struct PadWorktreeMarkdownSheet: View {
    let jobID: String
    @Bindable var manager: PadWorktreeStore
    let connection: PadConnection
    @Environment(\.dismiss) private var dismiss
    @State private var decisions: [String: String] = [:]
    @State private var reviewedJob: ClientWorktreeJob?

    private var job: ClientWorktreeJob? { manager.job?.id == jobID ? manager.job : nil }

    var body: some View {
        let currentJob = job
        let paths = currentJob?.commitPolicyBlocker?.files.map(\.path) ?? currentJob?.commitPolicyResidue?.paths ?? []
        let files = Dictionary((currentJob?.commitPolicyBlocker?.files ?? []).map { ($0.path, $0) }, uniquingKeysWith: { _, latest in latest })
        let currentReview = PadWorktreeStore.markdownReviewMatches(reviewedJob, current: currentJob)
        let canSubmit = !manager.jobBusy && !manager.planning && !paths.isEmpty && currentReview
            && (currentJob?.supports("resolve_commit_policy") == true || currentJob?.supports("resolve_commit_policy_residue") == true)
            && paths.allSatisfy { path in
                if let file = files[path] {
                    return file.appliedAction != nil || decisions[path].map { file.supportedActions.contains($0) } == true
                }
                return decisions[path].map { currentJob?.commitPolicyResidue?.supportedActions.contains($0) == true } == true
            }
        return NavigationStack {
            Form {
                Section {
                    Text("逐个处理计划外 Markdown，确认后继续提交和合并。")
                    Text("转为 Artifact 会移除工作区文件；允许 Git 跟踪仅授权当前文件版本。删除操作会删除所列文件。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("文件处理") {
                    ForEach(paths, id: \.self) { path in
                        let file = files[path]
                        let actions = file?.supportedActions ?? currentJob?.commitPolicyResidue?.supportedActions ?? []
                        Picker(path, selection: Binding(
                            get: { file?.appliedAction ?? (currentReview ? decisions[path] : nil) ?? "" },
                            set: {
                                if !PadWorktreeStore.markdownReviewMatches(reviewedJob, current: job) { decisions.removeAll(keepingCapacity: true) }
                                reviewedJob = job
                                decisions[path] = $0
                            }
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
                        guard let reviewedJob, PadWorktreeStore.markdownReviewMatches(reviewedJob, current: job) else { return }
                        let selected = paths.compactMap { path -> ClientWorktreeMarkdownDecision? in
                            let applied = files[path]?.appliedAction
                            guard let action = applied ?? decisions[path] else { return nil }
                            return .init(path: path, action: action)
                        }
                        Task {
                            if await manager.handleMarkdown(jobID: jobID, decisions: selected, reviewedJob: reviewedJob, connection: connection) { dismiss() }
                        }
                    }
                    .disabled(!canSubmit)
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
                reviewedJob = job
            }
            .onChange(of: job?.commitPolicyBlocker) { _, _ in clearReview() }
            .onChange(of: job?.commitPolicyResidue) { _, _ in clearReview() }
            .onChange(of: job?.planFingerprint) { _, _ in clearReview() }
        }
    }

    private func clearReview() {
        decisions.removeAll(keepingCapacity: true)
        reviewedJob = job
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
