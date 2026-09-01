import SwiftUI

@MainActor
enum MemoryScopeLayer: String, CaseIterable {
    case task = "task"
    case objective
    case agent

    var title: String {
        switch self {
        case .task: L10n("CorptieTask Memory")
        case .objective: L10n("Objective Memory")
        case .agent: L10n("Agent Long-term Memory")
        }
    }
    var icon: String {
        switch self {
        case .task: "checklist"
        case .objective: "target"
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
        case .agentDurable: L10n("Confirmed Agent Memory")
        case .systemManaged: L10n("System checkpoints and consolidation")
        case .inactive: L10n("Disabled, replaced or expired")
        }
    }
    var explanation: String {
        switch self {
        case .userKept: L10n("Memories explicitly kept or manually added by you.")
        case .agentCandidate: L10n("Untrusted candidates learned from Session activity; they are not recalled automatically.")
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
        if memory.promotionStatus == "candidate" || memory.trustLevel == "untrusted" || memory.sourceType == "extracted" {
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
    @ObservedObject private var client = EntityAPIClient.shared
    @State private var memories: [MemoryItem] = []
    @State private var query = ""
    @State private var kind = "all"
    @State private var status = "all"
    @State private var includeRevoked = true
    @State private var isLoading = false
    @State private var editingMemory: MemoryItem?
    @State private var revokingMemory: MemoryItem?
    @State private var historyMemory: MemoryItem?
    @State private var isAddingMemory = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            scopeExplanation
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
        .task(id: reloadKey) { await load() }
        .sheet(item: $editingMemory) { memory in
            MemoryTagEditor(memory: memory) { tags in
                if let updated = await client.updateMemory(memoryId: memory.id, tags: tags) {
                    replace(updated)
                }
            }
        }
        .sheet(isPresented: $isAddingMemory) {
            MemoryCreationSheet(scope: scope) { memory in
                memories.insert(memory, at: 0)
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
    }

    private var controls: some View {
        HStack(spacing: 8) {
            TextField(L10n("Search memories"), text: $query)
                .textFieldStyle(.roundedBorder)
            Picker(L10n("Kind"), selection: $kind) {
                Text(L10n("All kinds")).tag("all")
                ForEach(["skill", "procedure", "dev_experience", "fact", "lesson", "preference", "feedback", "episodic"], id: \.self) {
                    Text($0).tag($0)
                }
            }
            .labelsHidden()
            .frame(width: 130)
            Picker(L10n("Status"), selection: $status) {
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
            Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
        }
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
            L10n("CorptieTask → Objective → Agent is the recall priority. Memories are grouped by both scope and origin.")
        case .owner(type: "agent", id: _):
            L10n("Only this Agent's structured long-term layer is managed here. Objective, CorptieTask, and runtime file memories remain separate.")
        case .owner(type: "objective", id: _):
            L10n("Shared Objective context. CorptieTask-local and Agent long-term memories are managed separately.")
        case .owner(type: "task", id: _):
            L10n("The most specific task-local layer and the first layer considered during recall.")
        case .owner:
            L10n("Structured Memory for the selected owner.")
        }
    }

    private var layeredList: some View {
        ScrollView {
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
                if let sourceSessionId = memory.sourceSessionId {
                    Label(sourceSessionId, systemImage: "arrow.triangle.branch").font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                Button(L10n("Edit tags")) { editingMemory = memory }.buttonStyle(.link)
                    .disabled(memory.revokedAt != nil)
                Button(L10n("History")) { historyMemory = memory }.buttonStyle(.link)
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
            (includeRevoked || memory.revokedAt == nil)
                && (kind == "all" || memory.kind == kind)
                && (status == "all" || memory.promotionStatus == status)
                && (query.isEmpty || "\(memory.content) \(memory.tags?.joined(separator: " ") ?? "") \(memory.ownerId)"
                    .localizedCaseInsensitiveContains(query))
        }
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
        case .global: return "global:\(includeRevoked)"
        case let .owner(type, id): return "\(type):\(id):\(includeRevoked)"
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        switch scope {
        case .global:
            memories = await client.allMemories(includeRevoked: includeRevoked) ?? memories
        case let .owner(type, id):
            memories = await client.memories(ownerType: type, ownerId: id, includeRevoked: includeRevoked) ?? memories
        }
    }

    private func replace(_ updated: MemoryItem) {
        if let index = memories.firstIndex(where: { $0.id == updated.id }) { memories[index] = updated }
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
            _ownerType = State(initialValue: "agent")
            _ownerId = State(initialValue: "")
        case let .owner(type, id):
            _ownerType = State(initialValue: type)
            _ownerId = State(initialValue: id)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("Add structured Memory")).font(.headline)
            Text(L10n("Choose the narrowest scope that should be affected. CorptieTask is local, Objective is shared by the objective, and Agent is long-term."))
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
        case "task": options = client.tasks.compactMap {
            guard $0.currentSessionId != nil else { return nil }
            return MemoryOwnerOption(id: $0.id, label: $0.title)
        }
        case "objective": options = client.objectives.map { MemoryOwnerOption(id: $0.id, label: $0.name) }
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

private struct MemoryAuditSheet: View {
    let memory: MemoryItem
    let onRollback: (MemoryItem) -> Void
    @State private var entries: [MemoryAuditEntry] = []
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
            }
        }
        .padding(20)
        .frame(width: 620, height: 460)
        .task {
            entries = await EntityAPIClient.shared.memoryAudit(memoryId: memory.id) ?? []
            isLoading = false
        }
    }
}

private struct MemoryTagEditor: View {
    let memory: MemoryItem
    let save: ([String]) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(memory: MemoryItem, save: @escaping ([String]) async -> Void) {
        self.memory = memory
        self.save = save
        _text = State(initialValue: memory.tags?.joined(separator: ", ") ?? "")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("Edit Memory tags")).font(.headline)
            Text(memory.content).foregroundStyle(.secondary).lineLimit(3)
            TextField(L10n("Comma-separated tags"), text: $text)
            HStack {
                Spacer()
                Button(L10n("Cancel")) { dismiss() }
                Button(L10n("Save")) {
                    let tags = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                    Task { await save(tags); dismiss() }
                }.keyboardShortcut(.defaultAction)
            }
        }.padding(20).frame(width: 420)
    }
}

struct SessionMemoryDiagnosticsView: View {
    let session: TaskSession
    @State private var recalls: [MemoryRecallAudit] = []

    var body: some View {
        DisclosureGroup {
            if recalls.isEmpty {
                Text(L10n("No recall decisions recorded yet.")).font(.caption).foregroundStyle(.tertiary)
            } else {
                ForEach(recalls.prefix(8)) { recall in
                    HStack(alignment: .top, spacing: 6) {
                        Image(systemName: recall.selectedIds.isEmpty ? "minus.circle" : "checkmark.circle")
                            .foregroundStyle(recall.selectedIds.isEmpty ? Color.secondary : Color.green)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("\(recall.phase) · \(recall.mode)").font(.caption.bold())
                            Text("\(recall.reason) · hit \(recall.selectedIds.count)/\(recall.candidateIds.count)")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        } label: {
            Label(L10n("Memory recall"), systemImage: "brain.head.profile")
                .font(.system(size: 10, weight: .semibold)).foregroundStyle(.tertiary)
        }
        .task(id: session.id) {
            recalls = await EntityAPIClient.shared.memoryRecalls(sessionId: session.id) ?? []
        }
    }
}
