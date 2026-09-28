import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ProjectWorktreeManagerView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var supplementaryData = BackendClient.shared.supplementaryDataController
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    @ObservedObject private var workspaceCommands = BackendClient.shared.projectWorkspaceCommandController
    @ObservedObject private var gitHubPushState = BackendClient.shared.gitHubPushController
    @StateObject private var newSessionPanel = NewSessionPanelController()
    @State private var pendingOperation: ProjectWorktreeStatus?
    @State private var pendingSynchronization: ProjectWorktreeStatus?
    @State private var pendingCommit: ProjectWorktreeStatus?
    @State private var pendingDeletionWarning: PendingWorktreeDeletion?
    @State private var pendingDeletionConfirmation: PendingWorktreeDeletion?
    @State private var pendingMergedCleanup: [ProjectWorktreeStatus] = []
    @State private var showingIntegrationConfirmation = false
    @State private var pendingConflictRun: ProjectIntegrationRun?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n("Project Worktrees"))
                        .font(.system(size: 18, weight: .bold))
                    if let status {
                        Text(L10nFormat("%d worktrees are not merged into main", status.project.pendingWorktreeCount))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                }
                Spacer()
                if let status {
                    if let integrationStatus = supplementaryData.selectedProjectIntegrationStatus {
                        let integrationEntryState = ProjectWorktreeIntegrationEntryState(
                            eligibleCount: integrationStatus.eligibleWorktrees.count,
                            conflictCount: integrationStatus.latestRun?.counts.conflicts ?? 0,
                            isRunning: backendClient.isIntegratingCompletedWorktrees
                        )
                        Button {
                            handleIntegrationEntry(integrationEntryState)
                        } label: {
                            if integrationEntryState == .running {
                                ProgressView()
                                    .controlSize(.small)
                                Text(L10n("Integrating serially"))
                            } else {
                                Label(
                                    L10nFormat(
                                        "Integrate Completed (%d)",
                                        integrationStatus.eligibleWorktrees.count
                                    ),
                                    systemImage: "arrow.triangle.merge"
                                )
                            }
                        }
                        .controlSize(.small)
                        .disabled(integrationEntryState == .running)
                        .help(integrationEntryHelp(integrationEntryState))
                    }
                    let eligible = ProjectWorktreeCleanupPolicy.eligibleWorktrees(
                        from: status.project.worktrees
                    )
                    Button {
                        pendingMergedCleanup = eligible
                    } label: {
                        Label(
                            L10nFormat("Clean Up Merged (%d)", eligible.count),
                            systemImage: "trash"
                        )
                    }
                    .controlSize(.small)
                    .disabled(eligible.isEmpty || backendClient.isCleaningMergedProjectWorktrees)
                    .help(eligible.isEmpty
                        ? L10n("No merged Worktrees without associated sessions")
                        : L10n("Remove all merged Worktrees that have no associated sessions"))
                }
            }

            if let error = backendClient.projectWorktreeActionError {
                HStack(alignment: .top, spacing: 8) {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button {
                        backendClient.dismissProjectWorktreeActionError()
                    } label: {
                        Image(systemName: "xmark")
                    }
                    .buttonStyle(.plain)
                    .help(L10n("Dismiss"))
                }
                .padding(10)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }

            if let status {
                if let integrationStatus = supplementaryData.selectedProjectIntegrationStatus,
                   let run = integrationStatus.latestRun {
                    integrationResultCard(run, status: integrationStatus)
                }
                serviceCard(status)
                Divider()
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(status.project.worktrees) { worktree in
                            worktreeRow(worktree)
                        }
                    }
                    .padding(.vertical, 2)
                }
            } else if let loadError = supplementaryData.projectWorktreeLoadError {
                VStack(spacing: 12) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(.orange)
                    Text(loadError)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .multilineTextAlignment(.center)
                        .textSelection(.enabled)
                    Button(L10n("Retry")) {
                        Task { await backendClient.refreshSelectedProjectWorktrees() }
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 10) {
                    ProgressView()
                    Text(L10n("Loading project worktrees"))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(20)
        .frame(minWidth: 600, idealWidth: 680, minHeight: 400, idealHeight: 500)
        .task {
            await backendClient.refreshSelectedProjectWorktrees()
        }
        .sheet(item: $pendingOperation) { worktree in
            if let status {
                ProjectWorktreeOperationView(
                    worktree: worktree,
                    status: status,
                    onExecute: { merge, synchronize, deleteWorktree, deleteSessions, restart in
                        pendingOperation = nil
                        if deleteWorktree,
                           worktree.mergedIntoMain != true || worktree.dirty == true {
                            let deletion = PendingWorktreeDeletion(
                                worktree: worktree,
                                deleteSessions: deleteSessions,
                                restartService: restart
                            )
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(180))
                                pendingDeletionWarning = deletion
                            }
                        } else {
                            backendClient.operateProjectWorktree(
                                worktree,
                                mergeIntoMain: merge,
                                synchronizeWithMain: synchronize,
                                deleteWorktree: deleteWorktree,
                                deleteSessions: deleteSessions,
                                restartService: restart
                            )
                        }
                    },
                    onCancel: { pendingOperation = nil }
                )
            }
        }
        .sheet(item: Binding(
            get: { backendClient.worktreeCommitReviewPrompt },
            set: { value in
                if value == nil { backendClient.cancelProtectedWorktreeCommit() }
            }
        )) { prompt in
            WorktreeCommitReviewView(prompt: prompt)
                .environmentObject(backendClient)
        }
        .confirmationDialog(
            L10nFormat("Remove %d merged Worktrees?", pendingMergedCleanup.count),
            isPresented: Binding(
                get: { !pendingMergedCleanup.isEmpty },
                set: { if !$0 { pendingMergedCleanup = [] } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n("Remove Worktrees"), role: .destructive) {
                let targets = pendingMergedCleanup
                pendingMergedCleanup = []
                backendClient.cleanupMergedProjectWorktrees(targets)
            }
            Button(L10n("Cancel"), role: .cancel) {
                pendingMergedCleanup = []
            }
        } message: {
            Text(L10nFormat(
                "The following merged Worktrees have no associated sessions and will be permanently removed with their local branches:\n%@",
                pendingMergedCleanup.map { $0.branchName ?? $0.path }.joined(separator: "\n")
            ))
        }
        .confirmationDialog(
            L10nFormat(
                "%d unmerged commits will be permanently deleted",
                pendingDeletionWarning?.worktree.aheadOfMain ?? 0
            ),
            isPresented: Binding(
                get: { pendingDeletionWarning != nil },
                set: { if !$0 { pendingDeletionWarning = nil } }
            ),
            presenting: pendingDeletionWarning
        ) { deletion in
            Button(L10n("Continue to branch-name confirmation"), role: .destructive) {
                pendingDeletionWarning = nil
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(140))
                    pendingDeletionConfirmation = deletion
                }
            }
            Button(L10n("Cancel"), role: .cancel) {
                pendingDeletionWarning = nil
            }
        } message: { deletion in
            Text(L10nFormat(
                "Deleting this Worktree will permanently delete all changes on branch %@. This action cannot be undone.",
                deletion.worktree.branchName ?? L10n("detached HEAD")
            ))
        }
        .sheet(item: $pendingDeletionConfirmation) { deletion in
            ForceDeleteWorktreeConfirmationView(
                deletion: deletion,
                onConfirm: { branchName in
                    backendClient.operateProjectWorktree(
                        deletion.worktree,
                        mergeIntoMain: false,
                        synchronizeWithMain: false,
                        deleteWorktree: true,
                        deleteSessions: deletion.deleteSessions,
                        restartService: deletion.restartService,
                        forceDeleteUnmerged: true,
                        confirmedBranchName: branchName
                    )
                    pendingDeletionConfirmation = nil
                },
                onCancel: { pendingDeletionConfirmation = nil }
            )
        }
        .sheet(item: $pendingConflictRun) { run in
            if let integrationStatus = supplementaryData.selectedProjectIntegrationStatus {
                ProjectIntegrationConflictCorptieTaskConfirmationView(
                    run: run,
                    status: integrationStatus,
                    isCreating: backendClient.isCreatingIntegrationConflictCorptieTask,
                    onConfirm: { agentId, title in
                        backendClient.createIntegrationConflictCorptieTask(
                            runId: run.id,
                            agentId: agentId,
                            title: title
                        )
                        pendingConflictRun = nil
                    },
                    onCancel: { pendingConflictRun = nil }
                )
            }
        }
        .confirmationDialog(
            L10n("Integrate all completed Worktrees?"),
            isPresented: $showingIntegrationConfirmation,
            titleVisibility: .visible
        ) {
            Button(L10n("Start Serial Integration")) {
                showingIntegrationConfirmation = false
                backendClient.integrateCompletedWorktrees()
            }
            Button(L10n("Cancel"), role: .cancel) {
                showingIntegrationConfirmation = false
            }
        } message: {
            if let integrationStatus = supplementaryData.selectedProjectIntegrationStatus {
                Text(L10nFormat(
                    "Corptie will merge these completed Worktrees into main one at a time. Conflicts will be recorded and the remaining Worktrees will continue. No remote push is performed.\n\n%@",
                    integrationStatus.eligibleWorktrees.map {
                        "\($0.branchName ?? L10n("detached HEAD")) — \($0.taskTitle ?? L10n("Untitled CorptieTask"))"
                    }.joined(separator: "\n")
                ))
            }
        }
        .confirmationDialog(
            L10n("Synchronize this Worktree with main?"),
            isPresented: Binding(
                get: { pendingSynchronization != nil },
                set: { if !$0 { pendingSynchronization = nil } }
            ),
            presenting: pendingSynchronization
        ) { worktree in
            Button(L10n("Synchronize with main")) {
                backendClient.synchronizeProjectWorktree(worktree)
                pendingSynchronization = nil
            }
            Button(L10n("Cancel"), role: .cancel) {
                pendingSynchronization = nil
            }
        } message: { worktree in
            if worktree.dirty == true || worktree.mergedIntoMain != true {
                Text(L10n("This Worktree has changes not yet merged into main. Corptie will commit them if needed, merge them into main, and then synchronize the Worktree. No remote push is performed."))
            } else {
                Text(L10nFormat(
                    "This fast-forwards the Worktree by %d commits to the current main revision. No remote push is performed.",
                    worktree.behindMain ?? 0
                ))
            }
        }
        .confirmationDialog(
            L10n("Commit changes in this Worktree?"),
            isPresented: Binding(
                get: { pendingCommit != nil },
                set: { if !$0 { pendingCommit = nil } }
            ),
            presenting: pendingCommit
        ) { worktree in
            Button(L10n("Commit changes")) {
                backendClient.commitProjectWorktreeChanges(worktree)
                pendingCommit = nil
            }
            Button(L10n("Cancel"), role: .cancel) {
                pendingCommit = nil
            }
        } message: { worktree in
            Text(L10nFormat(
                "Corptie will generate a commit message using the associated session and commit the uncommitted changes on %@. No remote push is performed.",
                worktree.branchName ?? L10n("detached HEAD")
            ))
        }
    }

    private var status: ProjectWorktreeStatusResponse? {
        supplementaryData.selectedProjectWorktreeStatus
    }

    @ViewBuilder
    private func integrationResultCard(
        _ run: ProjectIntegrationRun,
        status: ProjectIntegrationStatusResponse
    ) -> some View {
        let conflicts = run.items.filter { $0.status == "conflict" }
        let failures = run.items.filter { $0.status == "failed" }
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Label(L10n("Completed Worktree Integration"), systemImage: "arrow.triangle.merge")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                if backendClient.isIntegratingCompletedWorktrees || run.status == "running" {
                    ProgressView().controlSize(.small)
                    Text(L10n("Integrating serially"))
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
            }

            HStack(spacing: 8) {
                integrationCountBadge(
                    L10nFormat("%d integrated", run.counts.integrated),
                    color: CorptiePalette.connected
                )
                integrationCountBadge(
                    L10nFormat("%d conflicts", run.counts.conflicts),
                    color: run.counts.conflicts > 0 ? CorptiePalette.amber : CorptiePalette.secondaryText
                )
                if run.counts.failed > 0 {
                    integrationCountBadge(
                        L10nFormat("%d failed", run.counts.failed),
                        color: .red
                    )
                }
            }

            if !conflicts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(conflicts) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.branchName ?? item.taskTitle)
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            Text(item.conflictFiles.isEmpty
                                ? L10n("Conflicting files will be inspected by the resolution CorptieTask")
                                : item.conflictFiles.joined(separator: ", "))
                                .font(.system(size: 10))
                                .foregroundStyle(CorptiePalette.secondaryText)
                                .lineLimit(2)
                        }
                    }
                }

                HStack {
                    Text(L10nFormat(
                        "%d Worktrees require conflict resolution",
                        conflicts.count
                    ))
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
                    Spacer()
                    Button(run.conflictCorptieTaskId == nil
                        ? L10n("Resolve Conflicts…")
                        : L10n("Open Conflict CorptieTask")) {
                        if run.conflictCorptieTaskId == nil {
                            pendingConflictRun = run
                        } else {
                            backendClient.createIntegrationConflictCorptieTask(
                                runId: run.id,
                                agentId: status.eligibleAgents.first?.agentId ?? ""
                            )
                        }
                    }
                    .controlSize(.small)
                    .disabled(
                        backendClient.isCreatingIntegrationConflictCorptieTask
                            || (run.conflictCorptieTaskId == nil && status.eligibleAgents.isEmpty)
                    )
                    .help(status.eligibleAgents.isEmpty && run.conflictCorptieTaskId == nil
                        ? L10n("Add an IC Agent to this Work before creating the resolution CorptieTask")
                        : L10n("Create and immediately start a CorptieTask to resolve these merge conflicts"))
                }
            }

            if !failures.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label(L10n("Worktree integration failures"), systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.red)
                    ForEach(failures) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.branchName ?? item.taskTitle)
                                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            Text(item.error ?? L10n("The Worktree could not be integrated. Refresh and try again."))
                                .font(.system(size: 10.5, weight: .medium))
                                .foregroundStyle(.red)
                                .textSelection(.enabled)
                        }
                    }
                }
            }

            if let error = run.error, !error.isEmpty {
                Text(error)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .padding(12)
        .background(CorptiePalette.amber.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(CorptiePalette.amber.opacity(0.22), lineWidth: 0.75)
        )
    }

    private func handleIntegrationEntry(_ state: ProjectWorktreeIntegrationEntryState) {
        switch state {
        case .ready:
            backendClient.dismissProjectWorktreeActionError()
            showingIntegrationConfirmation = true
        case .noEligibleWorktrees:
            backendClient.recordProjectWorktreeActionError(L10n(
                "No completed Worktrees are eligible for integration. Complete the CorptieTask, stop its active Session, and commit its local changes before trying again."
            ))
        case .unresolvedConflicts:
            backendClient.recordProjectWorktreeActionError(L10n(
                "Resolve the current Integration Run conflicts before starting another one"
            ))
        case .running:
            backendClient.recordProjectWorktreeActionError(L10n("Worktree integration is already running."))
        }
    }

    private func integrationEntryHelp(_ state: ProjectWorktreeIntegrationEntryState) -> String {
        switch state {
        case .ready:
            L10n("Serially merge every completed Worktree in this Work into main")
        case .noEligibleWorktrees:
            L10n("Click to see why no Worktrees can be integrated")
        case .unresolvedConflicts:
            L10n("Click to review the blocking integration conflict")
        case .running:
            L10n("Worktree integration is already running.")
        }
    }

    private func integrationCountBadge(_ label: String, color: Color) -> some View {
        Text(label)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(color.opacity(0.1), in: Capsule())
    }

    @ViewBuilder
    private func serviceCard(_ status: ProjectWorktreeStatusResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(L10n("Development Service"), systemImage: "server.rack")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(serviceLabel(status.service))
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(serviceColor(status.service))
                    if let detail = serviceIdentityDetail(status.service) {
                        Text(detail)
                            .font(.system(size: 9.5, weight: .medium, design: .monospaced))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .lineLimit(1)
                            .help(detail)
                    }
                }
            }

            if status.toolset.configured {
                if !status.toolset.profiles.isEmpty {
                    HStack(spacing: 8) {
                        Text(L10n("Service profile"))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Picker("", selection: Binding(
                            get: { status.toolset.selectedProfile },
                            set: { backendClient.selectProjectServiceProfile($0) }
                        )) {
                            ForEach(status.toolset.profiles) { profile in
                                Text(profile.label).tag(profile.id)
                            }
                        }
                        .labelsHidden()
                        .frame(maxWidth: 220)
                        .help(status.toolset.profiles.first(where: {
                            $0.id == status.toolset.selectedProfile
                        })?.description ?? "")
                        Spacer()
                    }
                    .controlSize(.small)
                    .disabled(isServiceActionRunning)
                }

                HStack(spacing: 8) {
                    if status.service.running == true {
                        Button(L10n("Rebuild and Restart")) { backendClient.runProjectServiceAction("restart") }
                        Button(L10n("Stop")) { backendClient.runProjectServiceAction("stop") }
                    } else {
                        Button(L10n("Build and Start")) { backendClient.runProjectServiceAction("start") }
                    }
                    Spacer()
                    Button(L10n("Update Corptie Scripts Tools Set")) {
                        backendClient.initializeProjectToolset(update: true)
                    }
                }
                .controlSize(.small)
                .disabled(isServiceActionRunning)
            } else if status.toolset.requiresUpdate {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n("This project uses an older Corptie toolset."))
                            .font(.system(size: 11, weight: .semibold))
                        Text(L10n("Update it before rebuilding or claiming that the running service is current."))
                            .font(.system(size: 10.5))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                    Spacer()
                    Button(L10n("Update Corptie Scripts Tools Set")) {
                        backendClient.initializeProjectToolset(update: true)
                    }
                    .disabled(supplementaryData.isLoadingProjectWorktrees)
                }
            } else {
                HStack {
                    Text(L10n("The Corptie Scripts Tools Set is being prepared or is not configured."))
                        .font(.system(size: 11))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Spacer()
                    Button(L10n("Initialize Toolset")) {
                        backendClient.initializeProjectToolset()
                    }
                    .disabled(supplementaryData.isLoadingProjectWorktrees)
                }
            }
        }
        .padding(12)
        .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
        )
    }

    @ViewBuilder
    private func worktreeRow(_ worktree: ProjectWorktreeStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: worktree.isMain ? "house.fill" : "arrow.triangle.branch")
                    .foregroundStyle(worktreeStateColor(worktree))
                Text(worktree.branchName ?? L10n("detached HEAD"))
                    .font(.system(size: 13, weight: .semibold, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                Spacer()
                if !worktree.isMain {
                    if backendClient.projectWorktreeActionIds.contains(worktree.worktreeId) {
                        ProgressView().controlSize(.small)
                    } else {
                        Button(L10n("Actions…")) {
                            pendingOperation = worktree
                        }
                        .controlSize(.small)
                    }
                }
            }
            Text(worktree.path)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(CorptiePalette.mutedText)
                .lineLimit(1)
                .truncationMode(.middle)
                .help(worktree.path)
            HStack(spacing: 8) {
                worktreeStateBadge(worktree)
                if !worktree.isMain {
                    worktreeSyncBadge(worktree)
                }
                if let ahead = worktree.aheadOfMain, ahead > 0 {
                    Button {
                        pendingOperation = worktree
                    } label: {
                        Label(L10nFormat("%d ahead", ahead), systemImage: "arrow.up")
                    }
                    .buttonStyle(.plain)
                    .help(L10n("Open Worktree operations"))
                }
                if let behind = worktree.behindMain, behind > 0 {
                    Button {
                        pendingSynchronization = worktree
                    } label: {
                        Label(L10nFormat("%d behind", behind), systemImage: "arrow.down")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(CorptiePalette.amber)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(CorptiePalette.amber.opacity(0.12), in: Capsule())
                    .disabled(backendClient.projectWorktreeActionIds.contains(worktree.worktreeId))
                    .help(L10n("Synchronize this Worktree with main"))
                }
                if worktree.dirty == true {
                    Button {
                        pendingCommit = worktree
                    } label: {
                        Label(L10n("Uncommitted changes"), systemImage: "pencil.circle")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(CorptiePalette.amber)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(CorptiePalette.amber.opacity(0.12), in: Capsule())
                    .disabled(backendClient.projectWorktreeActionIds.contains(worktree.worktreeId))
                    .help(L10n("Generate a commit message with the associated session and commit these changes"))
                }
                if worktree.isMain,
                   let push = worktree.gitHubPush,
                   push.available,
                   push.pending {
                    mainPushBadge(worktree, push: push)
                }
                worktreeSessionsBadge(worktree)
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(CorptiePalette.secondaryText)
        }
        .padding(12)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.09), lineWidth: 0.75)
        )
    }

    @ViewBuilder
    private func mainPushBadge(_ worktree: ProjectWorktreeStatus, push: GitHubPushStatus) -> some View {
        let label = push.unpushedCommitCount > 0
            ? L10nFormat("%d commit(s) pending push", push.unpushedCommitCount)
            : L10n("Pending GitHub push")
        if selectedSessionWorktreeId == worktree.worktreeId {
            Button {
                backendClient.prepareGitHubPush()
            } label: {
                Label(label, systemImage: "arrow.up.circle.fill")
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.connected)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(CorptiePalette.connected.opacity(0.12), in: Capsule())
            .disabled(backendClient.isPreparingGitHubPush || backendClient.isPushingGitHub)
            .help(L10n("Review and push the current main branch to GitHub"))
        } else {
            Label(label, systemImage: "arrow.up.circle.fill")
                .foregroundStyle(CorptiePalette.connected)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(CorptiePalette.connected.opacity(0.12), in: Capsule())
                .help(L10n("Open a Session on main to review and push these commits"))
        }
    }

    private var selectedSessionWorktreeId: String? {
        guard let session = backendClient.selectedSession,
              let status else { return nil }
        if let associated = status.project.worktrees.first(where: { worktree in
            worktree.sessions.contains(where: { $0.sessionId == session.id })
        }) {
            return associated.worktreeId
        }
        guard let path = session.external?.workspace?.path else { return nil }
        let normalized = URL(fileURLWithPath: path).standardizedFileURL.path
        return status.project.worktrees.first(where: {
            URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
        })?.worktreeId
    }

    private func worktreeStatusBadge(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
    }

    @ViewBuilder
    private func worktreeStateBadge(_ worktree: ProjectWorktreeStatus) -> some View {
        if worktree.isMain && worktree.dirty != true {
            worktreeStatusBadge(worktreeStateLabel(worktree), color: worktreeStateColor(worktree))
        } else {
            Button {
                if worktree.isMain {
                    pendingCommit = worktree
                } else {
                    pendingOperation = worktree
                }
            } label: {
                worktreeStatusBadge(worktreeStateLabel(worktree), color: worktreeStateColor(worktree))
            }
            .buttonStyle(.plain)
            .help(worktree.isMain ? L10n("Commit uncommitted changes") : L10n("Open Worktree operations"))
        }
    }

    @ViewBuilder
    private func worktreeSyncBadge(_ worktree: ProjectWorktreeStatus) -> some View {
        if worktree.synchronizedWithMain == false {
            Button {
                pendingSynchronization = worktree
            } label: {
                worktreeStatusBadge(worktreeSyncLabel(worktree), color: worktreeSyncColor(worktree))
            }
            .buttonStyle(.plain)
            .disabled(backendClient.projectWorktreeActionIds.contains(worktree.worktreeId))
            .help(L10n("Synchronize this Worktree with main"))
        } else {
            worktreeStatusBadge(worktreeSyncLabel(worktree), color: worktreeSyncColor(worktree))
        }
    }

    @ViewBuilder
    private func worktreeSessionsBadge(_ worktree: ProjectWorktreeStatus) -> some View {
        if worktree.sessions.isEmpty {
            Button {
                newSessionPanel.show(backendClient: backendClient, workspacePath: worktree.path)
            } label: {
                Label(L10n("No associated sessions"), systemImage: "plus.bubble")
            }
            .buttonStyle(.plain)
            .foregroundStyle(CorptiePalette.amber)
            .help(L10n("Create a session in this Worktree"))
        } else if worktree.sessions.count == 1, let association = worktree.sessions.first {
            Button {
                openSession(association)
            } label: {
                Label(L10nFormat("%d sessions", worktree.sessions.count), systemImage: "bubble.left.and.bubble.right")
            }
            .buttonStyle(.plain)
            .help(association.title ?? L10n("Open associated session"))
        } else {
            Menu {
                ForEach(worktree.sessions, id: \.logicalSessionId) { association in
                    Button(association.title ?? association.sessionId ?? association.logicalSessionId) {
                        openSession(association)
                    }
                }
            } label: {
                Label(L10nFormat("%d sessions", worktree.sessions.count), systemImage: "bubble.left.and.bubble.right")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .help(L10n("Open associated session"))
        }
    }

    private func openSession(_ association: ProjectWorktreeSession) {
        guard let sessionId = association.sessionId,
              let session = backendClient.sessions.first(where: { $0.id == sessionId }) else { return }
        backendClient.select(session: session, focusComposer: true)
        ProjectWorktreeWindowManager.shared.close()
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
        default:
            switch service.state {
            case "configuring": L10n("Configuring")
            case "configurationFailed": L10n("Configuration failed")
            case "notConfigured": L10n("Not configured")
            default: L10n("Version unknown")
            }
        }
    }

    private var isServiceActionRunning: Bool {
        backendClient.projectWorktreeActionIds.contains { $0.hasPrefix("service:") }
    }

    private func serviceColor(_ service: ProjectServiceStatus) -> Color {
        switch service.freshness {
        case "current": CorptiePalette.connected
        case "stale", "configurationMismatch", "unverifiedBuild", "toolsetUpdateRequired", "unhealthy": CorptiePalette.amber
        default: CorptiePalette.secondaryText
        }
    }

    private func serviceIdentityDetail(_ service: ProjectServiceStatus) -> String? {
        guard let revision = service.runningRevision, !revision.isEmpty else {
            return service.verificationDetail
        }
        let shortRevision = String(revision.prefix(5))
        let branch = service.runningBranch ?? L10n("unknown branch")
        let commitTime = service.runningCommitTime.flatMap { value -> String? in
            guard let date = ISO8601DateFormatter.corptieThreadItemDate(from: value) else { return nil }
            let formatter = DateFormatter()
            formatter.locale = Locale.current
            formatter.timeZone = .current
            formatter.dateFormat = "yyyy-MM-dd HH:mm"
            return formatter.string(from: date)
        } ?? L10n("unknown time")
        let profile = service.runningProfile ?? service.desiredProfile
        let base = L10nFormat("Commit %@ · %@ · branch %@", shortRevision, commitTime, branch)
        if let profile, !profile.isEmpty {
            return "\(base) · \(L10n("profile")) \(profile)"
        }
        return base
    }

    private func worktreeStateLabel(_ worktree: ProjectWorktreeStatus) -> String {
        switch worktree.state {
        case "main": L10n("Main")
        case "mainDirty": L10n("Main has changes")
        case "working": L10n("In progress")
        case "readyToMerge": L10n("Ready to merge")
        case "diverged": L10n("Diverged")
        case "synced": L10n("Merged")
        default: L10n("Unavailable")
        }
    }

    private func worktreeStateColor(_ worktree: ProjectWorktreeStatus) -> Color {
        switch worktree.state {
        case "main", "synced": CorptiePalette.connected
        case "working", "readyToMerge": CorptiePalette.amber
        case "diverged", "unavailable": .red
        default: CorptiePalette.secondaryText
        }
    }

    private func worktreeSyncLabel(_ worktree: ProjectWorktreeStatus) -> String {
        switch worktree.synchronizedWithMain {
        case true: L10n("In sync with main")
        case false: L10n("Not in sync with main")
        case nil: L10n("Sync unknown")
        }
    }

    private func worktreeSyncColor(_ worktree: ProjectWorktreeStatus) -> Color {
        switch worktree.synchronizedWithMain {
        case true: CorptiePalette.connected
        case false: CorptiePalette.amber
        case nil: CorptiePalette.secondaryText
        }
    }
}
