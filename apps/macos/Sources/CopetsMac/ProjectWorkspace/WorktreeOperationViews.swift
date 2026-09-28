import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ProjectIntegrationConflictCorptieTaskConfirmationView: View {
    let run: ProjectIntegrationRun
    let status: ProjectIntegrationStatusResponse
    let isCreating: Bool
    let onConfirm: (String, String?) -> Void
    let onCancel: () -> Void

    @State private var selectedAgentId = ""
    @State private var title = ""

    private var conflicts: [ProjectIntegrationRunItem] {
        run.items.filter { $0.status == "conflict" }
    }

    private var selectedAgent: ProjectIntegrationAgent? {
        status.eligibleAgents.first { $0.agentId == selectedAgentId }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "wrench.and.screwdriver.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(CorptiePalette.amber)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("Create Conflict-Resolution CorptieTask"))
                        .font(.system(size: 18, weight: .bold))
                    Text(L10nFormat(
                        "This CorptieTask will be created under Work %@ and start immediately.",
                        status.work.name
                    ))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
                }
            }

            Text(L10nFormat(
                "This operation creates one dedicated CorptieTask to resolve the merge conflicts in the following %d branches and merge the result into main:",
                conflicts.count
            ))
            .font(.system(size: 12, weight: .medium))

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(conflicts) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.branchName ?? item.taskTitle)
                                .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                            Text(item.taskTitle)
                                .font(.system(size: 10.5))
                                .foregroundStyle(CorptiePalette.secondaryText)
                            if !item.conflictFiles.isEmpty {
                                Text(item.conflictFiles.joined(separator: ", "))
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(CorptiePalette.mutedText)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            .frame(maxHeight: 180)

            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    Text(L10n("Work"))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Text(status.work.name)
                        .fontWeight(.semibold)
                }
                GridRow {
                    Text(L10n("Agent"))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Picker("", selection: $selectedAgentId) {
                        ForEach(status.eligibleAgents) { agent in
                            Text(agent.name).tag(agent.agentId)
                        }
                    }
                    .labelsHidden()
                }
                GridRow {
                    Text(L10n("CorptieTask title"))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    TextField(L10n("Resolve completed Worktree merge conflicts"), text: $title)
                        .textFieldStyle(.roundedBorder)
                }
            }
            .font(.system(size: 11.5, weight: .medium))

            if let selectedAgent {
                Text(L10nFormat(
                    "After confirmation, Corptie will bind this CorptieTask to Agent %@ and start its Work Session in a dedicated Integration Worktree.",
                    selectedAgent.name
                ))
                .font(.system(size: 10.5))
                .foregroundStyle(CorptiePalette.secondaryText)
            } else if status.eligibleAgents.isEmpty {
                Label(
                    L10n("This Work has no available IC Agent."),
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.red)
            }

            HStack {
                Spacer()
                Button(L10n("Cancel"), action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(L10n("Create and Start CorptieTask")) {
                    let customTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
                    onConfirm(selectedAgentId, customTitle.isEmpty ? nil : customTitle)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(selectedAgentId.isEmpty || isCreating)
            }
        }
        .padding(20)
        .frame(width: 580)
        .onAppear {
            if selectedAgentId.isEmpty {
                selectedAgentId = status.eligibleAgents.first?.agentId ?? ""
            }
        }
    }
}

struct ForceDeleteWorktreeConfirmationView: View {
    let deletion: PendingWorktreeDeletion
    let onConfirm: (String) -> Void
    let onCancel: () -> Void
    @State private var typedBranchName = ""

    private var branchName: String {
        deletion.worktree.branchName ?? ""
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "trash.slash.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(.red)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("Confirm permanent Worktree deletion"))
                        .font(.system(size: 18, weight: .bold))
                    Text(L10nFormat(
                        "%d commits have not been merged into main.",
                        deletion.worktree.aheadOfMain ?? 0
                    ))
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                }
            }

            Text(L10n("This will permanently delete the Worktree directory, its branch, and all changes unique to that branch. This action cannot be undone."))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.red)

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Type the full branch name exactly as shown to confirm:"))
                    .font(.system(size: 11, weight: .medium))
                Text(branchName.isEmpty ? L10n("detached HEAD") : branchName)
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .textSelection(.enabled)
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.primary.opacity(0.05), in: RoundedRectangle(cornerRadius: 7))
                TextField(L10n("Full branch name"), text: $typedBranchName)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
            }

            HStack {
                Spacer()
                Button(L10n("Cancel"), action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(L10n("Permanently Delete Worktree"), role: .destructive) {
                    onConfirm(typedBranchName)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(branchName.isEmpty || typedBranchName != branchName)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}

struct WorktreeCommitReviewView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @ObservedObject private var commandState = BackendClient.shared.sessionCommandController
    let prompt: WorktreeCommitReviewPrompt
    @State private var decision = "include"
    @State private var neverRemind = false
    @State private var commitMessage = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 10) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 24))
                    .foregroundStyle(CorptiePalette.amber)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L10n("Review Commit"))
                        .font(.system(size: 18, weight: .bold))
                    Text(prompt.worktree.branchName ?? L10n("detached HEAD"))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
            }

            Text(operationSummary)
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(CorptiePalette.secondaryText)

            CommitMessageEditor(
                message: $commitMessage,
                isGenerating: backendClient.isGeneratingWorktreeCommitMessage,
                helpText: L10n("Enter your own message or generate one with Agent, then edit it before continuing."),
                generate: { await backendClient.generateWorktreeCommitMessage() }
            )

            if prompt.protection.requiresDecision {
                PrivateAgentFilesDecisionView(
                    protection: prompt.protection,
                    decision: $decision,
                    neverRemind: $neverRemind
                )
            }

            HStack {
                Spacer()
                Button(L10n("Cancel")) {
                    backendClient.cancelProtectedWorktreeCommit()
                }
                .keyboardShortcut(.cancelAction)
                Button(confirmButtonLabel) {
                    backendClient.confirmProtectedWorktreeCommit(
                        commitMessage: commitMessage.trimmingCharacters(in: .whitespacesAndNewlines),
                        decision: decision,
                        neverRemindPrivateFiles: neverRemind
                    )
                }
                .keyboardShortcut(.defaultAction)
                .disabled(
                    backendClient.isGeneratingWorktreeCommitMessage
                        || commitMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            }
        }
        .padding(20)
        .frame(width: 560)
    }

    private var operationSummary: String {
        switch prompt.operation {
        case .commit: L10n("The changes will be committed to this Worktree only. No remote push is performed.")
        case .merge: L10n("The changes will be committed and then merged into main. No remote push is performed.")
        case .complete: L10n("The changes will be committed before completing the Worktree operation. No remote push is performed.")
        case .operate: L10n("The changes will be committed before running the selected Worktree operations. No remote push is performed.")
        }
    }

    private var confirmButtonLabel: String {
        switch prompt.operation {
        case .commit: L10n("Commit Changes")
        case .merge: L10n("Commit and Merge")
        case .complete, .operate: L10n("Commit and Continue")
        }
    }
}

struct PrivateAgentFilesDecisionView: View {
    let protection: GitCommitProtectionStatus
    @Binding var decision: String
    @Binding var neverRemind: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L10n("Detected these local Agent files:"))
                .font(.system(size: 12, weight: .semibold))
            ScrollView {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(protection.protectedPaths, id: \.self) { path in
                        Label {
                            Text(path)
                                .font(.system(size: 10.5, design: .monospaced))
                        } icon: {
                            Image(systemName: "doc.fill")
                                .font(.system(size: 9))
                                .foregroundStyle(CorptiePalette.amber)
                        }
                        .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(
                height: min(
                    max(CGFloat(protection.protectedPaths.count) * 18, 36),
                    105
                )
            )
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 6))

            Picker("", selection: $decision) {
                Text(L10n("Add matching paths to the project .gitignore")).tag("ignore")
                Text(L10n("Include these files in the commit")).tag("include")
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()

            Toggle(L10n("Do not remind me again for this project"), isOn: $neverRemind)
                .font(.system(size: 11, weight: .medium))

            if decision == "ignore" {
                Text(L10n("Corptie will append only the matching root paths to the project .gitignore. Existing rules will be preserved."))
                    .font(.system(size: 10.5))
                    .foregroundStyle(CorptiePalette.secondaryText)
            } else {
                Text(L10n("These files may be stored in Git history and included in a GitHub push."))
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(CorptiePalette.amber)
            }
        }
        .padding(12)
        .background(CorptiePalette.amber.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(CorptiePalette.amber.opacity(0.24), lineWidth: 0.75)
        )
    }
}

struct ProjectWorktreeOperationView: View {
    let worktree: ProjectWorktreeStatus
    let status: ProjectWorktreeStatusResponse
    let onExecute: (Bool, Bool, Bool, Bool, Bool) -> Void
    let onCancel: () -> Void

    @State private var mergeIntoMain: Bool
    @State private var synchronizeWithMain: Bool
    @State private var deleteWorktree = false
    @State private var deleteSessions = false
    @State private var restartService: Bool

    init(
        worktree: ProjectWorktreeStatus,
        status: ProjectWorktreeStatusResponse,
        onExecute: @escaping (Bool, Bool, Bool, Bool, Bool) -> Void,
        onCancel: @escaping () -> Void
    ) {
        self.worktree = worktree
        self.status = status
        self.onExecute = onExecute
        self.onCancel = onCancel
        let needsMerge = worktree.dirty == true || worktree.mergedIntoMain != true
        _mergeIntoMain = State(initialValue: needsMerge)
        _synchronizeWithMain = State(initialValue: worktree.synchronizedWithMain != true)
        _restartService = State(initialValue: false)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L10n("Worktree Operations"))
                    .font(.system(size: 17, weight: .bold))
                Text(worktree.branchName ?? L10n("detached HEAD"))
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(CorptiePalette.secondaryText)
            }

            VStack(alignment: .leading, spacing: 12) {
                Toggle(L10n("Merge into main"), isOn: $mergeIntoMain)
                    .disabled(deleteWorktree || mergeIsUnnecessary)
                Toggle(L10n("Synchronize with main"), isOn: $synchronizeWithMain)
                    .disabled(deleteWorktree || worktree.synchronizedWithMain == true)
                Toggle(L10n("Delete this Worktree"), isOn: $deleteWorktree)
                Toggle(L10nFormat("Delete %d associated sessions", worktree.sessions.count), isOn: $deleteSessions)
                    .disabled(worktree.sessions.isEmpty)
                Toggle(L10n("Restart service"), isOn: $restartService)
            }
            .toggleStyle(.checkbox)

            if deleteWorktree && !worktree.sessions.isEmpty && !deleteSessions {
                Text(L10n("Deleting this Worktree also requires deleting its associated sessions."))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.amber)
            } else {
                Text(L10n("Operations run in the displayed order. Service restart always runs last. No remote push is performed."))
                    .font(.system(size: 11))
                    .foregroundStyle(CorptiePalette.secondaryText)
            }

            Spacer()
            HStack {
                Spacer()
                Button(L10n("Cancel"), action: onCancel)
                    .keyboardShortcut(.cancelAction)
                Button(L10n("Execute")) {
                    onExecute(
                        mergeIntoMain,
                        synchronizeWithMain,
                        deleteWorktree,
                        deleteSessions,
                        restartService
                    )
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canExecute)
            }
        }
        .padding(20)
        .frame(width: 430, height: 350)
        .onChange(of: deleteWorktree) { _, selected in
            if selected {
                mergeIntoMain = false
                synchronizeWithMain = false
            }
        }
        .onChange(of: mergeIntoMain) { _, selected in
            if selected { deleteWorktree = false }
        }
        .onChange(of: synchronizeWithMain) { _, selected in
            if selected {
                deleteWorktree = false
                if worktree.mergedIntoMain != true || worktree.dirty == true {
                    mergeIntoMain = true
                }
            }
        }
    }

    private var mergeIsUnnecessary: Bool {
        worktree.mergedIntoMain == true && worktree.dirty != true
    }

    private var canExecute: Bool {
        let hasSelection = mergeIntoMain
            || synchronizeWithMain
            || deleteWorktree
            || deleteSessions
            || restartService
        let canDelete = !deleteWorktree || worktree.sessions.isEmpty || deleteSessions
        return hasSelection && canDelete
    }
}

struct GitBranchStamp: View {
    let headState: GitHeadState

    var body: some View {
        Text(headState.stampText ?? "")
            .font(.system(size: 7.5, weight: .bold, design: .monospaced))
            .foregroundStyle(headState.isWarning ? CorptiePalette.amber : Color.white)
            .lineLimit(1)
            .truncationMode(.middle)
            .padding(.horizontal, 4)
            .padding(.vertical, 2)
            .background(
                headState.isWarning ? CorptiePalette.amber.opacity(0.12) : Color.black.opacity(0.34),
                in: RoundedRectangle(cornerRadius: 3, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 3, style: .continuous)
                    .strokeBorder(
                        headState.isWarning ? CorptiePalette.amber.opacity(0.8) : Color.white.opacity(0.78),
                        lineWidth: 0.75
                    )
            }
            .help(headState.helpText ?? "")
            .accessibilityLabel(headState.helpText ?? "")
    }
}
