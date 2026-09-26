import Foundation
import SwiftUI

private struct ManagedMcpServer: Decodable, Identifiable {
    let serverId: String
    let name: String
    let url: String
    let transport: String
    let command: String?
    let args: [String]
    let cwd: String?
    let enabled: Bool
    let toolCount: Int
    let assignmentCount: Int
    let verifiedAt: String
    var id: String { serverId }
}

private struct McpServerListEnvelope: Decodable { let servers: [ManagedMcpServer] }
private struct McpServerEnvelope: Decodable { let server: ManagedMcpServer }
private struct McpAssignmentListEnvelope: Decodable { let serverIds: [String] }
private struct McpAssignmentEnvelope: Decodable {
    struct Assignment: Decodable { let serverId: String; let assigned: Bool }
    let assignment: Assignment
}
private struct McpVerificationEnvelope: Decodable {
    struct Verification: Decodable { let toolCount: Int; let toolNames: [String] }
    let verification: Verification
}

@MainActor
private final class McpManagementModel: ObservableObject {
    @Published private(set) var servers: [ManagedMcpServer] = []
    @Published private(set) var assignedIDs: Set<String> = []
    @Published private(set) var isLoading = false
    @Published private(set) var isWorking = false
    @Published var errorMessage: String?

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    private let decoder = JSONDecoder()

    func load(agentId: String?) async {
        isLoading = true
        defer { isLoading = false }
        do {
            servers = try await request("mcp-servers", as: McpServerListEnvelope.self).servers
            if let agentId {
                assignedIDs = Set(try await request(
                    "agents/\(agentId)/mcp-servers", as: McpAssignmentListEnvelope.self
                ).serverIds)
            } else {
                assignedIDs = []
            }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func install(config: [String: Any], agentId: String?) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await request("mcp-servers", method: "POST", body: config,
                                           as: McpServerEnvelope.self)
            await load(agentId: agentId)
            return servers.contains(where: { $0.id == result.server.id })
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func verify(config: [String: Any]) async -> McpVerificationEnvelope.Verification? {
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await request("mcp-servers/verify", method: "POST", body: config,
                                           as: McpVerificationEnvelope.self)
            errorMessage = nil
            return result.verification
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func assign(_ server: ManagedMcpServer, to agentId: String, enabled: Bool) async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await request("agents/\(agentId)/mcp-servers/\(server.serverId)",
                                  method: enabled ? "PUT" : "DELETE", as: McpAssignmentEnvelope.self)
            await load(agentId: agentId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func setEnabled(_ server: ManagedMcpServer, enabled: Bool, agentId: String?) async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await request("mcp-servers/\(server.serverId)", method: "PATCH",
                                  body: ["enabled": enabled], as: McpServerEnvelope.self)
            await load(agentId: agentId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func remove(_ server: ManagedMcpServer, agentId: String?) async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await request("mcp-servers/\(server.serverId)", method: "DELETE",
                                  as: McpRemovalEnvelope.self)
            await load(agentId: agentId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private struct McpRemovalEnvelope: Decodable { let removed: Bool }

    private func request<T: Decodable>(_ path: String, method: String = "GET",
                                        body: [String: Any]? = nil, as type: T.Type) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw EntityLaunchError(message: "MCP 请求未返回 HTTP 响应。", code: "INVALID_RESPONSE")
        }
        guard (200..<300).contains(http.statusCode) else {
            let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
            throw EntityLaunchError(message: envelope?.displayMessage ?? "MCP 操作失败（HTTP \(http.statusCode)）",
                                    code: envelope?.code)
        }
        return try decoder.decode(type, from: data)
    }
}

struct McpManagementView: View {
    let agents: [Agent]
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = McpManagementModel()
    @State private var selectedAgentId = ""
    @State private var isAdding = false
    @State private var removingServer: ManagedMcpServer?
    @State private var showRemovalConfirmation = false

    private var selectedAgent: Agent? { agents.first(where: { $0.agentId == selectedAgentId }) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("MCP Servers").font(.title2.bold())
                Spacer()
                Button("添加 MCP", systemImage: "plus") { isAdding = true }
                    .accessibilityLabel("添加 MCP Server")
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            .padding(20)
            Divider()
            HStack {
                Text("分配给 Agent")
                Picker("Agent", selection: Binding(
                    get: { selectedAgentId },
                    set: { value in
                        selectedAgentId = value
                        Task { await model.load(agentId: value.isEmpty ? nil : value) }
                    }
                )) {
                    Text("选择 Agent").tag("")
                    ForEach(agents.filter { !$0.isPlatformAssistant }, id: \.agentId) { agent in
                        Text(agent.name).tag(agent.agentId)
                    }
                }
                .frame(maxWidth: 240)
                Spacer()
                if model.isLoading { ProgressView().controlSize(.small) }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            if let error = model.errorMessage {
                Text(error).foregroundStyle(.red).padding(.horizontal, 20)
                    .accessibilityLabel("错误：\(error)")
            }
            if model.servers.isEmpty && !model.isLoading {
                ContentUnavailableView("暂无 MCP Server", systemImage: "point.3.connected.trianglepath.dotted",
                                       description: Text("添加独立 MCP Server 后，可分配给 Agent 使用。"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(model.servers) { server in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(server.name).font(.headline)
                            Text("\(server.toolCount) 个工具").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            if let selectedAgent, !selectedAgent.isPlatformAssistant {
                                Toggle("分配给 \(selectedAgent.name)", isOn: Binding(
                                    get: { model.assignedIDs.contains(server.serverId) },
                                    set: { value in Task { await model.assign(server, to: selectedAgent.agentId, enabled: value) } }
                                ))
                                .toggleStyle(.checkbox)
                                .disabled(model.isWorking)
                            }
                        }
                        Text(server.transport == "stdio"
                             ? "\(server.command ?? "") \(server.args.joined(separator: " "))"
                             : server.url).font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                        HStack {
                            Text(server.enabled ? "已启用 · 安装时已验证" : "已禁用")
                                .font(.caption).foregroundStyle(server.enabled ? Color.green : Color.secondary)
                            Text("\(server.assignmentCount) 个 Agent 已分配")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button(server.enabled ? "禁用" : "启用") {
                                Task { await model.setEnabled(server, enabled: !server.enabled,
                                                             agentId: selectedAgent?.agentId) }
                            }
                            .disabled(model.isWorking)
                            Button("删除", role: .destructive) {
                                removingServer = server
                                showRemovalConfirmation = true
                            }
                                .disabled(model.isWorking || server.assignmentCount > 0)
                                .help(server.assignmentCount > 0 ? "请先解除所有 Agent 分配" : "删除 MCP Server")
                        }
                    }
                    .padding(.vertical, 6)
                }
            }
        }
        .frame(width: 760, height: 620)
        .task {
            selectedAgentId = agents.first(where: { !$0.isPlatformAssistant })?.agentId ?? ""
            await model.load(agentId: selectedAgent?.agentId)
        }
        .sheet(isPresented: $isAdding) {
            McpInstallView(model: model, agentId: selectedAgent?.agentId)
        }
        .confirmationDialog("删除 MCP Server？", isPresented: $showRemovalConfirmation) {
            if let server = removingServer {
                Button("删除 \(server.name)", role: .destructive) {
                    Task { await model.remove(server, agentId: selectedAgent?.agentId) }
                }
            }
        } message: {
            Text("将移除本地登记。此操作不会删除外部服务。")
        }
    }
}

private struct McpInstallView: View {
    @ObservedObject var model: McpManagementModel
    let agentId: String?
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var url = ""
    @State private var transport = "http"
    @State private var command = ""
    @State private var argumentsText = ""
    @State private var workingDirectory = ""
    @State private var verification: McpVerificationEnvelope.Verification?

    private var config: [String: Any] {
        if transport == "stdio" {
            return ["name": name, "transport": transport, "command": command,
                    "args": argumentsText.split(separator: "\n").map(String.init), "cwd": workingDirectory]
        }
        return ["name": name, "transport": transport, "url": url]
    }

    private var isValid: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return transport == "stdio"
            ? !command.trimmingCharacters(in: .whitespaces).isEmpty
              && !workingDirectory.trimmingCharacters(in: .whitespaces).isEmpty
            : !url.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        Form {
            TextField("名称", text: $name)
            Picker("传输方式", selection: $transport) {
                Text("Streamable HTTP").tag("http")
                Text("SSE").tag("sse")
                Text("本地 stdio").tag("stdio")
            }
            if transport == "stdio" {
                TextField("可执行文件绝对路径", text: $command)
                TextField("工作目录绝对路径", text: $workingDirectory)
                VStack(alignment: .leading) {
                    Text("参数（每行一个，不经过 shell）")
                    TextEditor(text: $argumentsText).frame(height: 72)
                }
                Text("本地程序会在 Corptie 后端进程中启动，安装时只读取工具列表。")
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                TextField("MCP URL", text: $url)
            }
            if let verification {
                Text("连接成功：\(verification.toolCount) 个工具")
                Text(verification.toolNames.joined(separator: "、"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = model.errorMessage {
                Text(error).foregroundStyle(.red)
            }
            HStack {
                Button("取消") { dismiss() }
                Spacer()
                Button("测试连接") {
                    Task { verification = await model.verify(config: config) }
                }
                .disabled(model.isWorking || !isValid)
                Button("安装") {
                    Task {
                        if await model.install(config: config, agentId: agentId) {
                            dismiss()
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isWorking || !isValid)
            }
        }
        .padding(20)
        .frame(width: 540)
        .accessibilityLabel("安装独立 MCP Server")
    }
}
