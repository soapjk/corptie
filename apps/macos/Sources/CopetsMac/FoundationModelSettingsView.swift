import SwiftUI
import Observation
import CorptieConversation

struct FoundationModelConfiguration: Codable, Equatable {
    var mode = "default"
    var providerId = ""
    var model = ""
    var reasoning = ""
    var baseURL = ""
    var hasApiKey = false
}

@MainActor @Observable
final class FoundationModelDraft {
    var value = FoundationModelConfiguration() { didSet { clearStaleStatus() } }
    var apiKey = "" { didSet { if !apiKey.isEmpty { clearKey = false }; clearStaleStatus() } }
    var clearKey = false { didSet { if clearKey { apiKey = "" }; clearStaleStatus() } }
    var models: [CodexModel] = []
    var status = ""
    var failed = false
    var busy = false
    var loaded = false
    var readOnly = false
    var showValidation = false
    private(set) var savedValue = FoundationModelConfiguration()
    private var modelGeneration = 0
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL = CorptieAppEnvironment.backendBaseURL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    var isDirty: Bool { loaded && (value != savedValue || !apiKey.isEmpty || clearKey) }
    var validationError: String? {
        if value.mode == "provider" && value.providerId.isEmpty { return L10n("Choose a Provider.") }
        guard value.mode == "api" else { return nil }
        guard let url = URLComponents(string: value.baseURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              let host = url.host, !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.scheme == "https" || (url.scheme == "http" && ["localhost", "127.0.0.1", "[::1]", "::1"].contains(host)) else {
            return L10n("Use HTTPS without credentials or query parameters. HTTP is allowed only for localhost.")
        }
        return value.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? L10n("API model is required.") : nil
    }

    private func clearStaleStatus() {
        if loaded && !busy { status = ""; failed = false }
    }

    func discard() {
        value = savedValue
        apiKey = ""
        clearKey = false
        status = ""
        showValidation = false
    }

    private var endpoint: URL { baseURL.appending(path: "settings/foundation-model") }

    func load() async {
        guard !loaded, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let (data, response) = try await session.data(from: endpoint)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            value = try JSONDecoder().decode(FoundationModelConfiguration.self, from: data)
            savedValue = value
            loaded = true
        } catch { status = "读取模型设置失败"; failed = true }
    }

    func loadModels() async {
        modelGeneration += 1
        let generation = modelGeneration
        guard value.mode == "provider", !value.providerId.isEmpty else { models = []; return }
        let provider = value.providerId
        do {
            let url = baseURL.appending(path: "providers/\(provider)/models")
            let (data, response) = try await session.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let result = try JSONDecoder().decode(CodexModelsResponse.self, from: data)
            guard !Task.isCancelled, modelGeneration == generation, value.providerId == provider else { return }
            models = result.models
        } catch {
            guard !Task.isCancelled, modelGeneration == generation else { return }
            models = []; status = "模型列表暂不可用，已保存的选择保持不变"; failed = true
        }
    }

    func save() async {
        showValidation = true
        guard loaded, isDirty, !busy, !readOnly, validationError == nil else { return }
        busy = true
        failed = false
        defer { busy = false }
        do {
            var body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
            if clearKey { body["apiKey"] = "" }
            else if !apiKey.isEmpty { body["apiKey"] = apiKey }
            var request = URLRequest(url: endpoint)
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                failed = true
                readOnly = (response as? HTTPURLResponse)?.statusCode == 403
                status = readOnly ? "只浏览预览模式不能保存设置" : "保存失败，请检查配置"
                return
            }
            value = try JSONDecoder().decode(FoundationModelConfiguration.self, from: data)
            savedValue = value
            apiKey = ""; clearKey = false; status = "已保存，仅对后台文本能力生效"
        } catch { status = "保存失败"; failed = true }
    }
}

struct FoundationModelSettingsView: View {
    @ObservedObject var modelCatalog: ProviderCatalogStore
    @Bindable var draft: FoundationModelDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SettingsSectionHeading(title: "底层能力支持的模型设置", mode: L10n("Saved separately; not included in Save Settings."))
            Text("用于 Task 摘要、帮我写及提交说明等后台文本能力，不改变普通会话模型或任务修改权限。")
                .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
            Group {
                Picker("模型来源", selection: $draft.value.mode) {
                    Text("默认 Provider").tag("default")
                    Text("指定 Provider").tag("provider")
                    Text("第三方 API").tag("api")
                }.pickerStyle(.menu)
                if draft.value.mode == "provider" {
                    Picker("Provider", selection: Binding(get: { draft.value.providerId }, set: {
                        draft.value.providerId = $0; draft.value.model = ""; draft.value.reasoning = ""; draft.models = []
                    })) {
                        Text("请选择").tag("")
                        ForEach(modelCatalog.agentProviders.filter { $0.supports("background.prompt") }) {
                            Text($0.displayName).tag($0.id)
                        }
                    }
                    Picker("模型", selection: Binding(get: { draft.value.model }, set: {
                        draft.value.model = $0; draft.value.reasoning = ""
                    })) {
                        Text("Provider 默认模型").tag("")
                        ForEach(draft.models) { Text($0.name).tag($0.id) }
                        if !draft.value.model.isEmpty && !draft.models.contains(where: { $0.id == draft.value.model }) {
                            Text(draft.value.model).tag(draft.value.model)
                        }
                    }
                    Picker("推理强度", selection: $draft.value.reasoning) {
                        Text("模型默认").tag("")
                        ForEach(draft.models.first(where: { $0.id == draft.value.model })?.reasoningLevels ?? [], id: \.self) {
                            Text($0).tag($0)
                        }
                        if !draft.value.reasoning.isEmpty && !(draft.models.first(where: { $0.id == draft.value.model })?.reasoningLevels ?? []).contains(draft.value.reasoning) {
                            Text(draft.value.reasoning).tag(draft.value.reasoning)
                        }
                    }
                    Text("摘要仍要求 Provider 支持安全的无工具后台执行；不支持时会明确失败，不自动换 Provider。")
                        .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                } else if draft.value.mode == "api" {
                    TextField("OpenAI-compatible Base URL（例如 https://example.com/v1）", text: $draft.value.baseURL)
                        .accessibilityLabel("API Base URL")
                        .accessibilityIdentifier("settings.foundation.baseURL")
                    TextField("模型 ID", text: $draft.value.model)
                    SecureField(draft.value.hasApiKey ? "API Key 已保存，留空保持不变" : "API Key（本地接口可留空）", text: $draft.apiKey)
                    Toggle("清除已保存的 API Key", isOn: $draft.clearKey)
                    if draft.value.baseURL != draft.savedValue.baseURL && draft.value.hasApiKey {
                        Text(L10n("Changing the API address clears the saved key unless you enter a replacement."))
                            .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                    }
                    TextField("推理强度（可选，例如 low / medium / high）", text: $draft.value.reasoning)
                    Text("兼容 Chat Completions；摘要要求支持 JSON Schema。保存后后台能力按此配置运行，相关任务文本会发送到此地址，不额外发起测试请求。密钥仅保存在本机受限配置文件中，不回显；第三方的数据留存由该服务决定。")
                        .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                }
            }
            .disabled(draft.readOnly)
            if draft.readOnly {
                Label(L10n("Read-only preview. Shared settings cannot be saved."), systemImage: "lock")
                    .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
            }
            if draft.isDirty, let error = draft.validationError {
                Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.red)
                    .font(WorkbenchTypography.font(for: .help))
                    .accessibilityIdentifier("settings.foundation.error")
            }
            ViewThatFits(in: .horizontal) {
                HStack { modelActions }
                VStack(alignment: .leading, spacing: 8) { modelActions }
            }
            if !draft.status.isEmpty {
                Label(draft.status, systemImage: draft.failed ? "exclamationmark.circle" : "checkmark.circle")
                    .font(WorkbenchTypography.font(for: .help))
                    .foregroundStyle(draft.failed ? Color.red : Color.secondary)
            }
        }
        .textFieldStyle(.roundedBorder)
        .disabled(draft.busy)
        .task { await draft.load() }
        .task(id: draft.value.mode + ":" + draft.value.providerId) { await draft.loadModels() }
    }

    @ViewBuilder private var modelActions: some View {
        Button(L10n("Save Background Model")) { Task { await draft.save() } }.disabled(draft.busy || !draft.loaded || !draft.isDirty || draft.readOnly || draft.validationError != nil)
            .accessibilityIdentifier("settings.foundation.save")
        if draft.isDirty {
            Button(L10n("Discard Model Changes")) { draft.discard() }
        }
        if !draft.loaded && !draft.busy {
            Button(L10n("Retry")) { Task { await draft.load() } }
        }
        if draft.busy { ProgressView().controlSize(.small) }
    }
}
