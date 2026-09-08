import SwiftUI

private struct FoundationModelConfiguration: Codable, Equatable {
    var mode = "default"
    var providerId = ""
    var model = ""
    var reasoning = ""
    var baseURL = ""
    var hasApiKey = false
}

struct FoundationModelSettingsView: View {
    @EnvironmentObject private var backendClient: BackendClient
    @State private var value = FoundationModelConfiguration()
    @State private var apiKey = ""
    @State private var clearKey = false
    @State private var models: [CodexModel] = []
    @State private var status = ""
    @State private var busy = false
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("底层能力支持的模型设置").font(.headline)
            Text("用于 Task 摘要、帮我写及提交说明等后台文本能力，不改变普通会话模型或任务修改权限。")
                .font(.caption).foregroundStyle(.secondary)
            Picker("模型来源", selection: $value.mode) {
                Text("默认 Provider").tag("default")
                Text("指定 Provider").tag("provider")
                Text("第三方 API").tag("api")
            }.pickerStyle(.segmented)
            if value.mode == "provider" {
                Picker("Provider", selection: Binding(get: { value.providerId }, set: {
                    value.providerId = $0; value.model = ""; value.reasoning = ""; models = []
                })) {
                    Text("请选择").tag("")
                    ForEach(backendClient.agentProviders.filter { $0.supports("background.prompt") }) {
                        Text($0.displayName).tag($0.id)
                    }
                }
                Picker("模型", selection: Binding(get: { value.model }, set: {
                    value.model = $0; value.reasoning = ""
                })) {
                    Text("Provider 默认模型").tag("")
                    ForEach(models) { Text($0.name).tag($0.id) }
                    if !value.model.isEmpty && !models.contains(where: { $0.id == value.model }) {
                        Text(value.model).tag(value.model)
                    }
                }
                Picker("推理强度", selection: $value.reasoning) {
                    Text("模型默认").tag("")
                    ForEach(models.first(where: { $0.id == value.model })?.reasoningLevels ?? [], id: \.self) {
                        Text($0).tag($0)
                    }
                    if !value.reasoning.isEmpty && !(models.first(where: { $0.id == value.model })?.reasoningLevels ?? []).contains(value.reasoning) {
                        Text(value.reasoning).tag(value.reasoning)
                    }
                }
                Text("摘要仍要求 Provider 支持安全的无工具后台执行；不支持时会明确失败，不自动换 Provider。")
                    .font(.caption).foregroundStyle(.secondary)
            } else if value.mode == "api" {
                TextField("OpenAI-compatible Base URL（例如 https://example.com/v1）", text: $value.baseURL)
                TextField("模型 ID", text: $value.model)
                SecureField(value.hasApiKey ? "API Key 已保存，留空保持不变" : "API Key（本地接口可留空）", text: $apiKey)
                Toggle("清除已保存的 API Key", isOn: $clearKey)
                TextField("推理强度（可选，例如 low / medium / high）", text: $value.reasoning)
                Text("兼容 Chat Completions；摘要要求支持 JSON Schema。保存后后台能力按此配置运行，相关任务文本会发送到此地址，不额外发起测试请求。密钥仅保存在本机受限配置文件中，不回显；第三方的数据留存由该服务决定。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            HStack {
                Button("保存") { Task { await save() } }.disabled(busy || !loaded)
                if busy { ProgressView().controlSize(.small) }
                Text(status).font(.caption).foregroundStyle(.secondary)
            }
        }
        .textFieldStyle(.roundedBorder)
        .disabled(busy)
        .task { await load() }
        .task(id: value.mode + ":" + value.providerId) { await loadModels() }
    }

    private var endpoint: URL { CorptieAppEnvironment.backendBaseURL.appending(path: "settings/foundation-model") }

    private func load() async {
        busy = true
        defer { busy = false }
        do {
            let (data, response) = try await URLSession.shared.data(from: endpoint)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            value = try JSONDecoder().decode(FoundationModelConfiguration.self, from: data)
            loaded = true
        } catch { status = "读取模型设置失败" }
    }

    private func loadModels() async {
        guard value.mode == "provider", !value.providerId.isEmpty else { models = []; return }
        let provider = value.providerId
        do {
            let url = CorptieAppEnvironment.backendBaseURL.appending(path: "providers/\(provider)/models")
            let (data, response) = try await URLSession.shared.data(from: url)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let result = try JSONDecoder().decode(CodexModelsResponse.self, from: data)
            guard !Task.isCancelled, value.providerId == provider else { return }
            models = result.models
        } catch {
            guard !Task.isCancelled else { return }
            models = []; status = "模型列表暂不可用，已保存的选择保持不变"
        }
    }

    private func save() async {
        busy = true
        defer { busy = false }
        do {
            var body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(value)) as! [String: Any]
            if clearKey { body["apiKey"] = "" }
            else if !apiKey.isEmpty { body["apiKey"] = apiKey }
            var request = URLRequest(url: endpoint)
            request.httpMethod = "PUT"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                status = (response as? HTTPURLResponse)?.statusCode == 403 ? "只浏览预览模式不能保存设置" : "保存失败，请检查配置"
                return
            }
            value = try JSONDecoder().decode(FoundationModelConfiguration.self, from: data)
            apiKey = ""; clearKey = false; status = "已保存，仅对后台文本能力生效"
        } catch { status = "保存失败" }
    }
}
