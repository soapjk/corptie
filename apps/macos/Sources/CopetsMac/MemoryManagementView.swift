import SwiftUI

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

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
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
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(filteredMemories) { memory in
                            memoryRow(memory)
                        }
                    }
                    .padding(.vertical, 2)
                }
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
        .alert(L10n("Revoke Memory"), isPresented: Binding(
            get: { revokingMemory != nil },
            set: { if !$0 { revokingMemory = nil } }
        )) {
            Button(L10n("Revoke"), role: .destructive) {
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
            Text(L10n("Revocation preserves the audit trail and prevents future recall. Physical deletion is not available."))
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
            Button { Task { await load() } } label: { Image(systemName: "arrow.clockwise") }
                .buttonStyle(.borderless)
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
                Text(memory.revokedAt == nil ? (memory.promotionStatus ?? "active") : "revoked")
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
                Button(L10n("Revoke"), role: .destructive) { revokingMemory = memory }.buttonStyle(.link)
                    .disabled(memory.revokedAt != nil)
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
            memories = await client.memories(ownerType: type, ownerId: id) ?? memories
        }
    }

    private func replace(_ updated: MemoryItem) {
        if let index = memories.firstIndex(where: { $0.id == updated.id }) { memories[index] = updated }
    }
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
