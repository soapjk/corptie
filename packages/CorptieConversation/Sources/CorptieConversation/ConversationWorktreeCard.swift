import SwiftUI
import CorptieClientCore

/// The same component and operation flow on macOS, iPad and iPhone. It owns
/// only visible-card state; Git, authorization and job recovery stay server-side.
public struct ConversationWorktreeCard: View {
    private let sessionID: String
    private let refreshID: String
    private let api: @MainActor () async throws -> ClientSessionWorktreeAPI
    private let onJob: @MainActor (ClientWorktreeJob) -> Void
    private let localize: (String) -> String
    @State private var detail: ClientSessionWorktreeDetail?
    @State private var job: ClientWorktreeJob?
    @State private var review: ClientWorktreeJob?
    @State private var expanded = false
    @State private var loading = false
    @State private var mutating = false
    @State private var error: String?
    @State private var lastRead: Date?
    @State private var pollRevision = 0

    public init(sessionID: String, refreshID: String,
                api: @escaping @MainActor () async throws -> ClientSessionWorktreeAPI,
                onJob: @escaping @MainActor (ClientWorktreeJob) -> Void = { _ in },
                localize: @escaping (String) -> String = { $0 },
                initialDetail: ClientSessionWorktreeDetail? = nil) {
        self.sessionID = sessionID; self.refreshID = refreshID
        self.api = api; self.onJob = onJob; self.localize = localize
        _detail = State(initialValue: initialDetail)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Button { expanded.toggle() } label: {
                    Label("Worktree", systemImage: expanded ? "chevron.down" : "arrow.triangle.branch")
                        .font(.caption.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: headerHeight).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityValue(localize(expanded ? "已展开" : "已收起"))
                if detail?.canPerform(.synchronize) == true { actionButton(.synchronize, icon: "arrow.triangle.2.circlepath", label: "同步主分支") }
                if detail?.canPerform(.merge) == true { actionButton(.merge, icon: "arrow.triangle.merge", label: "合并到主分支") }
                Button { Task { await reload() } } label: { ConversationDetailHeaderIcon(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(loading || mutating).accessibilityLabel(localize("刷新 Worktree 状态"))
            }
            if loading && detail == nil { ProgressView() }
            if let tree = detail?.worktree {
                Text("\(tree.branchName ?? localize("游离 HEAD")) → \(detail?.mainBranch ?? "—")")
                    .font(.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Text(relation(tree)).font(.caption).foregroundStyle(.secondary)
                if tree.dirty == true {
                    Text("\(localize("未提交修改")) · \(tree.changedFileCount ?? tree.changedFiles.count)").font(.caption).foregroundStyle(.orange)
                }
                if let blocker = detail?.blockedReason, blocker != "MAIN_WORKTREE" {
                    Text(blockerText(blocker)).font(.caption).foregroundStyle(.orange)
                }
                if !tree.isMain, detail?.autoFollow != nil {
                    Toggle(localize("自动跟随主分支"), isOn: Binding(
                        get: { detail?.autoFollow?.enabled == true },
                        set: { enabled in Task { await setAutoFollow(enabled, worktreeID: tree.worktreeId) } }
                    ))
                    .font(.caption).disabled(loading || mutating)
                    .help(localize("工作区干净且会话空闲时自动 Rebase；不会自动提交、stash 或 push。"))
                    if let follow = detail?.autoFollow, follow.enabled {
                        Text(autoFollowText(follow)).font(.caption2)
                            .foregroundStyle(follow.status == "paused" ? Color.orange : Color.secondary)
                    }
                }
                if expanded {
                    Text(tree.path).font(.caption2.monospaced()).textSelection(.enabled)
                    Text(localize("比较本地主分支；不会自动 fetch 或 push。"))
                        .font(.caption2).foregroundStyle(.secondary)
                    ForEach(Array(tree.changedFiles.prefix(20).enumerated()), id: \.offset) { _, file in
                        Text(file).font(.caption2.monospaced()).textSelection(.enabled)
                    }
                    if (tree.changedFileCount ?? tree.changedFiles.count) > 20 { Text(localize("仅显示前 20 个文件")).font(.caption2) }
                }
            } else if detail?.attached == false {
                Text(localize("当前会话未绑定受管理的 Worktree")).font(.caption).foregroundStyle(.secondary)
            }
            if let job, ["awaiting_confirmation", "queued", "running", "paused", "failed", "cancellation_requested", "replanning"].contains(job.status) {
                jobContent(job)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }
        .modifier(ConversationDetailModuleSurface())
        .accessibilityIdentifier("conversation-worktree-card")
        .task(id: refreshID) {
            // Coalesce streaming Session updates. No Git read in body and no
            // perpetual idle poll. A task completion and manual refresh still read.
            if lastRead != nil { try? await Task.sleep(for: .milliseconds(750)) }
            guard !Task.isCancelled else { return }
            await reload()
        }
        .task(id: "\(job?.id ?? ""):\(pollRevision)") { await poll() }
        .task(id: detail?.autoFollow?.enabled == true) {
            // Only keep the visible opted-in card's status fresh. Automation
            // is server-owned and does not rely on this presentation refresh.
            while detail?.autoFollow?.enabled == true && !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(30)) } catch { return }
                await reload()
            }
        }
        .sheet(item: $review, onDismiss: cancelDraftIfNeeded) { reviewed in
            reviewSheet(reviewed)
        }
    }

    private func actionButton(_ action: ClientWorktreePlanOperation, icon: String, label: String) -> some View {
        Button { Task { await prepare(action) } } label: { ConversationDetailHeaderIcon(systemName: icon) }
            .buttonStyle(.plain).disabled(loading || mutating).help(localize(label)).accessibilityLabel(localize(label))
    }
    private func relation(_ tree: ClientSessionWorktreeDetail.Worktree) -> String {
        if tree.isMain { return localize("当前为主 Worktree") }
        guard let ahead = tree.aheadOfMain, let behind = tree.behindMain else { return localize("分支关系暂不可用") }
        if ahead == 0 && behind == 0 { return localize("与主分支一致") }
        return "↑ \(ahead) · ↓ \(behind) · " + localize(behind > 0 ? (ahead > 0 ? "先同步，再合并" : "待同步") : "可合并")
    }
    private func blockerText(_ code: String) -> String {
        localize(["SESSION_BUSY": "会话正在执行，请结束后再操作", "UNCOMMITTED_CHANGES": "请先处理当前或主 Worktree 的未提交修改",
            "GIT_OPERATION_IN_PROGRESS": "已有 Git 操作或冲突，请先处理", "WORKTREE_LOCKED": "Worktree 已锁定",
            "DETACHED_HEAD": "需要有效的本地分支", "WORKTREE_UNAVAILABLE": "Worktree 暂不可用",
            "INTEGRATION_JOB_ACTIVE": "已有 Worktree 操作，请先处理",
            "WORKTREE_STATE_CHANGED": "Worktree 状态已变化，等待重新检查"][code] ?? code)
    }
    private func autoFollowText(_ value: ClientSessionWorktreeDetail.AutoFollow) -> String {
        if value.status == "paused" { return localize("自动跟随已暂停，请处理冲突或检查绑定") }
        if value.status == "running" { return localize("正在自动同步主分支") }
        if value.status == "aligned" { return localize("已跟随主分支") }
        if let reason = value.reason { return localize("等待安全同步时机") + " · " + blockerText(reason) }
        return localize("等待主分支更新")
    }
    @MainActor private func setAutoFollow(_ enabled: Bool, worktreeID: String) async {
        guard !mutating else { return }; mutating = true; error = nil
        do { try await api().setAutoFollow(sessionID: sessionID, worktreeID: worktreeID, enabled: enabled) }
        catch { self.error = describe(error); mutating = false; return }
        mutating = false
        await reload()
    }
    @ViewBuilder private func jobContent(_ value: ClientWorktreeJob) -> some View {
        Divider()
        Text("\(localize("Worktree 操作")) · \(localize(jobState(value.status))) · \(localize(jobState(value.phase)))").font(.caption)
        if value.shouldPoll { ProgressView(value: value.progress.fraction) }
        if let failure = value.error { Text(failure).font(.caption).foregroundStyle(.orange) }
        ForEach(Array(value.plan.items.flatMap(\.conflictFiles).prefix(20).enumerated()), id: \.offset) { _, file in
            Text(file).font(.caption2.monospaced()).textSelection(.enabled)
        }
        HStack {
            if value.status == "awaiting_confirmation" {
                Button(localize("查看计划")) { review = value }
            }
            if ["paused", "failed"].contains(value.status) {
                Button(localize("处理后重试")) { Task { await jobAction(value, action: "retry") } }
            }
            if value.canCancel {
                Button(localize("取消任务")) { Task { await jobAction(value, action: "cancel") } }
            }
        }.font(.caption).disabled(mutating)
        if value.status == "paused" { Text(localize("请处理列出的冲突后重试；取消任务不会丢弃冲突现场。" )).font(.caption2).foregroundStyle(.secondary) }
    }
    private func reviewSheet(_ value: ClientWorktreeJob) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(localize(value.plan.operationType == "sync" ? "同步主分支（Rebase）" : "合并到主分支")).font(.headline)
            Text("\(value.plan.items.filter { !$0.isMain }.compactMap(\.branchName).joined(separator: ", ")) → \(value.plan.targetBranchName ?? detail?.mainBranch ?? "—")")
            Text(localize(value.plan.operationType == "sync"
                ? "仅将当前分支 Rebase 到主分支，不会合并到主分支。"
                : "将当前分支的已提交修改合并到本地主分支。"))
            Text(localize("不会自动提交、stash 或 push。" )).font(.caption).foregroundStyle(.secondary)
            ForEach(Array(value.plan.blockingRisks.enumerated()), id: \.offset) { _, risk in
                Text(risk.message).font(.caption).foregroundStyle(.orange)
            }
            if value.plan.items.contains(where: { $0.dirty }) { Text(localize("请先处理当前或主 Worktree 的未提交修改")).foregroundStyle(.orange) }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                Button(localize("取消")) { review = nil }
                Spacer()
                Button(localize("确认执行")) { Task { await confirm(value) } }
                    .disabled(mutating || !value.plan.blockingRisks.isEmpty || value.plan.items.contains(where: { $0.dirty || $0.commitStatus != "not_needed" }))
            }
        }.padding(20).frame(idealWidth: 420).fixedSize(horizontal: false, vertical: true)
            .interactiveDismissDisabled(mutating)
    }
    @MainActor private func reload() async {
        guard !loading, !mutating else { return }
        loading = true
        defer { loading = false }
        do {
            let next = try await api().detail(sessionID: sessionID)
            try Task.checkCancellation()
            detail = next; lastRead = Date(); error = nil
            if review == nil { job = next.job }
        } catch { if !Task.isCancelled { self.error = describe(error) } }
    }
    @MainActor private func prepare(_ action: ClientWorktreePlanOperation) async {
        guard !mutating else { return }; mutating = true; error = nil
        defer { mutating = false }
        do { let value = try await api().prepare(sessionID: sessionID, action: action); job = value; review = value }
        catch { self.error = describe(error) }
    }
    @MainActor private func confirm(_ value: ClientWorktreeJob) async {
        guard !mutating else { return }; mutating = true; error = nil
        defer { mutating = false }
        do {
            let next = try await api().confirm(value); job = next; onJob(next); review = nil; pollRevision += 1
        } catch { self.error = describe(error) }
    }
    private func cancelDraftIfNeeded() {
        guard let value = job, value.status == "awaiting_confirmation" else { return }
        Task { await jobAction(value, action: "cancel") }
    }
    @MainActor private func jobAction(_ value: ClientWorktreeJob, action: String) async {
        guard !mutating else { return }; mutating = true; error = nil
        do { let next = try await api().jobAction(value.id, action: action); job = next; onJob(next); pollRevision += 1 }
        catch { self.error = describe(error) }
        mutating = false
        await reload()
    }
    @MainActor private func poll() async {
        guard let id = job?.id else { return }
        while job?.id == id && job?.shouldPoll == true && !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(2))
                let next = try await api().job(id); try Task.checkCancellation()
                job = next; onJob(next)
            } catch { if !Task.isCancelled { self.error = describe(error) }; return }
        }
        if !Task.isCancelled, job?.id == id, job?.status != "awaiting_confirmation" { await reload() }
    }
    private func describe(_ error: Error) -> String {
        if let failure = error as? ClientServiceFailure { return localize("Worktree 操作未完成，请刷新状态后重试") + " · \(failure.code)" }
        return error.localizedDescription
    }
    private var headerHeight: CGFloat {
        #if os(macOS)
        28
        #else
        44
        #endif
    }
    private func jobState(_ value: String) -> String {
        ["awaiting_confirmation": "待确认", "queued": "排队中", "running": "执行中", "paused": "待处理",
         "failed": "失败", "cancellation_requested": "正在取消", "replanning": "重新规划",
         "plan": "操作计划", "rebasing": "Rebase", "merging": "合并", "committing": "提交检查",
         "completed": "已完成", "cancelled": "已取消"][value] ?? value
    }
}
