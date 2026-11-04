import SwiftUI
import CorptieConversation

/// Page-local shell: match the console's flat, full-height columns without
/// coupling scene navigation to its mode, split-controller or saved widths.
struct ScenePageColumns<Navigation: View, Detail: View>: View {
    let showsNavigation: Bool
    @ViewBuilder let navigation: () -> Navigation
    @ViewBuilder let detail: (Bool) -> Detail

    var body: some View {
        GeometryReader { geometry in
            let inline = geometry.size.width >= 820
            HStack(spacing: 0) {
                if inline && showsNavigation {
                    navigation()
                        .padding(.top, MainWindowLayoutMetrics.titlebarHeight)
                        // ConsoleSplitController's default work-outline width.
                        .frame(width: 284)
                        .frame(maxHeight: .infinity, alignment: .top)
                        .background(WorkbenchStyle.sidebarColor)
                }
                detail(inline)
                    .padding(.top, MainWindowLayoutMetrics.titlebarHeight)
                    .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(WorkbenchStyle.canvas)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(WorkbenchStyle.canvas)
        .ignoresSafeArea(.container, edges: .top)
    }
}

struct ScenesView: View {
    @EnvironmentObject private var sidebarState: TabSidebarState
    @StateObject private var client: SceneAPIClient
    @State private var selectedSceneID: String?
    @State private var createDraft: CreateSceneDraft?
    @State private var showsNavigation = false
    @State private var drafts = SceneDraftStore()

    init(client: SceneAPIClient = SceneAPIClient()) { _client = StateObject(wrappedValue: client) }
    private var selectedScene: SceneInstance? { selectedSceneID.flatMap { client.scenesByID[$0] } }

    var body: some View {
        ScenePageColumns(showsNavigation: sidebarState.isVisible && !client.scenes.isEmpty) {
            navigation
        } detail: { inline in
            detail(inline: inline)
        }
        .task { await client.loadInventory(); selectFirstSceneIfNeeded() }
        // One owner for selection reads. Detail and creation never start a duplicate request.
        .task(id: selectedSceneID) {
            guard let selectedScene else { return }
            await client.loadScene(selectedScene)
        }
        .onChange(of: selectedSceneID) { _, _ in showsNavigation = false }
        .sheet(item: $createDraft) { draft in
            SceneCreationSheet(draft: draft, client: client) { created in selectedSceneID = created.id }
        }
    }

    private var navigation: some View {
        VStack(spacing: 0) {
                sidebarHeader
                Divider()
                List(client.scenes, selection: $selectedSceneID) { scene in
                Label(scene.name, systemImage: SceneKind(scene).symbol)
                    .font(WorkbenchTypography.font(for: .navigation))
                    .lineLimit(1).help(scene.name).padding(.vertical, 4).tag(scene.id)
            }.listStyle(.sidebar)
                .scrollContentBackground(.hidden)
            if let error = client.inventoryError {
                SceneNotice(message: error) { Task { await client.loadInventory() } }.padding(12)
            }
        }
        .background(WorkbenchStyle.sidebarColor)
        .accessibilityIdentifier("scenes.navigation")
    }

    private var sidebarHeader: some View {
        HStack {
                Text(SceneText("Scenes")).font(WorkbenchTypography.font(for: .cardTitle))
                Spacer()
                Button(action: beginCreatingScene) { Image(systemName: "plus").frame(width: 28, height: 28) }
                    .buttonStyle(.borderless)
                    .help(SceneText("Create Scene")).accessibilityLabel(SceneText("Create Scene"))
                    .accessibilityIdentifier("scenes.create")
            }.padding(.horizontal, 12).frame(height: 38)
    }

    @ViewBuilder private func detail(inline: Bool) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                if !client.scenes.isEmpty && (!inline || !sidebarState.isVisible) {
                    Button { showsNavigation = true } label: { Label(SceneText("Scenes"), systemImage: "sidebar.left") }
                        .popover(isPresented: $showsNavigation, arrowEdge: .bottom) {
                            navigation.frame(width: 260, height: 400)
                        }
                        .accessibilityIdentifier("scenes.navigation.show")
                }
                Spacer()
                if !client.scenes.isEmpty {
                    Button(action: beginCreatingScene) { Label(SceneText("Create Scene"), systemImage: "plus") }
                        .accessibilityIdentifier("scenes.detail.create")
                }
            }.padding(.horizontal, 12).padding(.vertical, 6)
            if let scene = selectedScene {
                if let draft = drafts.draft(for: scene.id) {
                    SceneDetailView(scene: scene, client: client, draft: draft, operation: client.operation(for: scene.id))
                } else {
                    ContentUnavailableView(SceneText("Ten scenes have unsaved input"), systemImage: "square.and.pencil",
                        description: Text(SceneText("Save or clear input in another scene, then return here.")))
                }
            } else if client.isLoadingInventory {
                ProgressView(SceneText("Loading scenes…")).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = client.inventoryError, client.scenes.isEmpty {
                ContentUnavailableView {
                    Label(SceneText("Scenes could not load"), systemImage: "exclamationmark.triangle")
                } description: { Text(error) } actions: {
                    Button(SceneText("Retry")) { Task { await client.loadInventory(); selectFirstSceneIfNeeded() } }
                }
            } else if client.scenes.isEmpty {
                ContentUnavailableView {
                    Label(SceneText("No Scenes"), systemImage: "square.grid.2x2")
                } description: { Text(SceneText("Start with a checklist or manual measurements.")) } actions: {
                    Button(SceneText("Create Scene"), action: beginCreatingScene).buttonStyle(.borderedProminent)
                }
            } else {
                ContentUnavailableView(SceneText("Select a Scene"), systemImage: "square.grid.2x2")
            }
        }
    }
    private func beginCreatingScene() {
        let template = client.templates.first { SceneKind(templateID: $0.templateId, version: $0.version) != .unsupported }
        createDraft = CreateSceneDraft(templateId: template?.templateId ?? "", name: "", templateVersion: template?.version ?? 1)
    }
    private func selectFirstSceneIfNeeded() {
        if selectedSceneID == nil { selectedSceneID = client.scenes.first?.id }
        else if selectedScene == nil { selectedSceneID = nil }
    }
}

struct SceneDetailView: View {
    let scene: SceneInstance
    @ObservedObject var client: SceneAPIClient
    let draft: SceneEntryDraft
    @ObservedObject var operation: SceneOperationState
    @Environment(\.locale) private var locale

    private var kind: SceneKind { SceneKind(scene) }
    private var ownsRecords: Bool { client.recordsOwnerSceneID == scene.id }

    var body: some View {
        GeometryReader { geometry in
            let lane = WorkbenchStyle.lane(viewportWidth: geometry.size.width)
            // One lazy scrolling surface at every height; no eager list or nested scroll views.
            List {
                VStack(alignment: .leading, spacing: 6) {
                    Text(scene.name).font(WorkbenchTypography.font(for: .pageTitle)).textSelection(.enabled)
                    Text(kind.title).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                    DisclosureGroup(SceneText("Scene information")) {
                        Text(scene.timezone).textSelection(.enabled)
                        Text("r\(scene.instanceRevision)").font(WorkbenchTypography.font(for: .technical))
                    }.font(WorkbenchTypography.font(for: .help))
                }.sceneLane(lane)

                if kind != .unsupported {
                    SceneComposer(scene: scene, draft: draft, operation: operation,
                        enabled: ownsRecords && !client.isLoading && !client.isResolvingList && client.listIssue == nil && client.errorMessage == nil,
                        width: lane.width,
                        submit: { metric, value, unit in
                            if kind == .checklist { return await client.addChecklistItem(title: metric, to: scene) }
                            return await client.addMeasurement(metric: metric, value: value ?? 0, unit: unit, to: scene)
                        })
                    .sceneLane(lane)
                    if client.isResolvingList && ownsRecords {
                        ProgressView(SceneText("Checking checklist…")).controlSize(.small).sceneLane(lane)
                    }
                    if let issue = client.listIssue, ownsRecords { Text(issue).font(.callout).sceneLane(lane) }
                    if let message = operation.message {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(message).font(WorkbenchTypography.font(for: .help)).textSelection(.enabled)
                            if operation.needsVerification {
                                Button(SceneText("I checked the records; allow new entries")) {
                                    operation.needsVerification = false; operation.message = nil
                                }
                                .help(SceneText("Check for the submitted record first to avoid duplicates."))
                            }
                        }.sceneLane(lane)
                    }
                }

                HStack {
                    Text(kind == .checklist ? SceneText("Checklist records") : kind == .measurements ? SceneText("Measurement records") : SceneText("Records"))
                        .font(WorkbenchTypography.font(for: .sectionTitle))
                    Spacer()
                    if client.isLoading && ownsRecords { ProgressView().controlSize(.small) }
                    Button { Task { await client.loadScene(scene) } } label: { Image(systemName: "arrow.clockwise") }
                        .buttonStyle(.borderless).help(SceneText("Refresh records"))
                        .accessibilityLabel(SceneText("Refresh records"))
                        .accessibilityIdentifier("scenes.records.refresh")
                        .disabled(client.isLoading || operation.isPending || kind == .unsupported)
                }.sceneLane(lane)

                if !ownsRecords || (client.isLoading && client.rows.isEmpty) {
                    ProgressView(SceneText("Loading records…")).sceneLane(lane)
                } else {
                    if let error = client.errorMessage {
                        SceneNotice(message: client.rows.isEmpty ? error : SceneText("Refresh failed. Showing previously loaded records.") + "\n" + error) {
                            Task { await client.loadScene(scene) }
                        }.sceneLane(lane)
                    }
                    if client.rows.isEmpty && client.errorMessage == nil && kind != .unsupported {
                        ContentUnavailableView(kind == .checklist ? SceneText("No checklist items") : SceneText("No measurements"),
                            systemImage: "tray", description: Text(SceneText("Add the first record above.")))
                        .sceneLane(lane)
                    }
                    ForEach(client.rows) { row in
                        SceneRecordRow(row: row, compact: lane.width < 420, pending: operation.pendingRecordID == row.id,
                            disabled: operation.isPending || operation.needsVerification || client.isLoading) {
                                Task { await client.toggleChecklistItem(row.record, in: scene) }
                            }.equatable().sceneLane(lane)
                    }
                    if kind != .unsupported { pagination.sceneLane(lane) }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .contentMargins(.horizontal, 0, for: .scrollContent)
            .accessibilityIdentifier("scenes.detail")
            .onChange(of: locale) { _, _ in client.prepareRows(scene: scene) }
        }
    }

    private var pagination: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(String(format: SceneText("%lld records loaded in this group"), client.rows.count))
                .font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
            if let error = client.pageError { Text(error).font(.callout).foregroundStyle(.secondary) }
            HStack {
                if client.hasPreviousGroup {
                    Button(SceneText("Previous group")) { Task { await client.loadPrevious(scene) } }
                }
                if client.nextOffset != nil {
                    Button(client.records.count >= 500 ? SceneText("Next group") : SceneText("Load more")) {
                        Task { await client.loadMore(scene) }
                    }.accessibilityIdentifier("scenes.records.more")
                } else if client.pageError == nil {
                    Text(SceneText("All records from this read are shown.")).font(.callout).foregroundStyle(.secondary)
                }
                if client.isLoadingPage { ProgressView().controlSize(.small) }
            }.disabled(client.isLoadingPage || client.isLoading || operation.isPending)
        }
    }
}

private struct SceneComposer: View {
    let scene: SceneInstance
    @ObservedObject var draft: SceneEntryDraft
    @ObservedObject var operation: SceneOperationState
    let enabled: Bool
    let width: CGFloat
    let submit: (String, Double?, String) async -> SceneMutationOutcome
    @Environment(\.locale) private var locale
    @FocusState private var inputFocused: Bool
    private var checklist: Bool { SceneKind(scene) == .checklist }
    private var number: Double? { SceneInput.number(draft.value, locale: locale) }
    private var valid: Bool {
        SceneInput.validText(draft.title, maximum: checklist ? 240 : 80)
            && (checklist || (number != nil && SceneInput.validText(draft.unit, maximum: 32)))
    }
    private var editable: Bool { enabled && !operation.isPending && !operation.needsVerification }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(checklist ? SceneText("Add checklist item") : SceneText("Record measurement"))
                .font(WorkbenchTypography.font(for: .sectionTitle))
            Group {
                if checklist && width >= 420 {
                    HStack(alignment: .bottom, spacing: 8) { titleField; submitButton }
                } else {
                VStack(alignment: .leading, spacing: 12) {
                    titleField
                    if !checklist {
                        if width >= 420 {
                            HStack(alignment: .bottom, spacing: 12) {
                                valueField; unitField.frame(width: 100); submitButton
                            }
                        } else { valueField; unitField }
                    }
                    if checklist || width < 420 { HStack { Spacer(); submitButton } }
                }
                }
            }
            if !draft.title.isEmpty && !SceneInput.validText(draft.title, maximum: checklist ? 240 : 80) {
                Text(checklist ? SceneText("Enter 1–240 characters for the item.") : SceneText("Enter 1–80 characters for the metric."))
                    .font(.callout).foregroundStyle(.secondary)
            }
            if !checklist {
                if !draft.value.isEmpty && number == nil {
                    Text(SceneText("Enter a decimal number between -1000000 and 1000000.")).font(.callout)
                }
                if !SceneInput.validText(draft.unit, maximum: 32) {
                    Text(SceneText("Enter a unit of 1–32 characters.")).font(.callout)
                }
                Text(SceneText("Records the submission time") + " · " + scene.timezone)
                    .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
            }
            if !draft.isEmpty {
                HStack {
                    Text(SceneText("Input is not saved until submitted. Kept in this window only."))
                        .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                    Button(SceneText("Clear input")) { draft.clear() }
                        .disabled(operation.isPending)
                }
            }
        }
    }
    private var titleField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(checklist ? SceneText("Item name") : SceneText("Metric name")).font(WorkbenchTypography.font(for: .help))
            TextField(checklist ? SceneText("What needs to be done?") : SceneText("For example, body weight"), text: $draft.title)
                .textFieldStyle(.roundedBorder).focused($inputFocused)
                .accessibilityLabel(checklist ? SceneText("Item name") : SceneText("Metric name"))
                .accessibilityIdentifier(checklist ? "scenes.checklist.new-item" : "scenes.measurement.metric")
                .onSubmit { send() }.disabled(!editable)
        }
    }
    private var valueField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(SceneText("Value")).font(WorkbenchTypography.font(for: .help))
            TextField("68" + (locale.decimalSeparator ?? ".") + "4", text: $draft.value)
                .textFieldStyle(.roundedBorder).accessibilityLabel(SceneText("Value"))
                .accessibilityIdentifier("scenes.measurement.value").onSubmit { send() }.disabled(!editable)
        }
    }
    private var unitField: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(SceneText("Unit")).font(WorkbenchTypography.font(for: .help))
            TextField("kg", text: $draft.unit).textFieldStyle(.roundedBorder).accessibilityLabel(SceneText("Unit"))
                .accessibilityIdentifier("scenes.measurement.unit").onSubmit { send() }.disabled(!editable)
        }
    }
    private var submitButton: some View {
        Button(action: send) {
            HStack(spacing: 6) {
                if operation.isPending && operation.pendingRecordID == nil { ProgressView().controlSize(.small) }
                Text(operation.isPending && operation.pendingRecordID == nil ? SceneText("Saving…") : checklist ? SceneText("Add") : SceneText("Record"))
            }
        }.buttonStyle(.borderedProminent).disabled(!editable || !valid)
            .accessibilityIdentifier("scenes.entry.submit")
    }
    private func send() {
        guard editable, valid else { return }
        let title = draft.title, value = draft.value, unit = draft.unit, parsed = number
        Task {
            if await submit(title, parsed, unit) == .committed {
                if checklist && draft.title == title { draft.title = "" }
                if !checklist && draft.value == value {
                    draft.markMeasurementSaved(metric: title, unit: unit); draft.value = ""
                }
                inputFocused = true
            }
        }
    }
}

struct SceneRecordRow: View, Equatable {
    let row: SceneRecordPresentation
    var compact = false
    let pending: Bool
    let disabled: Bool
    let toggle: () -> Void
    @State private var expanded = false
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool { lhs.row == rhs.row && lhs.compact == rhs.compact && lhs.pending == rhs.pending && lhs.disabled == rhs.disabled }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if row.record.recordType == "Item" {
                Button(action: toggle) {
                    Image(systemName: row.completed ? "checkmark.circle.fill" : "circle")
                        .font(.body).frame(width: 28, height: 28)
                }.buttonStyle(.borderless).disabled(disabled)
                    .accessibilityLabel(row.title).accessibilityValue(row.completed ? SceneText("Completed") : SceneText("Not completed"))
            }
            VStack(alignment: .leading, spacing: 4) {
                if !compact, let value = row.value {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        title
                        Spacer(minLength: 0)
                        Text(value).font(WorkbenchTypography.font(for: .body)).monospacedDigit().textSelection(.enabled)
                    }
                } else {
                    title
                    if let value = row.value { Text(value).font(WorkbenchTypography.font(for: .body)).monospacedDigit().textSelection(.enabled) }
                }
                if row.title.utf16.count > 40 || row.title.contains("\n") {
                    Button(expanded ? SceneText("Collapse") : SceneText("Expand")) { expanded.toggle() }
                        .buttonStyle(.borderless).font(.callout)
                }
                if let metadata = row.metadata {
                    Text(metadata).font(WorkbenchTypography.font(for: .metadata)).foregroundStyle(.secondary)
                }
                if pending { ProgressView(SceneText("Updating…")).controlSize(.small) }
            }
            Spacer(minLength: 0)
        }.padding(.vertical, 8).frame(maxWidth: .infinity, minHeight: row.metadata == nil ? 52 : 60, alignment: .leading)
            .accessibilityIdentifier("scene-record.\(row.id)")
    }
    private var title: some View {
        Text(row.title).font(WorkbenchTypography.font(for: .body))
            .foregroundStyle(row.completed ? .secondary : .primary)
            .strikethrough(row.completed).lineLimit(expanded ? nil : 3).textSelection(.enabled)
    }
}

private struct SceneLaneModifier: ViewModifier {
    let lane: CGRect
    func body(content: Content) -> some View {
        content.frame(maxWidth: .infinity, alignment: .leading)
            .listRowInsets(EdgeInsets(top: 8, leading: lane.minX, bottom: 8, trailing: lane.minX))
            .listRowSeparator(.hidden).listRowBackground(Color.clear)
    }
}
private extension View {
    func sceneLane(_ lane: CGRect) -> some View { modifier(SceneLaneModifier(lane: lane)) }
}
private struct SceneNotice: View {
    let message: String
    let retry: () -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(message, systemImage: "exclamationmark.triangle").font(.callout).textSelection(.enabled)
            Button(SceneText("Retry"), action: retry)
        }
    }
}

struct SceneCreationSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: CreateSceneDraft
    @ObservedObject var client: SceneAPIClient
    let didCreate: (SceneInstance) -> Void
    @State private var pending = false
    @State private var error: String?
    @State private var uncertain = false
    @State private var confirmsDiscard = false
    @State private var initialSelection: String?
    @State private var initialTimezone: String?
    @FocusState private var nameFocused: Bool
    private var selectedTemplate: String { "\(draft.templateId):\(draft.templateVersion)" }
    private var valid: Bool {
        SceneInput.validText(draft.name, maximum: 120)
            && TimeZone(identifier: SceneInput.clean(draft.timezone)) != nil
            && SceneKind(templateID: draft.templateId, version: draft.templateVersion) != .unsupported
            && client.templates.contains { $0.id == selectedTemplate }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(SceneText("Create Scene")).font(WorkbenchTypography.font(for: .pageTitle))
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(SceneText("Template")).font(WorkbenchTypography.font(for: .cardTitle))
                    ForEach(client.templates) { template in templateOption(template) }
                    if client.templates.isEmpty {
                        Text(SceneText("No supported templates are available.")).font(.callout)
                        Button(SceneText("Retry")) { Task { await client.loadInventory() } }
                    }
                    if let inventoryError = client.inventoryError { Text(inventoryError).font(.callout) }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(SceneText("Name")).font(WorkbenchTypography.font(for: .help))
                        TextField(SceneText("Scene name"), text: $draft.name).textFieldStyle(.roundedBorder)
                            .focused($nameFocused).accessibilityLabel(SceneText("Name"))
                            .accessibilityIdentifier("scenes.creation.name")
                        if !draft.name.isEmpty && !SceneInput.validText(draft.name, maximum: 120) {
                            Text(SceneText("Enter a name of 1–120 characters.")).font(.callout)
                        }
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text(SceneText("Time Zone")).font(WorkbenchTypography.font(for: .help))
                        TextField("Asia/Shanghai", text: $draft.timezone).textFieldStyle(.roundedBorder)
                            .accessibilityLabel(SceneText("Time Zone"))
                        Text(SceneText("Uses your local IANA time zone by default, for example Asia/Shanghai."))
                            .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                        if TimeZone(identifier: SceneInput.clean(draft.timezone)) == nil {
                            Text(SceneText("Invalid time zone")).font(.callout)
                        }
                    }
                    if let error { Label(error, systemImage: "exclamationmark.triangle").font(.callout).textSelection(.enabled) }
                    if uncertain {
                        Button(SceneText("Check scene list")) { Task { await client.loadInventory() } }
                        Text(SceneText("Names are not unique. Check the scene list before creating again."))
                            .font(.callout)
                        ForEach(client.scenes.prefix(5)) { scene in
                            Text(scene.name + " · " + scene.createdAt).font(.callout).textSelection(.enabled)
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).disabled(pending)
            }
            HStack {
                Spacer()
                Button(SceneText("Cancel")) { cancel() }.keyboardShortcut(.cancelAction).disabled(pending)
                Button(pending ? SceneText("Creating…") : SceneText("Create")) { create() }
                    .keyboardShortcut(.defaultAction).buttonStyle(.borderedProminent)
                    .disabled(!valid || pending || uncertain).accessibilityIdentifier("scenes.creation.submit")
            }
        }
        .padding(24).frame(minWidth: 280, idealWidth: 480, maxWidth: 480, minHeight: 320, idealHeight: 540, maxHeight: 620)
        .interactiveDismissDisabled(pending || hasChanges)
        .onAppear { initialSelection = selectedTemplate; initialTimezone = draft.timezone; nameFocused = true }
        .confirmationDialog(SceneText("Discard this scene draft?"), isPresented: $confirmsDiscard) {
            Button(SceneText("Discard"), role: .destructive) { dismiss() }
            Button(SceneText("Keep editing"), role: .cancel) {}
        }
    }
    private func templateOption(_ template: SceneTemplateSummary) -> some View {
        let supported = SceneKind(templateID: template.templateId, version: template.version) != .unsupported
        return Button {
            draft.templateId = template.templateId; draft.templateVersion = template.version
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: template.id == selectedTemplate ? "largecircle.fill.circle" : "circle")
                VStack(alignment: .leading, spacing: 4) {
                    Text(template.title).font(WorkbenchTypography.font(for: .cardTitle))
                    Text(template.description).font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                    if template.templateId == "fitness-planner" {
                        Text(SceneText("Current interface: manual measurements")).font(.callout).foregroundStyle(.secondary)
                    }
                    if !supported { Text(SceneText("Unsupported template version")).font(.callout) }
                }
                Spacer(minLength: 0)
            }.padding(8).frame(maxWidth: .infinity, alignment: .leading)
                .background(template.id == selectedTemplate ? Color.primary.opacity(0.07) : .clear, in: RoundedRectangle(cornerRadius: 7))
                .contentShape(Rectangle())
        }.buttonStyle(.plain).disabled(!supported || pending)
            .accessibilityAddTraits(template.id == selectedTemplate ? .isSelected : [])
    }
    private var hasChanges: Bool {
        !draft.name.isEmpty || initialSelection.map { $0 != selectedTemplate } == true
            || initialTimezone.map { $0 != draft.timezone } == true
    }
    private func cancel() {
        if hasChanges { confirmsDiscard = true } else { dismiss() }
    }
    private func create() {
        guard valid, !pending, !uncertain else { return }
        pending = true; error = nil
        let snapshot = draft
        Task {
            do {
                let created = try await client.createScene(snapshot)
                didCreate(created); dismiss()
            } catch {
                uncertain = (error as? SceneRequestError)?.uncertain ?? false
                self.error = uncertain ? SceneText("Creation not confirmed. Check the scene list before creating again.") : error.localizedDescription
            }
            pending = false
        }
    }
}
