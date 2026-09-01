import AppKit
import SwiftUI

enum WorktreeAutomaticLoadPolicy {
    static func shouldLoad(isBackendOnline: Bool, isTabSelected: Bool) -> Bool {
        isBackendOnline && isTabSelected
    }

    static func shouldLoad(isBackendOnline: Bool, selectedTab: AppTab) -> Bool {
        shouldLoad(isBackendOnline: isBackendOnline, isTabSelected: selectedTab == .worktrees)
    }
}

struct WorktreeManagementView: View {
    @EnvironmentObject private var router: AppTabRouter
    @EnvironmentObject private var sidebarState: TabSidebarState
    @ObservedObject private var backendClient = BackendClient.shared
    @StateObject private var client = WorktreeManagementClient()
    @State private var showingPlan = false
    @State private var showingSynchronizationConfirmation = false
    @State private var pendingOperation: ManagedWorktree?
    @State private var pendingDeletion: ManagedWorktree?
    @State private var deletionBlocker: WorktreeDeletionBlockerPresentation?
    @State private var pendingCleanup: WorktreeCleanupRequest?
    @State private var worktreeScrollRequest: WorktreeListScrollRequest?

    var body: some View {
        NavigationSplitView(columnVisibility: $sidebarState.visibility) {
            repositoryColumn
                .navigationSplitViewColumnWidth(min: 230, ideal: 280, max: 360)
        } content: {
            worktreeColumn
                .navigationSplitViewColumnWidth(min: 320, ideal: 390, max: 520)
        } detail: {
            detailColumn
        }
        .toolbar(removing: .sidebarToggle)
        .task(id: worktreeReloadTrigger) {
            guard backendClient.isOnline else {
                client.dismissError()
                return
            }
            guard WorktreeAutomaticLoadPolicy.shouldLoad(
                isBackendOnline: backendClient.isOnline,
                isTabSelected: sidebarState.isSelected
            ) else { return }
            await client.loadRepositories()
        }
        .task(id: router.pendingWorktreeTarget) {
            guard backendClient.isOnline, sidebarState.isSelected else { return }
            guard let target = router.pendingWorktreeTarget else { return }
            if await client.navigate(to: target) {
                if let worktreeId = client.selection.worktreeId {
                    worktreeScrollRequest = WorktreeListScrollRequest(worktreeId: worktreeId)
                }
                router.consumeWorktreeTarget(target)
            }
        }
        .task(id: client.job.map { "\($0.id):\($0.shouldPoll)" }) {
            guard let jobId = client.job?.id else { return }
            var unchangedPolls = 0
            // Job changes are infrequent while an Agent works. Back off capped
            // polling and stop after one hour; SSE/tab refresh remains available.
            while unchangedPolls < WorktreeJobPollingPolicy.maximumUnchangedPolls,
                  !Task.isCancelled,
                  client.job?.id == jobId,
                  client.job?.shouldPoll == true {
                let delay = WorktreeJobPollingPolicy.delaySeconds(afterUnchangedPolls: unchangedPolls)
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                unchangedPolls = await client.pollJob() ? 0 : unchangedPolls + 1
            }
        }
        .sheet(isPresented: $showingPlan) {
            WorktreeIntegrationFlowSheet(client: client, isPresented: $showingPlan)
        }
        .sheet(item: $pendingOperation) { worktree in
            IndividualWorktreeOperationView(
                worktree: worktree,
                client: client,
                onClose: { pendingOperation = nil }
            )
        }
        .confirmationDialog(
            L10n("Synchronize this Worktree with main?"),
            isPresented: $showingSynchronizationConfirmation,
            titleVisibility: .visible
        ) {
            Button(L10n("Synchronize with main")) {
                Task { await client.synchronizeSelectedWorktree() }
            }
            Button(L10n("Cancel"), role: .cancel) {}
        } message: {
            Text(L10n("This fast-forwards an already integrated Worktree to the current main revision. Uncommitted or unmerged changes are never overwritten."))
        }
        .confirmationDialog(
            L10n("Delete this Worktree?"),
            isPresented: Binding(
                get: { pendingDeletion != nil },
                set: { if !$0 { pendingDeletion = nil } }
            ),
            titleVisibility: .visible,
            presenting: pendingDeletion
        ) { worktree in
            Button(L10n("Delete Worktree and Local Branch"), role: .destructive) {
                pendingDeletion = nil
                Task { _ = await client.deleteWorktree(worktree) }
            }
            Button(L10n("Cancel"), role: .cancel) { pendingDeletion = nil }
        } message: { worktree in
            Text(L10nFormat(
                "Corptie will permanently remove exactly this Worktree and its local branch:\n%@\n%@",
                worktree.branchName ?? L10n("Detached HEAD"),
                worktree.path
            ))
        }
        .sheet(item: $pendingCleanup) { request in
            WorktreeCleanupConfirmationView(
                worktrees: request.worktrees,
                onConfirm: {
                    pendingCleanup = nil
                    Task { await client.cleanupMergedWorktrees(request.worktrees) }
                },
                onCancel: { pendingCleanup = nil }
            )
        }
        .alert(item: $deletionBlocker) { presentation in
            Alert(
                title: Text(L10n("Worktree cannot be deleted")),
                message: Text("\(presentation.worktree.branchName ?? presentation.worktree.path): \(localizedDeletionBlocker(presentation.blocker))"),
                dismissButton: .cancel(Text(L10n("OK")))
            )
        }
        .alert(L10n(client.operationNoticeTitle), isPresented: Binding(
            get: { client.operationNotice != nil },
            set: { if !$0 { client.dismissOperationNotice() } }
        )) {
            Button(L10n("OK"), role: .cancel) { client.dismissOperationNotice() }
        } message: {
            Text(client.operationNotice ?? "")
        }
        .sheet(item: $client.cleanupResult) { result in
            WorktreeCleanupResultView(result: result) {
                client.cleanupResult = nil
            }
        }
        .alert(L10n("Worktree operation failed"), isPresented: Binding(
            get: { backendClient.isOnline && client.errorMessage != nil },
            set: { if !$0 { client.dismissError() } }
        )) {
            Button(L10n("OK"), role: .cancel) { client.dismissError() }
        } message: {
            Text(client.errorMessage ?? "")
        }
    }

    private var worktreeReloadTrigger: String {
        "\(backendClient.isOnline):\(sidebarState.isSelected)"
    }

    private var repositoryColumn: some View {
        VStack(spacing: 0) {
            columnHeader(L10n("Repository Workspaces"), systemImage: "externaldrive.connected.to.line.below") {
                Task { await client.loadRepositories(forceSelectedReload: true) }
            }
            if client.repositories.isEmpty && !client.isLoading {
                ContentUnavailableView(L10n("No Repository Workspaces"), systemImage: "folder.badge.questionmark")
            } else {
                List(selection: Binding(
                    get: { client.selection.repositoryId },
                    set: { value in Task { await client.selectRepository(value) } }
                )) {
                    ForEach(client.repositories) { repository in
                        repositoryRow(repository)
                        .tag(repository.id)
                        .accessibilityIdentifier("worktree.repository.\(repository.id)")
                    }
                }
                .listStyle(.sidebar)
            }
        }
        .accessibilityIdentifier("worktree.repository.column")
    }

    private var worktreeColumn: some View {
        VStack(spacing: 0) {
            columnHeader(L10n("Git Worktrees"), systemImage: "arrow.triangle.branch") {
                Task { await client.refreshSelected() }
            }
            if let project = client.detail?.project {
                worktreeActions(project)
                if let job = client.job, job.status != "awaiting_confirmation", job.status != "canceled" {
                    jobProgress(job)
                }
                if project.worktrees.isEmpty {
                    ContentUnavailableView(L10n("No Git Worktrees"), systemImage: "arrow.triangle.branch")
                } else {
                    ScrollViewReader { proxy in
                        List(selection: Binding(
                            get: { client.selection.worktreeId },
                            set: { client.selection.worktreeId = $0 }
                        )) {
                            ForEach(project.worktrees) { worktree in
                                worktreeRow(worktree)
                                    .id(worktree.worktreeId)
                                    .tag(worktree.worktreeId)
                                    .accessibilityIdentifier("worktree.item.\(worktree.worktreeId)")
                                    .contextMenu {
                                        Button(role: .destructive) {
                                            requestDeletion(of: worktree)
                                        } label: {
                                            Label(L10n("Delete Worktree"), systemImage: "trash")
                                        }
                                        .accessibilityIdentifier("worktree.delete.\(worktree.worktreeId)")
                                    }
                            }
                        }
                        .listStyle(.inset)
                        .task(id: worktreeScrollRequest) {
                            guard let request = worktreeScrollRequest,
                                  project.worktrees.contains(where: {
                                      $0.worktreeId == request.worktreeId
                                  }) else { return }
                            // Selection is applied after an async repository load. Let
                            // List materialize and measure the target row before asking
                            // ScrollViewReader to reveal it.
                            await Task.yield()
                            try? await Task.sleep(for: .milliseconds(16))
                            guard !Task.isCancelled else { return }
                            proxy.scrollTo(request.worktreeId, anchor: .center)
                        }
                    }
                }
            } else if client.isLoading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if case .failed(let message) = client.listLoadState {
                ContentUnavailableView {
                    Label(L10n("Could Not Load Worktrees"), systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button(L10n("Retry")) { Task { await client.refreshSelected() } }
                }
            } else {
                ContentUnavailableView(L10n("Select a Repository Workspace"), systemImage: "sidebar.left")
            }
        }
        .accessibilityIdentifier("worktree.list.column")
    }

    @ViewBuilder
    private var detailColumn: some View {
        if let worktree = client.selectedWorktree {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 5) {
                            Label(worktree.branchName ?? L10n("Detached HEAD"), systemImage: worktree.isMain ? "house.fill" : "arrow.triangle.branch")
                                .font(.title2.weight(.semibold))
                            Text(worktree.path).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                        }
                        Spacer()
                        worktreeStateControl(worktree)
                    }
                    detailSection(L10n("Git Status")) {
                        detailPair("HEAD", worktree.headOid ?? "—", monospaced: true)
                        detailPair(L10n("Availability"), localizedIntegrationStatus(worktree.availability))
                        detailPair(L10n("Branch relation"), "↑ \(worktree.aheadOfMain ?? 0)  ↓ \(worktree.behindMain ?? 0)")
                        detailPair(L10n("Operation"), worktree.operationState.map(localizedGitOperation) ?? L10n("None"))
                        if let summary = worktree.statusSummary, !summary.isEmpty {
                            Text(summary).font(.caption.monospaced()).textSelection(.enabled)
                        }
                    }
                    detailSection(L10n("Actions")) {
                        HStack(alignment: .center) {
                            Button {
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: worktree.path)])
                            } label: {
                                Label(L10n("Show in Finder"), systemImage: "folder")
                            }
                            Button {
                                Task { await client.pushWorktreeToGitHub(worktree) }
                            } label: {
                                if client.pushingWorktreeIds.contains(worktree.worktreeId) {
                                    ProgressView().controlSize(.small)
                                    Text(L10n("Pushing to GitHub…"))
                                } else {
                                    Label(L10n("Push to GitHub"), systemImage: "arrow.up.circle")
                                }
                            }
                            .disabled(
                                client.isMutating
                                    || client.pushingWorktreeIds.contains(worktree.worktreeId)
                                    || !ManagedWorktreeGitHubPushPolicy.canPush(worktree)
                            )
                            .help(worktreePushExplanation(worktree))
                            .accessibilityIdentifier("worktree.push-github.\(worktree.worktreeId)")
                            if !worktree.isMain, (worktree.behindMain ?? 0) > 0 {
                                Button {
                                    showingSynchronizationConfirmation = true
                                } label: {
                                    Label(L10n("Synchronize with main"), systemImage: "arrow.down.to.line")
                                }
                                .disabled(client.isMutating || worktree.availability != "available")
                            }
                            if worktree.isMain, worktree.dirty == true {
                                Button {
                                    pendingOperation = worktree
                                } label: {
                                    Label(L10n("Commit Changes"), systemImage: "checkmark.circle")
                                }
                                .disabled(
                                    client.isMutating
                                        || worktree.availability != "available"
                                        || worktree.operationState != nil
                                )
                                .accessibilityIdentifier("worktree.commit-main.\(worktree.worktreeId)")
                            } else if !worktree.isMain {
                                Button {
                                    pendingOperation = worktree
                                } label: {
                                    Label(L10n("Worktree Operations"), systemImage: "slider.horizontal.3")
                                }
                                .disabled(
                                    client.isMutating
                                        || worktree.availability != "available"
                                        || worktree.operationState != nil
                                )
                                Button(role: .destructive) {
                                    requestDeletion(of: worktree)
                                } label: {
                                    Label(L10n("Delete Worktree"), systemImage: "trash")
                                }
                                .disabled(client.isMutating)
                            }
                        }
                        .controlSize(.small)
                        Text(worktreePushExplanation(worktree))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    detailSection(L10n("Uncommitted Files")) {
                        if worktree.changedFiles.isEmpty {
                            Text(L10n("No uncommitted files")).foregroundStyle(.secondary)
                        } else {
                            ForEach(worktree.changedFiles, id: \.self) { file in
                                Label(file, systemImage: "doc").font(.callout).textSelection(.enabled)
                            }
                        }
                    }
                    detailSection(L10n("CorptieTask and Session")) {
                        if worktree.associations.isEmpty {
                            Text(L10n("No associated CorptieTask or Session")).foregroundStyle(.secondary)
                        } else {
                            ForEach(worktree.associations, id: \.logicalSessionId) { association in
                                VStack(alignment: .leading, spacing: 3) {
                                    if let task = association.taskTitle ?? association.taskId {
                                        Text(task).fontWeight(.medium)
                                    }
                                    if let sessionId = association.sessionId {
                                        Button(association.title ?? sessionId) {
                                            router.openSession(sessionId)
                                        }
                                        .buttonStyle(.link)
                                        .controlSize(.small)
                                    } else {
                                        Text(association.title ?? association.logicalSessionId)
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                    detailSection(L10n("Latest Integration Result")) {
                        if let item = client.job?.plan.items.first(where: { $0.worktreeId == worktree.worktreeId }) {
                            detailPair(L10n("Commit"), localizedIntegrationStatus(item.commitStatus))
                            detailPair(L10n("Merge"), localizedIntegrationStatus(item.mergeStatus))
                            if !item.conflictFiles.isEmpty {
                                ForEach(item.conflictFiles, id: \.self) { Label($0, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange) }
                            }
                            if let error = item.error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
                        } else {
                            Text(L10n("No integration result")).foregroundStyle(.secondary)
                        }
                    }
                    if let projectStatus = client.projectStatus {
                        developmentServiceSection(projectStatus)
                    }
                }
                .padding(24)
                .frame(maxWidth: 760, alignment: .leading)
            }
            .accessibilityIdentifier("worktree.detail.column")
        } else if client.detail != nil {
            ContentUnavailableView(L10n("Select a Worktree"), systemImage: "arrow.triangle.branch")
        } else {
            ContentUnavailableView(L10n("Worktree details unavailable"), systemImage: "exclamationmark.triangle")
        }
    }

    private func worktreeActions(_ project: ManagedGitProject) -> some View {
        let eligible = ManagedWorktreeDeletionPolicy.eligibleWorktrees(from: project.worktrees)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Button {
                    showingPlan = true
                    Task { await client.prepareFreshPlan() }
                } label: {
                    Label(L10n("Merge All into main"), systemImage: "arrow.triangle.merge")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .disabled(client.isMutating || client.isPreparingPlan || client.job?.isActive == true || client.job?.status == "paused")
                .accessibilityIdentifier("worktree.integrate.preflight")

                Button {
                    pendingCleanup = WorktreeCleanupRequest(worktrees: eligible)
                } label: {
                    Label(L10n("Clean Up Orphaned Worktrees"), systemImage: "trash")
                        .frame(maxWidth: .infinity)
                }
                .disabled(eligible.isEmpty || client.isMutating)
                .accessibilityIdentifier("worktree.cleanup")
            }
            if let progress = client.cleanupProgress {
                VStack(alignment: .leading, spacing: 5) {
                    HStack {
                        Text(L10nFormat(
                            "Deleting %d of %d: %@",
                            progress.currentIndex,
                            progress.total,
                            progress.branchName
                        ))
                        .font(.caption.weight(.semibold))
                        Spacer()
                        Text("\(progress.completed)/\(progress.total)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                    ProgressView(value: progress.fraction)
                        .accessibilityIdentifier("worktree.cleanup.progress")
                    Text(progress.command)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                        .help(progress.command)
                        .accessibilityIdentifier("worktree.cleanup.command")
                }
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.035))
    }

    private func requestDeletion(of worktree: ManagedWorktree) {
        if let blocker = ManagedWorktreeDeletionPolicy.blocker(for: worktree) {
            deletionBlocker = WorktreeDeletionBlockerPresentation(worktree: worktree, blocker: blocker)
        } else {
            pendingDeletion = worktree
        }
    }

    private func worktreePushExplanation(_ worktree: ManagedWorktree) -> String {
        ManagedWorktreeGitHubPushPolicy.explanation(for: worktree)
    }

    private func jobProgress(_ job: WorktreeIntegrationJob) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(localizedIntegrationPhase(job.phase)).font(.caption.weight(.semibold))
                Spacer()
                Text("\(job.progress.completed)/\(job.progress.total)").font(.caption.monospacedDigit())
                if job.hasMergeConflict,
                          let resolution = job.currentConflictResolution,
                          let sessionId = resolution.sessionId {
                    Button(L10n("View Agent Session")) { router.openSession(sessionId) }
                        .controlSize(.small)
                        .accessibilityIdentifier("worktree.integrate.open-conflict-agent")
                    if job.phase == "failed", resolution.status == "ready" {
                        Button(L10n("Revalidate and Continue")) { Task { await client.retryJob() } }
                            .controlSize(.small)
                            .disabled(client.isMutating)
                            .accessibilityIdentifier("worktree.integrate.revalidate")
                    } else if resolution.status == "failed" {
                        agentConflictRetryButton()
                        manualConflictRetryButton()
                    }
                } else if job.hasMergeConflict {
                    if let sessionId = job.conflictAutomation?.sessionId {
                        Button(L10n("View Agent Session")) { router.openSession(sessionId) }
                            .controlSize(.small)
                            .accessibilityIdentifier("worktree.integrate.open-plan-conflict-agent")
                    }
                    Button(L10n(job.conflictAutomation?.status == "blocked"
                        ? "Retry Agent for Remaining Worktrees"
                        : "Let Agent Resolve Conflicts")) {
                        Task { await client.resolveConflictWithAgent() }
                    }
                    .controlSize(.small)
                    .disabled(client.isMutating)
                    .accessibilityIdentifier("worktree.integrate.resolve-with-agent")
                    manualConflictRetryButton()
                } else if job.status == "paused" {
                    Button(L10n("Retry")) { Task { await client.retryJob() } }
                        .controlSize(.small)
                        .accessibilityIdentifier("worktree.integrate.retry")
                }
                if job.canCancel {
                    Button(L10n("Cancel"), role: .destructive) {
                        Task { await client.cancelIntegration() }
                    }
                    .controlSize(.small)
                    .disabled(client.isMutating)
                    .accessibilityIdentifier("worktree.integrate.cancel")
                }
            }
            ProgressView(value: job.progress.fraction)
            if let current = job.currentWorktreeId,
               let item = job.plan.items.first(where: { $0.worktreeId == current }) {
                Text(item.branchName ?? item.path).font(.caption).foregroundStyle(.secondary)
            }
            if job.requiresPlanRegeneration {
                Text(L10n("The integration state changed. Cancel this operation and start again."))
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else if job.conflictAutomation?.status == "blocked" {
                blockedConflictAutomation(job)
            } else if let resolution = job.currentConflictResolution {
                conflictAgentProgress(job: job, resolution: resolution)
                if job.phase == "failed", let error = job.error {
                    Text(L10nFormat(
                        "The Agent result was not promoted: %@ Nothing changed in main. Fix the dedicated Integration Worktree, then revalidate and continue, or stop and re-preflight.",
                        error
                    ))
                    .font(.caption)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                } else {
                    Text(resolution.status == "ready"
                        ? L10n("The conflict Agent finished in its dedicated Integration Worktree. Corptie is validating the committed result and will continue automatically; main remains untouched until validation passes.")
                        : (resolution.status == "failed"
                            ? L10n("The conflict Agent stopped before completing. Corptie did not promote anything to main; open its Session to inspect or resume it.")
                            : L10nFormat(
                                "Agent %@ is resolving conflicts only in %@. main remains unchanged; Corptie will validate the result and continue automatically when it finishes.",
                                resolution.agentName ?? L10n("Agent"),
                                resolution.workspace.branchName ?? resolution.workspace.path
                            )))
                    .font(.caption)
                    .foregroundStyle(.orange)
                }
            } else if job.hasMergeConflict, let item = currentConflictItem(job) {
                Text(L10nFormat(
                    "Resolve the conflicts in main (%@), stage the resolved files, then choose Retry after Manual Resolution. Conflicts: %@",
                    job.plan.mainPath,
                    item.conflictFiles.isEmpty ? "—" : item.conflictFiles.joined(separator: ", ")
                ))
                .font(.caption)
                .foregroundStyle(.orange)
                .textSelection(.enabled)
            } else if let error = job.error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            if job.status == "completed" {
                Text(L10n("Integration plan completed. All planned Worktrees reached a final state."))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.green)
                Text(finalWorktreeStatuses(job))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(10)
        .background((job.status == "paused" ? Color.orange : Color.accentColor).opacity(0.08))
        .accessibilityIdentifier("worktree.integration.progress")
    }

    @ViewBuilder
    private func conflictAgentProgress(
        job: WorktreeIntegrationJob,
        resolution: WorktreeConflictResolution
    ) -> some View {
        HStack(spacing: 7) {
            if resolution.status == "running" {
                ProgressView().controlSize(.small)
                Text(L10n("Agent is resolving conflicts…"))
            } else if resolution.status == "ready" {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
                Text(job.phase == "failed"
                    ? L10n("Agent finished; automatic validation needs attention")
                    : L10n("Agent resolved the conflicts; validating and continuing automatically…"))
            } else {
                Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red)
                Text(L10n("Agent stopped before resolving the conflicts"))
            }
        }
        .font(.caption.weight(.semibold))
        .accessibilityIdentifier("worktree.integrate.conflict-agent-progress")
    }

    private func currentConflictItem(_ job: WorktreeIntegrationJob) -> WorktreeIntegrationItem? {
        job.plan.items.first { $0.worktreeId == job.currentWorktreeId && $0.mergeStatus == "conflict" }
    }

    private func manualConflictRetryButton() -> some View {
        Button(L10n("Retry after Manual Resolution")) { Task { await client.retryJob() } }
            .controlSize(.small)
            .disabled(client.isMutating)
            .accessibilityIdentifier("worktree.integrate.retry-manual-conflict")
    }

    private func agentConflictRetryButton() -> some View {
        Button(L10n("Retry Agent for Remaining Worktrees")) {
            Task { await client.resolveConflictWithAgent() }
        }
        .controlSize(.small)
        .disabled(client.isMutating)
        .accessibilityIdentifier("worktree.integrate.retry-agent-conflicts")
    }

    @ViewBuilder
    private func blockedConflictAutomation(_ job: WorktreeIntegrationJob) -> some View {
        if let automation = job.conflictAutomation,
           let worktreeId = automation.blockedWorktreeId,
           let item = job.plan.items.first(where: { $0.worktreeId == worktreeId }) {
            Text(L10nFormat("Automatic conflict resolution is blocked at %@.", item.branchName ?? item.path))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.red)
            Text(L10nFormat(
                "Conflicting files: %@",
                automation.conflictFiles.isEmpty ? "—" : automation.conflictFiles.joined(separator: ", ")
            ))
            .font(.caption)
            .textSelection(.enabled)
            Text(automation.failureReason ?? job.error ?? L10n("The conflict could not be resolved automatically."))
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        }
    }

    private func finalWorktreeStatuses(_ job: WorktreeIntegrationJob) -> String {
        job.plan.items
            .filter { !$0.isMain }
            .map { "\($0.branchName ?? $0.path): \(localizedIntegrationStatus($0.mergeStatus))" }
            .joined(separator: "  ·  ")
    }

    private func worktreeRow(_ worktree: ManagedWorktree) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: worktree.isMain ? "house.fill" : "arrow.triangle.branch")
                Text(worktree.branchName ?? L10n("Detached HEAD")).fontWeight(.medium).lineLimit(1)
                Spacer()
                Circle().fill(worktree.dirty == true ? Color.orange : Color.green).frame(width: 7, height: 7)
            }
            Text(worktree.path).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 7) {
                Text(String((worktree.headOid ?? "—").prefix(8))).font(.caption2.monospaced())
                if worktree.isMain { statusBadge("main", color: .blue) }
                worktreeStateControl(worktree)
                if !worktree.isMain {
                    let synchronized = worktree.synchronizedWithMain == true
                    if synchronized {
                        statusBadge(L10n("Synchronized"), color: .green)
                    } else {
                        Button { pendingOperation = worktree } label: {
                            statusBadge(L10n("Not synchronized"), color: .orange)
                        }
                        .buttonStyle(.plain)
                        .help(L10n("Open Worktree operations"))
                    }
                }
                if let item = client.job?.plan.items.first(where: { $0.worktreeId == worktree.worktreeId }) {
                    statusBadge(localizedIntegrationStatus(item.mergeStatus), color: item.mergeStatus == "conflict" || item.mergeStatus == "failed" ? .orange : .secondary)
                }
                if !worktree.associations.isEmpty { Label("\(worktree.associations.count)", systemImage: "link").font(.caption2) }
            }
        }
        .padding(.vertical, 5)
    }

    private func repositoryRow(_ repository: ManagedRepository) -> some View {
        let displayPath = repository.mainPath ?? repository.path
        let available = repository.availability == "available"
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(repository.name).fontWeight(.medium).lineLimit(1)
                Spacer()
                Text(String(repository.worktreeCount))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Text(displayPath)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(2)
            Label(localizedIntegrationStatus(repository.availability), systemImage: available ? "checkmark.circle" : "exclamationmark.triangle")
                .font(.caption2)
                .foregroundStyle(available ? Color.secondary : Color.orange)
        }
        .padding(.vertical, 5)
    }

    private func columnHeader(_ title: String, systemImage: String, refresh: @escaping () -> Void) -> some View {
        HStack {
            Label(title, systemImage: systemImage).font(.headline)
            Spacer()
            if client.isLoading { ProgressView().controlSize(.small) }
            Button(action: refresh) { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.plain).help(L10n("Refresh"))
        }
        .padding(.horizontal, 12).frame(height: 42)
        .background(.bar)
    }

    private func detailSection<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.headline)
            content()
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12))
    }

    private func detailPair(_ label: String, _ value: String, monospaced: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).font(monospaced ? .caption.monospaced() : .callout).textSelection(.enabled)
        }
    }

    private func statusBadge(_ text: String, color: Color) -> some View {
        Text(text).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 2)
            .background(color.opacity(0.12), in: Capsule()).foregroundStyle(color)
    }

    @ViewBuilder
    private func worktreeStateControl(_ worktree: ManagedWorktree) -> some View {
        let state = worktreeState(worktree)
        if worktree.isMain, worktree.dirty != true {
            statusBadge(state.label, color: state.color)
        } else {
            Button { pendingOperation = worktree } label: {
                statusBadge(state.label, color: state.color)
            }
            .buttonStyle(.plain)
            .help(L10n("Open Worktree operations"))
            .disabled(
                client.isMutating
                    || worktree.availability != "available"
                    || worktree.operationState != nil
            )
            .accessibilityIdentifier("worktree.operation.\(worktree.worktreeId)")
        }
    }

    private func worktreeState(_ worktree: ManagedWorktree) -> (label: String, color: Color) {
        if worktree.availability != "available" { return (L10n("Unavailable"), .red) }
        if worktree.operationState != nil { return (L10n("Operation in progress"), .orange) }
        if worktree.dirty == true { return (L10n("Working"), .orange) }
        if worktree.isMain { return (L10n("Clean"), .green) }
        if worktree.pendingIntegration { return (L10n("Pending merge"), .blue) }
        if worktree.mergedIntoMain == true { return (L10n("Merged"), .purple) }
        return (L10n("Pending merge"), .secondary)
    }

    @ViewBuilder
    private func developmentServiceSection(_ status: ProjectDevelopmentServiceStatus) -> some View {
        detailSection(L10n("Development Service")) {
            HStack {
                Label(serviceLabel(status.service), systemImage: "server.rack")
                    .foregroundStyle(serviceColor(status.service))
                    .fontWeight(.semibold)
                Spacer()
                if status.service.running == true {
                    Button(L10n("Rebuild and Restart")) {
                        Task { await client.runDevelopmentServiceAction("restart") }
                    }
                    Button(L10n("Stop")) {
                        Task { await client.runDevelopmentServiceAction("stop") }
                    }
                } else {
                    Button(L10n("Build and Start")) {
                        Task { await client.runDevelopmentServiceAction("start") }
                    }
                }
            }
            .controlSize(.small)
            .disabled(client.isMutating)

            if status.toolset.configured, !status.toolset.profiles.isEmpty {
                Picker(L10n("Service profile"), selection: Binding(
                    get: { status.toolset.selectedProfile },
                    set: { profileId in
                        Task { await client.runDevelopmentServiceAction("profile", profileId: profileId) }
                    }
                )) {
                    ForEach(status.toolset.profiles) { profile in
                        Text(profile.label).tag(profile.id)
                    }
                }
                .controlSize(.small)
                .disabled(client.isMutating)
            } else {
                Button(status.toolset.requiresUpdate ? L10n("Update Corptie Scripts Tools Set") : L10n("Initialize Toolset")) {
                    Task {
                        await client.runDevelopmentServiceAction(status.toolset.requiresUpdate ? "update" : "initialize")
                    }
                }
                .controlSize(.small)
                .disabled(client.isMutating)
            }
        }
    }

    private func serviceLabel(_ service: ProjectServiceStatus) -> String {
        switch service.freshness {
        case "current": L10n("Running main latest")
        case "stale": L10n("Restart required")
        case "configurationMismatch": L10n("Service profile mismatch")
        case "unverifiedBuild": L10n("Build version unverified")
        case "toolsetUpdateRequired": L10n("Toolset update required")
        case "unhealthy": L10n("Service unhealthy")
        case "stopped": L10n("Stopped")
        default: L10n("Version unknown")
        }
    }

    private func serviceColor(_ service: ProjectServiceStatus) -> Color {
        switch service.freshness {
        case "current": .green
        case "stopped": .secondary
        case "stale", "configurationMismatch", "unverifiedBuild", "toolsetUpdateRequired", "unhealthy": .orange
        default: .secondary
        }
    }
}

private struct WorktreeListScrollRequest: Equatable {
    let id = UUID()
    let worktreeId: String
}

private struct IndividualWorktreeOperationView: View {
    let worktree: ManagedWorktree
    @ObservedObject var client: WorktreeManagementClient
    let onClose: () -> Void

    @State private var mergeIntoMain: Bool
    @State private var synchronizeWithMain: Bool
    @State private var restartService = false
    @State private var preparation: IndividualWorktreeOperationPreparation?
    @State private var commitMessage = ""
    @State private var privateFilesDecision: String?
    @State private var neverRemindPrivateFiles = false
    @State private var isPreparing = true

    init(
        worktree: ManagedWorktree,
        client: WorktreeManagementClient,
        onClose: @escaping () -> Void
    ) {
        self.worktree = worktree
        self.client = client
        self.onClose = onClose
        let needsMerge = worktree.dirty == true || worktree.mergedIntoMain != true
        _mergeIntoMain = State(initialValue: needsMerge)
        _synchronizeWithMain = State(initialValue: worktree.synchronizedWithMain != true)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n(worktree.isMain ? "Commit Changes" : "Worktree Operations"))
                    .font(.title3.weight(.semibold))
                Text(worktree.branchName ?? L10n("Detached HEAD"))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Text(worktree.path).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }

            if isPreparing {
                HStack { ProgressView().controlSize(.small); Text(L10n("Inspecting Worktree changes…")) }
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                if worktree.isMain {
                    Text(L10n("This creates a local commit for the uncommitted changes in main. Nothing is pushed."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 12) {
                        Toggle(L10n("Merge into main"), isOn: $mergeIntoMain)
                            .disabled(mergeIsUnnecessary)
                        Toggle(L10n("Synchronize with main"), isOn: $synchronizeWithMain)
                            .disabled(worktree.synchronizedWithMain == true)
                        Toggle(L10n("Restart service"), isOn: $restartService)
                    }
                    .toggleStyle(.checkbox)
                }

                if worktree.dirty == true, worktree.isMain || mergeIntoMain {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(L10n("Commit message")).font(.headline)
                        TextField(L10n("Enter a commit message"), text: $commitMessage)
                        if let protection = preparation?.protection,
                           protection.requiresDecision {
                            Label(L10n("Protected local files were detected."), systemImage: "exclamationmark.shield.fill")
                                .foregroundStyle(.orange)
                            ForEach(protection.protectedPaths, id: \.self) { path in
                                Text(path).font(.caption.monospaced()).textSelection(.enabled)
                            }
                            Picker(L10n("Handle protected files"), selection: $privateFilesDecision) {
                                Text(L10n("Choose…")).tag(String?.none)
                                Text(L10n("Add matching paths to .gitignore")).tag(String?.some("ignore"))
                                Text(L10n("Include files in this commit")).tag(String?.some("include"))
                            }
                            Toggle(L10n("Do not remind me again for this project"), isOn: $neverRemindPrivateFiles)
                        }
                    }
                }

                Text(L10n("Operations run in the displayed order. No remote push or deletion is performed."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()
            HStack {
                Button(L10n("Cancel"), action: onClose).keyboardShortcut(.cancelAction)
                Spacer()
                Button(L10n(worktree.isMain ? "Commit Changes" : "Execute")) {
                    executeAndDismiss()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(!canExecute)
                .accessibilityIdentifier("worktree.operation.execute")
            }
        }
        .padding(20)
        .frame(width: 480, height: worktree.dirty == true ? 520 : 370)
        .task {
            preparation = await client.prepareIndividualOperation(for: worktree)
            commitMessage = preparation?.commitMessage ?? ""
            isPreparing = false
        }
        .onChange(of: synchronizeWithMain) { _, selected in
            if selected, (worktree.dirty == true || worktree.mergedIntoMain != true) {
                mergeIntoMain = true
            }
        }
        .onChange(of: mergeIntoMain) { _, selected in
            if !selected, (worktree.dirty == true || worktree.mergedIntoMain != true) {
                synchronizeWithMain = false
            }
        }
    }

    private var mergeIsUnnecessary: Bool {
        worktree.mergedIntoMain == true && worktree.dirty != true
    }

    private var canExecute: Bool {
        guard !isPreparing, !client.isMutating else { return false }
        if worktree.isMain {
            guard worktree.dirty == true,
                  !commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
            if preparation?.protection?.requiresDecision == true, privateFilesDecision == nil { return false }
            return true
        }
        guard mergeIntoMain || synchronizeWithMain || restartService else { return false }
        if worktree.dirty == true, mergeIntoMain, commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return false
        }
        if preparation?.protection?.requiresDecision == true, mergeIntoMain, privateFilesDecision == nil {
            return false
        }
        return true
    }

    private func executeAndDismiss() {
        let merge = mergeIntoMain
        let synchronize = synchronizeWithMain
        let restart = restartService
        let message = commitMessage.isEmpty ? nil : commitMessage
        let protectedFilesDecision = privateFilesDecision
        let neverRemind = neverRemindPrivateFiles
        onClose()
        Task {
            if worktree.isMain, let message {
                _ = await client.commitMainWorktreeChanges(
                    worktree: worktree,
                    commitMessage: message,
                    privateFilesDecision: protectedFilesDecision,
                    neverRemindPrivateFiles: neverRemind
                )
            } else {
                _ = await client.executeIndividualOperation(
                    worktree: worktree,
                    mergeIntoMain: merge,
                    synchronizeWithMain: synchronize,
                    restartService: restart,
                    commitMessage: message,
                    privateFilesDecision: protectedFilesDecision,
                    neverRemindPrivateFiles: neverRemind
                )
            }
        }
    }
}

private struct WorktreeDeletionBlockerPresentation: Identifiable {
    let id = UUID()
    let worktree: ManagedWorktree
    let blocker: ManagedWorktreeDeletionBlocker
}

private struct WorktreeCleanupRequest: Identifiable {
    let id = UUID()
    let worktrees: [ManagedWorktree]
}

enum WorktreeCleanupConfirmationLayout {
    static func preferredHeight(for worktreeCount: Int) -> CGFloat {
        min(560, max(340, 210 + CGFloat(worktreeCount) * 58))
    }
}

struct WorktreeCleanupConfirmationView: View {
    let worktrees: [ManagedWorktree]
    let onConfirm: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10nFormat("Clean up %d merged Worktrees?", worktrees.count))
                .font(.title2.weight(.semibold))
            Text(L10n("Only these Worktrees, whose branches are merged into main and have no unfinished CorptieTask or active Session association, will be removed with their local branches:"))
                .font(.callout)
                .foregroundStyle(.secondary)

            ScrollView(.vertical) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(worktrees) { worktree in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(worktree.branchName ?? L10n("Detached HEAD"))
                                .fontWeight(.medium)
                            Text(worktree.path)
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 9)
                        Divider()
                    }
                }
            }
            .accessibilityIdentifier("worktree.cleanup.confirmation.list")
            .scrollIndicators(.automatic)

            HStack {
                Spacer()
                Button(L10n("Cancel"), action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(L10n("Clean Up Worktrees"), role: .destructive, action: onConfirm)
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("worktree.cleanup.confirmation.confirm")
            }
        }
        .padding(24)
        .frame(
            width: 640,
            height: WorktreeCleanupConfirmationLayout.preferredHeight(for: worktrees.count)
        )
        .accessibilityIdentifier("worktree.cleanup.confirmation")
    }
}

private struct WorktreeCleanupResultView: View {
    let result: WorktreeCleanupResult
    let onClose: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("Worktree Cleanup Results")).font(.title2.weight(.semibold))
            Text(L10nFormat(
                "Removed: %d   Skipped: %d   Failed: %d",
                result.counts.removed,
                result.counts.skipped,
                result.counts.failed
            ))
            .font(.headline.monospacedDigit())
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    resultSection(L10n("Removed"), entries: result.removed, color: .green)
                    resultSection(L10n("Skipped"), entries: result.skipped, color: .orange)
                    resultSection(L10n("Failed"), entries: result.failed, color: .red)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack {
                Spacer()
                Button(L10n("Done"), action: onClose).keyboardShortcut(.defaultAction)
            }
        }
        .padding(24)
        .frame(minWidth: 560, idealWidth: 680, minHeight: 360, idealHeight: 500)
    }

    @ViewBuilder
    private func resultSection(_ title: String, entries: [WorktreeDeletionResult], color: Color) -> some View {
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 7) {
                Text("\(title) (\(entries.count))").font(.headline).foregroundStyle(color)
                ForEach(entries) { entry in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(entry.branchName ?? entry.path).fontWeight(.medium)
                        Text(entry.path).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                        if let reason = entry.reason {
                            Text(reason).font(.caption).foregroundStyle(color).textSelection(.enabled)
                        }
                    }
                }
            }
        }
    }
}

@MainActor
private func localizedIntegrationStatus(_ value: String) -> String {
    switch value {
    case "available": L10n("Available")
    case "unavailable": L10n("Unavailable")
    case "awaiting_confirmation": L10n("Awaiting confirmation")
    case "queued": L10n("Queued")
    case "running": L10n("Running")
    case "paused": L10n("Paused")
    case "completed": L10n("Completed")
    case "failed": L10n("Failed")
    case "pending": L10n("Pending")
    case "not_needed": L10n("Not needed")
    case "recovered": L10n("Recovered")
    case "conflict": L10n("Conflict")
    case "skipped": L10n("Skipped")
    case "canceled": L10n("Canceled")
    case "cancellation_requested": L10n("Stopping")
    case "replanning": L10n("Generating a new plan")
    case "replanning_cleanup_failed": L10n("Could not restore main for re-preflight")
    case "cancellation_cleanup_failed": L10n("Could not restore main while canceling")
    case "replanning_failed": L10n("Could not generate a new plan")
    default: value.replacingOccurrences(of: "_", with: " ")
    }
}

@MainActor
private func localizedDeletionBlocker(_ blocker: ManagedWorktreeDeletionBlocker) -> String {
    switch blocker.code {
    case "MAIN_WORKTREE": L10n("The main Worktree cannot be deleted.")
    case "WORKTREE_UNAVAILABLE": L10n("This Worktree is unavailable and cannot be removed safely.")
    case "WORKTREE_LOCKED": L10n("This Worktree is locked by another operation.")
    case "WORKTREE_PRUNABLE": L10n("This Worktree has invalid or prunable Git metadata.")
    case "GIT_OPERATION_IN_PROGRESS": L10n("A Git operation is already in progress in this Worktree.")
    case "UNRESOLVED_CONFLICTS": L10n("This Worktree contains unresolved conflicts.")
    case "UNCOMMITTED_CHANGES": L10n("This Worktree has uncommitted changes. Commit or discard them before deleting it.")
    case "NOT_MERGED_INTO_MAIN": L10n("This Worktree has commits that are not merged into main.")
    case "WORKTREE_BRANCH_AMBIGUOUS": L10n("The branch for this Worktree cannot be determined safely.")
    case "TASK_ASSOCIATED", "WORKTREE_IN_USE": blocker.reason
    default: blocker.reason
    }
}

@MainActor
private func localizedIntegrationPhase(_ value: String) -> String {
    switch value {
    case "preflight_complete": L10n("Preflight complete")
    case "validating": L10n("Validating")
    case "committing": L10n("Creating local commits")
    case "merging": L10n("Merging into main")
    case "conflict": L10n("Waiting for conflict resolution")
    case "conflict_resolution_preparing": L10n("Preparing the Agent conflict workspace")
    case "conflict_resolution_running": L10n("Agent is resolving conflicts")
    case "conflict_resolution_resume_queued": L10n("Conflict resolved; continuing automatically")
    case "validating_resolution": L10n("Validating the Agent result")
    case "retry_queued": L10n("Retry queued")
    case "recovery_queued": L10n("Recovery queued")
    case "plan_stale": L10n("Plan changed")
    case "stopping": L10n("Stopping at a safe boundary")
    case "replanning": L10n("Generating a new plan")
    case "canceled_conflict_preserved": L10n("Stopped; conflict preserved")
    case "completed": L10n("Completed")
    default: localizedIntegrationStatus(value)
    }
}

@MainActor
private func localizedGitOperation(_ value: String) -> String {
    switch value {
    case "merge": L10n("Merge in progress")
    case "rebase": L10n("Rebase in progress")
    case "cherry-pick": L10n("Cherry-pick in progress")
    case "revert": L10n("Revert in progress")
    default: value
    }
}

@MainActor
private func localizedIntegrationRisk(_ risk: WorktreeIntegrationRisk) -> String {
    switch risk.code {
    case "MAIN_UNCOMMITTED_CHANGES": L10n("main contains uncommitted changes. Corptie will leave them untouched.")
    case "WORKTREE_UNAVAILABLE": L10n("This Worktree is unavailable.")
    case "WORKTREE_LOCKED": L10n("This Worktree is locked by another operation.")
    case "WORKTREE_PRUNABLE": L10n("This Worktree has invalid or prunable Git metadata.")
    case "GIT_OPERATION_IN_PROGRESS": L10n("A Git operation is already in progress in this Worktree.")
    case "WORKTREE_BRANCH_AMBIGUOUS": L10n("The branch for this Worktree cannot be determined safely.")
    case "UNRESOLVED_CONFLICTS": L10n("This Worktree contains unresolved conflicts.")
    case "ACTIVE_SESSION_IN_PROGRESS": L10n("An active Session is still modifying this Worktree. Stop it before integrating.")
    case "GIT_LOCAL_AGENT_SYMLINK_NOT_COMMITTABLE": L10n("Local Agent configuration links cannot be committed. Replace them with real project files first.")
    default: risk.message
    }
}

private struct WorktreeIntegrationFlowSheet: View {
    @ObservedObject var client: WorktreeManagementClient
    @Binding var isPresented: Bool

    var body: some View {
        Group {
            if client.isPreparingPlan {
                VStack(spacing: 18) {
                    ProgressView()
                        .controlSize(.large)
                    Text(L10n("Preparing Worktree merge…"))
                        .font(.headline)
                    Button(L10n("Cancel"), role: .cancel) {
                        client.cancelPlanPreparation()
                        isPresented = false
                    }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("worktree.integrate.preparing.cancel")
                }
                .frame(width: 520, height: 260)
            } else if let job = client.job, job.status == "awaiting_confirmation" {
                WorktreeIntegrationPlanReview(job: job, client: client, isPresented: $isPresented)
            } else {
                VStack(spacing: 18) {
                    ContentUnavailableView(
                        L10n("No Worktree changes require integration."),
                        systemImage: "checkmark.circle"
                    )
                    Button(L10n("Close")) { isPresented = false }
                        .keyboardShortcut(.cancelAction)
                }
                .frame(width: 520, height: 300)
            }
        }
        .interactiveDismissDisabled()
    }
}

private struct WorktreeIntegrationPlanReview: View {
    let job: WorktreeIntegrationJob
    @ObservedObject var client: WorktreeManagementClient
    @Binding var isPresented: Bool
    @State private var protectionDecisions: [String: String] = [:]
    @State private var neverRemindWorktrees: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("Review Worktree Integration Plan")).font(.title2.weight(.semibold))
            Text(L10n("Only local commits and merges will be performed. Nothing is pushed, deleted, reset, or force-cleaned."))
                .foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    preflightStatus
                    if !job.plan.blockingRisks.isEmpty {
                        blockingRiskDetails
                    }
                    if reviewItems.isEmpty {
                        ContentUnavailableView(
                            L10n("No Worktree changes require integration."),
                            systemImage: "checkmark.circle"
                        )
                    }
                    ForEach(reviewItems) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.isMain ? "main — \(item.path)" : (item.branchName ?? item.path)).fontWeight(.semibold)
                            Text(item.dirty ? L10nFormat("%d changed files; commit: %@", item.changedFiles.count, item.commitMessage ?? "—") : L10n("No local commit required"))
                                .font(.caption)
                            if !item.isMain {
                                Text(L10nFormat("Merge order #%d: %@", item.ordinal, localizedIntegrationStatus(item.mergeStatus)))
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            ForEach(item.associations.filter(\.active), id: \.logicalSessionId) { association in
                                Label(
                                    L10nFormat("Active Session: %@", association.title ?? association.sessionId ?? association.logicalSessionId),
                                    systemImage: "person.crop.circle.badge.clock"
                                )
                                .font(.caption)
                                .foregroundStyle(.orange)
                            }
                            if let protection = item.commitProtection, protection.requiresDecision {
                                Label(L10n("Protected local files were detected."), systemImage: "exclamationmark.shield.fill")
                                    .foregroundStyle(.orange)
                                ForEach(protection.protectedPaths, id: \.self) { path in
                                    Text(path).font(.caption.monospaced()).textSelection(.enabled)
                                }
                                Picker(
                                    L10n("Handle protected files"),
                                    selection: protectionDecisionBinding(for: item.worktreeId)
                                ) {
                                    Text(L10n("Choose…")).tag("")
                                    Text(L10n("Add matching paths to .gitignore")).tag("ignore")
                                    Text(L10n("Include files in this commit")).tag("include")
                                }
                                Toggle(
                                    L10n("Do not remind me again for this project"),
                                    isOn: neverRemindBinding(for: item.worktreeId)
                                )
                            }
                        }
                        Divider()
                    }
                }
            }
            .frame(maxHeight: 420)
            HStack {
                Button(L10n("Cancel"), role: .cancel) {
                    isPresented = false
                    Task { await client.cancelIntegration() }
                }
                .keyboardShortcut(.cancelAction)
                Spacer()
                if job.plan.blockingRisks.isEmpty {
                    Button(L10n("Confirm")) {
                        confirmAndDismiss()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(client.isMutating || hasMissingProtectionDecisions)
                    .accessibilityIdentifier("worktree.integrate.confirm")
                }
            }
        }
        .padding(20)
        .frame(width: 680, height: 620)
    }

    @ViewBuilder
    private var preflightStatus: some View {
        switch job.plan.preflightState {
        case .ready:
            Label(L10n("Preflight passed. The reviewed local-only plan can be started."), systemImage: "checkmark.shield.fill")
                .foregroundStyle(.green)
        case .taskConflict:
            taskConflictNotice
        case .mainUncommittedChanges:
            mainChangesNotice
        case .taskConflictAndMainUncommittedChanges:
            VStack(alignment: .leading, spacing: 10) {
                Label(L10n("Two independent blockers were detected"), systemImage: "exclamationmark.octagon.fill")
                    .font(.headline)
                    .foregroundStyle(.orange)
                mainChangesNotice
                taskConflictNotice
            }
        case .otherBlockingRisks:
            Label(
                L10n("The plan is blocked by the risks listed below. Resolve them in the affected Worktrees, then re-run preflight."),
                systemImage: "exclamationmark.triangle.fill"
            )
            .foregroundStyle(.orange)
        }
    }

    private var mainChangesNotice: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(L10n("main has uncommitted local changes"), systemImage: "externaldrive.badge.exclamationmark")
                .fontWeight(.semibold)
            Text(L10n("Impact: integration is blocked. Corptie will not switch main, commit it, clean it, or overwrite any file."))
                .font(.caption)
            if let main = job.plan.items.first(where: \.isMain) {
                Text(main.path).font(.caption.monospaced()).textSelection(.enabled)
                Button(L10n("Show main in Finder")) { reveal(main.path) }
                    .buttonStyle(.link)
            }
            Text(L10n("Next: preserve these changes yourself (for example commit or stash them), then return and re-run preflight."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private var taskConflictNotice: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(L10n("Task Worktree changes are conflicted"), systemImage: "arrow.triangle.merge")
                .fontWeight(.semibold)
            Text(L10n("Impact: only the listed task Worktrees require manual repair, but no plan step can start until their Git conflicts are resolved."))
                .font(.caption)
            ForEach(conflictedTaskItems) { item in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.branchName ?? item.path).font(.caption.weight(.semibold))
                        Text(item.path).font(.caption2.monospaced()).textSelection(.enabled)
                        if !item.conflictFiles.isEmpty {
                            Text(item.conflictFiles.joined(separator: ", ")).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Button(L10n("Show in Finder")) { reveal(item.path) }
                }
            }
            Text(L10n("Next: finish or abort the existing Git operation in each task Worktree, resolve all conflict files, then re-run preflight."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(10)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private var blockingRiskDetails: some View {
        let itemsByWorktreeId = job.plan.items.reduce(into: [String: WorktreeIntegrationItem]()) {
            $0[$1.worktreeId] = $1
        }
        return VStack(alignment: .leading, spacing: 8) {
            Label(L10n("Blocking risk details"), systemImage: "exclamationmark.octagon.fill")
                .font(.headline)
                .foregroundStyle(.orange)
            ForEach(job.plan.blockingRisks.indices, id: \.self) { index in
                let risk = job.plan.blockingRisks[index]
                blockingRiskRow(risk, item: risk.worktreeId.flatMap { itemsByWorktreeId[$0] })
            }
        }
        .padding(10)
        .background(Color.orange.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("worktree.integrate.blocking-risks")
    }

    private func blockingRiskRow(
        _ risk: WorktreeIntegrationRisk,
        item: WorktreeIntegrationItem?
    ) -> some View {
        let localizedMessage = localizedIntegrationRisk(risk)
        return VStack(alignment: .leading, spacing: 3) {
            Label(localizedMessage, systemImage: "exclamationmark.triangle.fill")
                .fontWeight(.semibold)
            if let item {
                Text(L10nFormat("Affected Worktree: %@", item.isMain ? "main" : (item.branchName ?? item.path)))
                    .font(.caption.weight(.semibold))
                Text(item.path)
                    .font(.caption2.monospaced())
                    .textSelection(.enabled)
                if !item.conflictFiles.isEmpty {
                    Text(L10nFormat("Conflict files: %@", item.conflictFiles.joined(separator: ", ")))
                        .font(.caption2)
                        .textSelection(.enabled)
                }
                Button(L10n("Show in Finder")) { reveal(item.path) }
                    .buttonStyle(.link)
            } else if let worktreeId = risk.worktreeId {
                Text(L10nFormat("Affected Worktree ID: %@", worktreeId))
                    .font(.caption2.monospaced())
                    .textSelection(.enabled)
            } else {
                Text(L10n("The backend did not identify an affected Worktree for this risk."))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if !risk.message.isEmpty, risk.message != localizedMessage {
                Text(risk.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 3)
    }

    private var conflictedTaskItems: [WorktreeIntegrationItem] {
        let ids = Set(job.plan.blockingRisks.compactMap { risk in
            risk.code == "UNRESOLVED_CONFLICTS" ? risk.worktreeId : nil
        })
        return job.plan.items.filter { !$0.isMain && ids.contains($0.worktreeId) }
    }

    private func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    private var reviewItems: [WorktreeIntegrationItem] {
        job.plan.items.filter {
            $0.commitStatus != "not_needed" || $0.mergeStatus != "not_needed"
        }
    }

    private var hasMissingProtectionDecisions: Bool {
        reviewItems.contains { item in
            item.commitProtection?.requiresDecision == true
                && !["ignore", "include"].contains(protectionDecisions[item.worktreeId])
        }
    }

    private func protectionDecisionBinding(for worktreeId: String) -> Binding<String> {
        Binding(
            get: { protectionDecisions[worktreeId] ?? "" },
            set: { protectionDecisions[worktreeId] = $0 }
        )
    }

    private func neverRemindBinding(for worktreeId: String) -> Binding<Bool> {
        Binding(
            get: { neverRemindWorktrees.contains(worktreeId) },
            set: { selected in
                if selected { neverRemindWorktrees.insert(worktreeId) }
                else { neverRemindWorktrees.remove(worktreeId) }
            }
        )
    }

    private func confirmAndDismiss() {
        let decisions = protectionDecisions.map { worktreeId, decision in
            WorktreeCommitProtectionDecision(
                worktreeId: worktreeId,
                decision: decision,
                neverRemind: neverRemindWorktrees.contains(worktreeId)
            )
        }
        Task {
            if await client.confirmPlan(commitProtectionDecisions: decisions) {
                isPresented = false
            }
        }
    }
}
