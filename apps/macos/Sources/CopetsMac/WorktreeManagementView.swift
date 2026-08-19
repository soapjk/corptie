import AppKit
import SwiftUI

enum WorktreeAutomaticLoadPolicy {
    static func shouldLoad(isBackendOnline: Bool, selectedTab: AppTab) -> Bool {
        isBackendOnline && selectedTab == .worktrees
    }
}

struct WorktreeManagementView: View {
    @EnvironmentObject private var router: AppTabRouter
    @ObservedObject private var backendClient = BackendClient.shared
    @StateObject private var client = WorktreeManagementClient()
    @State private var showingPlan = false
    @State private var showingSynchronizationConfirmation = false
    @State private var pendingOperation: ManagedWorktree?

    var body: some View {
        NavigationSplitView(columnVisibility: $router.sidebarVisibility) {
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
                selectedTab: router.selectedTab
            ) else { return }
            await client.loadRepositories()
            if let target = router.pendingWorktreeTarget {
                await client.navigate(to: target)
                router.consumeWorktreeTarget(target)
            }
        }
        .task(id: router.pendingWorktreeTarget) {
            guard backendClient.isOnline, router.selectedTab == .worktrees else { return }
            guard let target = router.pendingWorktreeTarget else { return }
            await client.navigate(to: target)
            router.consumeWorktreeTarget(target)
        }
        .task(id: client.job.map { "\($0.id):\($0.isActive)" }) {
            guard let jobId = client.job?.id else { return }
            while !Task.isCancelled, client.job?.id == jobId, client.job?.isActive == true {
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                await client.pollJob()
            }
        }
        .sheet(isPresented: $showingPlan) {
            if let job = client.job { WorktreeIntegrationPlanReview(job: job, client: client, isPresented: $showingPlan) }
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
        "\(backendClient.isOnline):\(router.selectedTab == .worktrees)"
    }

    private var repositoryColumn: some View {
        VStack(spacing: 0) {
            columnHeader(L10n("Repository Workspaces"), systemImage: "externaldrive.connected.to.line.below") {
                Task { await client.loadRepositories() }
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
                integrationAction(project)
                if let job = client.job { jobProgress(job) }
                List(selection: Binding(
                    get: { client.selection.worktreeId },
                    set: { client.selection.worktreeId = $0 }
                )) {
                    ForEach(project.worktrees) { worktree in
                        worktreeRow(worktree)
                            .tag(worktree.worktreeId)
                            .accessibilityIdentifier("worktree.item.\(worktree.worktreeId)")
                    }
                }
                .listStyle(.inset)
            } else if client.isLoading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
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
                        HStack {
                            Button {
                                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: worktree.path)])
                            } label: {
                                Label(L10n("Show in Finder"), systemImage: "folder")
                            }
                            if !worktree.isMain, (worktree.behindMain ?? 0) > 0 {
                                Button {
                                    showingSynchronizationConfirmation = true
                                } label: {
                                    Label(L10n("Synchronize with main"), systemImage: "arrow.down.to.line")
                                }
                                .disabled(client.isMutating || worktree.availability != "available")
                            }
                            if !worktree.isMain {
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
                            }
                        }
                        .controlSize(.small)
                        Text(L10n("Click a Worktree status to review and run operations for that Worktree only."))
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
                    detailSection(L10n("WorkItem and Session")) {
                        if worktree.associations.isEmpty {
                            Text(L10n("No associated WorkItem or Session")).foregroundStyle(.secondary)
                        } else {
                            ForEach(worktree.associations, id: \.logicalSessionId) { association in
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(association.workItemTitle ?? L10n("Unbound WorkItem")).fontWeight(.medium)
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

    private func integrationAction(_ project: ManagedGitProject) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(L10n("Integrate all Worktrees into main")).fontWeight(.semibold)
                Text(L10n("Preflight creates a reviewable local-only plan."))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button {
                if client.job?.status == "awaiting_confirmation" {
                    showingPlan = true
                } else {
                    Task {
                        await client.createPreflight()
                        showingPlan = client.job?.status == "awaiting_confirmation"
                    }
                }
            } label: {
                Label(
                    L10n(client.job?.status == "awaiting_confirmation" ? "Review Plan" : "Preflight"),
                    systemImage: "checklist"
                )
            }
            .buttonStyle(.borderedProminent)
            .disabled(client.isMutating || client.job?.isActive == true || client.job?.status == "paused")
            .accessibilityIdentifier("worktree.integrate.preflight")
        }
        .padding(12)
        .background(Color.primary.opacity(0.035))
    }

    private func jobProgress(_ job: WorktreeIntegrationJob) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack {
                Text(localizedIntegrationPhase(job.phase)).font(.caption.weight(.semibold))
                Spacer()
                Text("\(job.progress.completed)/\(job.progress.total)").font(.caption.monospacedDigit())
                if job.status == "paused" {
                    Button(L10n("Retry")) { Task { await client.retryJob() } }
                        .controlSize(.small)
                        .accessibilityIdentifier("worktree.integrate.retry")
                }
            }
            ProgressView(value: job.progress.fraction)
            if let current = job.currentWorktreeId,
               let item = job.plan.items.first(where: { $0.worktreeId == current }) {
                Text(item.branchName ?? item.path).font(.caption).foregroundStyle(.secondary)
            }
            if let error = job.error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding(10)
        .background((job.status == "paused" ? Color.orange : Color.accentColor).opacity(0.08))
        .accessibilityIdentifier("worktree.integration.progress")
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
        if worktree.isMain {
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
    private func developmentServiceSection(_ status: ProjectWorktreeStatusResponse) -> some View {
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
                Text(L10n("Worktree Operations")).font(.title3.weight(.semibold))
                Text(worktree.branchName ?? L10n("Detached HEAD"))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                Text(worktree.path).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }

            if isPreparing {
                HStack { ProgressView().controlSize(.small); Text(L10n("Inspecting Worktree changes…")) }
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    Toggle(L10n("Merge into main"), isOn: $mergeIntoMain)
                        .disabled(mergeIsUnnecessary)
                    Toggle(L10n("Synchronize with main"), isOn: $synchronizeWithMain)
                        .disabled(worktree.synchronizedWithMain == true)
                    Toggle(L10n("Restart service"), isOn: $restartService)
                }
                .toggleStyle(.checkbox)

                if worktree.dirty == true, mergeIntoMain {
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
                Button(L10n("Execute")) {
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
    default: value.replacingOccurrences(of: "_", with: " ")
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
    case "retry_queued": L10n("Retry queued")
    case "recovery_queued": L10n("Recovery queued")
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
    case "WORKTREE_UNAVAILABLE": L10n("This Worktree is unavailable.")
    case "WORKTREE_LOCKED": L10n("This Worktree is locked by another operation.")
    case "WORKTREE_PRUNABLE": L10n("This Worktree has invalid or prunable Git metadata.")
    case "GIT_OPERATION_IN_PROGRESS": L10n("A Git operation is already in progress in this Worktree.")
    case "WORKTREE_BRANCH_AMBIGUOUS": L10n("The branch for this Worktree cannot be determined safely.")
    case "UNRESOLVED_CONFLICTS": L10n("This Worktree contains unresolved conflicts.")
    default: risk.message
    }
}

private struct WorktreeIntegrationPlanReview: View {
    let job: WorktreeIntegrationJob
    @ObservedObject var client: WorktreeManagementClient
    @Binding var isPresented: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("Review Worktree Integration Plan")).font(.title2.weight(.semibold))
            Text(L10n("Only local commits and merges will be performed. Nothing is pushed, deleted, reset, or force-cleaned."))
                .foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
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
                            ForEach(item.risks, id: \.code) { risk in
                                Label(localizedIntegrationRisk(risk), systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                            }
                        }
                        Divider()
                    }
                }
            }
            .frame(maxHeight: 420)
            if !job.plan.blockingRisks.isEmpty {
                Text(L10n("Resolve all blocking risks and run preflight again before confirming."))
                    .foregroundStyle(.orange)
            }
            HStack {
                Button(L10n("Cancel"), role: .cancel) { isPresented = false }
                Spacer()
                Button(L10n("Confirm and Start")) {
                    confirmAndDismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(client.isMutating || !job.plan.blockingRisks.isEmpty)
                .accessibilityIdentifier("worktree.integrate.confirm")
            }
        }
        .padding(20)
        .frame(width: 680, height: 620)
    }

    private var reviewItems: [WorktreeIntegrationItem] {
        job.plan.items.filter {
            $0.commitStatus != "not_needed" || $0.mergeStatus != "not_needed"
        }
    }

    private func confirmAndDismiss() {
        isPresented = false
        Task { await client.confirmPlan() }
    }
}
