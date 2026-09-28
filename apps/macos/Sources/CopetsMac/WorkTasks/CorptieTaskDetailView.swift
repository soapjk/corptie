import SwiftUI
import CorptieClientCore
import CorptieConversation

struct CorptieTaskDetailView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backendClient = BackendClient.shared
    @EnvironmentObject private var router: AppTabRouter
    let task: CorptieTask
    let contributorAgentIds: [String]
    var isDeletionPending = false
    var onRequestDeletion: (() -> Void)?
    var onRequestReload: () -> Void = {}
    var showsHeader = true
    var embedsInParentScroll = false

    @State private var currentSession: CorptieTaskSessionSummary?
    @State private var memories: [MemoryItem] = []
    @State private var showAgentPicker = false
    @State private var showAgentSwitch = false
    @State private var executionAgentIds = Set<String>()
    @State private var executionError: EntityLaunchError?
    @State private var showEdit = false
    @State private var showCompleteConfirmation = false
    @State private var isLaunchingExecution = false
    @State private var sessionCreationAgent: Agent?
    @State private var worktreeStatus: CorptieTaskWorktreeStatus?
    @State private var isLoadingWorktree = false
    @State private var isReclaimingWorktree = false
    @State private var showReclaimConfirmation = false
    @State private var deletionPlan: CorptieTaskDeletionPlan?
    @State private var showDeletion = false
    @State private var isInspectingDeletion = false
    @State private var isDeletingCorptieTask = false
    @State private var deletionFeedback: String?
    @State private var showAcceptanceReview = false
    @State private var isRejectingAcceptance = false
    @State private var acceptanceRejectionError: String?

    var body: some View {
        VStack(spacing: 0) {
            if showsHeader {
                detailHeader

                Divider()
                    .opacity(0.5)
            }

            if embedsInParentScroll {
                detailContent
            } else {
                ScrollView {
                    detailContent
                }
            }
        }
        .task(id: task) {
            // 以 task 作为 task 标识：当父层重新拉取、currentSessionId 等字段变化时，
            // 本视图会拿到新的 task 值并重新刷新「当前执行」，避免依赖陈旧的 currentSessionId。
            await refreshExecution()
            if isCompleted { await refreshWorktree() }
        }
        .sheet(isPresented: $showEdit) {
            CorptieTaskEditView(task: task) {
                onRequestReload()
            }
        }
        .sheet(isPresented: $showAgentPicker) {
            AgentPickerView(
                selectedIds: $executionAgentIds,
                allowedAgentIds: Set(contributorAgentIds),
                onDone: { selection in
                if let agentId = selection.first {
                    Task {
                        await createExecutionSession(agentId: agentId)
                    }
                }
            })
        }
        .sheet(isPresented: $showAgentSwitch) {
            AgentPickerView(
                selectedIds: $executionAgentIds,
                allowedAgentIds: Set(contributorAgentIds),
                onDone: { selection in
                if let agentId = selection.first {
                    Task {
                        _ = await client.updateCorptieTask(taskId: task.id, mainAgentId: agentId)
                        await refreshExecution()
                        onRequestReload()
                    }
                }
            })
        }
        .sheet(item: $sessionCreationAgent) { agent in
            NewSessionCreationSheet(
                fixedAgent: agent,
                fixedCorptieTask: task,
                submitsInBackground: true
            ) { _ in
                Task {
                    await refreshExecution()
                    onRequestReload()
                }
            }
        }
        .alert(L10n("执行失败"), isPresented: Binding(
            get: { executionError != nil },
            set: { if !$0 { executionError = nil } }
        )) {
            Button(L10n("好"), role: .cancel) { executionError = nil }
        } message: {
            Text(executionError?.message ?? "")
        }
        .sheet(isPresented: $showCompleteConfirmation) {
            CorptieTaskCompletionConfirmationView(
                task: task,
                assessment: task.acceptanceAssessment,
                suggestion: task.completionSuggestion,
                onConfirm: { enqueueCompletion() },
                onCancel: {
                    showCompleteConfirmation = false
                }
            )
        }
        .sheet(isPresented: $showAcceptanceReview) {
            CorptieTaskAcceptanceReviewView(
                task: task,
                isRejecting: isRejectingAcceptance,
                rejectionError: acceptanceRejectionError,
                onClose: { showAcceptanceReview = false },
                onReject: { rejectAutomaticAcceptance() }
            )
        }
        .sheet(isPresented: $showDeletion) {
            if let deletionPlan {
                CorptieTaskDeletionConfirmationView(
                    task: task,
                    plan: deletionPlan,
                    onCancel: { showDeletion = false },
                    onMergeFirst: {
                        showDeletion = false
                        deletionFeedback = L10n("Merge the Task Worktree into the target branch before deleting it.")
                    },
                    onDelete: { force, branch, deleteWorktree, artifactDisposition in
                        deleteTask(
                            force: force,
                            confirmedBranchName: branch,
                            deleteWorktree: deleteWorktree,
                            artifactDisposition: artifactDisposition
                        )
                    }
                )
            }
        }
        .alert(L10n("Task deletion"), isPresented: Binding(
            get: { deletionFeedback != nil },
            set: { if !$0 { deletionFeedback = nil } }
        )) {
            Button(L10n("OK"), role: .cancel) { deletionFeedback = nil }
        } message: {
            Text(deletionFeedback ?? "")
        }
        .confirmationDialog(
            L10n("Reclaim this Worktree?"),
            isPresented: $showReclaimConfirmation,
            titleVisibility: .visible
        ) {
            Button(L10n("Reclaim Worktree"), role: .destructive) {
                Task { await reclaimWorktree() }
            }
            Button(L10n("Cancel"), role: .cancel) {}
        } message: {
            Text(L10n("The merged Worktree and its local branch will be removed. Session history will be archived and preserved."))
        }
    }

    private var detailContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            if task.userSummary?.content != nil {
                TaskSummaryView(task: task)
            }
            if hasTaskDefinitionContent {
                taskDefinitionSection
            }

            if isCompleted {
                Divider()
                worktreeSection
            }

            Divider()

            taskResourcesSection
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
    }

    private var detailHeader: some View {
        HStack(spacing: 8) {
            Image(systemName: "square.text.square")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Color.accentColor)
            Text(verbatim: "Detail")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Button {
                showEdit = true
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .help(L10n("编辑工作项"))
            Menu {
                if let currentSession,
                   let liveSession = backendClient.sessions.first(where: { $0.id == currentSession.id }) {
                    Button(L10n("Restart"), systemImage: "arrow.clockwise") {
                        backendClient.restart(session: liveSession)
                    }
                    .disabled(liveSession.actions?.restart?.available != true)
                }
                Button(task.archived == true ? L10n("恢复 Task") : L10n("归档 Task"), systemImage: "archivebox") {
                    Task {
                        if await client.setTaskArchived(task.archived != true, taskId: task.id) == nil {
                            executionError = EntityLaunchError(message: client.errorMessage ?? L10n("归档失败"), code: nil)
                        }
                    }
                }
                .disabled(task.lifecycleState == "done" || isDeletionPending)
                Divider()
                Button(L10n("Delete Task"), systemImage: "trash", role: .destructive) {
                    if let onRequestDeletion {
                        onRequestDeletion()
                    } else {
                        inspectDeletion()
                    }
                }
                .disabled(isDeletionPending || isInspectingDeletion || isDeletingCorptieTask)
            } label: {
                if isDeletionPending || isInspectingDeletion || isDeletingCorptieTask {
                    ProgressView().controlSize(.small).frame(width: 24, height: 24)
                } else {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 12, weight: .medium))
                        .frame(width: 24, height: 24)
                }
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .help(L10n("Task Actions"))
        }
        .padding(.leading, 14)
        .padding(.trailing, 10)
        .padding(.vertical, 9)
    }

    private var overviewSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                compactStatusBadge(task.lifecycleState)
                metadataPill(priorityLabel, systemImage: "flag")
                if let origin = task.creationOrigin {
                    metadataPill(creationOriginLabel(origin), systemImage: "arrow.turn.down.right")
                        .help(creationOriginHelp(origin))
                }
            }

            switch acceptanceReviewState {
            case .passed:
                Button {
                    acceptanceRejectionError = nil
                    showAcceptanceReview = true
                } label: {
                    Label(L10n("自动验收已通过"), systemImage: "checkmark.seal.fill")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.green)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(Color.green.opacity(0.12), in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n("自动验收已通过"))
                .accessibilityHint(L10n("查看自动验收情况"))
            case .manuallyRejected:
                Label(L10n("人工验收未通过"), systemImage: "xmark.seal.fill")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.red)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
                    .background(Color.red.opacity(0.1), in: Capsule())
                    .accessibilityLabel(L10n("人工验收未通过"))
            case .unavailable:
                EmptyView()
            }
        }
    }

    private var taskDefinitionSection: some View {
        ConversationTaskDefinition(description: task.description,
            acceptance: task.acceptanceCriteria, verification: task.verificationCriteria,
            descriptionTitle: L10n("Description"), acceptanceTitle: L10n("Acceptance Criteria"),
            verificationTitle: L10n("Verification Criteria"),
            expandLabel: L10n("Expand"), collapseLabel: L10n("Collapse"))
    }

    private var hasTaskDefinitionContent: Bool {
        hasContent(task.description)
            || hasContent(task.acceptanceCriteria)
            || hasContent(task.verificationCriteria)
    }

    private func hasContent(_ text: String) -> Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var executionAndWorkspaceSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            executionSection

            if isCompleted {
                Divider()

                worktreeSection
            }
        }
    }

    private var taskResourcesSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            ArtifactSectionView(workId: task.workId, taskId: task.id)

            Divider()

            memorySection
        }
    }

    private func creationOriginLabel(_ origin: CorptieTaskCreationOrigin) -> String {
        switch origin.originType {
        case "direct_user": L10n("用户创建")
        case "session": L10n("Session 创建")
        case "system": L10n("系统创建")
        default: L10n("历史来源未知")
        }
    }

    private func creationOriginHelp(_ origin: CorptieTaskCreationOrigin) -> String {
        guard origin.originType == "session", let sessionID = origin.creatorSessionId else {
            return creationOriginLabel(origin)
        }
        return L10nFormat("创建 Session：%@；仅为来源记录，不构成父子或协作关系", sessionID)
    }

    private func detailTextSection(title: String, systemImage: String, text: String) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: systemImage)
                .detailRailSectionLabelStyle()
            CollapsibleDetailText(
                text: text,
                color: .secondary
            )
        }
    }

    private var executionSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(L10n("执行状态"), systemImage: "waveform.path.ecg")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                executionControlButton
            }

            HStack(spacing: 10) {
                Button {
                    executionAgentIds = []
                    showAgentSwitch = true
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: currentAgent?.isPlatformAssistant == true ? "sparkles" : "person.fill")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 22, height: 22)
                            .background(currentAgent?.isPlatformAssistant == true ? Color.accentColor : Color.blue, in: Circle())
                        Text(currentAgent?.name ?? L10n("Select an Agent"))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(currentAgent == nil ? .secondary : .primary)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                Spacer(minLength: 4)

                Text(CorptieTaskExecutionPresentation.label(
                    executionStatus: task.executionStatus,
                    sessionStatus: currentSession?.status
                ))
                    .font(.system(size: 9, weight: .medium))
                    .foregroundStyle(.secondary)

                if let currentSession {
                    Button {
                        router.openSession(currentSession.id, source: .userSelection)
                    } label: {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.plain)
                    .help(currentSession.title.isEmpty ? L10n("Open Session") : L10nFormat("Open: %@", currentSession.title))
                }
            }
        }
    }

    private var memorySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(L10n("工作项记忆"), systemImage: "brain.head.profile")
                    .detailRailSectionLabelStyle()
                Spacer()
                if !memories.isEmpty {
                    Text("\(memories.count)")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.tertiary)
                }
                Button {
                    TaskMemoryWindowManager.shared.show(taskID: task.id, title: task.title)
                } label: {
                    Image(systemName: "arrow.up.right.square")
                }
                .buttonStyle(.borderless)
                .help(L10n("Open Memory Inspector"))
            }
            if !memories.isEmpty {
                ForEach(memories) { memory in
                    VStack(alignment: .leading, spacing: 3) {
                        CollapsibleDetailText(
                            text: memory.content,
                            font: .system(size: 11),
                            color: .primary,
                            lineSpacing: 1
                        )
                        Text(kindLabel(memory.kind))
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    // 当前 CorptieTask 绑定的 Agent（依据 mainAgentId 从 agents 列表解析）。
    private var currentAgent: Agent? {
        guard let agentId = task.mainAgentId else { return nil }
        return client.agents.first { $0.agentId == agentId }
    }

    // 是否已完成：只看 CorptieTask 自身状态。Session complete 只代表一次执行落定，
    // 只有证据支持的验收建议经用户确认后 status 才为 done。
    private var isCompleted: Bool {
        task.lifecycleState == "done"
    }

    private var acceptanceReviewState: CorptieTaskAcceptanceReviewState {
        .resolve(task)
    }

    private func rejectAutomaticAcceptance() {
        guard !isRejectingAcceptance else { return }
        isRejectingAcceptance = true
        acceptanceRejectionError = nil
        Task {
            defer { isRejectingAcceptance = false }
            guard await client.rejectCorptieTaskAcceptance(taskId: task.id) != nil else {
                acceptanceRejectionError = client.errorMessage ?? L10n("Unable to reject automated acceptance")
                return
            }
            showAcceptanceReview = false
            onRequestReload()
        }
    }

    private func inspectDeletion() {
        guard !isInspectingDeletion, !isDeletingCorptieTask else { return }
        isInspectingDeletion = true
        Task {
            defer { isInspectingDeletion = false }
            guard let plan = await client.inspectCorptieTaskDeletion(taskId: task.id) else {
                deletionFeedback = client.errorMessage ?? L10n("Unable to inspect Task deletion.")
                return
            }
            deletionPlan = plan
            showDeletion = true
        }
    }

    private func deleteTask(
        force: Bool,
        confirmedBranchName: String?,
        deleteWorktree: Bool,
        artifactDisposition: CorptieTaskArtifactDisposition
    ) {
        guard !isDeletingCorptieTask else { return }
        showDeletion = false
        BackgroundTaskCenter.shared.start(
            id: "task.deletion.\(task.id)",
            title: L10nFormat("删除 CorptieTask：%@", task.title)
        ) {
            isDeletingCorptieTask = true
            let deleted = await client.deleteCorptieTask(
                taskId: task.id,
                force: force,
                confirmedBranchName: confirmedBranchName,
                deleteWorktree: deleteWorktree,
                artifactDisposition: artifactDisposition
            )
            isDeletingCorptieTask = false
            if deleted {
                await client.refreshWorks()
                onRequestReload()
                return .success(L10nFormat("CorptieTask“%@”已删除。", task.title))
            }
            return .failure(client.errorMessage ?? L10n("Unable to delete Task."))
        }
    }

    // 是否正在运行（当前会话正在执行或等待输入）。
    private var isRunning: Bool {
        guard let s = currentSession?.status else { return false }
        return ["running", "blocked"].contains(s)
    }

    @ViewBuilder
    private var worktreeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(L10n("Worktree"), systemImage: "arrow.triangle.branch")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer()
                if isLoadingWorktree || isReclaimingWorktree {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            if let status = worktreeStatus {
                switch status.status {
                case "retired":
                    Label(L10n("Worktree reclaimed"), systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.green)
                case "available":
                    if let worktree = status.worktree {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(worktree.branchName ?? worktree.path)
                                .font(.system(size: 10.5, design: .monospaced))
                                .lineLimit(1)
                                .truncationMode(.middle)
                            HStack(spacing: 6) {
                                worktreeBadge(
                                    worktree.mergedIntoMain == true ? L10n("Merged") : L10n("Not merged"),
                                    color: worktree.mergedIntoMain == true ? .green : .orange
                                )
                                if worktree.dirty == true {
                                    worktreeBadge(L10n("Uncommitted changes"), color: .orange)
                                }
                            }
                        }
                        if status.canReclaim {
                            Button {
                                showReclaimConfirmation = true
                            } label: {
                                Label(L10n("Reclaim Worktree"), systemImage: "trash")
                            }
                            .buttonStyle(.bordered)
                            .disabled(isReclaimingWorktree)
                        } else if let blocker = status.blocker {
                            Text(worktreeBlockerMessage(blocker))
                                .font(.system(size: 10.5))
                                .foregroundStyle(.orange)
                        }
                    }
                case "none":
                    Text(L10n("No dedicated Worktree"))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                default:
                    Text(status.detail ?? L10n("Worktree unavailable"))
                        .font(.system(size: 10.5))
                        .foregroundStyle(.orange)
                }
            } else if !isLoadingWorktree {
                Text(L10n("Unable to inspect the Worktree."))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.orange)
            }
        }
    }

    private func worktreeBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 9.5, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(color.opacity(0.09), in: Capsule())
    }

    private func worktreeBlockerMessage(_ blocker: String) -> String {
        switch blocker {
        case "UNCOMMITTED_CHANGES": L10n("Commit the Worktree changes before reclaiming it.")
        case "NOT_MERGED_INTO_MAIN", "INTEGRATION_PENDING": L10n("Merge this Worktree into main before reclaiming it.")
        case "SESSION_BUSY": L10n("Wait for the Session to finish before reclaiming its Worktree.")
        case "SHARED_WITH_ACTIVE_TASK": L10n("This Worktree is still used by an active CorptieTask.")
        default: L10n("This Worktree is not safe to reclaim yet.")
        }
    }

    private func refreshWorktree() async {
        guard !isLoadingWorktree else { return }
        isLoadingWorktree = true
        defer { isLoadingWorktree = false }
        worktreeStatus = await client.worktreeStatus(taskId: task.id)
    }

    private func reclaimWorktree() async {
        guard !isReclaimingWorktree else { return }
        isReclaimingWorktree = true
        defer { isReclaimingWorktree = false }
        if let status = await client.reclaimWorktree(taskId: task.id) {
            worktreeStatus = status
            await refreshExecution()
            onRequestReload()
        } else {
            executionError = EntityLaunchError(
                message: client.errorMessage ?? L10n("Unable to reclaim the Worktree."),
                code: nil
            )
        }
    }

    // Task 创建时已经自动启动伴生 Work Session，因此这里不再提供手动开始按钮。
    // 仅保留运行中的终止操作，以及已完成 Task 的显式恢复操作。
    @ViewBuilder
    private var executionControlButton: some View {
        if isCompleted {
            Button {
                Task { await startOrResumeExecution() }
            } label: {
                Image(systemName: "arrow.counterclockwise")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Color.accentColor, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(isLaunchingExecution)
            .help(L10n("Resume"))
        } else if isRunning {
            Button {
                Task { await interruptExecution() }
            } label: {
                Image(systemName: "stop.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 24, height: 24)
                    .background(Color.red, in: Circle())
            }
            .buttonStyle(.plain)
            .help(L10n("终止执行"))
        }
    }

    // 开始执行：已有会话则恢复；否则优先使用 CorptieTask 已绑定的 Agent，未绑定时才让用户选择。
    private func startOrResumeExecution() async {
        switch CorptieTaskExecutionStartDecision.resolve(
            status: task.lifecycleState,
            currentSessionId: currentSession?.id,
            mainAgentId: task.mainAgentId
        ) {
        case .restoreCompleted:
            guard !isLaunchingExecution else { return }
            isLaunchingExecution = true
            defer { isLaunchingExecution = false }
            let result = await client.restoreCorptieTaskExecution(taskId: task.id)
            if result.task != nil {
                await refreshExecution()
                onRequestReload()
            } else {
                executionError = result.error ?? EntityLaunchError(
                    message: client.errorMessage ?? L10n("Unable to restore CorptieTask execution"),
                    code: nil
                )
            }
        case .resume(let sessionId):
            guard !isLaunchingExecution else { return }
            isLaunchingExecution = true
            defer { isLaunchingExecution = false }
            if await client.resumeSession(sessionId: sessionId) {
                await refreshExecution()
                onRequestReload()
            } else {
                executionError = EntityLaunchError(message: client.errorMessage ?? "恢复会话失败", code: nil)
            }
        case .createSession(let agentId):
            await createExecutionSession(agentId: agentId)
        case .chooseAgent:
            executionAgentIds = []
            showAgentPicker = true
        }
    }

    private func createExecutionSession(agentId: String) async {
        if client.agents.isEmpty { await client.refreshAgents() }
        guard let agent = client.agents.first(where: { $0.agentId == agentId }) else {
            executionError = EntityLaunchError(message: L10n("Agent 不存在"), code: "AGENT_NOT_FOUND")
            return
        }
        sessionCreationAgent = agent
    }

    // 终止当前运行中的会话。
    private func interruptExecution() async {
        guard let session = currentSession else { return }
        if await client.interruptSession(
            sessionId: session.id,
            surface: .taskDetailExecutionControl
        ) {
            await refreshExecution()
            onRequestReload()
        } else {
            executionError = EntityLaunchError(message: client.errorMessage ?? "终止失败", code: nil)
        }
    }

    // 用户在前台完成证据审阅与最终裁决；确认后立即关闭审阅窗，
    // 专用完成接口由全局后台任务执行。重试前先查询权威状态，防止
    // 首次请求已落库但客户端丢失响应时重复提交。
    private func enqueueCompletion() {
        let target = task
        let requestId = "completion-request:\(UUID().uuidString.lowercased())"
        let interactionId = "completion-click:\(UUID().uuidString.lowercased())"
        let idempotencyKey = "completion:\(UUID().uuidString.lowercased())"
        Task {
            guard let receipt = await client.issueCorptieTaskCompletionIntent(
                task: target,
                interactionId: interactionId,
                requestId: requestId,
                uiSurface: "task_completion_confirmation"
            ) else {
                executionError = EntityLaunchError(
                    message: client.errorMessage ?? L10n("Unable to authorize CorptieTask completion"),
                    code: "COMPLETION_INTENT_FAILED"
                )
                return
            }
            guard let submission = CorptieTaskCompletionSubmission.freeze(
                task: target, receipt: receipt, requestId: requestId, idempotencyKey: idempotencyKey
            ) else { return }
            startCompletionBackgroundTask(submission: submission)
        }
    }

    private func startCompletionBackgroundTask(submission: CorptieTaskCompletionSubmission) {
        let taskId = "task.complete:\(submission.taskId)"
        let title = submission.displayedTitle
        let started = BackgroundTaskCenter.shared.start(
            id: taskId,
            title: L10nFormat("完成 CorptieTask：%@", title)
        ) {
            if let latest = await client.task(id: submission.taskId),
               CorptieTaskCompletionBackgroundDecision.resolve(status: latest.lifecycleState) == .alreadyCompleted {
                onRequestReload()
                return .success(L10nFormat("CorptieTask“%@”已完成。", title))
            }
            guard await client.confirmCorptieTaskCompletion(submission: submission) != nil else {
                return .failure(client.errorMessage ?? L10n("Unable to confirm CorptieTask completion"))
            }
            onRequestReload()
            return .success(L10nFormat("CorptieTask“%@”已完成。", title))
        }
        if started || BackgroundTaskCenter.shared.records.contains(where: { $0.id == taskId }) {
            showCompleteConfirmation = false
        }
    }

    private var priorityLabel: String {
        switch task.priority {
        case "low": L10n("Low")
        case "medium": L10n("Medium")
        case "high": L10n("High")
        default: task.priority
        }
    }

    private func refreshExecution() async {
        if client.agents.isEmpty { await client.refreshAgents() }
        let sessions = await client.sessions(for: task)
        // 优先用 task.currentSessionId 匹配；匹配不到（例如旧 task 值仍为 nil）时，
        // 取后端返回列表里 updatedAt 最新的那一条，避免因陈旧 currentSessionId 导致「当前执行」显示为空。
        currentSession = sessions.first { $0.id == task.currentSessionId }
            ?? sessions.max(by: { $0.updatedAt < $1.updatedAt })
        if CorptieTaskMemoryPresentationPolicy.shouldLoad(currentSessionId: task.currentSessionId) {
            if let loaded = await client.memories(ownerType: "task", ownerId: task.id) {
                memories = loaded.filter {
                    $0.ownerType == "task" && $0.ownerId == task.id && $0.taskId == task.id
                }
            }
        } else {
            memories = []
        }
    }

    private func kindLabel(_ kind: String) -> String {
        switch kind {
        case "fact": L10n("Fact")
        case "lesson": L10n("Lesson")
        case "feedback": L10n("Feedback")
        case "preference": L10n("Preference")
        case "procedure": L10n("Procedure")
        case "skill": L10n("Skill")
        case "dev_experience": L10n("Development Experience")
        case "episodic": L10n("Experience")
        default: kind
        }
    }

    private func statusLabel(_ status: String) -> String {
        switch status {
        case "running": L10n("Running")
        case "blocked": L10n("Waiting for Input")
        case "completed", "complete", "done": L10n("Complete")
        case "failed": L10n("Failed")
        default: status
        }
    }

    @ViewBuilder
    private func compactStatusBadge(_ status: String) -> some View {
        if CorptieTaskAcceptancePresentationDecision.canOpenCompletionConfirmation(status: status) {
            Button {
                showCompleteConfirmation = true
            } label: {
                statusBadgeLabel(status)
            }
            .buttonStyle(.plain)
            .help(L10n("打开完成确认"))
        } else {
            statusBadgeLabel(status)
        }
    }

    private func statusBadgeLabel(_ status: String) -> some View {
        let (label, color): (String, Color) = {
            switch status {
            case "in_progress", "doing", "running": (L10n("In Progress"), .orange)
            case "review", "reviewing": (L10n("Awaiting Completion Approval"), .blue)
            case "done", "complete", "completed": (L10n("Completed"), .green)
            case "failed": (L10n("Failed"), .red)
            default: (L10n("Preparing"), .secondary)
            }
        }()
        return Label(label, systemImage: "circle.fill")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(color.opacity(0.11), in: Capsule())
    }

    private func metadataPill(_ text: String, systemImage: String) -> some View {
        Label(text, systemImage: systemImage)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Color.primary.opacity(0.045), in: Capsule())
    }
}
