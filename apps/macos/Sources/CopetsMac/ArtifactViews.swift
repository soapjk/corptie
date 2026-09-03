import AppKit
import SwiftUI

struct ArtifactSectionView: View {
    @ObservedObject private var client = ArtifactAPIClient.shared
    let workId: String
    let taskId: String?

    @State private var selection: WorkArtifact?
    @State private var showCreate = false
    @State private var importReceipt: ArtifactImportReceipt?
    @State private var isImporting = false

    private var loadState: ArtifactCollectionLoadState {
        if let taskId { return client.taskLoadStates[taskId] ?? .idle }
        return client.workLoadStates[workId] ?? .idle
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Label(L10n("Artifacts"), systemImage: "doc.on.doc")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text("\(CorptieAppEnvironment.displayName) · :\(CorptieAppEnvironment.backendPort)")
                    .font(.system(size: 8, weight: .medium))
                    .foregroundStyle(CorptieAppEnvironment.isDevelopment ? Color.orange : Color.secondary)
                Spacer()
                Button { importDocument() } label: { Image(systemName: "square.and.arrow.down") }
                    .buttonStyle(.plain)
                    .help(L10n("Import Local Document"))
                    .disabled(isImporting)
                Button { showCreate = true } label: { Image(systemName: "plus") }
                    .buttonStyle(.plain)
                    .help(L10n("Create Artifact"))
            }

            artifactLoadContent

            if client.hasMore(workId: workId, taskId: taskId) {
                Button(L10n("Load more Artifacts")) {
                    Task { await client.loadMore(workId: workId, taskId: taskId) }
                }
                .buttonStyle(.borderless)
                .frame(maxWidth: .infinity, alignment: .center)
            }

            if let receipt = importReceipt {
                Label("SHA-256 \(receipt.contentHash.prefix(12))… · \(receipt.byteLength) bytes · source preserved", systemImage: "checkmark.shield")
                    .font(.system(size: 9)).foregroundStyle(.green)
            }
        }
        .task(id: taskId ?? workId) { await refresh() }
        .onDisappear { if let taskId { client.cancelRefresh(taskId: taskId) } }
        .sheet(item: $selection) { artifact in
            ArtifactDetailContainer(
                artifactId: artifact.artifactId,
                workId: workId,
                taskId: taskId
            ) { Task { await refresh() } }
        }
        .sheet(isPresented: $showCreate) {
            ArtifactCreateView(workId: workId, taskId: taskId) {
                showCreate = false
                Task { await refresh() }
            }
        }
    }

    @ViewBuilder
    private var artifactLoadContent: some View {
        switch loadState {
        case .idle:
            artifactLoading
        case .loading(let previous):
            if let previous {
                Label(L10n("Refreshing Artifacts — displayed data may be stale."), systemImage: "clock.arrow.circlepath")
                    .font(.system(size: 9)).foregroundStyle(.secondary)
                artifactRows(previous)
            } else {
                artifactLoading
            }
        case .loaded(let artifacts):
            if artifacts.isEmpty {
                Text(L10n("No private Artifacts are referenced."))
                    .font(.system(size: 10)).foregroundStyle(.tertiary)
            } else {
                artifactRows(artifacts)
            }
        case .failed(let message, let previous):
            VStack(alignment: .leading, spacing: 6) {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.system(size: 9)).foregroundStyle(.red).textSelection(.enabled)
                Button(L10n("Retry")) { Task { await refresh() } }
                    .buttonStyle(.borderless)
                    .accessibilityHint(L10n("Retry loading Artifacts for this Work Item."))
                if let previous {
                    Text(L10n("Displayed Artifact data may be stale."))
                        .font(.system(size: 9)).foregroundStyle(.secondary)
                    artifactRows(previous)
                }
            }
        }
    }

    private var artifactLoading: some View {
        HStack(spacing: 7) {
            ProgressView().controlSize(.small)
            Text(L10n("Loading Artifacts…"))
                .font(.system(size: 10)).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    private func artifactRows(_ artifacts: [WorkArtifact]) -> some View {
        LazyVStack(spacing: 6) {
            ForEach(artifacts) { artifact in
                        Button { selection = artifact } label: {
                            HStack(spacing: 8) {
                                if artifact.visibility == .repositoryTracked {
                                    Image(systemName: "point.3.connected.trianglepath.dotted")
                                        .foregroundStyle(artifact.status == "revoked" ? Color.red : Color.accentColor)
                                } else {
                                    Image(systemName: "lock.doc")
                                        .foregroundStyle(artifact.status == "revoked" ? Color.red : Color.accentColor)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(artifact.title).font(.system(size: 11, weight: .medium)).lineLimit(1)
                                    Text("v\(ArtifactVersionSelectionPolicy.preferredVersion(for: artifact, taskId: taskId)) · \(artifact.visibility.rawValue)")
                                        .font(.system(size: 9)).foregroundStyle(.secondary)
                                }
                                Spacer()
                                if artifact.references.contains(where: { $0.required && $0.revokedAt == nil }) {
                                    Text(L10n("Required")).font(.system(size: 8, weight: .semibold)).foregroundStyle(.orange)
                                }
                                if artifact.references.contains(where: { $0.pendingVersion != nil && $0.revokedAt == nil }) {
                                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                                }
                            }
                            .padding(8)
                            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 7))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
            }
        }
    }

    private func refresh() async {
        if let taskId { await client.refresh(taskId: taskId) }
        else { await client.refresh(workId: workId) }
    }

    private func importDocument() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        isImporting = true
        Task {
            let imported = await client.importFile(
                workId: workId,
                fileURL: url,
                visibility: taskId == nil ? .workPrivate : .taskPrivate,
                boundTaskId: taskId
            )
            importReceipt = imported?.receipt
            if let taskId, let artifact = imported?.artifact {
                _ = await client.reference(artifactId: artifact.artifactId, taskId: taskId, relation: "implementation_spec", required: false, versionPolicy: "fixed")
            }
            isImporting = false
            await refresh()
        }
    }
}

enum ArtifactVersionSelectionPolicy {
    static func preferredVersion(for artifact: WorkArtifact, taskId: String?) -> Int {
        if let taskId,
           let reference = artifact.references.first(where: {
               $0.taskId == taskId && $0.revokedAt == nil
           }) {
            return reference.pinnedVersion
        }
        return artifact.approvedVersion ?? artifact.currentVersion
    }
}

private struct ArtifactDetailContainer: View {
    @ObservedObject private var client = ArtifactAPIClient.shared
    let artifactId: String
    let workId: String
    let taskId: String?
    let onChanged: () -> Void

    var body: some View {
        if let artifact = client.artifact(
            artifactId: artifactId,
            workId: workId,
            taskId: taskId
        ) {
            ArtifactDetailView(artifact: artifact, taskId: taskId, onChanged: onChanged)
                .id("\(artifact.artifactId):\(artifact.resourceVersion)")
        } else {
            ContentUnavailableView(
                L10n("Artifact Unavailable"),
                systemImage: "doc.badge.ellipsis",
                description: Text(L10n("This Artifact is no longer available in the current scope."))
            )
            .frame(width: 520, height: 320)
        }
    }
}

private struct ArtifactCreateView: View {
    @ObservedObject private var client = ArtifactAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let workId: String
    let taskId: String?
    let onCreated: () -> Void

    @State private var title = ""
    @State private var summary = ""
    @State private var content = ""
    @State private var relation = "implementation_spec"
    @State private var required = false
    @State private var versionPolicy = "fixed"
    @State private var isSaving = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("Create Private Artifact")).font(.title3.bold())
            TextField(L10n("Title"), text: $title)
            TextField(L10n("Bounded summary (injected into Session index)"), text: $summary)
            TextEditor(text: $content)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 220)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.primary.opacity(0.15)))
            if taskId != nil {
                Picker(L10n("Relation"), selection: $relation) {
                    ForEach(["implementation_spec", "security_requirement", "test_plan", "research_evidence", "handoff", "acceptance_evidence"], id: \.self) { Text($0).tag($0) }
                }
                Toggle(L10n("Required"), isOn: $required)
                Picker(L10n("Version Policy"), selection: $versionPolicy) {
                    Text("fixed").tag("fixed")
                    Text("latest-approved").tag("latest_approved")
                }
            }
            HStack {
                Spacer()
                Button(L10n("Cancel")) { dismiss() }
                Button(L10n("Create")) { create() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSaving)
            }
        }
        .padding(20)
        .frame(width: 560, height: 480)
    }

    private func create() {
        isSaving = true
        Task {
            let artifact = await client.create(
                workId: workId, title: title, summary: summary, content: content,
                visibility: taskId == nil ? .workPrivate : .taskPrivate,
                boundTaskId: taskId
            )
            if let artifact, let taskId {
                _ = await client.reference(artifactId: artifact.artifactId, taskId: taskId, relation: relation, required: required, versionPolicy: versionPolicy)
            }
            isSaving = false
            if artifact != nil { onCreated(); dismiss() }
        }
    }
}

private struct ArtifactDetailView: View {
    @ObservedObject private var client = ArtifactAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let artifact: WorkArtifact
    let taskId: String?
    let onChanged: () -> Void

    @State private var detail: ArtifactDetailEnvelope?
    @State private var selectedVersion: Int
    @State private var offset = 0
    @State private var showPublish = false
    @State private var showSupersede = false
    @State private var exportTarget: URL?
    @State private var showExportConfirm = false
    @State private var showRepositoryExportConfirm = false
    @State private var isOpeningInSystemApplication = false
    @State private var openError: String?
    @State private var readTurnExecutionId = UUID().uuidString

    init(artifact: WorkArtifact, taskId: String?, onChanged: @escaping () -> Void) {
        self.artifact = artifact
        self.taskId = taskId
        self.onChanged = onChanged
        _selectedVersion = State(initialValue: ArtifactVersionSelectionPolicy.preferredVersion(
            for: artifact,
            taskId: taskId
        ))
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading) {
                    Text(artifact.title).font(.headline)
                    Text("\(artifact.artifactId) · \(artifact.visibility.rawValue)").font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer()
                Picker("", selection: $selectedVersion) {
                    ForEach(artifact.versions, id: \.version) { Text("v\($0.version) \($0.approvalStatus)").tag($0.version) }
                }.frame(width: 130)
                Menu {
                    Button(L10n("Open with System Application")) { openWithSystemApplication() }
                        .disabled(isOpeningInSystemApplication)
                    Divider()
                    if can("publish_and_repin") || can("publish") {
                        Button(L10n("Publish New Version")) { showPublish = true }
                    }
                    Button(L10n("Secure Export")) { chooseExport() }
                    if can("supersede") {
                        Button(L10n("Mark Superseded"), role: .destructive) { showSupersede = true }
                    }
                } label: { Image(systemName: "ellipsis.circle") }
                Button(L10n("Close")) { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }.padding(14)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    metadata
                    references
                    audit
                }.padding(16)
            }
            .frame(maxHeight: 210)
            Divider()
            contentPage
                .padding(16)
        }
        .frame(width: 720, height: 680)
        .task(id: "\(selectedVersion):\(offset)") {
            detail = await client.detail(
                artifact: artifact,
                version: selectedVersion,
                offset: offset,
                turnExecutionId: readTurnExecutionId
            )
        }
        .sheet(isPresented: $showPublish) { ArtifactPublishView(artifact: artifact, taskId: taskId) { showPublish = false; onChanged(); dismiss() } }
        .confirmationDialog(L10n("Mark this Artifact superseded?"), isPresented: $showSupersede) {
            Button(L10n("Mark Superseded"), role: .destructive) { Task { if await client.markSuperseded(artifactId: artifact.artifactId) { onChanged(); dismiss() } } }
        }
        .confirmationDialog(L10n("Export verified private content to the selected local path?"), isPresented: $showExportConfirm) {
            Button(L10n("Export")) { exportConfirmed() }
            Button(L10n("Cancel"), role: .cancel) { exportTarget = nil }
        } message: {
            Text(L10n("This confirms a local export. Repository destinations require a separate confirmation."))
        }
        .confirmationDialog(L10n("The selected destination is inside a Git Repository. Write the Artifact there?"), isPresented: $showRepositoryExportConfirm) {
            Button(L10n("Write to Repository"), role: .destructive) { repositoryExportConfirmed() }
            Button(L10n("Cancel"), role: .cancel) { exportTarget = nil }
        } message: {
            Text(L10n("The exported document may be staged, committed, or uploaded by later Git operations. Corptie will not perform those operations now."))
        }
        .alert(
            L10n("Unable to Open Artifact"),
            isPresented: Binding(
                get: { openError != nil },
                set: { if !$0 { openError = nil } }
            )
        ) {
            Button(L10n("OK"), role: .cancel) { openError = nil }
        } message: {
            Text(openError ?? "")
        }
    }

    private var metadata: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(artifact.summary.isEmpty ? L10n("No summary") : artifact.summary)
            if let detail {
                Text("SHA-256 \(detail.contentHash) · \(detail.totalBytes) bytes")
                    .font(.caption2).foregroundStyle(.secondary).textSelection(.enabled)
            }
        }
    }

    private var references: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n("References and Impact")).font(.caption.bold())
            ForEach(artifact.references) { reference in
                HStack {
                    Text("\(reference.relation) · \(reference.taskId ?? reference.sessionId ?? "-") · v\(reference.pinnedVersion)")
                    if reference.required { Text(L10n("Required")).foregroundStyle(.orange) }
                    if let pending = reference.pendingVersion, can("acknowledge_reference") {
                        Button("v\(pending) pending — acknowledge") { Task { if await client.acknowledge(referenceId: reference.referenceId) { onChanged(); dismiss() } } }
                            .foregroundStyle(.orange)
                    }
                    Spacer()
                    if reference.revokedAt == nil && can("revoke_reference") {
                        Button(L10n("Revoke"), role: .destructive) { Task { if await client.revoke(referenceId: reference.referenceId, reason: "Revoked by local user") { onChanged(); dismiss() } } }
                    }
                }.font(.caption)
            }
        }
    }

    private func can(_ action: String) -> Bool {
        taskId == nil || artifact.availableActions?.contains(action) == true
    }

    private var contentPage: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(L10n("Content Page")).font(.caption.bold())
                Spacer()
                Button(L10n("Previous")) { if let previous = ArtifactContentPagingPolicy.previousOffset(currentOffset: offset) { offset = previous } }
                    .disabled(offset == 0)
                Button(L10n("Next")) { if let next = detail?.range.nextOffset { offset = next } }
                    .disabled(detail?.range.nextOffset == nil)
            }
            ArtifactContentPreview(
                content: detail?.content
                    ?? (artifact.visibility == .repositoryTracked ? artifact.repositoryLocator ?? "" : L10n("Loading…"))
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .overlay(RoundedRectangle(cornerRadius: 7).stroke(Color.primary.opacity(0.12)))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var audit: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L10n("Audit")).font(.caption.bold())
            ForEach(artifact.audit.prefix(30)) { event in
                Text("\(event.createdAt) · \(event.action) · \(event.actorId)").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private func chooseExport() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = artifact.title.replacingOccurrences(of: "/", with: "-") + ".md"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        exportTarget = url
        showExportConfirm = true
    }

    private func exportConfirmed() {
        guard let exportTarget else { return }
        Task {
            let outcome = await client.export(artifact: artifact, version: selectedVersion, destinationURL: exportTarget, confirmRepositoryWrite: false, confirmOverwrite: true)
            if outcome == .repositoryConfirmationRequired {
                showRepositoryExportConfirm = true
            } else {
                self.exportTarget = nil
            }
        }
    }

    private func repositoryExportConfirmed() {
        guard let exportTarget else { return }
        Task {
            _ = await client.export(artifact: artifact, version: selectedVersion, destinationURL: exportTarget, confirmRepositoryWrite: true, confirmOverwrite: true)
            self.exportTarget = nil
        }
    }

    private func openWithSystemApplication() {
        guard !isOpeningInSystemApplication else { return }
        isOpeningInSystemApplication = true
        Task {
            defer { isOpeningInSystemApplication = false }
            do {
                let receipt = try await client.localFile(
                    artifact: artifact,
                    version: selectedVersion
                )
                openError = await ArtifactSystemApplicationOpener.open(receipt)
            } catch let error as EntityLaunchError {
                openError = localizedOpenError(error)
            } catch {
                openError = L10nFormat("The system could not open this Artifact: %@", error.localizedDescription)
            }
        }
    }

    private func localizedOpenError(_ error: EntityLaunchError) -> String {
        switch error.code {
        case "ARTIFACT_LOCAL_FILE_NOT_FOUND":
            L10n("The Artifact file no longer exists.")
        case "ARTIFACT_LOCAL_FILE_PERMISSION_DENIED":
            L10n("Corptie does not have permission to open this Artifact file.")
        case "ARTIFACT_LOCAL_FILE_NOT_FILE":
            L10n("The Artifact's local path is not a regular file.")
        default:
            error.localizedDescription
        }
    }
}

struct ArtifactContentPreview: NSViewRepresentable {
    let content: String

    func makeNSView(context: Context) -> NSScrollView {
        Self.makeScrollView(content: content)
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView,
              Self.update(textView: textView, content: content) else { return }
        textView.scrollToBeginningOfDocument(nil)
    }

    static func makeScrollView(content: String) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false

        guard let textView = scrollView.documentView as? NSTextView else { return scrollView }
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.importsGraphics = false
        textView.drawsBackground = false
        textView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        textView.textContainerInset = NSSize(width: 10, height: 10)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.string = content
        return scrollView
    }

    @discardableResult
    static func update(textView: NSTextView, content: String) -> Bool {
        guard textView.string != content else { return false }
        textView.string = content
        return true
    }
}

private struct ArtifactPublishView: View {
    @ObservedObject private var client = ArtifactAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    let artifact: WorkArtifact
    let taskId: String?
    let onPublished: () -> Void
    @State private var summary: String
    @State private var content = ""

    init(artifact: WorkArtifact, taskId: String?, onPublished: @escaping () -> Void) {
        self.artifact = artifact
        self.taskId = taskId
        self.onPublished = onPublished
        _summary = State(initialValue: artifact.summary)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("Publish New Artifact Version")).font(.headline)
            TextField(L10n("Summary"), text: $summary)
            TextEditor(text: $content).font(.system(.body, design: .monospaced)).frame(minHeight: 260)
            Text(L10n("Started CorptieTasks remain pinned. latest-approved references receive an audited impact notice requiring acknowledgement."))
                .font(.caption).foregroundStyle(.orange)
            HStack { Spacer(); Button(L10n("Cancel")) { dismiss() }; Button(L10n("Publish")) { Task { if await client.publish(artifact: artifact, taskId: taskId, content: content, summary: summary) { onPublished(); dismiss() } } }.disabled(content.isEmpty) }
        }.padding(20).frame(width: 580, height: 440)
    }
}
