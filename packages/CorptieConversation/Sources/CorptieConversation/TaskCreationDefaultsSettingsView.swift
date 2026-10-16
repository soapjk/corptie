import SwiftUI
import CorptieClientCore

/// Same configuration editor on desktop and paired clients; networking stays with the host.
public struct TaskCreationDefaultsSettingsView: View {
    private let load: @MainActor (String?) async throws -> TaskCreationSettings
    private let save: @MainActor (TaskCreationDefaults) async throws -> TaskCreationSettings
    @State private var catalog: TaskCreationSettings?
    @State private var localDraft = TaskCreationDefaults()
    private let externalDraft: Binding<TaskCreationDefaults>?
    private var draft: TaskCreationDefaults {
        get { externalDraft?.wrappedValue ?? localDraft }
        nonmutating set {
            if let externalDraft { externalDraft.wrappedValue = newValue } else { localDraft = newValue }
        }
    }
    @State private var initialized = false
    @State private var busy = false
    @State private var notice = ""
    @State private var loadGeneration = 0

    public init(load: @escaping @MainActor (String?) async throws -> TaskCreationSettings,
                save: @escaping @MainActor (TaskCreationDefaults) async throws -> TaskCreationSettings,
                draft: Binding<TaskCreationDefaults>? = nil) {
        self.load = load; self.save = save; self.externalDraft = draft
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("创建会话默认模型").font(.headline)
            Text("所有新建会话共用，包括 Task、聊天、内部工具与冲突处理；显式选择优先，不修改已有会话。")
                .font(.caption).foregroundStyle(.secondary)
            if catalog?.readOnly == true {
                Text("Development 预览只读：可查看配置，不加载模型或保存修改。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let catalog {
                Picker("Provider", selection: Binding(get: { draft.providerId ?? "" }, set: {
                    draft = TaskCreationDefaults(providerId: $0.isEmpty ? nil : $0)
                })) {
                    Text("跟随默认 Provider").tag("")
                    ForEach(catalog.providers) { provider in
                        Text(provider.available ? provider.name : "\(provider.name)（不可用）")
                            .tag(provider.id).disabled(!provider.available)
                    }
                    if let id = draft.providerId, !catalog.providers.contains(where: { $0.id == id }) {
                        Text("\(id)（不可用）").tag(id)
                    }
                }.accessibilityIdentifier("settings.taskDefaults.provider")
                if draft.providerId != nil && selectedProvider?.supportsModels == true {
                    Picker("模型", selection: Binding(get: { draft.model ?? "" }, set: {
                        draft.model = $0.isEmpty ? nil : $0; draft.reasoningLevel = nil
                    })) {
                        Text("Provider 默认模型").tag("")
                        ForEach(catalog.models) { Text($0.name).tag($0.id) }
                        if let id = draft.model, !catalog.models.contains(where: { $0.id == id }) {
                            Text("\(id)（不可用）").tag(id)
                        }
                    }.accessibilityIdentifier("settings.taskDefaults.model")
                    if selectedProvider?.supportsReasoning == true && draft.model != nil {
                        Picker("推理强度", selection: Binding(get: { draft.reasoningLevel ?? "" }, set: {
                            draft.reasoningLevel = $0.isEmpty ? nil : $0
                        })) {
                            Text("模型默认").tag("")
                            ForEach(reasoningLevels, id: \.self) { Text($0).tag($0) }
                            if let level = draft.reasoningLevel, !reasoningLevels.contains(level) {
                                Text("\(level)（不可用）").tag(level)
                            }
                        }.accessibilityIdentifier("settings.taskDefaults.reasoning")
                    }
                }
                if let provider = selectedProvider, !provider.supportsModels {
                    Text("此 Provider 使用自身默认模型，不支持模型选择。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if catalog.modelError != nil {
                    Text("模型列表暂不可用，已保存的配置不会被清除。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            HStack {
                if externalDraft == nil {
                Button("保存") { Task { await persist() } }
                    .disabled(busy || !initialized || selectedProvider?.available != true)
                }
                Button("重新加载") { Task { await refresh(initial: !initialized) } }.disabled(busy)
                if busy { ProgressView().controlSize(.small) }
            }
            if !notice.isEmpty { Text(notice).font(.caption).foregroundStyle(.secondary) }
        }
        .disabled(busy || catalog?.readOnly == true)
        .task { await refresh(initial: true) }
        .task(id: draft.providerId) {
            if initialized { await refresh(initial: false) }
        }
    }

    private var selectedProvider: TaskCreationSettings.Provider? {
        catalog?.providers.first { $0.id == (draft.providerId ?? catalog?.defaultProviderId) }
    }
    private var reasoningLevels: [String] {
        catalog?.models.first { $0.id == draft.model }?.reasoningLevels ?? []
    }

    @MainActor private func refresh(initial: Bool) async {
        loadGeneration += 1
        let generation = loadGeneration
        busy = true
        defer { if generation == loadGeneration { busy = false } }
        do {
            let result = try await load(initial ? nil : (draft.providerId ?? catalog?.defaultProviderId))
            guard !Task.isCancelled, generation == loadGeneration else { return }
            catalog = result
            if initial { if externalDraft == nil { draft = result.value }; initialized = true }
            notice = ""
        } catch {
            guard !Task.isCancelled, generation == loadGeneration else { return }
            notice = "读取 Provider 设置失败，请重新加载。"
        }
    }
    @MainActor private func persist() async {
        busy = true
        defer { busy = false }
        do {
            catalog = try await save(draft)
            notice = "已保存"
        } catch { notice = "保存失败：请确认 Provider、模型与推理强度仍然可用。" }
    }
}
