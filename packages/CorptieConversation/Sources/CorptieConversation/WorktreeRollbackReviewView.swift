import SwiftUI
import CorptieClientCore

/// One snapshot per explicit review. Git inspection runs through the supplied
/// async service, never from body or once per rendered target row.
public struct WorktreeRollbackReviewView: View {
    private let prepare: () async throws -> (ClientWorktreeRollbackPreview?, Bool)
    private let confirm: (String, Bool, Bool) async throws -> Void
    private let resume: (() async throws -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var preview: ClientWorktreeRollbackPreview?
    @State private var loading = true
    @State private var executing = false
    @State private var error: String?
    @State private var generation = 0
    @State private var discardChanges = false
    @State private var includeAdditionalCommits = false

    public init(prepare: @escaping () async throws -> (ClientWorktreeRollbackPreview?, Bool),
                confirm: @escaping (String, Bool, Bool) async throws -> Void,
                resume: (() async throws -> Void)? = nil) {
        self.prepare = prepare; self.confirm = confirm; self.resume = resume
    }

    private var hasEdits: Bool { preview?.targets.contains { $0.requiresPreservation } == true }
    private var hasAdditionalHistory: Bool { preview?.targets.contains { !$0.additionalCommits.isEmpty || $0.published } == true }
    private var needsGitRecovery: Bool { preview?.targets.contains {
        ["resolve_git_operation", "review_diverged_history"].contains($0.mode)
    } == true }

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("取消并回滚本次合并").font(.headline)
            Text("后续合并步骤将停止。确认后，所列目标分支恢复到本轮合并起点；来源 Worktree 已生成的提交保留。")
                .font(.callout)
            if loading { ProgressView("正在等待当前步骤停止并检查回滚范围…") }
            if let preview {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(preview.targets) { target in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(target.branchName ?? target.worktreeId).font(.subheadline.bold())
                                Text(target.path).font(.caption).textSelection(.enabled)
                                Text("当前：\(target.currentHead)\n恢复到：\(target.baselineHead)")
                                    .font(.caption.monospaced()).textSelection(.enabled)
                                if target.mode == "already_restored" { Text("已在合并起点，无需重复回滚。").font(.caption) }
                                if !target.additionalCommits.isEmpty {
                                    Text("以下额外提交也将从本地目标分支撤下：").foregroundStyle(.orange)
                                    ForEach(target.additionalCommits, id: \.self) { Text($0).font(.caption.monospaced()).textSelection(.enabled) }
                                }
                                if target.published {
                                    Text("本轮结果已出现在远程跟踪历史中。此次只恢复本地分支，远程分支不会回滚。")
                                        .font(.caption).foregroundStyle(.orange)
                                }
                                ForEach(target.changedFiles, id: \.self) { Text($0).font(.caption.monospaced()).textSelection(.enabled) }
                            }
                            Divider()
                        }
                        if preview.targets.isEmpty { Text("本轮尚未写入合并结果，可以直接结束任务。") }
                    }
                }.frame(minHeight: 100, maxHeight: 320)
                if hasEdits {
                    Toggle("确认放弃上面列出的未提交及冲突解决修改；需要保留时请先自行保存，再刷新范围。", isOn: $discardChanges)
                }
                if hasAdditionalHistory {
                    Toggle("确认恢复上述本地分支起点，包括撤下列出的额外提交及已发布合并结果。", isOn: $includeAdditionalCommits)
                }
                if needsGitRecovery {
                    Text("存在不属于本轮的 Git 操作或已分叉的历史。请返回 Worktree，继续／中止具体 Git 操作或恢复分支后，再重新查看回滚范围。")
                        .foregroundStyle(.orange).textSelection(.enabled)
                }
            }
            if let error { WorktreeErrorDetailsView(error) }
            HStack {
                Button("关闭（保持暂停）") { dismiss() }.disabled(executing)
                if let resume {
                    Button("返回并继续合并") {
                        executing = true; error = nil
                        Task {
                            do { try await resume(); dismiss() }
                            catch { self.error = error.localizedDescription }
                            executing = false
                        }
                    }.disabled(loading || executing || preview == nil)
                }
            }
            HStack {
                Button("刷新回滚范围") { generation += 1 }.disabled(loading || executing)
                Spacer()
                if executing { ProgressView("正在回滚并核验…") }
                Button("确认取消并回滚", role: .destructive) {
                    guard let preview else { return }
                    executing = true; error = nil
                    Task {
                        do {
                            try await confirm(preview.id, discardChanges, includeAdditionalCommits)
                            dismiss()
                        } catch {
                            self.error = error.localizedDescription
                            self.preview = nil
                            discardChanges = false; includeAdditionalCommits = false
                        }
                        executing = false
                    }
                }
                .disabled(loading || executing || preview == nil || needsGitRecovery
                    || hasEdits && !discardChanges || hasAdditionalHistory && !includeAdditionalCommits)
                .accessibilityIdentifier("worktree.rollback.confirm")
            }
        }
        .padding(20)
        .interactiveDismissDisabled(executing)
        .task(id: generation) {
            loading = true; error = nil; preview = nil
            discardChanges = false; includeAdditionalCommits = false
            defer { loading = false }
            do {
                while !Task.isCancelled {
                    let (review, waiting) = try await prepare()
                    if let review { preview = review; return }
                    if !waiting { dismiss(); return }
                    try await Task.sleep(for: .milliseconds(500))
                }
            } catch is CancellationError { }
            catch { self.error = error.localizedDescription }
        }
    }
}
