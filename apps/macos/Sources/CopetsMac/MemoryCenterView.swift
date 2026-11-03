import SwiftUI
import CorptieConversation

struct MemoryCenterOwner: Identifiable, Hashable, Sendable {
    let type: String
    let resourceID: String
    let title: String
    var isStarted = true
    var id: String { "\(type):\(resourceID)" }
}

enum MemoryCenterLayout {
    static func showsSidebar(_ width: CGFloat) -> Bool { width >= 1000 }
    static func showsDetailBesideList(_ width: CGFloat) -> Bool { width >= 720 }
}

/// The standalone Tab owns its navigation and paging. Embedded owner inspectors
/// continue using MemoryManagementView and their existing scroll ownership.
struct MemoryCenterView: View {
    let focus: MemoryFocus?
    @State private var store = MemoryCenterStore()
    @State private var query = MemoryCenterQuery()
    @State private var search = ""
    @State private var mode = "library"
    @State private var owners: [MemoryCenterOwner] = []
    @State private var owner: MemoryCenterOwner?
    @State private var ownerNames: [String: String] = [:]
    @State private var selected: MemoryCenterRow?
    @State private var compactDetail = false
    @State private var showFilters = false
    @State private var showScopePicker = false
    @State private var selection = [String: MemoryCenterRow]()
    @State private var selecting = false
    @State private var editor: MemoryItem?
    @State private var review: MemoryItem?
    @State private var history: MemoryItem?
    @State private var revoke: MemoryItem?
    @State private var adding = false
    @State private var merging = false
    @State private var actionError: String?
    @State private var mutationInFlight = false
    @FocusState private var searchFocused: Bool
    private let client = EntityAPIClient.shared

    init(focus: MemoryFocus? = nil, store: MemoryCenterStore = MemoryCenterStore()) {
        self.focus = focus
        _store = State(initialValue: store)
        _query = State(initialValue: MemoryCenterQuery(ownerType: focus?.ownerType, ownerID: focus?.ownerId))
        _owner = State(initialValue: focus.map { .init(type: $0.ownerType, resourceID: $0.ownerId, title: $0.ownerId) })
    }

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                toolbar(width: geometry.size.width)
                Divider()
                if mode == "queue" {
                    MemoryCenterQueueView()
                } else {
                    HStack(spacing: 0) {
                        if MemoryCenterLayout.showsSidebar(geometry.size.width) {
                            scopeSidebar.frame(width: 200)
                            Divider()
                        }
                        VStack(spacing: 0) {
                            searchAndFilters(width: geometry.size.width)
                            Divider()
                            memoryColumns(width: geometry.size.width)
                        }
                    }
                }
            }
            .background(WorkbenchStyle.canvas)
            .font(WorkbenchTypography.font(for: .body))
        }
        .task(id: focus) { applyFocus(); await prepareOwners() }
        .task(id: query) { if store.loadedQuery != query { await store.load(query) } }
        .task(id: search) {
            do {
                try await Task.sleep(for: .milliseconds(250))
                try Task.checkCancellation()
                if let editor = NSApp.keyWindow?.firstResponder as? NSTextView, editor.hasMarkedText() { return }
                query.text = search.trimmingCharacters(in: .whitespacesAndNewlines)
            } catch { }
        }
        .onChange(of: store.rows) { _, rows in
            if let id = selected?.id { selected = rows.first { $0.id == id } }
            selection = selection.filter { id, _ in rows.contains { $0.id == id && $0.canMerge } }
        }
        .onChange(of: query) { _, _ in selection.removeAll(); compactDetail = false }
        .onChange(of: mode) { _, value in
            query.reviewOnly = value == "review"
            selection.removeAll()
            compactDetail = false
        }
        .sheet(isPresented: $adding) {
            MemoryCreationSheet(scope: currentScope) { _ in Task { await store.load(query) } }
        }
        .sheet(item: $editor) { memory in
            MemoryTagEditor(memory: memory) { content, keywords, topic, secondary, applies, delivery in
                guard await client.updateMemory(memoryId: memory.id, content: content, tags: memory.tags ?? [],
                    keywords: keywords, primaryTopic: topic, secondaryTopics: secondary,
                    appliesTo: applies, deliveryMode: delivery) != nil else { return false }
                await store.load(query)
                return true
            }
        }
        .sheet(item: $review) { memory in
            MemoryReviewSheet(memory: memory) { _ in Task { await store.load(query) } }
        }
        .sheet(item: $history) { memory in
            MemoryCenterHistoryView(memory: memory) { Task { await store.load(query) } }
        }
        .sheet(isPresented: $merging) {
            MemoryMergeSheet(memories: selection.values.map(\.memory)) { content in
                guard await client.consolidateMemories(memoryIds: Array(selection.keys), content: content) != nil else { return false }
                selection.removeAll()
                selecting = false
                await store.load(query)
                return true
            }
        }
        .alert(L10n("Disable Memory recall?"), isPresented: Binding(get: { revoke != nil }, set: { if !$0 { revoke = nil } })) {
            Button(L10n("Disable recall"), role: .destructive) {
                guard let memory = revoke else { return }
                Task { await setRecall(memory, restore: false) }
            }
            Button(L10n("Cancel"), role: .cancel) { revoke = nil }
        } message: {
            Text(L10n("The Memory will stop participating in recall. Its content and audit history remain available, and it can be enabled again."))
        }
    }

    private var currentScope: MemoryManagementView.Scope {
        owner.map { .owner(type: $0.type, id: $0.resourceID) } ?? .global
    }

    private func toolbar(width: CGFloat) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 16) { title; modePicker; Spacer(minLength: 0); toolbarActions }
            VStack(alignment: .leading, spacing: 8) {
                HStack { title; Spacer(minLength: 0); toolbarActions }
                modePicker
            }
        }
        .padding(16)
        .accessibilityIdentifier("memory.toolbar")
    }
    private var title: some View {
        Text(L10n("Memory")).font(WorkbenchTypography.font(for: .pageTitle)).fixedSize()
    }
    private var modePicker: some View {
        Picker(L10n("Memory workspace"), selection: $mode) {
            Text(L10n("Memory library")).tag("library")
            Text(L10n("Pending review")).tag("review")
            Text(L10n("Extraction queue")).tag("queue")
        }.pickerStyle(.segmented).frame(idealWidth: 320, maxWidth: 380)
        .accessibilityIdentifier("memory.modes")
    }
    private var toolbarActions: some View {
        HStack(spacing: 8) {
            if mode != "queue" {
                Button { Task { await store.load(query); await prepareOwners() } } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel(L10n("Refresh")).help(L10n("Refresh"))
                    .disabled(store.isLoading).accessibilityIdentifier("memory.refresh")
            }
            Button { adding = true } label: { Label(L10n("Add Memory"), systemImage: "plus") }
                .buttonStyle(.borderedProminent).disabled(owner?.isStarted == false).accessibilityIdentifier("memory.create")
        }.fixedSize()
    }

    private var scopeSidebar: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n("Memory scope")).font(WorkbenchTypography.font(for: .navigationHeading))
                .foregroundStyle(.secondary).padding([.top, .horizontal], 16)
            List {
                Button { chooseOwner(nil) } label: {
                    Label(L10n("All scopes"), systemImage: "square.3.layers.3d")
                        .font(WorkbenchTypography.font(for: .navigation))
                }.listRowBackground(owner == nil ? Color.primary.opacity(0.07) : .clear)
                ForEach(owners) { item in
                    Button { chooseOwner(item) } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).lineLimit(1)
                            Text(MemoryScopeLayer(rawValue: item.type)?.title ?? item.type)
                                .font(WorkbenchTypography.font(for: .navigationHeading)).foregroundStyle(.secondary)
                        }
                    }.listRowBackground(owner == item ? Color.primary.opacity(0.07) : .clear)
                }
            }.listStyle(.sidebar).scrollContentBackground(.hidden).buttonStyle(.plain)
        }.background(WorkbenchStyle.sidebarColor)
        .accessibilityIdentifier("memory.scopes")
    }

    private var scopeMenu: some View {
        Button { showScopePicker = true } label: {
            Label(owner?.title ?? L10n("All scopes"), systemImage: "square.3.layers.3d").lineLimit(1)
        }.accessibilityIdentifier("memory.scope-menu")
        .sheet(isPresented: $showScopePicker) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(L10n("Memory scope")).font(WorkbenchTypography.font(for: .sectionTitle))
                    Spacer()
                    Button(L10n("Done")) { showScopePicker = false }
                }.padding(16)
                List {
                    Button(L10n("All scopes")) { chooseOwner(nil); showScopePicker = false }
                    ForEach(owners) { item in
                        Button { chooseOwner(item); showScopePicker = false } label: {
                            VStack(alignment: .leading) {
                                Text(item.title)
                                Text(MemoryScopeLayer(rawValue: item.type)?.title ?? item.type)
                                    .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                            }
                        }
                    }
                }.listStyle(.plain)
            }.frame(minWidth: 320, idealWidth: 420, minHeight: 300, idealHeight: 480)
        }
    }

    private func searchAndFilters(width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                if !MemoryCenterLayout.showsSidebar(width) { scopeMenu }
                TextField(L10n("Search content, tags and keywords"), text: $search)
                    .textFieldStyle(.roundedBorder).focused($searchFocused)
                    .onSubmit { query.text = search.trimmingCharacters(in: .whitespacesAndNewlines) }
                    .accessibilityIdentifier("memory.search")
                Button { showFilters.toggle() } label: { Label("\(L10n("Filters")) (\(filterCount))", systemImage: "line.3.horizontal.decrease") }
                    .accessibilityIdentifier("memory.filters")
                Button { searchFocused = true } label: { EmptyView() }
                    .keyboardShortcut("f", modifiers: .command).hidden().frame(width: 0)
            }
            if showFilters {
                LazyVGrid(columns: [.init(.adaptive(minimum: 150, maximum: 220))], alignment: .leading, spacing: 8) {
                    Picker(L10n("Kind"), selection: $query.kind) {
                        Text(L10n("All kinds")).tag("all")
                        ForEach(["skill", "procedure", "dev_experience", "fact", "lesson", "preference", "feedback", "episodic"], id: \.self) {
                            Text(MemoryPresentationLabels.kind($0)).tag($0)
                        }
                    }
                    Picker(L10n("主题"), selection: $query.topic) {
                        Text(L10n("所有主题")).tag("all")
                        ForEach(MemoryTopicChoices.values) { Text($0.title).tag($0.id) }
                    }
                    if mode != "review" {
                        Picker(L10n("Status"), selection: $query.status) {
                            Text(L10n("Current memories")).tag("current")
                            Text(L10n("All statuses")).tag("all")
                            ForEach(["active", "candidate", "superseded", "promoted_to_skill", "archived", "rolled_back"], id: \.self) {
                                Text(MemoryPresentationLabels.status($0)).tag($0)
                            }
                        }
                        Toggle(L10n("显示已停用"), isOn: $query.includeRevoked).toggleStyle(.checkbox)
                    }
                    if mode != "review" {
                        Picker(L10n("source"), selection: $query.sourceType) {
                            Text(L10n("All sources")).tag("all")
                            Text(L10n("Kept by me")).tag("user")
                            Text(L10n("Extracted")).tag("extracted")
                            Text(L10n("System")).tag("system")
                            Text(L10n("Consolidated")).tag("consolidated")
                            Text(L10n("Checkpoint")).tag("pre_compaction")
                        }
                    }
                    Picker(L10n("trust"), selection: $query.trustLevel) {
                        Text(L10n("All trust levels")).tag("all")
                        Text(L10n("Trusted")).tag("trusted")
                        Text(L10n("Untrusted")).tag("untrusted")
                    }
                    Button(L10n("Clear filters"), action: clearFilters)
                }
            }
            HStack {
                Text(owner?.title ?? L10n("All scopes")).lineLimit(1)
                Text("· \(store.rows.count) \(L10n("loaded"))\(store.nextCursor == nil ? "" : " · \(L10n("More available"))")")
                    .monospacedDigit()
                if store.isLoading { ProgressView().controlSize(.mini); Text(L10n("Updating…")) }
                Spacer(minLength: 0)
                if mode == "library" {
                    Button(L10n(selecting ? "Done" : "Select for merge")) { selecting.toggle(); selection.removeAll() }
                }
            }.font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
            if filterCount > 0 || !search.isEmpty {
                Button(L10n("Clear filters"), action: clearFilters)
                    .font(WorkbenchTypography.font(for: .help))
            }
            if selecting {
                HStack {
                    Text("\(selection.count) \(L10n("selected"))").monospacedDigit()
                    Button(L10n("Merge selected")) { merging = true }.disabled(!canMerge || store.isLoading || store.loadedQuery != query)
                    Text(L10n("Select active, trusted memories from the same owner."))
                        .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary).lineLimit(2)
                }
            }
            if let error = store.error {
                Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                Button(L10n("Retry")) { Task { await store.load(query) } }
                if store.updatedAt != nil { Text(L10n("Showing the last successfully loaded content.")).foregroundStyle(.secondary) }
            }
        }.padding(12)
    }

    @ViewBuilder private func memoryColumns(width: CGFloat) -> some View {
        if MemoryCenterLayout.showsDetailBesideList(width) {
            HSplitView {
                memoryList.frame(minWidth: 280, idealWidth: 320, maxWidth: 400)
                detail.frame(minWidth: 340, maxWidth: .infinity)
            }
        } else {
            ZStack {
                memoryList.opacity(compactDetail && selected != nil ? 0 : 1)
                    .allowsHitTesting(!compactDetail || selected == nil)
                    .accessibilityHidden(compactDetail && selected != nil)
                if compactDetail, selected != nil { detail.background(WorkbenchStyle.canvas) }
            }
        }
    }

    private var memoryList: some View {
        Group {
            if store.rows.isEmpty {
                VStack(spacing: 12) {
                    if store.isLoading {
                        ProgressView()
                        Text(L10n("Loading memories…")).foregroundStyle(.secondary)
                    } else {
                        ContentUnavailableView {
                            Label(emptyTitle, systemImage: "brain")
                        } description: {
                            Text(owner?.isStarted == false ? L10n("Start this Task and bind a Session before managing its memories.")
                                 : L10n("Choose another scope or clear the current filters."))
                        } actions: {
                            if store.error != nil {
                                Button(L10n("Retry")) { Task { await store.load(query) } }
                            } else if filterCount > 0 || !search.isEmpty {
                                Button(L10n("Clear filters"), action: clearFilters)
                            } else if owner?.isStarted != false {
                                Button(L10n("Add Memory")) { adding = true }
                            }
                        }
                    }
                }
            } else {
                List(selection: Binding<String?>(
                    get: { selected?.id },
                    set: { id in
                        selected = id.flatMap { store.rowsByID[$0] }
                        compactDetail = selected != nil
                        actionError = nil
                    }
                )) {
                    ForEach(store.rows) { row in
                        HStack(alignment: .top, spacing: 8) {
                            if selecting {
                                Toggle(L10n("Select for merge"), isOn: Binding(
                                    get: { selection[row.id] != nil },
                                    set: { if $0 { selection[row.id] = row } else { selection.removeValue(forKey: row.id) } }
                                )).labelsHidden().toggleStyle(.checkbox).disabled(!row.canMerge || store.isLoading || store.loadedQuery != query)
                            }
                            Button { selected = row; compactDetail = true; actionError = nil } label: {
                                MemoryCenterListRow(row: row)
                            }.buttonStyle(.plain).accessibilityIdentifier("memory.row.\(row.id)")
                        }
                        .padding(.vertical, 4)
                        .tag(row.id)
                        .listRowBackground(selected?.id == row.id ? Color.accentColor.opacity(0.10) : .clear)
                    }
                    if store.nextCursor != nil {
                        if store.rows.count >= MemoryCenterStore.cacheLimit {
                            Text(L10n("500 memories loaded. Narrow the search to continue browsing."))
                                .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                        } else {
                            Button(L10n("Load more memories")) { Task { await store.load(query, more: true) } }
                                .disabled(store.isLoading).accessibilityIdentifier("memory.load-more")
                        }
                    }
                }.listStyle(.plain).scrollContentBackground(.hidden)
            }
        }.accessibilityIdentifier("memory.list")
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let row = selected {
                HStack {
                    Button { compactDetail = false; selected = nil } label: { Label(L10n("Back to list"), systemImage: "chevron.left") }
                    Spacer()
                    Button(L10n("Edit Memory")) { editor = row.memory }.disabled(row.memory.revokedAt != nil)
                    Button(L10n("History")) { history = row.memory }
                    Menu {
                        if row.memory.revokedAt == nil {
                            Button(L10n("Disable recall"), role: .destructive) { revoke = row.memory }
                        } else {
                            Button(L10n("Enable recall")) { Task { await setRecall(row.memory, restore: true) } }
                        }
                    } label: { Image(systemName: "ellipsis") }.accessibilityLabel(L10n("More actions"))
                }.padding(12).disabled(mutationInFlight || store.isLoading || store.loadedQuery != query)
                Divider()
                if let actionError { Text(actionError).foregroundStyle(.red).padding(12) }
                MemoryCenterDetail(row: row, ownerName: ownerNames["\(row.memory.ownerType):\(row.memory.ownerId)"], review: { review = row.memory })
                    .disabled(mutationInFlight || store.isLoading || store.loadedQuery != query)
            } else {
                ContentUnavailableView(L10n("Select a memory"), systemImage: "text.alignleft",
                    description: Text(L10n("Read its content, scope and source evidence.")))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }.accessibilityIdentifier("memory.detail")
    }

    private var emptyTitle: String {
        if store.error != nil { return L10n("Could not load memories") }
        if owner?.isStarted == false { return L10n("Task has not started") }
        return L10n(filterCount > 0 || !search.isEmpty || mode == "review" ? "No matching memories" : "No memories")
    }
    private func clearFilters() {
        search = ""; query.text = ""; query.kind = "all"; query.topic = "all"
        query.status = "current"; query.includeRevoked = false; query.sourceType = "all"; query.trustLevel = "all"
    }

    private var filterCount: Int {
        (query.kind == "all" ? 0 : 1) + (query.topic == "all" ? 0 : 1)
            + (query.status == "current" || mode == "review" ? 0 : 1) + (query.includeRevoked ? 1 : 0)
            + (query.sourceType == "all" || mode == "review" ? 0 : 1) + (query.trustLevel == "all" ? 0 : 1)
    }

    private var canMerge: Bool {
        guard selection.count >= 2, let first = selection.values.first else { return false }
        return selection.values.allSatisfy { $0.canMerge && $0.memory.ownerType == first.memory.ownerType && $0.memory.ownerId == first.memory.ownerId }
    }
    private func chooseOwner(_ value: MemoryCenterOwner?) {
        owner = value; selected = nil
        query.ownerType = value?.type; query.ownerID = value?.resourceID
    }
    private func prepareOwners() async {
        // Capture immutable inventory snapshots; construct the projection outside
        // the UI executor, never when the scope picker is first clicked.
        let works = client.works, tasks = client.tasks, roles = client.roles
        let globalTitle = L10n("Global Memory"), legacyTitle = L10n("Legacy Role layer")
        let result = await Task.detached(priority: .utility) {
            var values: [MemoryCenterOwner] = [.init(type: "global", resourceID: "user:local", title: globalTitle)]
            values += works.map { .init(type: "work", resourceID: $0.id, title: $0.name) }
            values += tasks.map { .init(type: "task", resourceID: $0.id, title: $0.title, isStarted: $0.currentSessionId != nil) }
            values += roles.map { .init(type: "agent", resourceID: $0.roleId, title: "\($0.name) · \(legacyTitle)") }
            return values
        }.value
        guard !Task.isCancelled else { return }
        owners = result
        ownerNames = Dictionary(result.map { ($0.id, $0.title) }, uniquingKeysWith: { _, last in last })
        if let focus, let resolved = result.first(where: { $0.type == focus.ownerType && $0.resourceID == focus.ownerId }) {
            owner = resolved
        }
    }
    private func applyFocus() {
        if let focus {
            chooseOwner(owners.first { $0.type == focus.ownerType && $0.resourceID == focus.ownerId }
                ?? .init(type: focus.ownerType, resourceID: focus.ownerId, title: focus.ownerId))
        } else { chooseOwner(nil) }
    }
    private func setRecall(_ memory: MemoryItem, restore: Bool) async {
        guard !mutationInFlight else { return }
        mutationInFlight = true; actionError = nil
        defer { mutationInFlight = false }
        let updated = restore
            ? await client.restoreMemory(memoryId: memory.id, reason: "Enabled from Memory Tab")
            : await client.revokeMemory(memoryId: memory.id, reason: "Disabled from Memory Tab")
        if updated != nil { revoke = nil; await store.load(query) }
        else { actionError = client.errorMessage ?? L10n("Could not save memory.") }
    }
}

private struct MemoryCenterListRow: View {
    let row: MemoryCenterRow
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(row.preview).font(WorkbenchTypography.font(for: .body)).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack {
                Text(MemoryPresentationLabels.kind(row.memory.kind))
                Spacer(minLength: 4)
                Text(row.inactive ? L10n("Not participating in recall") : MemoryPresentationLabels.status(row.memory.promotionStatus ?? "active"))
            }.font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
            Text(MemoryScopeLayer(rawValue: row.memory.ownerType)?.title ?? row.memory.ownerType)
                .font(WorkbenchTypography.font(for: .navigationHeading)).foregroundStyle(.secondary)
        }.contentShape(Rectangle())
    }
}

private struct MemoryCenterDetail: View {
    let row: MemoryCenterRow
    let ownerName: String?
    let review: () -> Void
    @State private var expanded = false
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(MemoryPresentationLabels.kind(row.memory.kind)).font(WorkbenchTypography.font(for: .sectionTitle))
                Text(row.inactive ? L10n("Not participating in recall") : MemoryPresentationLabels.status(row.memory.promotionStatus ?? "active"))
                    .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                if row.canReview {
                    Text(L10n("Candidates do not participate in recall until confirmed.")).foregroundStyle(.secondary)
                    Button(L10n("Review candidate"), action: review).buttonStyle(.borderedProminent)
                }
                Text(expanded ? row.memory.content : row.excerpt)
                    .font(WorkbenchTypography.font(for: .body)).textSelection(.enabled)
                if row.hasMoreContent && !expanded {
                    Button(L10n("展开全文")) { expanded = true }
                }
                Divider()
                section("Memory scope", ownerName ?? row.memory.ownerId)
                if let topic = row.memory.primaryTopic { section("主题", MemoryTopicChoices.title(topic)) }
                if let topics = row.memory.secondaryTopics, !topics.isEmpty { section("辅助主题", topics.map(MemoryTopicChoices.title).joined(separator: " · ")) }
                if let words = row.memory.keywords, !words.isEmpty { section("Keywords", words.joined(separator: " · ")) }
                if row.memory.deliveryMode == "applicable_preference" { section("适用场景", (row.memory.appliesTo ?? []).joined(separator: " · ")) }
                Divider()
                Text(L10n("Source and evidence")).font(WorkbenchTypography.font(for: .sectionTitle))
                Text(row.memory.structured?.extraction?.evidence ?? L10n("Source evidence was not recorded.")).textSelection(.enabled)
                if let rationale = row.memory.structured?.extraction?.rationale { Text(rationale).foregroundStyle(.secondary) }
                if let rationale = row.memory.structured?.extraction?.scopeRationale { Text(rationale).foregroundStyle(.secondary) }
                if let session = row.memory.sourceSessionId {
                    Button { AppTabRouter.shared.openSession(session, source: .userSelection) } label: { Label(session, systemImage: "arrow.up.forward") }
                        .font(WorkbenchTypography.font(for: .technical))
                }
                DisclosureGroup(L10n("Technical details")) {
                    VStack(alignment: .leading, spacing: 8) {
                        section("ID", row.id)
                        section("Owner", row.memory.ownerId)
                        if let sequences = row.memory.sourceEventSeqs, !sequences.isEmpty {
                            section("Source events", sequences.prefix(20).map(String.init).joined(separator: ", "))
                        }
                        section("source", row.memory.sourceType)
                        section("trust", row.memory.trustLevel ?? "untrusted")
                        section("Version", row.memory.version.map(String.init) ?? L10n("Not recorded"))
                        section("updated", row.memory.updatedAt ?? row.memory.createdAt)
                        section("usage", row.memory.usageCount.map(String.init) ?? L10n("Not recorded"))
                        if let confidence = row.memory.confidence { section("Recorded confidence", String(format: "%.0f%%", confidence * 100)) }
                        if let replacement = row.memory.replacesMemoryId { section("replacesMemoryId", replacement) }
                        if let skill = row.memory.promotedSkillId { section("promoted", skill) }
                    }.padding(.top, 8)
                }
            }.padding(16).frame(maxWidth: WorkbenchStyle.readingWidth, alignment: .leading)
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }.id(row.id)
    }
    private func section(_ title: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L10n(title)).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
            Text(value).textSelection(.enabled)
        }
    }
}

struct MemoryCenterQueueView: View {
    @State private var jobs: [MemoryExtractionJob] = []
    @State private var error: String?
    @State private var loading = false
    @State private var updatedAt: Date?
    private let reader = MemoryCenterReader(baseURL: CorptieAppEnvironment.backendBaseURL)
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n("Recent extraction tasks · up to 100")).font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                Spacer()
                Button(L10n("Refresh")) { Task { await load() } }.disabled(loading)
            }.padding(.horizontal, 16).padding(.top, 12)
            if loading { ProgressView().controlSize(.small).padding(.horizontal, 16) }
            if let error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).padding(.horizontal, 16) }
            if let updatedAt { Text(updatedAt, style: .time).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary).padding(.horizontal, 16) }
            if jobs.isEmpty && !loading {
                ContentUnavailableView(L10n(error == nil ? "No extraction tasks returned" : "Could not load extraction queue"), systemImage: "clock.arrow.circlepath")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(jobs, id: \.sessionId) { job in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(Self.status(job)).font(WorkbenchTypography.font(for: .cardTitle))
                        Button { AppTabRouter.shared.openSession(job.sessionId, source: .userSelection) } label: { Text(job.sessionId).lineLimit(1) }
                        Text("\(job.reason) · \(job.attempts) \(L10n("attempts"))").font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                        if let retry = job.retryAt { Text("\(L10n("Next retry")): \(retry)").font(WorkbenchTypography.font(for: .metadata)) }
                        if let error = job.lastError { Text(error).font(WorkbenchTypography.font(for: .technical)).textSelection(.enabled) }
                    }.padding(.vertical, 8)
                }.listStyle(.plain).scrollContentBackground(.hidden)
            }
        }.task { await load() }.accessibilityIdentifier("memory.queue")
    }
    static func status(_ job: MemoryExtractionJob) -> String {
        switch job.state {
        case "queued": L10n(job.retryAt == nil ? "Queued" : "Waiting to retry")
        case "running": L10n("Running")
        case "blocked": L10n("Blocked")
        case "skipped": L10n("Skipped")
        default: job.state
        }
    }
    private func load() async {
        guard !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do { jobs = try await reader.jobs(); updatedAt = Date() }
        catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

struct MemoryCenterHistoryView: View {
    let memory: MemoryItem
    let onChange: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var entries: [MemoryAuditEntry] = []
    @State private var recalls: [MemoryRecallAudit] = []
    @State private var auditError: String?
    @State private var recallError: String?
    @State private var actionError: String?
    @State private var rollback: MemoryAuditEntry?
    @State private var loading = false
    @State private var saving = false
    @State private var section = "changes"
    private let reader = MemoryCenterReader(baseURL: CorptieAppEnvironment.backendBaseURL)
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(L10n("Memory audit history")).font(WorkbenchTypography.font(for: .sectionTitle))
                Spacer()
                Button(L10n("Done")) { dismiss() }.disabled(saving)
            }
            Text(String(memory.content.prefix(240))).lineLimit(2).foregroundStyle(.secondary)
            Picker(L10n("History"), selection: $section) {
                Text(L10n("Changes")).tag("changes")
                Text(L10n("Recall history")).tag("recalls")
            }.pickerStyle(.segmented)
            if loading { ProgressView().controlSize(.small) }
            if let actionError { Text(actionError).foregroundStyle(.red) }
            if section == "changes" {
                if let auditError { failure(auditError) }
                if entries.isEmpty && !loading && auditError == nil { Text(L10n("No change records returned.")).foregroundStyle(.secondary) }
                List(entries) { entry in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(entry.action).font(WorkbenchTypography.font(for: .cardTitle))
                        Text([entry.actorType, entry.actorId, entry.createdAt].compactMap { $0 }.joined(separator: " · "))
                            .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary).textSelection(.enabled)
                        if let reason = entry.reason { Text(reason).font(WorkbenchTypography.font(for: .help)) }
                        if ["update", "revoke", "supersede"].contains(entry.action) {
                            Button(L10n("Rollback")) { rollback = entry }.disabled(saving)
                        }
                    }.padding(.vertical, 6)
                }.listStyle(.plain)
            } else {
                if let recallError { failure(recallError) }
                if recalls.isEmpty && !loading && recallError == nil { Text(L10n("No recall records returned.")).foregroundStyle(.secondary) }
                List(recalls) { recall in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(recall.injectionStatus ?? L10n("Not recorded"))
                        if let session = recall.sessionId {
                            Button(session) { AppTabRouter.shared.openSession(session, source: .userSelection); dismiss() }
                        }
                        Text(recall.createdAt).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                    }.padding(.vertical, 6)
                }.listStyle(.plain)
            }
        }.padding(16).frame(minWidth: 320, idealWidth: 600, maxWidth: 680, minHeight: 320, idealHeight: 460)
        .background(WorkbenchStyle.canvas)
        .task { await load() }
        .interactiveDismissDisabled(saving)
        .alert(L10n("Restore the state before this change?"), isPresented: Binding(get: { rollback != nil }, set: { if !$0 { rollback = nil } })) {
            Button(L10n("Rollback"), role: .destructive) {
                guard let event = rollback else { return }
                Task {
                    saving = true; actionError = nil
                    defer { saving = false }
                    if await EntityAPIClient.shared.rollbackMemoryAudit(auditId: event.id) != nil {
                        onChange(); await load()
                    } else { actionError = EntityAPIClient.shared.errorMessage ?? L10n("Could not save memory.") }
                    rollback = nil
                }
            }
            Button(L10n("Cancel"), role: .cancel) { rollback = nil }
        } message: {
            Text(L10n("A new rollback event will be recorded. Existing history is preserved. A field-by-field preview is not available."))
        }
    }
    private func failure(_ message: String) -> some View {
        HStack {
            Text(message).foregroundStyle(.red)
            Button(L10n("Retry")) { Task { await load() } }.disabled(loading)
        }
    }
    private func load() async {
        guard !loading else { return }
        loading = true; auditError = nil; recallError = nil
        defer { loading = false }
        do { entries = try await reader.audit(memory.id) }
        catch { if !Task.isCancelled { auditError = error.localizedDescription } }
        do { recalls = try await reader.recalls(memory.id) }
        catch { if !Task.isCancelled { recallError = error.localizedDescription } }
    }
}
