import SwiftUI
import CorptieClientCore

/// Explicit actions only. Rendering and appearance never query the Keychain.
struct MacCredentialMigrationSection: View {
    @ObservedObject private var cloud = CloudRemoteAccessController.shared
    @State private var running = false
    @State private var result: String?
    @State private var mcpOperation: Task<Void, Never>?
    var body: some View {
        Section(L10n("本地凭据存储")) {
            Text(L10n("登录凭据保存在仅当前系统用户可读写的本地文件中。同一用户运行的其他程序可能读取这些文件。"))
                .font(.caption).foregroundStyle(.secondary)
            Text(L10n("旧凭据仅在点击导入后读取，macOS 可能要求授权。拒绝授权不会删除原数据。"))
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                if !cloud.signedIn {
                    Button(L10n("导入旧 Cloud 登录")) { Task { await cloud.importLegacyCredentials() } }
                        .disabled(cloud.busy || cloud.restoring)
                }
                Button(L10n("导入旧缓存密钥")) {
                    Task {
                        running = true
                        defer { running = false }
                        do {
                            try await MacCredentialServices.importLegacyCacheKey()
                            result = L10n("密钥已导入；旧记录会在实际访问时验证，尚未完整验证。原密文未修改。")
                        } catch { result = L10n("密钥导入未完成，原数据已保留。") }
                    }
                }
                .disabled(running || !CorptieAppEnvironment.canManageProductionBackend)
                Button(L10n("导入旧 MCP 凭据")) {
                    running = true
                    mcpOperation = Task { await importMcpCredentials() }
                }
                .disabled(running || !CorptieAppEnvironment.canManageProductionBackend)
                if mcpOperation != nil {
                    Button(L10n("停止导入")) {
                        mcpOperation?.cancel()
                        Task { _ = try? await migrationRequest(method: "POST", action: "cancel") }
                    }
                }
            }
            if running { ProgressView().controlSize(.small) }
            if let result { Text(result).font(.caption).textSelection(.enabled) }
            if CorptieAppEnvironment.isDevelopment {
                Text(L10n("开发版不导入正式版的旧缓存密钥。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("local-credential-migration")
        .onDisappear { mcpOperation?.cancel() }
    }

    @MainActor private func migrationRequest(method: String, action: String? = nil) async throws -> MigrationStatus {
        guard let dataRoot = BackendClient.shared.settings?.dataRoot else { throw ClientConnectionError.invalidResponse }
        let token = try await LocalDeviceAdminClient.adminToken(dataRoot: dataRoot)
        let endpoint = CorptieAppEnvironment.backendEndpoint
        guard endpoint.isLoopback else { throw ClientConnectionError.outsideEndpoint }
        var request = try endpoint.request(path: ["mcp-servers", "credential-migration"])
        request.httpMethod = method
        request.timeoutInterval = 15
        if let action {
            request.httpBody = try JSONEncoder().encode(["action": action])
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, _) = try await BackendTransport(endpoint: endpoint, bearerToken: token).data(for: request)
        return try JSONDecoder().decode(MigrationStatus.self, from: data)
    }
    @MainActor private func importMcpCredentials() async {
        defer { running = false; mcpOperation = nil }
        do {
            var state = try await migrationRequest(method: "POST", action: "import")
            while state.state == "importing" {
                result = L10n("正在导入旧 MCP 凭据…")
                try await Task.sleep(for: .seconds(2))
                state = try await migrationRequest(method: "GET")
            }
            result = state.state == "completed"
                ? L10nFormat("MCP import completed: %d migrated, %d missing. The Keychain was unchanged.", state.migrated, state.missing)
                : L10n("MCP 导入未完成；已保存的项目保留，可再次导入或重新配置。")
        } catch is CancellationError {
            _ = try? await migrationRequest(method: "POST", action: "cancel")
            result = L10n("已停止等待；已保存的项目保留。")
        } catch {
            result = L10n("MCP 导入请求失败；未自动重发。可稍后检查或重新配置。")
        }
    }
    private struct MigrationStatus: Decodable {
        let state: String
        let migrated: Int
        let missing: Int
    }
}
