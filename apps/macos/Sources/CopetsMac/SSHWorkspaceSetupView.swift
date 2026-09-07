import SwiftUI

struct SSHConnectionResource: Decodable, Identifiable, Hashable {
    let connectionId: String
    let label: String
    let hostIdentity: String
    let hostAlias: String
    var id: String { connectionId }
}

struct SSHConnectionsEnvelope: Decodable {
    let connections: [SSHConnectionResource]
    let aliases: [String]
}

struct SSHHostInspection: Decodable {
    struct Target: Decodable {
        let hostname: String
        let port: String
        let user: String
    }
    struct Key: Decodable, Identifiable {
        let algorithm: String
        let fingerprint: String
        var id: String { fingerprint }
    }
    let hostAlias: String
    let target: Target
    let keys: [Key]
}

struct SSHConnectionEnvelope: Decodable {
    let connection: SSHConnectionResource
}

struct SSHWorkspaceObservationEnvelope: Decodable {
    let observation: SSHWorkspaceObservation?
}

struct SSHWorkspaceObservation: Decodable {
    struct Tree: Decodable, Identifiable {
        let path: String
        let headOid: String
        let branchRef: String?
        let detached: Bool
        let locked: Bool
        let prunable: Bool
        var id: String { path }
    }
    let rootPath: String
    let worktrees: [Tree]
    let observedAt: String
}

private struct SSHConfigurationAPIError: Decodable { let error: String }

@MainActor
protocol SSHWorkspaceAPI {
    func listConnections() async throws -> SSHConnectionsEnvelope
    func inspectAlias(_ alias: String) async throws -> SSHHostInspection
    func registerConnection(alias: String, label: String, fingerprint: String) async throws -> SSHConnectionEnvelope
    func registerWorkspace(connectionId: String, rootPath: String) async throws -> WorkspaceRegistrationEnvelope
    func observation(workspaceId: String) async throws -> SSHWorkspaceObservationEnvelope
    func probe(workspaceId: String) async throws -> SSHWorkspaceObservationEnvelope
}

@MainActor
struct SSHWorkspaceHTTPClient: SSHWorkspaceAPI {
    var baseURL = CorptieAppEnvironment.backendBaseURL

    func listConnections() async throws -> SSHConnectionsEnvelope { try await request("ssh/connections") }
    func inspectAlias(_ alias: String) async throws -> SSHHostInspection {
        try await request("ssh/connections/inspect", input: ["hostAlias": alias])
    }
    func registerConnection(alias: String, label: String, fingerprint: String) async throws -> SSHConnectionEnvelope {
        try await request("ssh/connections", input: ["hostAlias": alias, "label": label, "fingerprint": fingerprint])
    }
    func registerWorkspace(connectionId: String, rootPath: String) async throws -> WorkspaceRegistrationEnvelope {
        try await request("ssh/workspaces", input: ["connectionId": connectionId, "rootPath": rootPath])
    }
    func observation(workspaceId: String) async throws -> SSHWorkspaceObservationEnvelope {
        try await request("ssh/workspaces/\(workspaceId)/observation")
    }
    func probe(workspaceId: String) async throws -> SSHWorkspaceObservationEnvelope {
        try await request("ssh/workspaces/\(workspaceId)/probe", input: [:])
    }

    func request<T: Decodable>(_ path: String, input: [String: String]? = nil) async throws -> T {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.timeoutInterval = 30
        if let input {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(input)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(SSHConfigurationAPIError.self, from: data).error) ?? L10n("SSH 配置请求失败")
            throw NSError(domain: "SSHWorkspace", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// Local configuration only. Saving does not connect, copy a repository, or start an Agent.
struct SSHWorkspaceSetupView: View {
    @Binding var workspaceId: String?
    @Environment(\.dismiss) private var dismiss
    @State private var connections: [SSHConnectionResource] = []
    @State private var aliases: [String] = []
    @State private var selectedConnection = ""
    @State private var selectedAlias = ""
    @State private var selectedFingerprint = ""
    @State private var rootPath = ""
    @State private var connectionLabel = ""
    @State private var inspection: SSHHostInspection?
    @State private var errorMessage: String?
    @State private var isBusy = false
    @State private var operation: Task<Void, Never>?
    var client: any SSHWorkspaceAPI = SSHWorkspaceHTTPClient()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n("SSH 远程 Workspace")).font(.title3.bold())
            Form {
                Picker(L10n("SSH 连接"), selection: $selectedConnection) {
                    Text(L10n("请选择连接")).tag("")
                    ForEach(connections) { connection in
                        Text("\(connection.label) · \(connection.hostAlias)").tag(connection.connectionId)
                    }
                }
                .accessibilityIdentifier("ssh.workspace.connection")
                TextField(L10n("远端仓库绝对根目录"), text: $rootPath, prompt: Text("/home/user/project"))
                    .accessibilityIdentifier("ssh.workspace.root")
                Text(L10n("目录是命令工作目录，不是安全沙箱。项目和 Worktree 保留在远端，Provider 与认证保留在本机。"))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                DisclosureGroup(L10n("添加已有 OpenSSH 连接")) {
                    connectionForm
                }
            }
            .formStyle(.grouped)
            .disabled(isBusy)

            Text(L10n("保存仅记录本机配置。尚未验证远端仓库、Provider 工具路由和进程管理，暂不能用于 Work 执行。"))
                .font(.callout).foregroundStyle(.secondary)
                .accessibilityIdentifier("ssh.workspace.availability")
            if let errorMessage {
                Text(errorMessage).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            }
            HStack {
                if isBusy { ProgressView().controlSize(.small) }
                Spacer()
                Button(L10n("取消")) { operation?.cancel(); dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(L10n("保存配置")) { run(saveWorkspace) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(isBusy || selectedConnection.isEmpty || !rootPath.hasPrefix("/"))
                    .accessibilityIdentifier("ssh.workspace.save")
            }
        }
        .padding(24)
        .frame(width: 560)
        .task { await loadConnections() }
        .onDisappear { operation?.cancel() }
        .onChange(of: selectedAlias) { _, _ in inspection = nil; selectedFingerprint = "" }
    }

    private var connectionForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            if aliases.isEmpty {
                Text(L10n("未找到具体 Host 别名。请先在本机 OpenSSH 配置中建立连接并核验主机密钥。"))
                    .font(.caption).foregroundStyle(.secondary)
            } else {
                Picker(L10n("OpenSSH Host"), selection: $selectedAlias) {
                    Text(L10n("请选择 Host" )).tag("")
                    ForEach(aliases, id: \.self) { Text($0).tag($0) }
                }
                Button(L10n("读取本机目标与已信任指纹")) { run(inspectAlias) }
                    .disabled(selectedAlias.isEmpty)
                Text(L10n("读取会由 OpenSSH 解析本机配置，包括已有 Match 条件；此步骤不会连接远端。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let inspection {
                Text("\(inspection.target.user)@\(inspection.target.hostname):\(inspection.target.port)")
                    .font(.callout).textSelection(.enabled)
                Picker(L10n("固定主机公钥"), selection: $selectedFingerprint) {
                    ForEach(inspection.keys) { key in
                        Text("\(key.algorithm) · \(key.fingerprint)").tag(key.fingerprint)
                    }
                }
                TextField(L10n("连接名称"), text: $connectionLabel)
                Button(L10n("保存此指纹的连接")) { run(registerConnection) }
                    .disabled(selectedFingerprint.isEmpty || connectionLabel.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.vertical, 8)
    }

    private func run(_ action: @escaping @MainActor () async throws -> Void) {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        operation = Task { @MainActor in
            defer { isBusy = false }
            do { try await action() }
            catch is CancellationError { }
            catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
        }
    }

    @MainActor private func loadConnections() async {
        isBusy = true
        defer { isBusy = false }
        do {
            let envelope = try await client.listConnections()
            connections = envelope.connections
            aliases = envelope.aliases
            if selectedConnection.isEmpty { selectedConnection = connections.first?.connectionId ?? "" }
        } catch { if !Task.isCancelled { errorMessage = error.localizedDescription } }
    }

    @MainActor private func inspectAlias() async throws {
        let result = try await client.inspectAlias(selectedAlias)
        inspection = result
        selectedFingerprint = result.keys.first?.fingerprint ?? ""
        connectionLabel = result.hostAlias
    }

    @MainActor private func registerConnection() async throws {
        let envelope = try await client.registerConnection(alias: selectedAlias, label: connectionLabel, fingerprint: selectedFingerprint)
        connections.removeAll { $0.connectionId == envelope.connection.connectionId }
        connections.append(envelope.connection)
        selectedConnection = envelope.connection.connectionId
    }

    @MainActor private func saveWorkspace() async throws {
        let registration = try await client.registerWorkspace(connectionId: selectedConnection, rootPath: rootPath)
        await EntityAPIClient.shared.refreshWorkspaces()
        workspaceId = registration.workspace.workspaceId
        dismiss()
    }
}
