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
    private let data: ClientDetailWorktreeState
    private var detail: ClientSessionWorktreeDetail? { get { data.detail } nonmutating set { data.detail = newValue } }
    private var job: ClientWorktreeJob? { get { data.job } nonmutating set { data.job = newValue } }
    @State private var review: ClientWorktreeJob?
    @Environment(\.detailPresentation) private var presentation
    @Environment(\.detailSectionPrefix) private var prefix
    @State private var localExpanded = false
    private var expanded: Bool {
        get { presentation?.section("\(prefix):worktree").expanded ?? localExpanded }
        nonmutating set { if let section = presentation?.section("\(prefix):worktree") { section.expanded = newValue } else { localExpanded = newValue } }
    }
    private var loading: Bool { get { data.loading } nonmutating set { data.loading = newValue } }
    private var mutating: Bool { get { data.mutating } nonmutating set { data.mutating = newValue } }
    private var error: String? { get { data.error } nonmutating set { data.error = newValue } }
    private var lastRead: Date? { get { data.lastRead } nonmutating set { data.lastRead = newValue } }
    @State private var pollRevision = 0
    private struct CommitReview: Identifiable {
        let id: String
        let protection: ClientGitCommitProtectionStatus
    }
    @State private var commitReview: CommitReview?
    @State private var commitMessage = ""
    @State private var privateFilesDecision = ""

    public init(sessionID: String, refreshID: String,
                api: @escaping @MainActor () async throws -> ClientSessionWorktreeAPI,
                onJob: @escaping @MainActor (ClientWorktreeJob) -> Void = { _ in },
                localize: @escaping (String) -> String = { $0 },
                initialDetail: ClientSessionWorktreeDetail? = nil,
                state: ClientDetailWorktreeState? = nil, expectedWorktreeID: String? = nil) {
        self.sessionID = sessionID; self.refreshID = refreshID
        self.api = api; self.onJob = onJob; self.localize = localize
        let retained = state ?? ClientDetailWorktreeState()
        if let expectedWorktreeID { retained.bind(expectedWorktreeID) }
        if retained.detail == nil { retained.detail = initialDetail }
        self.data = retained
    }

    public var body: some View {
        Group {
        if detail?.attached != false {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 4) {
                Button { expanded.toggle() } label: {
                    Label("Worktree", systemImage: expanded ? "chevron.down" : "arrow.triangle.branch")
                        .font(.caption.weight(.semibold)).frame(maxWidth: .infinity, alignment: .leading)
                        .frame(minHeight: headerHeight).contentShape(Rectangle())
                }.buttonStyle(.plain).accessibilityValue(localize(expanded ? "已展开" : "已收起"))
                if detail?.worktree?.dirty == true {
                    Button { Task { await prepareCommit() } } label: { ConversationDetailHeaderIcon(systemName: "checkmark.circle") }
                        .buttonStyle(.plain).foregroundStyle(Color.accentColor).disabled(loading || mutating)
                        .help(localize("提交修改")).accessibilityLabel(localize("提交修改"))
                }
                if detail?.worktree?.isMain == false {
                    actionButton(.synchronize, icon: "arrow.triangle.2.circlepath", label: detail?.worktree?.hierarchy?.role == "child" ? "同步父分支" : "同步主分支")
                    if detail?.worktree?.hierarchy?.role != "parent" { actionButton(.merge, icon: "arrow.triangle.merge", label: detail?.worktree?.hierarchy == nil ? "合并到主分支" : "合并到父分支") }
                }
                Button { Task { await reload() } } label: { ConversationDetailHeaderIcon(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain).disabled(loading || mutating).accessibilityLabel(localize("刷新 Worktree 状态"))
            }
            if loading && detail == nil { ProgressView() }
            if let tree = detail?.worktree {
                Text("\(tree.branchName ?? localize("游离 HEAD")) → \(tree.hierarchy?.comparison.branchName ?? detail?.mainBranch ?? "—")")
                    .font(.caption.monospaced()).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                Text(relation(tree)).font(.caption).foregroundStyle(.secondary)
                if tree.dirty == true {
                    Text("\(localize("未提交修改")) · \(tree.changedFileCount ?? tree.changedFiles.count)").font(.caption).foregroundStyle(.orange)
                }
                if let blocker = detail?.blockedReason, blocker != "MAIN_WORKTREE" {
                    Text(blockerText(blocker)).font(.caption).foregroundStyle(.orange)
                }
                if !tree.isMain, tree.hierarchy?.role != "parent", detail?.autoFollow != nil {
                    Toggle(localize(tree.hierarchy == nil ? "自动同步主分支" : "自动跟随父分支"), isOn: Binding(
                        get: { detail?.autoFollow?.enabled == true },
                        set: { enabled in Task { await setAutoFollow(enabled, worktreeID: tree.worktreeId) } }
                    ))
                    .toggleStyle(.switch)
                    .font(.caption).disabled(loading || mutating)
                    .help(localize(tree.hierarchy == nil ? "工作区干净且会话空闲时自动 Rebase；不会自动提交、stash 或 push。"
                        : "工作区干净且会话空闲时同步父分支；已发布分支使用 merge，不会自动提交、stash 或 push。"))
                    if let follow = detail?.autoFollow, follow.enabled {
                        Text(autoFollowText(follow)).font(.caption2)
                            .foregroundStyle(follow.status == "paused" ? Color.orange : Color.secondary)
                    }
                }
                if expanded {
                    if let hierarchy=tree.hierarchy {
                        ConversationHierarchyActions(hierarchy:hierarchy,api:{ try await api().hierarchyAPI },prepare:{ action,receipt in
                            do { let next=try await api().prepareHierarchy(sessionID:sessionID,action:action,receiptId:receipt)
                                job=next;review=next;onJob(next)
                            } catch { self.error=error.localizedDescription }
                        },localize:localize)
                    }
                    Text(tree.path).font(.caption2.monospaced()).textSelection(.enabled)
                    Text(localize("比较本地主分支；不会自动 fetch 或 push。"))
                        .font(.caption2).foregroundStyle(.secondary)
                    ForEach(Array(tree.changedFiles.prefix(20).enumerated()), id: \.offset) { _, file in
                        Text(file).font(.caption2.monospaced()).textSelection(.enabled)
                    }
                    if (tree.changedFileCount ?? tree.changedFiles.count) > 20 { Text(localize("仅显示前 20 个文件")).font(.caption2) }
                }
            }
            if let job, ["awaiting_confirmation", "queued", "running", "paused", "failed", "cancellation_requested", "replanning"].contains(job.status) {
                jobContent(job)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled) }
        }
        .modifier(ConversationDetailModuleSurface())
        .accessibilityIdentifier("conversation-worktree-card")
        }
        }
        .task(id: refreshID) {
            guard data.refreshID != refreshID || data.detail == nil else { return }
            // Coalesce streaming Session updates. No Git read in body and no
            // perpetual idle poll. A task completion and manual refresh still read.
            if lastRead != nil { try? await Task.sleep(for: .milliseconds(750)) }
            guard !Task.isCancelled else { return }
            await reload()
        }
        .onChange(of: data.generation) { _, _ in review = nil; commitReview = nil; commitMessage = ""; privateFilesDecision = "" }
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
        .sheet(item: $commitReview) { draft in
            VStack(alignment: .leading, spacing: 12) {
                Text(localize("提交修改")).font(.headline)
                Text(localize("仅提交当前 Worktree，不合并、同步或推送。" )).font(.caption).foregroundStyle(.secondary)
                TextField(localize("提交信息"), text: $commitMessage, axis: .vertical).lineLimit(3...6).textFieldStyle(.roundedBorder)
                if draft.protection.requiresDecision {
                    Picker(localize("私密文件"), selection: $privateFilesDecision) {
                        Text(localize("请选择处理方式")).tag("")
                        Text(localize("忽略并继续")).tag("ignore")
                        Text(localize("包含并继续")).tag("include")
                    }
                    ScrollView { VStack(alignment: .leading) { ForEach(draft.protection.protectedPaths, id: \.self) { Text($0).font(.caption.monospaced()) } } }.frame(maxHeight: 140)
                }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
                HStack {
                    Button(localize("取消")) { commitReview = nil }.disabled(mutating)
                    Spacer()
                    Button(localize("提交")) { Task { await commit(draft) } }
                        .disabled(mutating || commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (draft.protection.requiresDecision && privateFilesDecision.isEmpty))
                }
            }.padding(20).frame(idealWidth: 400).interactiveDismissDisabled(mutating)
        }
    }

    private func actionButton(_ action: ClientWorktreePlanOperation, icon: String, label: String) -> some View {
        Button { Task { await prepare(action) } } label: { ConversationDetailHeaderIcon(systemName: icon) }
            .buttonStyle(.plain).foregroundStyle(Color.accentColor).disabled(loading || mutating || detail?.canPerform(action) != true)
            .help(localize(label)).accessibilityLabel(localize(label))
    }
    @MainActor private func prepareCommit() async {
        guard !mutating, let id = detail?.worktree?.worktreeId else { return }
        let generation = data.generation
        mutating = true; error = nil
        defer { if data.generation == generation { mutating = false } }
        do {
            let protection = try await api().prepareCommit(sessionID: sessionID, worktreeID: id)
            try Task.checkCancellation()
            guard data.generation == generation else { return }
            commitMessage = ""; privateFilesDecision = ""; commitReview = CommitReview(id: id, protection: protection)
        } catch { if !Task.isCancelled, data.generation == generation { self.error = describe(error) } }
    }
    @MainActor private func commit(_ draft: CommitReview) async {
        guard !mutating else { return }; mutating = true; error = nil
        let generation = data.generation
        do {
            try await api().commit(sessionID: sessionID, worktreeID: draft.id, message: commitMessage,
                privateFilesDecision: privateFilesDecision.isEmpty ? nil : privateFilesDecision)
            guard data.generation == generation else { return }
            commitReview = nil
        } catch {
            guard data.generation == generation else { return }
            // A transport failure does not prove the commit failed. Do not
            // automatically retry or leave a submit button ready to resend.
            commitReview = nil
            self.error = localize("提交结果需核对，请刷新 Worktree 或打开管理页面确认，勿直接重复提交。")
        }
        mutating = false
        if error == nil { await reload() }
    }
    private func relation(_ tree: ClientSessionWorktreeDetail.Worktree) -> String {
        if tree.isMain { return localize("当前为主 Worktree") }
        guard let ahead = tree.hierarchy?.comparison.ahead ?? tree.aheadOfMain,
              let behind = tree.hierarchy?.comparison.behind ?? tree.behindMain else { return localize("分支关系暂不可用") }
        if ahead == 0 && behind == 0 { return localize(tree.hierarchy?.role == "child" ? "与父分支一致" : "与主分支一致") }
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
        let followsParent=detail?.worktree?.hierarchy?.role == "child"
        if value.status == "paused" { return localize("自动跟随已暂停，请处理冲突或检查绑定") }
        if value.status == "running" { return localize(followsParent ? "正在自动同步父分支" : "正在自动同步主分支") }
        if value.status == "aligned" { return localize(followsParent ? "已跟随父分支" : "已跟随主分支") }
        if let reason = value.reason { return localize("等待安全同步时机") + " · " + blockerText(reason) }
        return localize(followsParent ? "等待父分支更新" : "等待主分支更新")
    }
    @MainActor private func setAutoFollow(_ enabled: Bool, worktreeID: String) async {
        guard !mutating else { return }; mutating = true; error = nil
        let generation = data.generation
        do { try await api().setAutoFollow(sessionID: sessionID, worktreeID: worktreeID, enabled: enabled) }
        catch { if data.generation == generation { self.error = describe(error); mutating = false }; return }
        guard data.generation == generation else { return }
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
        let scoped=value.plan.taskScope != nil
        let sync=value.plan.operationType == "sync"
        let sources=value.plan.items.filter { value.plan.sourceWorktreeIds?.contains($0.worktreeId) ?? !$0.isMain }
            .compactMap(\.branchName).joined(separator:", ")
        let target=value.plan.targetBranchName ?? detail?.mainBranch ?? "—"
        return VStack(alignment: .leading, spacing: 12) {
            Text(localize(scoped ? (sync ? "同步分支" : value.plan.taskScope?.action == "promote_parent" ? "验收后合入主分支" : "合并到父分支")
                : sync ? "同步主分支（Rebase）" : "合并到主分支")).font(.headline)
            Text(sync ? "\(target) → \(sources)" : "\(sources) → \(target)")
            if scoped {
                Text(localize(sync
                    ? (value.plan.syncStrategy == "merge" ? "将基线合并到来源分支，基线分支保持不变。" : "仅更新来源分支，基线分支保持不变；实际同步策略以审查计划为准。")
                    : value.plan.taskScope?.action == "promote_parent" ? "仅将已验收提交快进至本地主分支。" : "仅将已提交的子分支修改合并到父分支。"))
            } else {
            Text(localize(sync
                ? "仅将当前分支 Rebase 到主分支，不会合并到主分支。"
                : "将当前分支的已提交修改合并到本地主分支。"))
            }
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
        let generation = data.generation
        loading = true
        defer { if generation == data.generation { loading = false } }
        do {
            let next = try await api().detail(sessionID: sessionID)
            try Task.checkCancellation()
            guard data.generation == generation else { return }
            detail = next; lastRead = Date(); error = nil
            data.refreshID = refreshID
            if review == nil { job = next.job }
        } catch { if !Task.isCancelled, data.generation == generation { self.error = describe(error) } }
    }
    @MainActor private func prepare(_ action: ClientWorktreePlanOperation) async {
        guard !mutating else { return }; mutating = true; error = nil
        let generation = data.generation
        defer { if data.generation == generation { mutating = false } }
        do {
            let value = try await api().prepare(sessionID: sessionID, action: action, expectedWorktreeID: detail?.worktree?.worktreeId)
            guard data.generation == generation else { return }
            job = value; review = value
        } catch { if data.generation == generation { self.error = describe(error) } }
    }
    @MainActor private func confirm(_ value: ClientWorktreeJob) async {
        guard !mutating else { return }; mutating = true; error = nil
        let generation = data.generation
        defer { if data.generation == generation { mutating = false } }
        do {
            let next = try await api().confirm(value, sessionID: sessionID)
            guard data.generation == generation else { return }
            job = next; onJob(next); review = nil; pollRevision += 1
        } catch { if data.generation == generation { self.error = describe(error) } }
    }
    private func cancelDraftIfNeeded() {
        guard let value = job, value.status == "awaiting_confirmation" else { return }
        Task { await jobAction(value, action: "cancel") }
    }
    @MainActor private func jobAction(_ value: ClientWorktreeJob, action: String) async {
        guard !mutating else { return }; mutating = true; error = nil
        let generation = data.generation
        do {
            let next = try await api().jobAction(value.id, action: action, sessionID: sessionID)
            guard data.generation == generation else { return }
            job = next; onJob(next); pollRevision += 1
        } catch { if data.generation == generation { self.error = describe(error) } }
        guard data.generation == generation else { return }
        mutating = false
        await reload()
    }
    @MainActor private func poll() async {
        guard let id = job?.id else { return }
        let generation = data.generation
        while job?.id == id && job?.shouldPoll == true && !Task.isCancelled {
            do {
                try await Task.sleep(for: .seconds(2))
                let next = try await api().job(id); try Task.checkCancellation()
                guard data.generation == generation else { return }
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
