import SwiftUI

struct ScenesView: View {
    @EnvironmentObject private var sidebarState: TabSidebarState
    @StateObject private var client = SceneAPIClient()
    @State private var selectedSceneID: String?
    @State private var createDraft: CreateSceneDraft?

    private var selectedScene: SceneInstance? {
        client.scenes.first(where: { $0.id == selectedSceneID })
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $sidebarState.visibility) {
            VStack(spacing: 0) {
                sidebarHeader
                Divider()
                List(client.scenes, selection: $selectedSceneID) { scene in
                    Label(scene.name, systemImage: scene.templateId == "daily-checklist" ? "checklist" : "figure.run")
                        .tag(scene.id)
                }
                .overlay {
                    if client.scenes.isEmpty && !client.isLoading {
                        ContentUnavailableView(L10n("No Scenes"), systemImage: "square.grid.2x2",
                            description: Text(L10n("Create a scene from a template to get started.")))
                    }
                }
            }
        } detail: {
            if let selectedScene {
                SceneDetailView(scene: selectedScene, client: client)
                    .id(selectedScene.id)
            } else if client.isLoading {
                ProgressView().controlSize(.small)
            } else {
                ContentUnavailableView(L10n("Select a Scene"), systemImage: "square.grid.2x2")
            }
        }
        .navigationSplitViewStyle(.balanced)
        .mainWindowPageCard()
        .task { await client.loadInventory(); selectFirstSceneIfNeeded() }
        .onChange(of: selectedSceneID) { _, value in
            guard let value, let scene = client.scenes.first(where: { $0.id == value }) else { return }
            Task { await client.loadScene(scene) }
        }
        .sheet(item: $createDraft) { draft in
            SceneCreationSheet(draft: draft, templates: client.templates) { value in
                if let scene = await client.createScene(value) {
                    selectedSceneID = scene.id
                    await client.loadScene(scene)
                }
            }
        }
        .alert(L10n("Scene Error"), isPresented: Binding(
            get: { client.errorMessage != nil },
            set: { if !$0 { client.clearError() } }
        )) { Button(L10n("OK"), role: .cancel) { client.clearError() } } message: {
            Text(client.errorMessage ?? "")
        }
    }

    private var sidebarHeader: some View {
        HStack(spacing: 8) {
            Text(L10n("Scenes")).font(.headline)
            Spacer()
            Button {
                let templateID = client.templates.first?.templateId ?? "daily-checklist"
                createDraft = CreateSceneDraft(templateId: templateID, name: "")
            } label: {
                Image(systemName: "plus")
            }
            .buttonStyle(.borderless)
            .help(L10n("Create Scene"))
            .accessibilityLabel(L10n("Create Scene"))
            .accessibilityIdentifier("scenes.create")
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
    }

    private func selectFirstSceneIfNeeded() {
        if selectedSceneID == nil { selectedSceneID = client.scenes.first?.id }
    }
}

private struct SceneDetailView: View {
    let scene: SceneInstance
    @ObservedObject var client: SceneAPIClient
    @State private var entry = ""
    @State private var measurementValue = ""
    @State private var measurementUnit = "kg"

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(scene.name).font(.title2.weight(.semibold))
                    Text(scene.templateId == "daily-checklist" ? L10n("Checklist") : L10n("Fitness Plan"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text("r\(scene.instanceRevision)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
            }

            if scene.templateId == "daily-checklist" { checklistComposer } else { measurementComposer }

            if client.isLoading && client.records.isEmpty {
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if client.records.filter({ $0.recordType != "List" }).isEmpty {
                ContentUnavailableView(L10n("No Records"), systemImage: "tray",
                    description: Text(L10n("Add the first record above.")))
            } else {
                List(client.records.filter { $0.recordType != "List" }) { record in
                    SceneRecordRow(scene: scene, record: record, client: client)
                }
                .listStyle(.inset)
            }
        }
        .padding(20)
        .task(id: scene.instanceId) { await client.loadScene(scene) }
    }

    private var checklistComposer: some View {
        HStack {
            TextField(L10n("New checklist item"), text: $entry)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("scenes.checklist.new-item")
                .onSubmit { addChecklistItem() }
            Button(L10n("Add"), action: addChecklistItem).disabled(entry.trimmingCharacters(in: .whitespaces).isEmpty)
        }
    }

    private var measurementComposer: some View {
        HStack {
            TextField(L10n("Metric"), text: $entry).textFieldStyle(.roundedBorder)
            TextField(L10n("Value"), text: $measurementValue).frame(width: 90).textFieldStyle(.roundedBorder)
            TextField(L10n("Unit"), text: $measurementUnit).frame(width: 70).textFieldStyle(.roundedBorder)
            Button(L10n("Record")) {
                guard let value = Double(measurementValue) else { return }
                let metric = entry.trimmingCharacters(in: .whitespacesAndNewlines)
                Task { await client.addMeasurement(metric: metric, value: value, unit: measurementUnit, to: scene) }
                entry = ""; measurementValue = ""
            }
            .disabled(entry.trimmingCharacters(in: .whitespaces).isEmpty || Double(measurementValue) == nil)
        }
    }

    private func addChecklistItem() {
        let title = entry.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { return }
        entry = ""
        Task { await client.addChecklistItem(title: title, to: scene) }
    }
}

private struct SceneRecordRow: View {
    let scene: SceneInstance
    let record: SceneRecord
    @ObservedObject var client: SceneAPIClient

    var body: some View {
        HStack(spacing: 10) {
            if record.recordType == "Item" {
                Button { Task { await client.toggleChecklistItem(record, in: scene) } } label: {
                    Image(systemName: (record.data["completed"]?.boolValue ?? false) ? "checkmark.circle.fill" : "circle")
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n("Toggle completion"))
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(primaryText).strikethrough(record.data["completed"]?.boolValue ?? false)
                if let secondaryText { Text(secondaryText).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
        }
        .accessibilityIdentifier("scene-record.\(record.recordId)")
    }

    private var primaryText: String {
        record.data["title"]?.stringValue ?? record.data["metric"]?.stringValue ?? record.recordType
    }
    private var secondaryText: String? {
        guard let value = record.data["value"]?.numberValue else { return nil }
        return "\(value.formatted()) \(record.data["unit"]?.stringValue ?? "")"
    }
}

private struct SceneCreationSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State var draft: CreateSceneDraft
    let templates: [SceneTemplateSummary]
    let create: (CreateSceneDraft) async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("Create Scene")).font(.title2.weight(.semibold))
            Picker(L10n("Template"), selection: $draft.templateId) {
                ForEach(templates) { template in Text(template.title).tag(template.templateId) }
            }
            TextField(L10n("Name"), text: $draft.name)
            TextField(L10n("Time Zone"), text: $draft.timezone)
            HStack { Spacer(); Button(L10n("Cancel"), role: .cancel) { dismiss() }; Button(L10n("Create")) {
                let value = draft; dismiss(); Task { await create(value) }
            }.keyboardShortcut(.defaultAction).disabled(draft.name.trimmingCharacters(in: .whitespaces).isEmpty) }
        }
        .padding(24)
        .frame(width: 420)
    }
}
