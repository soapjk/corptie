import CorptieClientCore
import Foundation
import CryptoKit
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
    let lastCheckedAt: String?
    let lastCheckStatus: String
    let lastErrorCode: String?
    let observedToolNames: [String]
    let sourceKind: String?
    let sourceLocator: String?
    let sourceRevision: String?
    let packageHash: String?
    let configRevision: Int
    let hasCredentials: Bool
    let credentialNames: [String]
    var id: String { serverId }
}

private struct McpCredentialInput: Identifiable {
    let id = UUID()
    var name = ""
    var value = ""

    init(name: String = "", value: String = "") {
        self.name = name
        self.value = value
    }
}

private struct McpCredentialFields: View {
    let kind: String
    @Binding var rows: [McpCredentialInput]

    var body: some View {
        Section(kind == "stdio" ? "环境变量（存入 macOS Keychain）" : "请求 Header（存入 macOS Keychain）") {
            ForEach($rows) { $row in
                HStack {
                    TextField(kind == "stdio" ? "变量名" : "Header 名称", text: $row.name)
                        .accessibilityLabel(kind == "stdio" ? "环境变量名" : "请求 Header 名称")
                    SecureField("凭证值", text: $row.value)
                        .accessibilityLabel("凭证值：\(row.name.isEmpty ? "未命名" : row.name)")
                    Button {
                        rows.removeAll(where: { $0.id == row.id })
                    } label: {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("删除 \(row.name.isEmpty ? "未命名" : row.name) 凭证")
                }
            }
            Button("添加\(kind == "stdio" ? "环境变量" : "请求 Header")") {
                rows.append(McpCredentialInput())
            }
            .disabled(rows.count >= 16)
            Text("凭证值不会显示在 Server 列表或配置编辑页。")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

private func mcpCredentialConfig(_ rows: [McpCredentialInput], transport: String) -> [String: Any] {
    guard !rows.isEmpty else { return [:] }
    return [transport == "stdio" ? "env" : "headers":
        Dictionary(rows.map { ($0.name.trimmingCharacters(in: .whitespaces), $0.value) },
                   uniquingKeysWith: { first, _ in first })]
}

private func validMcpCredentials(_ rows: [McpCredentialInput], transport: String) -> Bool {
    guard rows.count <= 16 else { return false }
    let names = rows.map { $0.name.trimmingCharacters(in: .whitespaces) }
    let normalized = transport == "stdio" ? names : names.map { $0.lowercased() }
    return Set(normalized).count == rows.count
        && rows.allSatisfy { !$0.name.trimmingCharacters(in: .whitespaces).isEmpty && !$0.value.isEmpty }
}

private struct McpServerListEnvelope: Decodable { let servers: [ManagedMcpServer] }
private struct McpServerEnvelope: Decodable { let server: ManagedMcpServer }
private struct McpDeletionImpactEnvelope: Decodable {
    struct Impact: Decodable {
        struct AssignedAgent: Decodable { let agentId: String; let name: String }
        let serverId: String
        let canRemove: Bool
        let assignedAgents: [AssignedAgent]
        let managedPackageCopies: Int
        let credentialReferences: Int
        let originalSourceWillBeDeleted: Bool
    }
    let impact: Impact
}
private struct McpRuntimeEventsEnvelope: Decodable {
    struct Event: Decodable, Identifiable {
        let eventId: String
        let logicalSessionId: String?
        let bindingId: String?
        let stage: String
        let status: String
        let errorCode: String?
        let toolName: String?
        let toolCount: Int?
        let createdAt: String
        var id: String { eventId }
    }
    let events: [Event]
}
private struct McpAssignmentListEnvelope: Decodable {
    struct Detail: Decodable {
        let serverId: String
        let hasOwnCredentials: Bool
        let credentialNames: [String]
        let toolAllowlist: [String]?
    }
    let serverIds: [String]
    let assignments: [Detail]
}
private struct McpAssignmentCredentialTarget: Identifiable {
    let server: ManagedMcpServer
    let agentId: String
    let agentName: String
    let detail: McpAssignmentListEnvelope.Detail?
    var id: String { "\(agentId):\(server.serverId)" }
}
private struct McpAssignmentToolTarget: Identifiable {
    let server: ManagedMcpServer
    let agentId: String
    let agentName: String
    let toolAllowlist: [String]?
    var id: String { "\(agentId):\(server.serverId)" }
}
private struct McpAssignmentEnvelope: Decodable {
    struct Assignment: Decodable { let serverId: String; let assigned: Bool }
    let assignment: Assignment
}
private struct McpVerificationEnvelope: Decodable {
    struct Verification: Decodable { let toolCount: Int; let toolNames: [String] }
    let verification: Verification
}
private struct McpPackageDiscoveryEnvelope: Decodable {
    struct Discovery: Decodable {
        struct Candidate: Decodable, Identifiable {
            let serverName: String
            let transport: String
            let requiresConfiguration: Bool
            let credentialNames: [String]
            let command: String?
            let args: [String]
            let url: String?
            var id: String { serverName }
        }
        let sourceType: String
        let source: String
        let sourceRevision: String?
        let descriptorPath: String
        let contentHash: String
        let candidates: [Candidate]
    }
    let discovery: Discovery
}

private struct McpPackageVersionsEnvelope: Decodable {
    struct Version: Decodable, Identifiable {
        let revision: Int
        let current: Bool
        let transport: String
        let sourceKind: String
        let sourceLocator: String?
        let sourceRevision: String?
        let packageHash: String?
        let credentialNames: [String]
        let credentialsAvailable: Bool
        let retainedAt: String
        var id: Int { revision }
    }
    let versions: [Version]
}

private struct McpSessionAvailabilityEnvelope: Decodable {
    struct Availability: Decodable {
        struct Server: Decodable, Identifiable {
            let serverName: String
            let serverLabel: String
            let domainId: String
            let available: Bool
            let errorCode: String?
            let toolNames: [String]
            var id: String { domainId }
        }
        struct DeclaredSkill: Decodable { let skillId: String; let name: String }
        struct Receipt: Decodable {
            let status: String
            let errorCode: String?
            let toolName: String?
            let createdAt: String
        }
        struct StandaloneAssignment: Decodable, Identifiable {
            let serverId: String
            let name: String
            let lastToolsList: Receipt?
            let lastSessionCall: Receipt?
            var id: String { serverId }
        }
        let sessionName: String
        let agentId: String?
        let bindingId: String?
        let status: String
        let errorCode: String?
        let toolHostStatus: String
        let servers: [Server]
        let declaredSkills: [DeclaredSkill]?
        let standaloneAssignments: [StandaloneAssignment]?
    }
    let availability: Availability
}

@MainActor
private final class McpManagementModel: ObservableObject {
    @Published private(set) var servers: [ManagedMcpServer] = []
    @Published private(set) var assignedIDs: Set<String> = []
    @Published private(set) var assignmentDetails: [String: McpAssignmentListEnvelope.Detail] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var isWorking = false
    @Published private(set) var isDiagnosing = false
    @Published var errorMessage: String?

    private let baseURL = CorptieAppEnvironment.backendBaseURL
    private let decoder = JSONDecoder()
    private var loadGeneration = UUID()

    func load(agentId: String?) async {
        let generation = UUID()
        loadGeneration = generation
        isLoading = true
        defer { if loadGeneration == generation { isLoading = false } }
        do {
            let loadedServers = try await request("mcp-servers", as: McpServerListEnvelope.self).servers
            let loadedAssignments: Set<String>
            let loadedDetails: [String: McpAssignmentListEnvelope.Detail]
            if let agentId {
                let response = try await request(
                    "agents/\(agentId)/mcp-servers", as: McpAssignmentListEnvelope.self
                )
                loadedAssignments = Set(response.serverIds)
                loadedDetails = Dictionary(uniqueKeysWithValues: response.assignments.map { ($0.serverId, $0) })
            } else {
                loadedAssignments = []
                loadedDetails = [:]
            }
            guard loadGeneration == generation else { return }
            servers = loadedServers
            assignedIDs = loadedAssignments
            assignmentDetails = loadedDetails
            errorMessage = nil
        } catch {
            if loadGeneration == generation { errorMessage = error.localizedDescription }
        }
    }

    func check(_ server: ManagedMcpServer, agentId: String?) async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await request("mcp-servers/\(server.serverId)/verify", method: "POST",
                                  as: McpServerEnvelope.self)
            await load(agentId: agentId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func install(config: [String: Any], agentId: String?, installRequestId: String) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            var body = config
            body["installRequestId"] = installRequestId
            let result = try await request("mcp-servers", method: "POST", body: body,
                                           as: McpServerEnvelope.self)
            await load(agentId: agentId)
            OperationNotificationManager.shared.complete(.init(category: .mcp, outcome: .succeeded, name: "MCP installation"))
            return true
        } catch {
            OperationNotificationManager.shared.complete(.init(category: .mcp, outcome: OperationNotificationOutcome.errorOutcome(error), name: "MCP installation"))
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

    func discoverPackage(sourceType: String, source: String) async -> McpPackageDiscoveryEnvelope.Discovery? {
        isWorking = true
        defer { isWorking = false }
        do {
            let result = try await request("mcp-servers/discover", method: "POST",
                                           body: ["sourceType": sourceType, "source": source],
                                           as: McpPackageDiscoveryEnvelope.self)
            errorMessage = nil
            return result.discovery
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func installPackage(sourceType: String, source: String, serverName: String, contentHash: String,
                        sourceRevision: String?,
                        agentId: String?, assignAfterInstall: Bool,
                        credentials: [String: Any], installRequestId: String) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            var body: [String: Any] = [
                "sourceType": sourceType, "source": source, "serverName": serverName,
                "expectedContentHash": contentHash
            ]
            if let sourceRevision { body["expectedSourceRevision"] = sourceRevision }
            body.merge(credentials) { _, new in new }
            body["installRequestId"] = installRequestId
            let result = try await request("mcp-servers/package", method: "POST", body: body,
                                           as: McpServerEnvelope.self)
            var assignmentFailure: String?
            if assignAfterInstall, let agentId {
                do {
                    _ = try await request("agents/\(agentId)/mcp-servers/\(result.server.serverId)",
                                          method: "PUT", as: McpAssignmentEnvelope.self)
                } catch {
                    assignmentFailure = "MCP 已安装，但分配给 Agent 失败：\(error.localizedDescription)"
                }
            }
            await load(agentId: agentId)
            if let assignmentFailure { errorMessage = assignmentFailure }
            OperationNotificationManager.shared.complete(.init(category: .mcp, outcome: assignmentFailure == nil ? .succeeded : .partial, name: "MCP installation"))
            return true
        } catch {
            OperationNotificationManager.shared.complete(.init(category: .mcp, outcome: OperationNotificationOutcome.errorOutcome(error), name: "MCP installation"))
            errorMessage = error.localizedDescription
            return false
        }
    }

    func packageVersions(_ server: ManagedMcpServer) async -> [McpPackageVersionsEnvelope.Version]? {
        do {
            return try await request("mcp-servers/\(server.serverId)/versions",
                                     as: McpPackageVersionsEnvelope.self).versions
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func diagnoseSession(_ reference: String) async -> McpSessionAvailabilityEnvelope.Availability? {
        isDiagnosing = true
        defer { isDiagnosing = false }
        do {
            var components = URLComponents(url: baseURL.appending(path: "mcp-availability"),
                                           resolvingAgainstBaseURL: false)
            components?.queryItems = [URLQueryItem(name: "session", value: reference)]
            guard let url = components?.url else {
                throw EntityLaunchError(message: "无法构造 Session 诊断请求。", code: "INVALID_INPUT")
            }
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse else {
                throw EntityLaunchError(message: "Session 诊断未返回 HTTP 响应。", code: "INVALID_RESPONSE")
            }
            guard (200..<300).contains(http.statusCode) else {
                let envelope = try? decoder.decode(EntityErrorEnvelope.self, from: data)
                throw EntityLaunchError(message: envelope?.displayMessage ?? "Session 诊断失败。",
                                        code: envelope?.code)
            }
            errorMessage = nil
            return try decoder.decode(McpSessionAvailabilityEnvelope.self, from: data).availability
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func updatePackage(_ server: ManagedMcpServer,
                       discovery: McpPackageDiscoveryEnvelope.Discovery,
                       serverName: String, credentials: [String: Any],
                       agentId: String?) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            var body: [String: Any] = [
                "sourceType": discovery.sourceType, "source": discovery.source,
                "serverName": serverName, "expectedContentHash": discovery.contentHash,
                "expectedConfigRevision": server.configRevision
            ]
            if let revision = discovery.sourceRevision { body["expectedSourceRevision"] = revision }
            body.merge(credentials) { _, new in new }
            _ = try await request("mcp-servers/\(server.serverId)/package", method: "POST",
                                  body: body, as: McpServerEnvelope.self)
            await load(agentId: agentId)
            OperationNotificationManager.shared.complete(.init(category: .mcp, outcome: .succeeded, name: "MCP update"))
            return true
        } catch {
            OperationNotificationManager.shared.complete(.init(category: .mcp, outcome: OperationNotificationOutcome.errorOutcome(error), name: "MCP update"))
            errorMessage = error.localizedDescription
            return false
        }
    }

    func rollbackPackage(_ server: ManagedMcpServer, targetRevision: Int,
                         credentials: [String: Any], agentId: String?) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            var body: [String: Any] = ["expectedConfigRevision": server.configRevision,
                                       "targetRevision": targetRevision]
            body.merge(credentials) { _, new in new }
            _ = try await request("mcp-servers/\(server.serverId)/rollback", method: "POST",
                                  body: body, as: McpServerEnvelope.self)
            await load(agentId: agentId)
            OperationNotificationManager.shared.complete(.init(category: .mcp, outcome: .succeeded, name: "MCP rollback"))
            return true
        } catch {
            OperationNotificationManager.shared.complete(.init(category: .mcp, outcome: OperationNotificationOutcome.errorOutcome(error), name: "MCP rollback"))
            errorMessage = error.localizedDescription
            return false
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

    func setAssignmentCredentials(_ server: ManagedMcpServer, agentId: String,
                                  credentials: [String: Any]?, clear: Bool) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            let body = clear ? ["clearCredentials": true] : (credentials ?? [:])
            _ = try await request("agents/\(agentId)/mcp-servers/\(server.serverId)",
                                  method: "PUT", body: body, as: McpAssignmentEnvelope.self)
            await load(agentId: agentId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func setAssignmentToolAllowlist(_ server: ManagedMcpServer, agentId: String,
                                    toolAllowlist: [String]?) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            let value: Any = toolAllowlist.map { $0 as Any } ?? NSNull()
            _ = try await request("agents/\(agentId)/mcp-servers/\(server.serverId)",
                                  method: "PUT", body: ["toolAllowlist": value],
                                  as: McpAssignmentEnvelope.self)
            await load(agentId: agentId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
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

    func update(_ server: ManagedMcpServer, config: [String: Any], agentId: String?) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        do {
            var body = config
            body["expectedConfigRevision"] = server.configRevision
            _ = try await request("mcp-servers/\(server.serverId)", method: "PATCH", body: body,
                                  as: McpServerEnvelope.self)
            await load(agentId: agentId)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
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

    func deletionImpact(_ server: ManagedMcpServer) async -> McpDeletionImpactEnvelope.Impact? {
        isWorking = true
        defer { isWorking = false }
        do {
            return try await request("mcp-servers/\(server.serverId)/deletion-impact",
                                     as: McpDeletionImpactEnvelope.self).impact
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func runtimeEvents(_ server: ManagedMcpServer) async -> [McpRuntimeEventsEnvelope.Event]? {
        do {
            let events = try await request("mcp-servers/\(server.serverId)/runtime-events?limit=50",
                                           as: McpRuntimeEventsEnvelope.self).events
            errorMessage = nil
            return events
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private struct McpRemovalEnvelope: Decodable { let removed: Bool }

    private func request<T: Decodable>(_ path: String, method: String = "GET",
                                        body: [String: Any]? = nil, as type: T.Type) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = method
        if path == "mcp-servers/discover" || path == "mcp-servers/package"
            || (path.hasPrefix("mcp-servers/") && path.hasSuffix("/package")) {
            request.timeoutInterval = 150
        }
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
    @State private var editingServer: ManagedMcpServer?
    @State private var versionedServer: ManagedMcpServer?
    @State private var eventServer: ManagedMcpServer?
    @State private var credentialTarget: McpAssignmentCredentialTarget?
    @State private var toolTarget: McpAssignmentToolTarget?
    @State private var removingServer: ManagedMcpServer?
    @State private var removalImpact: McpDeletionImpactEnvelope.Impact?
    @State private var showRemovalConfirmation = false
    @State private var diagnosticSessionName = ""
    @State private var sessionAvailability: McpSessionAvailabilityEnvelope.Availability?

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
                if model.isLoading {
                    ProgressView().controlSize(.small).accessibilityLabel("正在加载 MCP Server")
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 10)
            HStack {
                TextField("Session 名称或 logical ID", text: $diagnosticSessionName)
                    .accessibilityLabel("要检查 MCP 工具的 Session 名称或 logical ID")
                Button("检查会话工具") {
                    let requested = diagnosticSessionName.trimmingCharacters(in: .whitespacesAndNewlines)
                    Task {
                        let result = await model.diagnoseSession(requested)
                        guard diagnosticSessionName.trimmingCharacters(in: .whitespacesAndNewlines)
                            == requested else { return }
                        sessionAvailability = result
                    }
                }
                .disabled(model.isDiagnosing || diagnosticSessionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if model.isDiagnosing {
                    ProgressView().controlSize(.small).accessibilityLabel("正在检查会话工具")
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
            if let sessionAvailability {
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(sessionAvailability.sessionName)：\(mcpAvailabilityLabel(sessionAvailability.status))")
                        .font(.subheadline.weight(.semibold))
                    Text("Tool Host：\(sessionAvailability.toolHostStatus)")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Agent：\(sessionAvailability.agentId ?? "未绑定") · Binding：\(sessionAvailability.bindingId ?? "未绑定")")
                        .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    if let errorCode = sessionAvailability.errorCode {
                        Text(errorCode).font(.caption).foregroundStyle(.red)
                    }
                    if sessionAvailability.status == "assigned_mcp_unresolved" {
                        Text("已分配 Skill：\((sessionAvailability.declaredSkills ?? []).map(\.name).joined(separator: "、"))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(Array(sessionAvailability.servers.prefix(4))) { server in
                        Text("\(server.serverLabel)：\(mcpServerAvailabilityLabel(server)) · \(server.toolNames.count) 个工具")
                            .font(.caption)
                            .foregroundStyle(server.available ? Color.secondary : Color.red)
                    }
                    ForEach(Array((sessionAvailability.standaloneAssignments ?? []).prefix(4))) { assignment in
                        Text("\(assignment.name)：tools/list \(assignment.lastToolsList?.status ?? "无回执")；本会话调用 \(assignment.lastSessionCall?.status ?? "无回执")\(assignment.lastSessionCall.map { "（\($0.createdAt)）" } ?? "")")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 8)
                .accessibilityElement(children: .combine)
            }
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
                            if server.sourceKind == "local_package" || server.sourceKind == "git_package" {
                                Text(server.sourceKind == "git_package" ? "Git 包" : "本地包")
                                    .font(.caption).foregroundStyle(.secondary)
                            }
                            Text("\(server.toolCount) 个工具").font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            if let selectedAgent, !selectedAgent.isPlatformAssistant {
                                Toggle("分配给 \(selectedAgent.name)", isOn: Binding(
                                    get: { model.assignedIDs.contains(server.serverId) },
                                    set: { value in Task { await model.assign(server, to: selectedAgent.agentId, enabled: value) } }
                                ))
                                .toggleStyle(.checkbox)
                                .disabled(model.isWorking)
                                if model.assignedIDs.contains(server.serverId) {
                                    Menu("分配设置") {
                                        Button("Agent 凭据") {
                                            credentialTarget = McpAssignmentCredentialTarget(
                                                server: server, agentId: selectedAgent.agentId,
                                                agentName: selectedAgent.name,
                                                detail: model.assignmentDetails[server.serverId])
                                        }
                                        Button("工具权限") {
                                            toolTarget = McpAssignmentToolTarget(
                                                server: server, agentId: selectedAgent.agentId,
                                                agentName: selectedAgent.name,
                                                toolAllowlist: model.assignmentDetails[server.serverId]?.toolAllowlist)
                                        }
                                    }
                                    .disabled(model.isWorking)
                                }
                            }
                        }
                        Text(server.transport == "stdio"
                             ? "\(server.command ?? "") \(server.args.joined(separator: " "))"
                             : server.url).font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1).truncationMode(.middle)
                        HStack {
                            Text(server.enabled ? "已启用" : "已禁用")
                                .font(.caption).foregroundStyle(.secondary)
                            Text(server.lastCheckedAt == nil ? "安装时已验证"
                                 : server.lastCheckStatus == "available" ? "最近检测成功" : "最近检测失败")
                                .font(.caption)
                                .foregroundStyle(server.lastCheckStatus == "available" ? Color.green : Color.red)
                                .help(server.lastCheckedAt ?? server.verifiedAt)
                            if let errorCode = server.lastErrorCode {
                                Text(errorCode).font(.caption).foregroundStyle(.secondary)
                            }
                            Text("\(server.assignmentCount) 个 Agent 已分配")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("重新检测") {
                                Task { await model.check(server, agentId: selectedAgent?.agentId) }
                            }
                            .disabled(model.isWorking)
                            Button("运行记录") { eventServer = server }
                                .disabled(model.isWorking)
                            if server.sourceKind == nil || server.sourceKind == "direct" {
                                Button("编辑配置") { editingServer = server }
                                    .disabled(model.isWorking)
                            } else {
                                Button("版本管理") { versionedServer = server }
                                    .disabled(model.isWorking)
                            }
                            Button(server.enabled ? "禁用" : "启用") {
                                Task { await model.setEnabled(server, enabled: !server.enabled,
                                                             agentId: selectedAgent?.agentId) }
                            }
                            .disabled(model.isWorking)
                            Button("删除", role: .destructive) {
                                Task {
                                    guard let impact = await model.deletionImpact(server) else { return }
                                    removingServer = server
                                    removalImpact = impact
                                    showRemovalConfirmation = true
                                }
                            }
                                .disabled(model.isWorking)
                                .help("查看删除影响")
                        }
                        if !server.observedToolNames.isEmpty {
                            Text("已观察工具：\(server.observedToolNames.prefix(3).joined(separator: "、"))")
                                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
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
        .sheet(item: $editingServer) { server in
            McpEditView(model: model, server: server, agentId: selectedAgent?.agentId)
        }
        .sheet(item: $versionedServer) { server in
            McpPackageVersionsView(model: model, server: server, agentId: selectedAgent?.agentId)
        }
        .sheet(item: $eventServer) { server in
            McpRuntimeEventsView(model: model, server: server)
        }
        .sheet(item: $credentialTarget) { target in
            McpAssignmentCredentialView(model: model, target: target)
        }
        .sheet(item: $toolTarget) { target in
            McpAssignmentToolView(model: model, target: target)
        }
        .confirmationDialog("删除 MCP Server？", isPresented: $showRemovalConfirmation) {
            if let server = removingServer, removalImpact?.canRemove == true {
                Button("删除 \(server.name)", role: .destructive) {
                    Task { await model.remove(server, agentId: selectedAgent?.agentId) }
                }
            }
        } message: {
            if let impact = removalImpact, !impact.canRemove {
                Text("无法删除：仍分配给 \(impact.assignedAgents.map(\.name).joined(separator: "、"))。请先解除这些 Agent 的分配。")
            } else if let impact = removalImpact {
                Text("将移除登记及 \(impact.managedPackageCopies) 份受控包副本，并清理 \(impact.credentialReferences) 个凭据引用。不会删除原始来源或外部服务。")
            }
        }
    }
}

private struct McpRuntimeEventsView: View {
    @ObservedObject var model: McpManagementModel
    let server: ManagedMcpServer
    @Environment(\.dismiss) private var dismiss
    @State private var events: [McpRuntimeEventsEnvelope.Event] = []
    @State private var isLoading = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("\(server.name) · 运行记录").font(.title3.bold())
                Spacer()
                Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
            }
            Text("仅记录工具发现与调用状态，不保存参数、返回内容或凭据。")
                .font(.caption).foregroundStyle(.secondary)
            if isLoading {
                ProgressView("正在加载运行记录")
            } else if let error = model.errorMessage {
                Text("加载失败：\(error)").foregroundStyle(.red)
                    .accessibilityLabel("运行记录加载失败：\(error)")
            } else if events.isEmpty {
                ContentUnavailableView("暂无运行记录", systemImage: "list.bullet.rectangle")
            } else {
                List(events) { event in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(event.stage == "tools-list" ? "工具发现" : "工具调用") · \(event.status == "success" ? "成功" : "失败")")
                            .font(.headline)
                        Text("\(event.createdAt)\(event.errorCode.map { " · \($0)" } ?? "")")
                            .font(.caption).foregroundStyle(.secondary)
                        if let toolName = event.toolName {
                            Text("工具：\(toolName)").font(.caption)
                        } else if let toolCount = event.toolCount {
                            Text("工具数：\(toolCount)").font(.caption)
                        }
                        if let session = event.logicalSessionId {
                            Text("Session：\(session)").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .padding(20)
        .frame(width: 620, height: 460)
        .task {
            events = await model.runtimeEvents(server) ?? []
            isLoading = false
        }
    }
}

private struct McpAssignmentCredentialView: View {
    @ObservedObject var model: McpManagementModel
    let target: McpAssignmentCredentialTarget
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [McpCredentialInput]

    init(model: McpManagementModel, target: McpAssignmentCredentialTarget) {
        self.model = model
        self.target = target
        _rows = State(initialValue: (target.detail?.credentialNames ?? []).map {
            McpCredentialInput(name: $0)
        })
    }

    var body: some View {
        Form {
            Text("\(target.server.name) · \(target.agentName)").font(.title3.bold())
            Text("这里的凭据只供此 Agent 使用，会覆盖 Server 安装级凭据。已有秘密不会回填；保存时需填写全部字段的新值。")
                .font(.caption).foregroundStyle(.secondary)
            McpCredentialFields(kind: target.server.transport, rows: $rows)
            if target.detail?.hasOwnCredentials == true {
                Text("当前已有 Agent 专属凭据：\(target.detail?.credentialNames.joined(separator: "、") ?? "")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = model.errorMessage {
                Text("错误：\(error)").foregroundStyle(.red)
            }
            HStack {
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                if target.detail?.hasOwnCredentials == true {
                    Button("清除 Agent 覆盖", role: .destructive) {
                        Task {
                            if await model.setAssignmentCredentials(target.server, agentId: target.agentId,
                                                                    credentials: nil, clear: true) {
                                dismiss()
                            }
                        }
                    }
                    .disabled(model.isWorking)
                    .help("清除后回退到安装级凭据；若安装时未提供凭据，则该 Agent 不使用凭据")
                }
                Button("保存 Agent 凭据") {
                    Task {
                        let credentials = mcpCredentialConfig(rows, transport: target.server.transport)
                        if await model.setAssignmentCredentials(target.server, agentId: target.agentId,
                                                                credentials: credentials, clear: false) {
                            dismiss()
                        }
                    }
                }
                .disabled(model.isWorking || rows.isEmpty
                          || !validMcpCredentials(rows, transport: target.server.transport))
            }
        }
        .padding(20)
        .frame(width: 560)
        .accessibilityLabel("为 \(target.agentName) 设置 \(target.server.name) 的专属 MCP 凭据")
    }
}

private struct McpAssignmentToolView: View {
    @ObservedObject var model: McpManagementModel
    let target: McpAssignmentToolTarget
    @Environment(\.dismiss) private var dismiss
    @State private var mode: String
    @State private var selected: Set<String>

    init(model: McpManagementModel, target: McpAssignmentToolTarget) {
        self.model = model
        self.target = target
        let allowlist = target.toolAllowlist
        _mode = State(initialValue: allowlist == nil ? "all" : allowlist!.isEmpty ? "none" : "selected")
        _selected = State(initialValue: Set(allowlist ?? []).intersection(target.server.observedToolNames))
    }

    var body: some View {
        Form {
            Text("\(target.server.name) · \(target.agentName)").font(.title3.bold())
            Picker("可用工具范围", selection: $mode) {
                Text("全部工具").tag("all")
                Text("仅选中工具").tag("selected")
                Text("暂不允许工具").tag("none")
            }
            .pickerStyle(.segmented)
            Text("保存后立即影响该 Agent 的旧会话；先前目录里的未授权工具名不能继续调用。")
                .font(.caption).foregroundStyle(.secondary)
            if mode == "selected" {
                if target.server.observedToolNames.isEmpty {
                    Text("尚无已观察工具，请先返回 Server 列表重新检测。")
                        .foregroundStyle(.red)
                } else {
                    Text("已选 \(selected.count) / \(target.server.observedToolNames.count) 个工具")
                        .font(.caption).foregroundStyle(.secondary)
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(target.server.observedToolNames, id: \.self) { name in
                                Toggle(name, isOn: Binding(
                                    get: { selected.contains(name) },
                                    set: { enabled in
                                        if enabled { selected.insert(name) }
                                        else { selected.remove(name) }
                                    }
                                ))
                                .toggleStyle(.checkbox)
                            }
                        }
                    }
                    .frame(height: 240)
                }
            }
            if let error = model.errorMessage {
                Text("错误：\(error)").foregroundStyle(.red)
            }
            HStack {
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("保存工具权限") {
                    let allowlist: [String]? = mode == "all" ? nil
                        : mode == "none" ? [] : selected.sorted()
                    Task {
                        if await model.setAssignmentToolAllowlist(target.server, agentId: target.agentId,
                                                                   toolAllowlist: allowlist) {
                            dismiss()
                        }
                    }
                }
                .disabled(model.isWorking || (mode == "selected" && selected.isEmpty))
            }
        }
        .padding(20)
        .frame(width: 560)
        .accessibilityLabel("为 \(target.agentName) 设置 \(target.server.name) 的 MCP 工具权限")
    }
}

private func mcpAvailabilityLabel(_ status: String) -> String {
    switch status {
    case "available": return "可用"
    case "degraded": return "部分 Server 不可用"
    case "no_mcp_assigned": return "未分配 MCP"
    case "no_tools_allowed": return "已分配 MCP，但未授权工具"
    case "assigned_mcp_unresolved": return "已分配但未解析出 MCP"
    case "gateway_available_host_unverified": return "网关可用，Tool Host 待验证"
    case "no_active_binding": return "无活跃会话绑定"
    case "agent_unavailable": return "Agent 不可用"
    default: return "诊断失败"
    }
}

private func mcpServerAvailabilityLabel(_ server: McpSessionAvailabilityEnvelope.Availability.Server) -> String {
    if !server.available { return server.errorCode ?? "不可用" }
    return server.toolNames.isEmpty ? "无授权工具" : "可用"
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
    @State private var verificationFingerprint: String?
    @State private var installMode = "direct"
    @State private var packageSourceType = "local"
    @State private var packageSource = ""
    @State private var packageDiscovery: McpPackageDiscoveryEnvelope.Discovery?
    @State private var selectedServerName = ""
    @State private var assignAfterInstall = false
    @State private var credentialRows: [McpCredentialInput] = []
    @State private var packageCredentialRows: [McpCredentialInput] = []
    @State private var retryFingerprint: String?
    @State private var retryRequestId = UUID().uuidString

    private func installRequestId(for payload: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return UUID().uuidString
        }
        let fingerprint = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        if retryFingerprint != fingerprint {
            retryFingerprint = fingerprint
            retryRequestId = UUID().uuidString
        }
        return retryRequestId
    }

    private var selectedCandidate: McpPackageDiscoveryEnvelope.Discovery.Candidate? {
        packageDiscovery?.candidates.first(where: { $0.serverName == selectedServerName })
    }

    private var packageCredentialsValid: Bool {
        guard let selectedCandidate,
              validMcpCredentials(packageCredentialRows, transport: selectedCandidate.transport) else { return false }
        let supplied = Set(packageCredentialRows.map { $0.name.trimmingCharacters(in: .whitespaces) })
        return selectedCandidate.credentialNames.allSatisfy { supplied.contains($0) }
    }

    private var config: [String: Any] {
        var result: [String: Any]
        if transport == "stdio" {
            result = ["name": name, "transport": transport, "command": command,
                      "args": argumentsText.split(separator: "\n").map(String.init), "cwd": workingDirectory]
        } else {
            result = ["name": name, "transport": transport, "url": url]
        }
        result.merge(mcpCredentialConfig(credentialRows, transport: transport)) { _, new in new }
        return result
    }

    private var configFingerprint: String? {
        guard let data = try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]) else {
            return nil
        }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private var isValid: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty,
              validMcpCredentials(credentialRows, transport: transport) else { return false }
        return transport == "stdio"
            ? !command.trimmingCharacters(in: .whitespaces).isEmpty
              && !workingDirectory.trimmingCharacters(in: .whitespaces).isEmpty
            : !url.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        Form {
            Picker("安装方式", selection: $installMode) {
                Text("直接连接").tag("direct")
                Text("MCP 包").tag("package")
            }
            if installMode == "package" {
                Picker("包来源", selection: Binding(
                    get: { packageSourceType },
                    set: { packageSourceType = $0; packageDiscovery = nil;
                           selectedServerName = ""; packageCredentialRows = [] }
                )) {
                    Text("本地目录").tag("local")
                    Text("Git 仓库").tag("git")
                }
                TextField(packageSourceType == "git" ? "HTTPS Git URL 或本地 Git 目录" : "本地包绝对路径", text: Binding(
                    get: { packageSource },
                    set: { packageSource = $0; packageDiscovery = nil;
                           selectedServerName = ""; packageCredentialRows = [] }
                ))
                Text("包中可以只有 MCP 描述，不需要 SKILL.md。扫描会读取来源；安装时核对内容哈希及 Git 提交，再复制到受控目录并启动选中的 Server 验证工具列表。")
                    .font(.caption).foregroundStyle(.secondary)
                Button("扫描包") {
                    let source = packageSource
                    let sourceType = packageSourceType
                    Task {
                        let discovered = await model.discoverPackage(sourceType: sourceType, source: source)
                        guard packageSource == source && packageSourceType == sourceType else { return }
                        packageDiscovery = discovered
                        selectedServerName = discovered?.candidates.first?.serverName ?? ""
                        packageCredentialRows = discovered?.candidates.first?.credentialNames.map {
                            McpCredentialInput(name: $0)
                        } ?? []
                    }
                }
                .disabled(model.isWorking || packageSource.isEmpty
                          || (packageSourceType == "local" && !packageSource.hasPrefix("/")))
                if let packageDiscovery {
                    Text("描述文件：\(packageDiscovery.descriptorPath)")
                        .font(.caption).foregroundStyle(.secondary)
                    if let revision = packageDiscovery.sourceRevision {
                        Text("Git 提交：\(revision.prefix(12))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Picker("要安装的 MCP Server", selection: Binding(
                        get: { selectedServerName },
                        set: { newName in
                               selectedServerName = newName
                               packageCredentialRows = packageDiscovery.candidates
                                .first(where: { $0.serverName == newName })?.credentialNames.map { fieldName in
                                    McpCredentialInput(name: fieldName)
                                } ?? [] }
                    )) {
                        ForEach(packageDiscovery.candidates) { candidate in
                            Text("\(candidate.serverName) · \(candidate.transport)").tag(candidate.serverName)
                        }
                    }
                    if let selectedCandidate {
                        Text(selectedCandidate.transport == "stdio"
                             ? "启动命令：\(selectedCandidate.command ?? "") \(selectedCandidate.args.joined(separator: " "))"
                             : "连接地址：\(selectedCandidate.url ?? "")")
                            .font(.caption).foregroundStyle(.secondary)
                            .textSelection(.enabled)
                        McpCredentialFields(kind: selectedCandidate.transport, rows: $packageCredentialRows)
                        if selectedCandidate.requiresConfiguration && !packageCredentialsValid {
                            Text("请填写包声明的所有凭证字段后再安装。")
                                .foregroundStyle(.red)
                        }
                    }
                }
            } else {
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
                        TextEditor(text: $argumentsText)
                            .frame(height: 72)
                            .accessibilityLabel("本地 MCP 启动参数，每行一个")
                    }
                    Text("本地程序会在 Corptie 后端进程中启动，安装时只读取工具列表。")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    TextField("MCP URL", text: $url)
                }
                McpCredentialFields(kind: transport, rows: $credentialRows)
                if let verification, verificationFingerprint == configFingerprint {
                    Text("连接成功：\(verification.toolCount) 个工具")
                    Text(verification.toolNames.joined(separator: "、"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error = model.errorMessage {
                Text(error).foregroundStyle(.red)
                    .accessibilityLabel("错误：\(error)")
            }
            HStack {
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                if installMode == "direct" {
                    Button("测试连接") {
                        let requestedConfig = config
                        let requestedFingerprint = configFingerprint
                        Task {
                            let result = await model.verify(config: requestedConfig)
                            guard requestedFingerprint == configFingerprint else { return }
                            verification = result
                            verificationFingerprint = result == nil ? nil : requestedFingerprint
                        }
                    }
                    .disabled(model.isWorking || !isValid)
                }
                Button("安装") {
                    Task {
                        let installed: Bool
                        if installMode == "package", let packageDiscovery {
                            let credentials = mcpCredentialConfig(packageCredentialRows,
                                transport: selectedCandidate?.transport ?? "stdio")
                            var fingerprintInput: [String: Any] = [
                                "sourceType": packageDiscovery.sourceType,
                                "source": packageDiscovery.source,
                                "serverName": selectedServerName,
                                "expectedContentHash": packageDiscovery.contentHash
                            ]
                            if let revision = packageDiscovery.sourceRevision {
                                fingerprintInput["expectedSourceRevision"] = revision
                            }
                            fingerprintInput.merge(credentials) { _, new in new }
                            let requestId = installRequestId(for: fingerprintInput)
                            installed = await model.installPackage(
                                sourceType: packageDiscovery.sourceType,
                                source: packageDiscovery.source, serverName: selectedServerName,
                                contentHash: packageDiscovery.contentHash,
                                sourceRevision: packageDiscovery.sourceRevision,
                                agentId: agentId, assignAfterInstall: assignAfterInstall,
                                credentials: credentials, installRequestId: requestId
                            )
                        } else {
                            let currentConfig = config
                            installed = await model.install(config: currentConfig, agentId: agentId,
                                installRequestId: installRequestId(for: currentConfig))
                        }
                        if installed {
                            dismiss()
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isWorking || (installMode == "package"
                           ? packageDiscovery == nil || !packageCredentialsValid
                           : !isValid))
            }
            if installMode == "package", agentId != nil {
                Toggle("安装后分配给当前 Agent", isOn: $assignAfterInstall)
            }
        }
        .padding(20)
        .frame(width: 540)
        .accessibilityLabel("安装独立 MCP Server")
    }
}

private struct McpEditView: View {
    @ObservedObject var model: McpManagementModel
    let server: ManagedMcpServer
    let agentId: String?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var transport: String
    @State private var url: String
    @State private var command: String
    @State private var argumentsText: String
    @State private var workingDirectory: String
    @State private var credentialAction = "keep"
    @State private var credentialRows: [McpCredentialInput] = []

    init(model: McpManagementModel, server: ManagedMcpServer, agentId: String?) {
        self.model = model
        self.server = server
        self.agentId = agentId
        _name = State(initialValue: server.name)
        _transport = State(initialValue: server.transport)
        _url = State(initialValue: server.url)
        _command = State(initialValue: server.command ?? "")
        _argumentsText = State(initialValue: server.args.joined(separator: "\n"))
        _workingDirectory = State(initialValue: server.cwd ?? "")
    }

    private var config: [String: Any] {
        var result: [String: Any]
        if transport == "stdio" {
            result = ["name": name, "transport": transport, "command": command,
                      "args": argumentsText.split(separator: "\n").map(String.init), "cwd": workingDirectory]
        } else {
            result = ["name": name, "transport": transport, "url": url]
        }
        if credentialAction == "replace" {
            result.merge(mcpCredentialConfig(credentialRows, transport: transport)) { _, new in new }
        } else if credentialAction == "clear" {
            result["clearCredentials"] = true
        }
        return result
    }

    private var canSave: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty,
              !(server.hasCredentials && transport != server.transport && credentialAction == "keep"),
              credentialAction != "replace" || (!credentialRows.isEmpty
                  && validMcpCredentials(credentialRows, transport: transport)) else { return false }
        return transport == "stdio"
            ? command.hasPrefix("/") && workingDirectory.hasPrefix("/")
            : !url.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        Form {
            Text("编辑 \(server.name) 的连接配置").font(.headline)
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
                    TextEditor(text: $argumentsText)
                        .frame(height: 72)
                        .accessibilityLabel("本地 MCP 启动参数，每行一个")
                }
            } else {
                TextField("MCP URL", text: $url)
            }
            if server.hasCredentials {
                Text("当前凭证字段：\(server.credentialNames.joined(separator: "、"))。现有值不会回显。")
                    .font(.caption).foregroundStyle(.secondary)
                Picker("凭证处理", selection: $credentialAction) {
                    Text("保留现有凭证").tag("keep")
                    Text("替换凭证").tag("replace")
                    Text("清除凭证").tag("clear")
                }
            } else {
                Picker("凭证处理", selection: $credentialAction) {
                    Text("不使用凭证").tag("keep")
                    Text("添加凭证").tag("replace")
                }
            }
            if server.hasCredentials && transport != server.transport && credentialAction == "keep" {
                Text("更换传输方式时，请明确选择替换或清除原凭证。")
                    .foregroundStyle(.red)
            }
            if credentialAction == "replace" {
                McpCredentialFields(kind: transport, rows: $credentialRows)
            }
            Text("保存前只进行握手和工具列表验证；验证失败会保留原配置。成功后，已分配 Agent 的旧会话可通过固定 Tool Host 看到更新。")
                .font(.caption).foregroundStyle(.secondary)
            if let error = model.errorMessage {
                Text(error).foregroundStyle(.red)
                    .accessibilityLabel("错误：\(error)")
            }
            HStack {
                Button("取消") { dismiss() }.keyboardShortcut(.cancelAction)
                Spacer()
                Button("验证并保存") {
                    Task {
                        if await model.update(server, config: config, agentId: agentId) {
                            dismiss()
                        }
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(model.isWorking || !canSave)
            }
        }
        .padding(20)
        .frame(width: 540)
    }
}

private struct McpPackageVersionsView: View {
    @ObservedObject var model: McpManagementModel
    let server: ManagedMcpServer
    let agentId: String?
    @Environment(\.dismiss) private var dismiss
    @State private var versions: [McpPackageVersionsEnvelope.Version] = []
    @State private var sourceType: String
    @State private var source: String
    @State private var discovery: McpPackageDiscoveryEnvelope.Discovery?
    @State private var selectedServerName = ""
    @State private var credentialAction = "keep"
    @State private var credentialRows: [McpCredentialInput] = []
    @State private var rollbackRevision = 0
    @State private var rollbackCredentialAction = "keep"
    @State private var rollbackCredentialRows: [McpCredentialInput] = []
    @State private var showRollbackConfirmation = false

    init(model: McpManagementModel, server: ManagedMcpServer, agentId: String?) {
        self.model = model
        self.server = server
        self.agentId = agentId
        _sourceType = State(initialValue: server.sourceKind == "git_package" ? "git" : "local")
        _source = State(initialValue: server.sourceLocator ?? "")
    }

    private var selectedCandidate: McpPackageDiscoveryEnvelope.Discovery.Candidate? {
        discovery?.candidates.first(where: { $0.serverName == selectedServerName })
    }

    private var rollbackVersion: McpPackageVersionsEnvelope.Version? {
        versions.first(where: { $0.revision == rollbackRevision && !$0.current })
    }

    private var canUpdate: Bool {
        guard let selectedCandidate, discovery != nil else { return false }
        if credentialAction == "clear" && selectedCandidate.requiresConfiguration { return false }
        if credentialAction != "replace" { return true }
        let supplied = Set(credentialRows.map { $0.name.trimmingCharacters(in: .whitespaces) })
        return !credentialRows.isEmpty
            && validMcpCredentials(credentialRows, transport: selectedCandidate.transport)
            && selectedCandidate.credentialNames.allSatisfy { supplied.contains($0) }
    }

    private var canRollback: Bool {
        guard let rollbackVersion else { return false }
        return rollbackCredentialAction != "replace"
            || (!rollbackCredentialRows.isEmpty
                && validMcpCredentials(rollbackCredentialRows, transport: rollbackVersion.transport))
    }

    private var updateCredentials: [String: Any] {
        if credentialAction == "clear" { return ["clearCredentials": true] }
        return credentialAction == "replace"
            ? mcpCredentialConfig(credentialRows, transport: selectedCandidate?.transport ?? "stdio") : [:]
    }

    private var rollbackCredentials: [String: Any] {
        rollbackCredentialAction == "replace"
            ? mcpCredentialConfig(rollbackCredentialRows, transport: rollbackVersion?.transport ?? "stdio") : [:]
    }

    var body: some View {
        Form {
            Text("\(server.name) · 包版本管理").font(.headline)
            Text("更新与回滚会先验证工具列表，再切换同一个 Server；已有 Agent 分配保持不变。")
                .font(.caption).foregroundStyle(.secondary)

            Section("安装新版本") {
                Picker("来源", selection: Binding(
                    get: { sourceType },
                    set: { sourceType = $0; discovery = nil; selectedServerName = "" }
                )) {
                    Text("本地目录").tag("local")
                    Text("Git 仓库").tag("git")
                }
                TextField(sourceType == "git" ? "HTTPS Git URL 或本地 Git 目录" : "本地包绝对路径",
                          text: Binding(get: { source },
                                        set: { source = $0; discovery = nil; selectedServerName = "" }))
                Button("扫描新版本") {
                    let requestedSource = source
                    let requestedType = sourceType
                    Task {
                        let result = await model.discoverPackage(sourceType: requestedType,
                                                                 source: requestedSource)
                        guard source == requestedSource && sourceType == requestedType else { return }
                        discovery = result
                        selectedServerName = result?.candidates.first?.serverName ?? ""
                        credentialRows = result?.candidates.first?.credentialNames.map {
                            McpCredentialInput(name: $0)
                        } ?? []
                    }
                }
                .disabled(model.isWorking || source.isEmpty
                          || (sourceType == "local" && !source.hasPrefix("/")))
                if let discovery {
                    Text("已锁定内容哈希：\(discovery.contentHash.prefix(12))")
                        .font(.caption).foregroundStyle(.secondary)
                    if let revision = discovery.sourceRevision {
                        Text("Git 提交：\(revision.prefix(12))")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Picker("包内 MCP Server", selection: Binding(
                        get: { selectedServerName },
                        set: { newName in
                            selectedServerName = newName
                            credentialRows = discovery.candidates.first(where: { $0.serverName == newName })?
                                .credentialNames.map { McpCredentialInput(name: $0) } ?? []
                        }
                    )) {
                        ForEach(discovery.candidates) { candidate in
                            Text("\(candidate.serverName) · \(candidate.transport)").tag(candidate.serverName)
                        }
                    }
                    Picker("凭证处理", selection: $credentialAction) {
                        Text("保留当前凭证").tag("keep")
                        Text("替换凭证").tag("replace")
                        Text("清除凭证").tag("clear")
                    }
                    if credentialAction == "replace", let selectedCandidate {
                        McpCredentialFields(kind: selectedCandidate.transport, rows: $credentialRows)
                    }
                    if credentialAction == "clear" && selectedCandidate?.requiresConfiguration == true {
                        Text("这个版本声明了必需凭证，不能清除后安装。")
                            .foregroundStyle(.red)
                    }
                    Button("验证并更新") {
                        Task {
                            if await model.updatePackage(server, discovery: discovery,
                                                         serverName: selectedServerName,
                                                         credentials: updateCredentials,
                                                         agentId: agentId) { dismiss() }
                        }
                    }
                    .disabled(model.isWorking || !canUpdate)
                }
            }

            Section("回滚至保留版本") {
                if versions.filter({ !$0.current }).isEmpty {
                    Text("暂无可回滚版本。")
                        .foregroundStyle(.secondary)
                } else {
                    Picker("目标版本", selection: Binding(
                        get: { rollbackRevision },
                        set: { newRevision in
                            rollbackRevision = newRevision
                            rollbackCredentialRows = versions.first(where: { $0.revision == newRevision })?
                                .credentialNames.map { McpCredentialInput(name: $0) } ?? []
                        }
                    )) {
                        Text("选择版本").tag(0)
                        ForEach(versions.filter { !$0.current }) { version in
                            Text("v\(version.revision) · \(version.packageHash?.prefix(12) ?? "未知哈希")")
                                .tag(version.revision)
                        }
                    }
                    if let rollbackVersion {
                        Text("来源：\(rollbackVersion.sourceLocator ?? "未知")")
                            .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        Picker("凭证处理", selection: $rollbackCredentialAction) {
                            Text("使用当前可用凭证").tag("keep")
                            Text("提供新凭证").tag("replace")
                        }
                        if rollbackCredentialAction == "replace" {
                            McpCredentialFields(kind: rollbackVersion.transport,
                                                rows: $rollbackCredentialRows)
                        }
                        Button("回滚到 v\(rollbackVersion.revision)", role: .destructive) {
                            showRollbackConfirmation = true
                        }
                        .disabled(model.isWorking || !canRollback)
                    }
                }
            }
            if let error = model.errorMessage {
                Text(error).foregroundStyle(.red)
                    .accessibilityLabel("错误：\(error)")
            }
            Button("关闭") { dismiss() }.keyboardShortcut(.cancelAction)
        }
        .padding(20)
        .frame(width: 620, height: 680)
        .task { versions = await model.packageVersions(server) ?? [] }
        .confirmationDialog("确认回滚 MCP Server？", isPresented: $showRollbackConfirmation) {
            if let rollbackVersion {
                Button("回滚到 v\(rollbackVersion.revision)", role: .destructive) {
                    Task {
                        if await model.rollbackPackage(server, targetRevision: rollbackVersion.revision,
                                                       credentials: rollbackCredentials,
                                                       agentId: agentId) { dismiss() }
                    }
                }
            }
        } message: {
            Text("回滚会重新验证目标版本并切换工具目录，不改变 Server ID 或 Agent 分配。")
        }
    }
}
