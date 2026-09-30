import SwiftUI
import CorptieClientCore

struct PadWorktreeManagementView: View {
    let repository: ClientControlItem
    let connection: PadConnection
    @Bindable var manager: PadWorktreeStore
    let openSession: (String) -> Void
    @State private var operationDraft: PadWorktreeOperationDraft?
    @State private var pendingDelete: ClientManagedWorktree?
    @State private var pendingSync: ClientManagedWorktree?
    @State private var pendingCleanup: [ClientManagedWorktree] = []
    @State private var showingPlan = false
    @State private var showingJobReview = false
    @State private var planSheetDismissed = true
    @State private var reviewAfterPlanDismissal = false

    var body: some View {
        Group {
            if let detail = manager.detail {
                GeometryReader { proxy in
                    if proxy.size.width >= 760 {
                        HStack(spacing: 0) {
                            worktreeList(detail).frame(width: min(330, proxy.size.width * 0.36))
                            Divider()
                            detailPane(detail)
                        }
                    } else {
                        detailPane(detail)
                    }
                }
            } else if manager.loading {
                ProgressView("正在读取 Worktree…")
            } else {
                ContentUnavailableView("无法读取仓库", systemImage: "externaldrive.badge.exclamationmark",
                    description: Text(manager.errorMessage ?? "请稍后重试。"))
            }
        }
        .navigationTitle(repository.name)
        .toolbar { toolbar }
        .task(id: repository.id) { await manager.load(repository.id, connection: connection) }
        .sheet(item: $operationDraft) { draft in
            PadWorktreeOperationSheet(draft: draft) { confirmed in
                Task { await manager.execute(confirmed, connection: connection) }
            }
        }
        .sheet(isPresented: $showingPlan, onDismiss: {
            planSheetDismissed = true
            if reviewAfterPlanDismissal {
                reviewAfterPlanDismissal = false
                showingJobReview = true
            }
        }) {
            if let project = manager.detail?.project {
                PadWorktreePlanSheet(project: project) { operation, sources, target in
                    Task {
                        let previousJobID = manager.job?.id
                        await manager.preparePlan(operation: operation, sources: sources,
                                                  target: target, replacingDraft: true, connection: connection)
                        if manager.job?.id != previousJobID, manager.job?.status == "awaiting_confirmation" {
                            if planSheetDismissed { showingJobReview = true }
                            else { reviewAfterPlanDismissal = true }
                        }
                    }
                }
                .onAppear { planSheetDismissed = false }
            }
        }
        .sheet(isPresented: $showingJobReview) {
            if let job = manager.job {
                PadWorktreeJobReview(job: job,
                    confirm: { decisions in await manager.jobAction("confirm", decisions: decisions, reviewedJob: job, connection: connection) },
                    cancel: { await manager.jobAction("cancel", reviewedJob: job, connection: connection) })
            }
        }
        .confirmationDialog("删除 Worktree？", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        ), titleVisibility: .visible) {
            if let worktree = pendingDelete {
                Button("删除 Worktree 与本地分支", role: .destructive) {
                    pendingDelete = nil
                    Task { await manager.delete(worktree, connection: connection) }
                }
            }
            Button("取消", role: .cancel) { pendingDelete = nil }
        } message: {
            Text("不会执行远程 Git 推送，也不会删除 GitHub 上的分支。")
        }
        .confirmationDialog("清理已合并 Worktree？", isPresented: Binding(
            get: { !pendingCleanup.isEmpty }, set: { if !$0 { pendingCleanup = [] } }
        ), titleVisibility: .visible) {
            Button("清理 \(pendingCleanup.count) 个 Worktree", role: .destructive) {
                let targets = pendingCleanup; pendingCleanup = []
                Task { await manager.cleanup(targets, connection: connection) }
            }
            Button("取消", role: .cancel) { pendingCleanup = [] }
        } message: {
            Text("将删除：\n" + pendingCleanup.map { "\($0.branchName ?? $0.worktreeId) · \($0.path)" }.joined(separator: "\n")
                + "\n不会删除远程分支。")
        }
        .confirmationDialog("与主分支同步？", isPresented: Binding(
            get: { pendingSync != nil }, set: { if !$0 { pendingSync = nil } }
        ), titleVisibility: .visible) {
            if let worktree = pendingSync {
                Button("同步 \(worktree.branchName ?? worktree.worktreeId)") {
                    pendingSync = nil
                    Task { await manager.synchronize(worktree, connection: connection) }
                }
            }
            Button("取消", role: .cancel) { pendingSync = nil }
        } message: { Text("将更新本地分支，不会推送到远程。") }
        .alert("Worktree 操作提示", isPresented: Binding(
            get: { manager.errorMessage != nil },
            set: { if !$0 { manager.errorMessage = nil } }
        )) { Button("好", role: .cancel) {} } message: { Text(manager.errorMessage ?? "") }
        .alert("操作完成", isPresented: Binding(
            get: { manager.notice != nil }, set: { if !$0 { manager.notice = nil } }
        )) { Button("好", role: .cancel) {} } message: { Text(manager.notice ?? "") }
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .primaryAction) {
            if manager.loading || manager.planning { ProgressView().controlSize(.small) }
            Menu {
                if let targets = cleanupTargets, !targets.isEmpty {
                    Button("清理 \(targets.count) 个已合并 Worktree", systemImage: "trash", role: .destructive) {
                        pendingCleanup = targets
                    }
                }
            } label: { Label("管理", systemImage: "ellipsis.circle") }
            .disabled(manager.detail == nil || manager.planning || manager.jobBusy)
            Button("刷新", systemImage: "arrow.clockwise") {
                Task { await manager.load(repository.id, connection: connection, force: true) }
            }.disabled(manager.loading)
        }
    }

    private func worktreeList(_ detail: ClientManagedRepositoryDetail) -> some View {
        List(selection: Binding(get: { manager.selectedWorktreeID }, set: { id in
            guard let id else { return }
            Task { await manager.select(id, connection: connection) }
        })) {
            Section {
                ForEach(detail.project.worktrees) { worktree in
                    worktreeRow(worktree).tag(worktree.worktreeId)
                }
            } header: {
                Text("\(detail.project.worktrees.count) 个 Worktree")
            }
        }
        .listStyle(.sidebar)
    }

    private func worktreeRow(_ worktree: ClientManagedWorktree) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: worktree.isMain ? "house.fill" : "arrow.triangle.branch")
                    .foregroundStyle(worktree.isMain ? Color.accentColor : Color.secondary)
                Text(worktree.branchName ?? "游离 HEAD").lineLimit(1)
                Spacer()
                if manager.busyWorktreeIDs.contains(worktree.worktreeId) { ProgressView().controlSize(.mini) }
            }
            worktreeStatusControls(worktree)
            Text(worktree.path).font(.caption2.monospaced()).foregroundStyle(.secondary).lineLimit(1)
        }
        .padding(.vertical, 3)
    }

    private func detailPane(_ detail: ClientManagedRepositoryDetail) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                if detail.project.worktrees.count > 1 {
                    Picker("Worktree", selection: Binding(get: { manager.selectedWorktreeID ?? "" }, set: { id in
                        Task { await manager.select(id, connection: connection) }
                    })) {
                        ForEach(detail.project.worktrees) { worktree in
                            Text(worktree.branchName ?? worktree.path).tag(worktree.worktreeId)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                integrationActions(detail.project)
                if let worktree = manager.selectedWorktree {
                    worktreeOverview(worktree)
                    worktreeChanges(worktree)
                    worktreeAssociations(worktree)
                    worktreeActions(worktree)
                }
                if let service = manager.service { serviceCard(service) }
                if let job = manager.job { jobCard(job) }
            }
            .padding(20)
            .frame(maxWidth: 820, alignment: .leading)
        }
        .refreshable { await manager.load(repository.id, connection: connection, force: true) }
    }

    private func integrationActions(_ project: ClientManagedGitProject) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: prepareAllPending) {
                Label("一键合并至 main", systemImage: "arrow.triangle.merge")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(project.pendingWorktreeCount == 0 || manager.planning || manager.jobBusy
                || ["queued", "running", "paused", "cancellation_requested", "replanning"].contains(manager.job?.status ?? ""))
            .accessibilityIdentifier("worktree.integrate.preflight")

            HStack {
                Text("\(project.pendingWorktreeCount) 个待合并 Worktree")
                    .font(.footnote).foregroundStyle(.secondary)
                Spacer()
                Button("自选范围…") { showingPlan = true }
                    .font(.footnote)
                    .disabled(manager.planning || manager.jobBusy)
            }
            Text("先生成审查计划，确认后才会依次本地合并；不会推送到远程。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func prepareAllPending() {
        Task {
            let previousJobID = manager.job?.id
            await manager.preparePlan(replacingDraft: true, connection: connection)
            if manager.job?.id != previousJobID, manager.job?.status == "awaiting_confirmation" {
                showingJobReview = true
            }
        }
    }

    private func worktreeOverview(_ worktree: ClientManagedWorktree) -> some View {
        card("状态", systemImage: "info.circle") {
            worktreeStatusControls(worktree)
            infoRow("分支", worktree.branchName ?? "游离 HEAD", monospaced: true)
            infoRow("路径", worktree.path, monospaced: true)
            if let oid = worktree.headOid { infoRow("HEAD", String(oid.prefix(12)), monospaced: true) }
            infoRow("与主分支", "领先 \(worktree.aheadOfMain ?? 0) · 落后 \(worktree.behindMain ?? 0)")
            if let summary = worktree.statusSummary, !summary.isEmpty { Text(summary).font(.footnote).foregroundStyle(.secondary) }
            if let operation = worktree.operationState { Label("正在进行 Git 操作：\(operation)", systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
            if worktree.isLocked { Label(worktree.lockReason ?? "Worktree 已锁定", systemImage: "lock.fill").foregroundStyle(.orange) }
        }
    }

    @ViewBuilder private func worktreeChanges(_ worktree: ClientManagedWorktree) -> some View {
        if !worktree.changedFiles.isEmpty || !worktree.conflictFiles.isEmpty {
            card("文件", systemImage: "doc.on.doc") {
                if let stat = worktree.diffStat { Text(stat).font(.caption.monospaced()).foregroundStyle(.secondary) }
                ForEach(worktree.conflictFiles, id: \.self) { file in
                    Label(file, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.red).font(.footnote.monospaced())
                }
                ForEach(worktree.changedFiles.prefix(80), id: \.self) { file in
                    Text(file).font(.footnote.monospaced()).textSelection(.enabled)
                }
                if worktree.changedFiles.count > 80 { Text("另有 \(worktree.changedFiles.count - 80) 个文件").foregroundStyle(.secondary) }
            }
        }
    }

    @ViewBuilder private func worktreeAssociations(_ worktree: ClientManagedWorktree) -> some View {
        if !worktree.associations.isEmpty {
            card("关联会话与 Task", systemImage: "link") {
                ForEach(Array(worktree.associations.enumerated()), id: \.offset) { _, association in
                    Button {
                        if let session = association.sessionId { openSession(session) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(association.taskTitle ?? association.title ?? association.logicalSessionId)
                                if let task = association.taskId { Text(task).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            if association.active { statusPill("活跃", color: .green) }
                            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(association.sessionId == nil)
                }
            }
        }
    }

    private func worktreeActions(_ worktree: ClientManagedWorktree) -> some View {
        card("操作", systemImage: "wrench.and.screwdriver") {
            let busy = manager.busyWorktreeIDs.contains(worktree.worktreeId)
            if worktree.isMain {
                Button("提交主 Worktree 修改", systemImage: "checkmark.circle") { prepare(worktree) }
                    .disabled(busy || worktree.dirty != true)
            } else {
                Button("提交、同步、合并…", systemImage: "arrow.triangle.merge") { prepare(worktree) }.disabled(busy)
                Button("仅与主分支同步", systemImage: "arrow.triangle.2.circlepath") {
                    pendingSync = worktree
                }.disabled(busy || worktree.availability != "available" || (worktree.behindMain ?? 0) == 0)
            }
            if let push = manager.pushStatuses[worktree.worktreeId] {
                Button("推送到 GitHub", systemImage: "arrow.up.circle") {
                    Task { await manager.push(worktree, connection: connection) }
                }
                .disabled(busy || !push.available || !push.pending)
                if let destination = push.destinationUrl { Text(destination).font(.caption).foregroundStyle(.secondary).textSelection(.enabled) }
                if let error = push.error { Text(error).font(.caption).foregroundStyle(.orange) }
            }
            Divider()
            Button("删除 Worktree 与本地分支", systemImage: "trash", role: .destructive) {
                if deletionBlocker(worktree) == nil { pendingDelete = worktree }
                else { manager.errorMessage = deletionBlocker(worktree) }
            }.disabled(busy || worktree.isMain)
        }
    }

    private func serviceCard(_ status: ClientDevelopmentServiceStatus) -> some View {
        card("开发服务", systemImage: "server.rack") {
            HStack {
                statusPill(serviceLabel(status.service), color: status.service.healthy == true ? .green : status.service.running == true ? .orange : .secondary)
                if status.toolset.requiresUpdate { statusPill("Toolset 待更新", color: .orange) }
                else if status.toolset.installed { statusPill("Toolset 已安装", color: .green) }
            }
            Picker("服务配置", selection: Binding(get: { status.toolset.selectedProfile }, set: { profile in
                Task { await manager.serviceAction(status.toolset.installed ? "profile" : "initialize",
                                                   profileID: profile, connection: connection) }
            })) {
                ForEach(status.toolset.profiles) { profile in Text(profile.label).tag(profile.id) }
            }
            .disabled(manager.serviceBusy || status.toolset.profiles.isEmpty)
            HStack {
                if status.service.running == true {
                    Button("重新构建并启动", systemImage: "hammer") {
                        Task { await manager.serviceAction("restart", profileID: status.toolset.selectedProfile, connection: connection) }
                    }
                    Button("停止", systemImage: "stop.fill", role: .destructive) {
                        Task { await manager.serviceAction("stop", connection: connection) }
                    }
                } else {
                    Button("构建并启动", systemImage: "play.fill") {
                        Task { await manager.serviceAction("start", profileID: status.toolset.selectedProfile, connection: connection) }
                    }
                }
            }.disabled(manager.serviceBusy || !status.toolset.configured)
            Button(status.toolset.requiresUpdate ? "更新 Corptie Scripts Toolset" : "初始化 Toolset",
                   systemImage: "shippingbox") {
                Task { await manager.serviceAction(status.toolset.requiresUpdate ? "update" : "initialize",
                                                   profileID: status.toolset.selectedProfile, connection: connection) }
            }.disabled(manager.serviceBusy || (status.toolset.installed && !status.toolset.requiresUpdate))
            if let error = status.service.configurationError { Text(error).font(.footnote).foregroundStyle(.orange) }
            if let detail = status.service.verificationDetail { Text(detail).font(.footnote).foregroundStyle(.secondary) }
        }
    }

    private func jobCard(_ job: ClientWorktreeJob) -> some View {
        card("集成任务", systemImage: "arrow.triangle.merge") {
            HStack {
                statusPill(jobStatus(job.status), color: job.status == "completed" ? .green : job.status == "failed" ? .red : .blue)
                Text("\(job.progress.completed) / \(job.progress.total)").foregroundStyle(.secondary)
            }
            ProgressView(value: job.progress.fraction)
            Text("阶段：\(job.phase)").font(.footnote).foregroundStyle(.secondary)
            ForEach(job.plan.blockingRisks, id: \.code) { risk in
                Label(risk.message, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.orange)
            }
            ForEach(job.plan.items) { item in
                HStack(alignment: .top) {
                    Text(item.branchName ?? item.worktreeId).lineLimit(1)
                    Spacer()
                    Text("提交 \(item.commitStatus) · 合并 \(item.mergeStatus)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let error = item.error, !error.isEmpty {
                    Text(error).font(.caption).foregroundStyle(.red)
                }
            }
            if job.hasMergeConflict {
                Label("存在合并冲突。请先处理冲突，再重新验证；不要重复生成计划。",
                      systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote).foregroundStyle(.orange)
            }
            if let error = job.error { Text(error).font(.footnote).foregroundStyle(.red) }
            HStack {
                if job.status == "awaiting_confirmation" {
                    Button("查看并确认计划", systemImage: "checkmark.seal") { showingJobReview = true }
                }
                if job.status == "paused" {
                    Button("重新验证并继续", systemImage: "arrow.clockwise") {
                        Task { await manager.jobAction("retry", connection: connection) }
                    }
                    if job.hasMergeConflict {
                        Button("交给 Agent 解决冲突", systemImage: "person.crop.circle.badge.gearshape") {
                            Task { await manager.jobAction("resolve-conflict", connection: connection) }
                        }
                    }
                }
                if job.canCancel {
                    Button("取消任务", role: .destructive) {
                        Task { await manager.jobAction("cancel", connection: connection) }
                    }
                }
            }.disabled(manager.jobBusy || manager.planning)
            if let session = job.conflictResolution?.sessionId ?? job.conflictAutomation?.sessionId {
                Button("查看冲突处理会话", systemImage: "bubble.left.and.bubble.right") { openSession(session) }
            }
        }
    }

    private func prepare(_ worktree: ClientManagedWorktree) {
        Task {
            if let draft = await manager.prepareOperation(worktree, connection: connection) { operationDraft = draft }
        }
    }

    private var cleanupTargets: [ClientManagedWorktree]? {
        manager.detail?.project.worktrees.filter { !$0.isMain && deletionBlocker($0) == nil }
    }

    private func deletionBlocker(_ worktree: ClientManagedWorktree) -> String? {
        if let blocker = worktree.deletionBlocker { return blocker.reason }
        if worktree.isMain { return "主 Worktree 不能删除。" }
        if worktree.availability != "available" { return "Worktree 当前不可用。" }
        if worktree.isLocked { return worktree.lockReason ?? "Worktree 已锁定。" }
        if worktree.operationState != nil { return "Worktree 正在进行 Git 操作。" }
        if !worktree.conflictFiles.isEmpty { return "请先解决冲突。" }
        if worktree.dirty != false { return "请先提交或放弃未提交修改。" }
        if worktree.mergedIntoMain != true { return "请先合并到主分支。" }
        if !worktree.associations.isEmpty { return "请先移动或结束关联的会话与 Task。" }
        return nil
    }

    private func worktreeLabel(_ worktree: ClientManagedWorktree) -> String {
        if worktree.availability != "available" { return "不可用" }
        if worktree.operationState != nil { return "操作中" }
        if worktree.dirty == true { return "未提交" }
        if worktree.isMain { return "干净" }
        if worktree.pendingIntegration { return "待合并" }
        if worktree.mergedIntoMain == true { return "已合并" }
        return "待合并"
    }
    private func worktreeColor(_ worktree: ClientManagedWorktree) -> Color {
        if worktree.availability != "available" { return .red }
        if worktree.operationState != nil || worktree.dirty == true { return .orange }
        if worktree.isMain { return .green }
        if worktree.pendingIntegration { return .blue }
        if worktree.mergedIntoMain == true { return .purple }
        return .secondary
    }

    private func worktreeStatusControls(_ worktree: ClientManagedWorktree) -> some View {
        HStack(spacing: 6) {
            if worktree.isMain { statusPill("main", color: .blue) }
            if worktree.isMain && worktree.dirty != true {
                statusPill(worktreeLabel(worktree), color: worktreeColor(worktree))
            } else {
                operationStatus(worktreeLabel(worktree), color: worktreeColor(worktree), worktree: worktree)
                    .accessibilityIdentifier("worktree.operation.\(worktree.worktreeId)")
            }
            if !worktree.isMain {
                if worktree.synchronizedWithMain == true {
                    statusPill("已同步", color: .green)
                } else {
                    operationStatus("未同步", color: .orange, worktree: worktree)
                        .accessibilityIdentifier("worktree.synchronize.\(worktree.worktreeId)")
                }
            }
        }
    }

    private func operationStatus(_ title: String, color: Color, worktree: ClientManagedWorktree) -> some View {
        Button { prepare(worktree) } label: {
            statusPill(title, color: color)
                .frame(minHeight: 32)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("打开 Worktree 操作")
        .disabled(!manager.busyWorktreeIDs.isEmpty || manager.planning
                  || worktree.availability != "available" || worktree.operationState != nil)
    }
    private func serviceLabel(_ service: ClientProjectServiceStatus) -> String {
        if service.running == true, service.healthy == true { return "运行正常" }
        if service.running == true { return "运行异常" }
        return "已停止"
    }
    private func jobStatus(_ value: String) -> String {
        ["awaiting_confirmation": "等待确认", "queued": "已排队", "running": "执行中",
         "paused": "已暂停", "completed": "已完成", "failed": "失败",
         "cancellation_requested": "正在取消", "cancelled": "已取消", "replanning": "正在重建计划"][value] ?? value
    }

    private func card<Content: View>(_ title: String, systemImage: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: systemImage).font(.headline)
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func infoRow(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary).frame(width: 76, alignment: .leading)
            Text(value).font(monospaced ? .footnote.monospaced() : .body).textSelection(.enabled)
        }
    }

    private func statusPill(_ text: String, color: Color) -> some View {
        Text(text).font(.caption.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(color.opacity(0.12), in: Capsule())
    }
}

private struct PadWorktreeOperationSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: PadWorktreeOperationDraft
    let confirm: (PadWorktreeOperationDraft) -> Void
    var body: some View {
        NavigationStack {
            Form {
                Section("Worktree") {
                    LabeledContent("分支", value: draft.worktree.branchName ?? "游离 HEAD")
                    Text(draft.worktree.path).font(.caption.monospaced()).textSelection(.enabled)
                }
                if draft.worktree.dirty == true && (draft.worktree.isMain || draft.mergeIntoMain) {
                    Section("提交修改") {
                        TextField("提交信息", text: $draft.commitMessage, axis: .vertical).lineLimit(3...6)
                        if draft.protection?.requiresDecision == true {
                            Picker("私密文件", selection: Binding(get: { draft.privateFilesDecision ?? "" },
                                                                  set: { draft.privateFilesDecision = $0 })) {
                                Text("请选择处理方式").tag("")
                                Text("忽略并继续").tag("ignore")
                                Text("包含并继续").tag("include")
                            }
                            Toggle("以后不再提醒", isOn: $draft.neverRemindPrivateFiles)
                            ForEach(draft.protection?.protectedPaths ?? [], id: \.self) { Text($0).font(.caption.monospaced()) }
                        }
                    }
                }
                if !draft.worktree.isMain {
                    Section("执行") {
                        Toggle("与主分支同步", isOn: $draft.synchronizeWithMain)
                            .disabled(draft.mergeIntoMain)
                        Toggle("合并到主分支", isOn: $draft.mergeIntoMain)
                            .onChange(of: draft.mergeIntoMain) { _, merge in
                                if merge { draft.synchronizeWithMain = true }
                            }
                        Toggle("完成后重启开发服务", isOn: $draft.restartService)
                    }
                }
            }
            .navigationTitle(draft.worktree.isMain ? "提交修改" : "Worktree 操作")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("执行") { confirm(draft); dismiss() }
                        .disabled(!draft.canExecute)
                }
            }
        }.presentationDetents([.medium, .large])
    }
}

enum PadWorktreePlanDefaults {
    static func eligible(_ tree: ClientManagedWorktree) -> Bool {
        !tree.isMain && tree.availability == "available" && tree.branchName != nil
            && !tree.isDetached && tree.operationState == nil && tree.conflictFiles.isEmpty
    }
    static func sources(in project: ClientManagedGitProject) -> [String] {
        project.worktrees.filter { eligible($0) && $0.pendingIntegration }.map(\.worktreeId)
    }
}

private struct PadWorktreePlanSheet: View {
    @Environment(\.dismiss) private var dismiss
    let project: ClientManagedGitProject
    let submit: (ClientWorktreePlanOperation, [String], String) -> Void
    @State private var operation = ClientWorktreePlanOperation.merge
    @State private var sources: [String]
    @State private var target: String

    init(project: ClientManagedGitProject, submit: @escaping (ClientWorktreePlanOperation, [String], String) -> Void) {
        self.project = project
        self.submit = submit
        _sources = State(initialValue: PadWorktreePlanDefaults.sources(in: project))
        _target = State(initialValue: project.mainWorktreeId)
    }

    var body: some View {
        NavigationStack {
            Form {
                Picker("操作", selection: $operation) {
                    Text("按顺序合并").tag(ClientWorktreePlanOperation.merge)
                    Text("仅同步分支").tag(ClientWorktreePlanOperation.synchronize)
                    Text("收敛到目标分支").tag(ClientWorktreePlanOperation.converge)
                }
                Section("来源 Worktree") {
                    HStack {
                        Button("全选待合并") { sources = PadWorktreePlanDefaults.sources(in: project) }
                        Spacer()
                        Button("清空") { sources = [] }
                    }
                    .font(.footnote)
                    ForEach(project.worktrees.filter { PadWorktreePlanDefaults.eligible($0) }) { tree in
                        Toggle(tree.branchName ?? tree.path, isOn: Binding(
                            get: { sources.contains(tree.worktreeId) },
                            set: { enabled in
                                if enabled, !sources.contains(tree.worktreeId) { sources.append(tree.worktreeId) }
                                else if !enabled { sources.removeAll { $0 == tree.worktreeId } }
                            }
                        ))
                    }
                }
                if sources.count > 1 {
                    Section("执行顺序") {
                        ForEach(sources, id: \.self) { id in
                            Text(project.worktrees.first { $0.worktreeId == id }?.branchName ?? id)
                        }
                        .onMove { offsets, destination in sources.move(fromOffsets: offsets, toOffset: destination) }
                    }
                }
                Section("目标") {
                    Picker("目标分支", selection: $target) {
                        ForEach(project.worktrees.filter { $0.availability == "available" && $0.branchName != nil && !$0.isDetached && $0.operationState == nil && $0.conflictFiles.isEmpty }) { tree in
                            Text(tree.branchName ?? tree.path).tag(tree.worktreeId)
                        }
                    }
                }
            }
            .navigationTitle("生成集成计划")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("生成审查计划") { submit(operation, sources, target); dismiss() }
                        .disabled((try? ClientWorktreePlanRequest(operation: operation, sources: sources, target: target)) == nil
                            || sources.contains(target))
                }
            }
        }.presentationDetents([.large])
    }
}

private struct PadWorktreeJobReview: View {
    @Environment(\.dismiss) private var dismiss
    let job: ClientWorktreeJob
    let confirm: ([ClientWorktreeCommitDecision]) async -> Bool
    let cancel: () async -> Bool
    @State private var decisions: [String: String] = [:]
    @State private var neverRemind: Set<String> = []
    @State private var submitting = false
    var body: some View {
        NavigationStack {
            List {
                Section("计划") {
                    LabeledContent("操作", value: job.plan.operationType ?? "merge")
                    LabeledContent("目标", value: job.plan.targetBranchName ?? "main")
                    LabeledContent("Worktree", value: "\(job.plan.items.count)")
                    Text("仅执行本地操作，不会推送到远程。请检查来源、顺序及受保护文件，再确认。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !job.plan.mergeOrder.isEmpty {
                    Section("执行顺序") {
                        ForEach(Array(job.plan.mergeOrder.enumerated()), id: \.offset) { index, id in
                            Text("\(index + 1). \(job.plan.items.first { $0.worktreeId == id }?.branchName ?? id)")
                        }
                    }
                }
                if !job.plan.blockingRisks.isEmpty {
                    Section("阻塞风险") {
                        ForEach(job.plan.blockingRisks, id: \.code) { risk in
                            Label(risk.message, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                        }
                    }
                }
                ForEach(job.plan.items) { item in
                    Section(item.branchName ?? item.path) {
                        Text(item.path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                        Text(item.statusSummary).font(.footnote)
                        LabeledContent("领先 / 落后", value: "\(item.aheadOfMain ?? 0) / \(item.behindMain ?? 0)")
                        LabeledContent("提交", value: item.commitStatus)
                        LabeledContent("合并", value: item.mergeStatus)
                        if let commitMessage = item.commitMessage, !commitMessage.isEmpty {
                            LabeledContent("提交信息", value: commitMessage)
                        }
                        if !item.changedFiles.isEmpty {
                            DisclosureGroup("修改文件（\(item.changedFiles.count)）") {
                                ForEach(item.changedFiles, id: \.self) { Text($0).font(.caption.monospaced()) }
                            }
                        }
                        if !item.associations.isEmpty {
                            DisclosureGroup("关联会话与 Task（\(item.associations.count)）") {
                                ForEach(item.associations, id: \.logicalSessionId) { association in
                                    Text(association.taskTitle ?? association.title ?? association.logicalSessionId)
                                        .font(.footnote)
                                }
                            }
                        }
                        ForEach(item.risks, id: \.code) { risk in
                            Label(risk.message, systemImage: "exclamationmark.triangle")
                                .font(.footnote).foregroundStyle(.orange)
                        }
                        if !item.conflictFiles.isEmpty {
                            Label("有 \(item.conflictFiles.count) 个冲突文件", systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(.red)
                        }
                        if item.commitProtection?.requiresDecision == true {
                            Picker("私密文件", selection: Binding(get: { decisions[item.worktreeId] ?? "" },
                                                                  set: { decisions[item.worktreeId] = $0 })) {
                                Text("请选择处理方式").tag("")
                                Text("忽略").tag("ignore"); Text("包含").tag("include")
                            }
                            ForEach(item.commitProtection?.protectedPaths ?? [], id: \.self) { Text($0).font(.caption.monospaced()) }
                            Toggle("以后不再提醒", isOn: Binding(
                                get: { neverRemind.contains(item.worktreeId) },
                                set: { enabled in
                                    if enabled { neverRemind.insert(item.worktreeId) } else { neverRemind.remove(item.worktreeId) }
                                }
                            ))
                        }
                    }
                }
            }
            .navigationTitle("审查集成计划")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消计划") {
                        submitting = true
                        Task { if await cancel() { dismiss() }; submitting = false }
                    }.disabled(submitting || job.status != "awaiting_confirmation")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("确认并执行") {
                        let selected = job.plan.items.compactMap { item -> ClientWorktreeCommitDecision? in
                            guard item.commitProtection?.requiresDecision == true else { return nil }
                            return ClientWorktreeCommitDecision(worktreeId: item.worktreeId,
                                decision: decisions[item.worktreeId] ?? "",
                                neverRemind: neverRemind.contains(item.worktreeId))
                        }
                        submitting = true
                        Task { if await confirm(selected) { dismiss() }; submitting = false }
                    }.disabled(!job.plan.blockingRisks.isEmpty || job.status != "awaiting_confirmation"
                               || submitting || job.plan.items.contains { item in
                                   item.commitProtection?.requiresDecision == true
                                       && !["ignore", "include"].contains(decisions[item.worktreeId] ?? "")
                               })
                }
            }
        }
        .interactiveDismissDisabled(job.status == "awaiting_confirmation")
    }
}
