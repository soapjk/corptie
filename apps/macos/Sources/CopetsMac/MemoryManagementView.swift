import SwiftUI
import CorptieConversation

@MainActor
enum MemoryScopeLayer: String, CaseIterable {
    case task = "task"
    case work
    case global
    case agent

    var title: String {
        switch self {
        case .task: L10n("CorptieTask Memory")
        case .work: L10n("Work Memory")
        case .global: L10n("Global Memory")
        case .agent: L10n("Agent Long-term Memory")
        }
    }
    var icon: String {
        switch self {
        case .task: "checklist"
        case .work: "target"
        case .global: "globe"
        case .agent: "person.crop.circle.badge.checkmark"
        }
    }
}

@MainActor
enum MemoryOriginLayer: Int, CaseIterable {
    case userKept
    case agentCandidate
    case agentDurable
    case systemManaged
    case inactive
    private static let timestampFormatter = ISO8601DateFormatter()

    var title: String {
        switch self {
        case .userKept: L10n("Kept by me")
        case .agentCandidate: L10n("Suggested by Agent")
        case .agentDurable: L10n("Active extracted Memory")
        case .systemManaged: L10n("System checkpoints and consolidation")
        case .inactive: L10n("Disabled, replaced or expired")
        }
    }
    var explanation: String {
        switch self {
        case .userKept: L10n("Memories explicitly kept or manually added by you.")
        case .agentCandidate: L10n("Candidates awaiting review; they do not participate in recall.")
        case .agentDurable: L10n("Trusted durable knowledge available within this scope.")
        case .systemManaged: L10n("Recoverable pre-compaction checkpoints and audited consolidation results.")
        case .inactive: L10n("Preserved for audit but excluded from normal recall.")
        }
    }

    static func classify(_ memory: MemoryItem, now: Date = Date()) -> Self {
        let inactiveStatuses = ["superseded", "archived", "rolled_back"]
        let expired = memory.expiresAt.flatMap(timestampFormatter.date(from:)).map { $0 <= now } ?? false
        if memory.revokedAt != nil || expired || inactiveStatuses.contains(memory.promotionStatus ?? "") { return .inactive }
        if memory.sourceType == "user" { return .userKept }
        if memory.promotionStatus == "candidate" || memory.trustLevel == "untrusted" {
            return .agentCandidate
        }
        if ["system", "consolidated", "pre_compaction"].contains(memory.sourceType) { return .systemManaged }
        return .agentDurable
    }
}

struct MemoryManagementView: View {
    enum Scope: Equatable {
        case owner(type: String, id: String)
        case global
    }

    let scope: Scope
    let embedsListInParentScrollView: Bool
    private let client = EntityAPIClient.shared
    @State private var memories: [MemoryItem] = []
    @State private var extractionJobs: [MemoryExtractionJob] = []
    @State private var query = ""
    @State private var selectedLayer = "all"
    @State private var kind = "all"
    @State private var status = "current"
    @State private var includeRevoked = true
    @State private var isLoading = false
    @State private var editingMemory: MemoryItem?
    @State private var revokingMemory: MemoryItem?
    @State private var historyMemory: MemoryItem?
    @State private var reviewingMemory: MemoryItem?
    @State private var isAddingMemory = false
    @State private var selectedForMerge = Set<String>()
    @State private var isMerging = false

    init(scope: Scope, embedsListInParentScrollView: Bool = false) {
        self.scope = scope
        self.embedsListInParentScrollView = embedsListInParentScrollView
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            scopeExplanation
            if scope == .global { extractionStatus }
            controls
            if isLoading && memories.isEmpty {
                Spacer()
                ProgressView().frame(maxWidth: .infinity)
                Spacer()
            } else if filteredMemories.isEmpty {
                ContentUnavailableView(
                    L10n("No memories"),
                    systemImage: "brain",
                    description: Text(L10n("No Memory matches the current scope and filters."))
                )
            } else {
                layeredList
                if client.browsedMemoriesHasMore {
                    Button(L10n("Load more memories")) {
                        Task {
                            isLoading = true
                            defer { isLoading = false }
                            memories = await client.loadMoreMemories() ?? memories
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .center)
                }
            }
            if let error = client.errorMessage, !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
        .task(id: reloadKey) {
            await load()
            if scope == .global { extractionJobs = await client.memoryExtractionJobs() ?? [] }
        }
        .sheet(item: $editingMemory) { memory in
            MemoryTagEditor(memory: memory) { content, tags in
                if let updated = await client.updateMemory(memoryId: memory.id, content: content, tags: tags) {
                    replace(updated)
                }
            }
        }
        .sheet(isPresented: $isAddingMemory) {
            MemoryCreationSheet(scope: scope) { memory in
                memories.insert(memory, at: 0)
            }
        }
        .sheet(isPresented: $isMerging) {
            MemoryMergeSheet(memories: selectedMemoriesForMerge) { content in
                if await client.consolidateMemories(
                    memoryIds: selectedMemoriesForMerge.map(\.id), content: content
                ) != nil {
                    selectedForMerge.removeAll()
                    await load()
                    return true
                }
                return false
            }
        }
        .alert(L10n("Disable Memory recall?"), isPresented: Binding(
            get: { revokingMemory != nil },
            set: { if !$0 { revokingMemory = nil } }
        )) {
            Button(L10n("Disable recall"), role: .destructive) {
                guard let memory = revokingMemory else { return }
                Task {
                    if let updated = await client.revokeMemory(memoryId: memory.id, reason: "Revoked from Memory Inspector") {
                        replace(updated)
                    }
                    revokingMemory = nil
                }
            }
            Button(L10n("Cancel"), role: .cancel) { revokingMemory = nil }
        } message: {
            Text(L10n("The Memory will stop participating in recall. Its content and audit history remain available, and it can be enabled again."))
        }
        .sheet(item: $historyMemory) { memory in
            MemoryAuditSheet(memory: memory) { updated in replace(updated) }
        }
        .sheet(item: $reviewingMemory) { memory in
            MemoryReviewSheet(memory: memory) { updated in replace(updated) }
        }
    }

    private var controls: some View {
        HStack(spacing: 8) {
            TextField(L10n("Search memories"), text: $query)
                .textFieldStyle(.roundedBorder)
            if scope == .global {
                Picker(L10n("Memory layer"), selection: $selectedLayer) {
                    Text(L10n("All scopes")).tag("all")
                    ForEach(MemoryScopeLayer.allCases, id: \.self) { layer in
                        Text(layer.title).tag(layer.rawValue)
                    }
                }
                .labelsHidden()
                .frame(width: 150)
            }
            Picker(L10n("Kind"), selection: $kind) {
                Text(L10n("All kinds")).tag("all")
                ForEach(["skill", "procedure", "dev_experience", "fact", "lesson", "preference", "feedback", "episodic"], id: \.self) {
                    Text($0).tag($0)
                }
            }
            .labelsHidden()
            .frame(width: 130)
            Picker(L10n("Status"), selection: $status) {
                Text(L10n("Current memories")).tag("current")
                Text(L10n("All statuses")).tag("all")
                ForEach(["active", "candidate", "superseded", "promoted_to_skill", "archived", "rolled_back"], id: \.self) {
                    Text($0).tag($0)
                }
            }
            .labelsHidden()
            .frame(width: 150)
            Toggle(L10n("Revoked"), isOn: $includeRevoked).toggleStyle(.checkbox)
            Button { isAddingMemory = true } label: {
                Label(L10n("Add Memory"), systemImage: "plus")
            }
            .buttonStyle(.borderedProminent)
            if canMerge {
                Button(L10n("Merge selected")) { isMerging = true }
                    .buttonStyle(.bordered)
            }
            Button { Task {
                await load()
                if scope == .global { extractionJobs = await client.memoryExtractionJobs() ?? extractionJobs }
            } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
        }
    }

    private var extractionStatus: some View {
        let pending = extractionJobs.filter { $0.state == "queued" || $0.state == "running" }
        let retrying = pending.filter { $0.retryAt != nil }
        let blocked = extractionJobs.filter { $0.state == "blocked" }
        let skipped = extractionJobs.filter { $0.state == "skipped" }
        return VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 12) {
                Label(L10n("Extraction queue"), systemImage: "clock.arrow.circlepath")
                    .font(.caption.bold())
                Text("\(pending.count) \(L10n("pending")) · \(retrying.count) \(L10n("retrying"))")
                    .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                if !blocked.isEmpty || !skipped.isEmpty {
                    Text("\(blocked.count) \(L10n("Paused")) · \(skipped.count) \(L10n("Skipped"))")
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer()
            }
            if let failed = blocked.first ?? retrying.first, let reason = failed.lastError {
                Text("\(failed.sessionId): \(reason)")
                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var scopeExplanation: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "square.3.layers.3d")
                .foregroundStyle(.tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(scopeTitle).font(.headline)
                Text(scopeSubtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(10)
        .background(Color.accentColor.opacity(0.07), in: RoundedRectangle(cornerRadius: 9))
    }

    private var scopeTitle: String {
        switch scope {
        case .global: L10n("Layered Memory Inspector")
        case let .owner(type, _): MemoryScopeLayer(rawValue: type)?.title ?? L10n("Structured Memory")
        }
    }

    private var scopeSubtitle: String {
        switch scope {
        case .global:
            L10n("Task → Work → Global memories apply across their scopes. Agent memories remain a separate legacy layer.")
        case .owner(type: "agent", id: _):
            L10n("Only this Agent's structured long-term layer is managed here. Work, CorptieTask, and runtime file memories remain separate.")
        case .owner(type: "work", id: _):
            L10n("Shared Work context. CorptieTask-local and Agent long-term memories are managed separately.")
        case .owner(type: "task", id: _):
            L10n("The most specific task-local layer and the first layer considered during recall.")
        case .owner:
            L10n("Structured Memory for the selected owner.")
        }
    }

    private var layeredList: some View {
        Group {
            if embedsListInParentScrollView {
                memoryRows
            } else {
                ScrollView { memoryRows }
            }
        }
    }

    private var memoryRows: some View {
        LazyVStack(alignment: .leading, spacing: 16) {
            ForEach(scopeLayersWithContent, id: \.self) { layer in
                if scope == .global {
                    Label("\(layer.title) · \(memories(in: layer).count)", systemImage: layer.icon)
                        .font(.title3.bold())
                        .padding(.top, 4)
                }
                ForEach(MemoryOriginLayer.allCases, id: \.self) { origin in
                    let rows = memories(in: layer, origin: origin)
                    if !rows.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(origin.title).font(.subheadline.bold())
                                Text("\(rows.count)").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                                Spacer()
                            }
                            Text(origin.explanation).font(.caption2).foregroundStyle(.tertiary)
                            ForEach(rows) { memory in memoryRow(memory) }
                        }
                    }
                }
                if scope == .global { Divider() }
            }
        }
        .padding(.vertical, 2)
    }

    private func memoryRow(_ memory: MemoryItem) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline) {
                Text(memory.kind).font(.caption.bold())
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.12), in: Capsule())
                Text(memory.ownerType.replacingOccurrences(of: "_", with: " "))
                    .font(.caption).foregroundStyle(.secondary)
                Text(memory.ownerId).font(.caption2.monospaced()).foregroundStyle(.tertiary).lineLimit(1)
                Spacer()
                Text(memory.revokedAt == nil ? (memory.promotionStatus ?? "active") : L10n("recall disabled"))
                    .font(.caption.bold())
                    .foregroundStyle(memory.revokedAt == nil ? Color.secondary : Color.red)
            }
            Text(memory.content).font(.body).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            if let evidence = memory.structured?.extraction?.evidence {
                Text(evidence).font(.caption).foregroundStyle(.secondary)
                    .textSelection(.enabled).lineLimit(4)
            }
            if let rationale = memory.structured?.extraction?.rationale {
                Text(rationale).font(.caption2).foregroundStyle(.tertiary).lineLimit(2)
            }
            if let tags = memory.tags, !tags.isEmpty {
                Text(tags.map { "#\($0)" }.joined(separator: "  "))
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                metadata("source", memory.sourceType)
                metadata("trust", memory.trustLevel ?? "untrusted")
                metadata("confidence", String(format: "%.0f%%", (memory.confidence ?? 0) * 100))
                metadata("usage", "\(memory.usageCount ?? 0)")
                metadata("updated", memory.updatedAt ?? memory.createdAt)
                if let promoted = memory.promotedSkillId { metadata("promoted", promoted) }
                if let replacement = memory.replacesMemoryId { metadata("impact", "replaced by \(replacement)") }
                else { metadata("impact", memory.ownerType == "agent" ? "all Agent sessions" : "this \(memory.ownerType)") }
                Spacer()
            }
            HStack {
                if memory.promotionStatus == "active" && memory.trustLevel == "trusted"
                    && memory.revokedAt == nil {
                    Toggle(L10n("Select for merge"), isOn: Binding(
                        get: { selectedForMerge.contains(memory.id) },
                        set: { selected in
                            if selected { selectedForMerge.insert(memory.id) }
                            else { selectedForMerge.remove(memory.id) }
                        }
                    ))
                    .toggleStyle(.checkbox)
                    .labelsHidden()
                    .help(L10n("Select for merge"))
                }
                if let sourceSessionId = memory.sourceSessionId {
                    Label(sourceSessionId, systemImage: "arrow.triangle.branch").font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                Button(L10n("Edit Memory")) { editingMemory = memory }.buttonStyle(.link)
                    .disabled(memory.revokedAt != nil)
                Button(L10n("History")) { historyMemory = memory }.buttonStyle(.link)
                if memory.promotionStatus == "candidate" && memory.sourceType == "extracted" {
                    Button(L10n("Review candidate")) { reviewingMemory = memory }.buttonStyle(.link)
                }
                if memory.revokedAt == nil {
                    Button(L10n("Disable recall"), role: .destructive) { revokingMemory = memory }.buttonStyle(.link)
                } else {
                    Button(L10n("Enable recall")) {
                        Task {
                            if let restored = await client.restoreMemory(memoryId: memory.id, reason: "Enabled from Memory Inspector") {
                                replace(restored)
                            }
                        }
                    }.buttonStyle(.link)
                }
            }
        }
        .padding(10)
        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 9))
        .overlay(RoundedRectangle(cornerRadius: 9).stroke(Color.primary.opacity(0.08)))
    }

    private func metadata(_ label: String, _ value: String) -> some View {
        Text("\(label): \(value)").font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
    }

    private var filteredMemories: [MemoryItem] {
        memories.filter { memory in
            (selectedLayer == "all" || memory.ownerType == selectedLayer)
                && (includeRevoked || memory.revokedAt == nil)
                && (kind == "all" || memory.kind == kind)
                && (status == "all" || status == "current" && ["active", "candidate"].contains(memory.promotionStatus ?? "")
                    || memory.promotionStatus == status)
                && (query.isEmpty || "\(memory.content) \(memory.tags?.joined(separator: " ") ?? "") \(memory.ownerId)"
                    .localizedCaseInsensitiveContains(query))
        }
    }

    private var selectedMemoriesForMerge: [MemoryItem] {
        memories.filter { selectedForMerge.contains($0.id) }
    }

    private var canMerge: Bool {
        let selected = selectedMemoriesForMerge
        guard selected.count >= 2, let first = selected.first else { return false }
        return selected.allSatisfy { $0.ownerType == first.ownerType && $0.ownerId == first.ownerId }
    }

    private var scopeLayersWithContent: [MemoryScopeLayer] {
        let requested: [MemoryScopeLayer]
        switch scope {
        case .global: requested = MemoryScopeLayer.allCases
        case let .owner(type, _): requested = MemoryScopeLayer(rawValue: type).map { [$0] } ?? []
        }
        return requested.filter { !memories(in: $0).isEmpty }
    }

    private func memories(in layer: MemoryScopeLayer) -> [MemoryItem] {
        filteredMemories.filter { $0.ownerType == layer.rawValue }
    }

    private func memories(in layer: MemoryScopeLayer, origin: MemoryOriginLayer) -> [MemoryItem] {
        memories(in: layer).filter { MemoryOriginLayer.classify($0) == origin }
    }

    private var reloadKey: String {
        switch scope {
        case .global: return "global:\(includeRevoked):\(status)"
        case let .owner(type, id): return "\(type):\(id):\(includeRevoked):\(status)"
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        switch scope {
        case .global:
            memories = await client.allMemories(includeRevoked: includeRevoked,
                                                status: status == "all" ? nil : status) ?? memories
        case let .owner(type, id):
            memories = await client.memories(ownerType: type, ownerId: id, includeRevoked: includeRevoked,
                                             status: status == "all" ? nil : status) ?? memories
        }
    }

    private func replace(_ updated: MemoryItem) {
        if let index = memories.firstIndex(where: { $0.id == updated.id }) { memories[index] = updated }
    }
}

private struct MemoryReviewSheet: View {
    let memory: MemoryItem
    let onReview: (MemoryItem) -> Void
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var isSaving = false

    init(memory: MemoryItem, onReview: @escaping (MemoryItem) -> Void) {
        self.memory = memory
        self.onReview = onReview
        _content = State(initialValue: memory.content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("Review extracted Memory")).font(.headline)
            Text(L10n("Confirm only durable information that should be recalled in future Sessions."))
                .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $content).frame(minHeight: 130)
            Text("\(memory.sourceSessionId ?? "") · \(memory.ownerType) · #\(memory.sourceEventSeqs?.first ?? 0)")
                .font(.caption2).foregroundStyle(.tertiary)
            if let error = client.errorMessage, !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(.red)
            }
            HStack {
                Button(L10n("Reject candidate"), role: .destructive) { Task { await review("reject") } }
                    .disabled(isSaving)
                Spacer()
                Button(L10n("Cancel")) { dismiss() }
                Button(L10n("Confirm Memory")) { Task { await review("confirm") } }
                    .buttonStyle(.borderedProminent)
                    .disabled(isSaving || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
    }

    private func review(_ action: String) async {
        isSaving = true
        defer { isSaving = false }
        guard let updated = await client.reviewMemory(
            memoryId: memory.id, action: action, content: content, expectedVersion: memory.version ?? 1
        ) else { return }
        onReview(updated)
        dismiss()
    }
}

private struct MemoryCreationSheet: View {
    let scope: MemoryManagementView.Scope
    let onCreate: (MemoryItem) -> Void
    @ObservedObject private var client = EntityAPIClient.shared
    @Environment(\.dismiss) private var dismiss
    @State private var ownerType: String
    @State private var ownerId: String
    @State private var kind = "fact"
    @State private var content = ""
    @State private var tags = ""
    @State private var isSaving = false

    init(scope: MemoryManagementView.Scope, onCreate: @escaping (MemoryItem) -> Void) {
        self.scope = scope
        self.onCreate = onCreate
        switch scope {
        case .global:
            _ownerType = State(initialValue: "global")
            _ownerId = State(initialValue: "user:local")
        case let .owner(type, id):
            _ownerType = State(initialValue: type)
            _ownerId = State(initialValue: id)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("Add structured Memory")).font(.headline)
            Text(L10n("Choose the scope where this memory should apply. Global memories follow you across Works and Tasks."))
                .font(.caption).foregroundStyle(.secondary)

            Form {
                Picker(L10n("Memory layer"), selection: $ownerType) {
                    ForEach(MemoryScopeLayer.allCases, id: \.self) { layer in Text(layer.title).tag(layer.rawValue) }
                }
                .disabled(isFixedScope)

                if isFixedScope {
                    LabeledContent(L10n("Owner"), value: ownerLabel)
                } else {
                    Picker(L10n("Owner"), selection: $ownerId) {
                        ForEach(ownerOptions) { option in Text(option.label).tag(option.id) }
                    }
                }

                Picker(L10n("Kind"), selection: $kind) {
                    ForEach(["fact", "preference", "procedure", "skill", "dev_experience", "lesson", "feedback", "episodic"], id: \.self) {
                        Text($0).tag($0)
                    }
                }
                TextEditor(text: $content).frame(minHeight: 110)
                TextField(L10n("Comma-separated tags"), text: $tags)
            }

            HStack {
                Spacer()
                Button(L10n("Cancel")) { dismiss() }
                Button(L10n("Keep Memory")) { Task { await create() } }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!isValid || isSaving)
            }
        }
        .padding(20)
        .frame(width: 520)
        .task { selectFirstOwnerIfNeeded() }
        .onChange(of: ownerType) { _, _ in
            ownerId = ""
            selectFirstOwnerIfNeeded()
        }
    }

    private var isFixedScope: Bool {
        if case .owner = scope { return true }
        return false
    }

    private var ownerOptions: [MemoryOwnerOption] {
        let options: [MemoryOwnerOption]
        switch ownerType {
        case "global": options = [MemoryOwnerOption(id: "user:local", label: L10n("You"))]
        case "task": options = client.tasks.compactMap {
            guard $0.currentSessionId != nil else { return nil }
            return MemoryOwnerOption(id: $0.id, label: $0.title)
        }
        case "work": options = client.works.map { MemoryOwnerOption(id: $0.id, label: $0.name) }
        default: options = client.agents.map { MemoryOwnerOption(id: $0.agentId, label: $0.name) }
        }
        return options.sorted { $0.label.localizedCaseInsensitiveCompare($1.label) == .orderedAscending }
    }

    private var ownerLabel: String {
        ownerOptions.first(where: { $0.id == ownerId })?.label ?? ownerId
    }

    private var isValid: Bool {
        !ownerId.isEmpty
            && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && (ownerType != "task" || sourceSessionId != nil)
    }

    private var sourceSessionId: String? {
        guard ownerType == "task" else { return nil }
        return client.tasks.first(where: { $0.id == ownerId })?.currentSessionId
    }

    private func selectFirstOwnerIfNeeded() {
        guard ownerId.isEmpty else { return }
        ownerId = ownerOptions.first?.id ?? ""
    }

    private func create() async {
        isSaving = true
        defer { isSaving = false }
        let parsedTags = tags.split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if let created = await client.createMemory(
            ownerType: ownerType,
            ownerId: ownerId,
            kind: kind,
            content: content.trimmingCharacters(in: .whitespacesAndNewlines),
            tags: parsedTags,
            sourceSessionId: sourceSessionId
        ) {
            onCreate(created)
            dismiss()
        }
    }
}

private struct MemoryOwnerOption: Identifiable {
    let id: String
    let label: String
}

private struct MemoryMergeSheet: View {
    let memories: [MemoryItem]
    let onMerge: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var content: String
    @State private var isSaving = false

    init(memories: [MemoryItem], onMerge: @escaping (String) async -> Bool) {
        self.memories = memories
        self.onMerge = onMerge
        _content = State(initialValue: memories.map(\.content).joined(separator: "；"))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("Merge memories")).font(.headline)
            Text(L10n("The selected memories will be superseded. The merged memory keeps their source references and can be rolled back."))
                .font(.caption).foregroundStyle(.secondary)
            TextEditor(text: $content).frame(minHeight: 120)
            HStack {
                Spacer()
                Button(L10n("Cancel")) { dismiss() }
                Button(L10n("Merge")) {
                    Task {
                        isSaving = true
                        defer { isSaving = false }
                        if await onMerge(content.trimmingCharacters(in: .whitespacesAndNewlines)) { dismiss() }
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSaving || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 520)
    }
}

private struct MemoryAuditSheet: View {
    let memory: MemoryItem
    let onRollback: (MemoryItem) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [MemoryAuditEntry] = []
    @State private var recalls: [MemoryRecallAudit] = []
    @State private var isLoading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("Memory audit history")).font(.headline)
            Text(memory.content).foregroundStyle(.secondary).lineLimit(2)
            if isLoading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(entries) { entry in
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(entry.action).font(.body.bold())
                            Text([entry.actorType, entry.actorId, entry.createdAt].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(.secondary)
                            if let reason = entry.reason { Text(reason).font(.caption2).foregroundStyle(.tertiary) }
                        }
                        Spacer()
                        if entry.action == "update" || entry.action == "revoke" || entry.action == "supersede" {
                            Button(L10n("Rollback")) {
                                Task {
                                    if let restored = await EntityAPIClient.shared.rollbackMemoryAudit(auditId: entry.id) {
                                        onRollback(restored)
                                        entries = await EntityAPIClient.shared.memoryAudit(memoryId: memory.id) ?? entries
                                    }
                                }
                            }
                        }
                    }
                }
                if !recalls.isEmpty {
                    Text(L10n("Recall history")).font(.subheadline.bold())
                    List(recalls) { recall in
                        HStack {
                            if let sessionId = recall.sessionId {
                                Button(sessionId) {
                                    AppTabRouter.shared.openSession(sessionId, source: .userSelection)
                                    dismiss()
                                }
                                .buttonStyle(.link)
                                .font(.caption.monospaced()).lineLimit(1)
                            }
                            Spacer()
                            Text(recall.injectionStatus ?? "not_recorded")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .frame(minHeight: 100, maxHeight: 180)
                }
            }
        }
        .padding(20)
        .frame(width: 620, height: 460)
        .task {
            entries = await EntityAPIClient.shared.memoryAudit(memoryId: memory.id) ?? []
            recalls = await EntityAPIClient.shared.memoryRecalls(memoryId: memory.id) ?? []
            isLoading = false
        }
    }
}

private struct MemoryTagEditor: View {
    let memory: MemoryItem
    let save: (String, [String]) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var content: String

    init(memory: MemoryItem, save: @escaping (String, [String]) async -> Void) {
        self.memory = memory
        self.save = save
        _text = State(initialValue: memory.tags?.joined(separator: ", ") ?? "")
        _content = State(initialValue: memory.content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("Edit Memory")).font(.headline)
            TextEditor(text: $content).frame(minHeight: 100)
            TextField(L10n("Comma-separated tags"), text: $text)
            HStack {
                Spacer()
                Button(L10n("Cancel")) { dismiss() }
                Button(L10n("Save")) {
                    let tags = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                    Task { await save(content.trimmingCharacters(in: .whitespacesAndNewlines), tags); dismiss() }
                }.keyboardShortcut(.defaultAction)
                    .disabled(content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding(20).frame(width: 420)
    }
}

struct SessionMemoryDiagnosticsView: View {
    let session: TaskSession
    @State private var hits: [MemoryRecallEntry] = []
    @State private var loadFailed = false
    @State private var isExpanded = false
    @State private var isLoading = false

    var body: some View {
        ConversationDetailDisclosure(isExpanded: $isExpanded, header: {
            Label(L10n("Memory Hit"), systemImage: "brain.head.profile")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
            if !hits.isEmpty {
                Text("\(hits.count)").font(.caption2.monospacedDigit()).foregroundStyle(.tertiary)
            }
        }, content: {
            Button { Task { await reloadHits() } } label: {
                Label(L10n("Refresh Memory hits"), systemImage: "arrow.clockwise")
            }
            .buttonStyle(.link)
            .disabled(isLoading)
            if isLoading {
                ProgressView().controlSize(.small)
            } else if loadFailed {
                Text(L10n("Could not load Memory hits."))
                    .font(.caption).foregroundStyle(.red)
            } else if hits.isEmpty {
                Text(L10n("No Memory hits recorded for this Session."))
                    .font(.caption).foregroundStyle(.tertiary)
            } else {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(hits) { entry in
                        HStack(alignment: .top, spacing: 6) {
                            Image(systemName: "checkmark.circle")
                                .foregroundStyle(.green)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(entry.content ?? entry.id)
                                    .font(.caption).lineLimit(4).textSelection(.enabled)
                                HStack(spacing: 4) {
                                    Text(entry.kind ?? L10n("Memory unavailable"))
                                    if let ownerType = entry.ownerType { Text("· \(ownerType)") }
                                    if !entry.snapshotAtRecall {
                                        Text("· \(L10n("Current content; historical snapshot unavailable"))")
                                    }
                                }
                                .font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
        })
        .task(id: "\(session.id):\(isExpanded)") {
            guard isExpanded else { return }
            await reloadHits()
        }
    }

    private func reloadHits() async {
        isLoading = true
        defer { isLoading = false }
        let loaded = await EntityAPIClient.shared.memoryHits(sessionId: session.id)
        hits = loaded ?? []
        loadFailed = loaded == nil
    }
}
