import SwiftUI

struct TaskUserSummary: Codable, Hashable {
    let state: String
    let content: Content?

    struct Content: Codable, Hashable {
        let schemaVersion: Int
        let focus: String
        let progress: String
        let intervention: String
        let reason: String
        let nextAction: String
        let sourceRefs: [String]
        let generatedAt: String
        let providerID: String?
        let model: String?
        let basis: Basis
    }

    struct Basis: Codable, Hashable {
        let taskRevision: Int
        let sessionID: String
        let timelineRevision: Int
    }

    func isCurrent(for task: CorptieTask) -> Bool {
        state == "ready" && content?.schemaVersion == 1 && content?.basis.taskRevision == task.revision
    }

    func stateLabel(for task: CorptieTask) -> String {
        switch state {
        case "generating": return "摘要更新中"
        case "failed": return "摘要生成失败"
        case "ready" where isCurrent(for: task): return ""
        default: return content == nil ? "摘要待生成" : "旧摘要 · 待更新"
        }
    }
}

extension CorptieTask {
    var summaryNeedsIntervention: Bool {
        userSummary?.isCurrent(for: self) == true && userSummary?.content?.intervention == "required"
    }
}

/// Same persisted projection for the compact card and the information rail.
/// No network request, transcript access, polling, or per-card observation.
struct TaskSummaryView: View {
    let task: CorptieTask
    var compact = false
    @State private var configuringTask: CorptieTask?

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 7) {
            if !compact {
                HStack {
                    Label("当前摘要", systemImage: "text.alignleft").detailRailSectionLabelStyle()
                    Spacer()
                    Button("摘要设置", systemImage: "gearshape") { configuringTask = task }
                        .labelStyle(.iconOnly).buttonStyle(.borderless).help("自动摘要设置")
                }
            }
            if let summary = task.userSummary, let content = summary.content, content.schemaVersion == 1 {
                if compact {
                    Text(task.summaryNeedsIntervention ? content.nextAction : content.focus)
                        .font(.system(size: 11)).lineLimit(2)
                        .foregroundStyle(task.summaryNeedsIntervention ? Color.orange : Color.secondary)
                } else {
                    Text(content.focus).font(.system(size: 12, weight: .medium))
                    Text(content.progress).font(.system(size: 11)).foregroundStyle(.secondary)
                    if task.summaryNeedsIntervention {
                        Text("需要你：\(content.nextAction)").font(.system(size: 11, weight: .medium)).foregroundStyle(.orange)
                        Text(content.reason).font(.system(size: 10)).foregroundStyle(.secondary)
                    } else if summary.isCurrent(for: task) {
                        Text(content.intervention == "not_required" ? "暂不需要介入" : "是否需要介入尚未明确")
                            .font(.system(size: 10)).foregroundStyle(.secondary)
                    }
                    Text("更新：\(content.generatedAt)")
                        .font(.system(size: 9)).foregroundStyle(.tertiary).lineLimit(1)
                        .help("来源：\(content.sourceRefs.joined(separator: "\n"))")
                }
                if !summary.stateLabel(for: task).isEmpty {
                    Text(summary.stateLabel(for: task)).font(.system(size: 9)).foregroundStyle(.secondary)
                }
            } else if !compact {
                Text(task.userSummary?.stateLabel(for: task) ?? "尚未生成摘要")
                    .font(.system(size: 10)).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(item: $configuringTask) { TaskSummaryPolicySheet(task: $0) }
    }
}

private struct TaskSummaryPolicy: Decodable {
    struct Provider: Decodable, Identifiable {
        let id: String
        let name: String
        let supported: Bool
    }
    let enabled: Bool
    let preview: Bool
    let providerID: String?
    let model: String?
    let providers: [Provider]
}

private struct TaskSummaryPolicySheet: View {
    let task: CorptieTask
    @Environment(\.dismiss) private var dismiss
    @State private var policy: TaskSummaryPolicy?
    @State private var providerID = ""
    @State private var model = ""
    @State private var consent = false
    @State private var busy = false
    @State private var error: String?

    private var supportedProviders: [TaskSummaryPolicy.Provider] {
        policy?.providers.filter(\.supported) ?? []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("自动摘要 · \(task.title)").font(.headline).lineLimit(1)
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            if let policy {
                Text(policy.enabled ? "此 Task 已启用自动摘要" : "此 Task 的自动摘要尚未启用")
                    .font(.subheadline)
                if policy.preview {
                    Text("只读预览：不能启动模型、修改授权或刷新摘要。")
                        .font(.caption).foregroundStyle(.orange)
                }
                Picker("Provider", selection: $providerID) {
                    Text("请选择").tag("")
                    ForEach(supportedProviders) { Text($0.name).tag($0.id) }
                }
                TextField("模型（留空使用 Provider 默认值）", text: $model)
                if supportedProviders.isEmpty {
                    Text("当前没有声明支持无工具后台生成的 Provider。不会降级为可执行工具的会话。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("启用后，仅此 Task 的当前定义、上一份摘要及最近最多 80 条消息的有界内容会自动发送到所选 Provider 当前配置的模型服务；消息可能包含代码或私密内容。生成结果及来源保存在本机，远端保留期限和访问规则由该服务及你的账户配置决定。不会切换到其他 Provider。")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("我同意向所选 Provider 发送上述内容，用于此 Task 的自动摘要", isOn: $consent)
                    .font(.caption)
                HStack {
                    Button("确认启用") { save(enabled: true) }
                        .disabled(policy.preview || busy || !consent || !supportedProviders.contains(where: { $0.id == providerID }))
                    if policy.enabled {
                        Button("停用") { save(enabled: false) }.disabled(policy.preview || busy)
                        Button("刷新摘要") { refreshSummary() }.disabled(policy.preview || busy)
                    }
                    if busy { ProgressView().controlSize(.small) }
                }
            } else {
                ProgressView().controlSize(.small)
            }
            if let error {
                Text(error).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                if policy == nil { Button("重试") { Task { await load() } } }
            }
        }
        .padding(20).frame(width: 460)
        .task(id: task.id) { await load() }
        .onChange(of: providerID) { _, _ in consent = false }
        .onChange(of: model) { _, _ in consent = false }
    }

    private func load() async {
        do {
            let data = try await request(path: "summary-policy")
            let value = try JSONDecoder().decode(TaskSummaryPolicy.self, from: data)
            policy = value
            providerID = value.providerID ?? ""
            model = value.model ?? ""
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func save(enabled: Bool) {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await request(path: "summary-policy", method: "PUT", body: [
                    "enabled": enabled, "providerID": providerID, "model": model,
                    "consentVersion": 1, "confirmed": consent
                ])
                consent = false
                await load()
                await AppStateSyncController.shared.refreshSnapshot()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func refreshSummary() {
        busy = true
        Task { @MainActor in
            defer { busy = false }
            do {
                _ = try await request(path: "summary-refresh", method: "POST", body: [:])
                await AppStateSyncController.shared.refreshSnapshot()
                error = nil
            } catch { self.error = error.localizedDescription }
        }
    }

    private func request(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: CorptieAppEnvironment.backendBaseURL.appending(path: "tasks/\(task.id)/\(path)"))
        request.httpMethod = method
        request.timeoutInterval = 15
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode) else {
            let details = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            throw NSError(domain: "TaskSummary", code: 1, userInfo: [NSLocalizedDescriptionKey: details?["error"] as? String ?? "摘要设置请求失败"])
        }
        return data
    }
}
