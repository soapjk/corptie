import SwiftUI
import CorptieClientCore

struct ClientDeviceInventory: Decodable {
    struct Device: Decodable, Identifiable {
        let id: String
        let name: String
        let revoked: Bool
        let permissions: [String]?
    }
    struct Pending: Decodable, Identifiable {
        let pairingId: String
        let name: String
        var id: String { pairingId }
    }
    let devices: [Device]
    let pending: [Pending]
}

struct ClientDeviceInvite: Decodable {
    let pairingId: String
    let pairingSecret: String
    let expiresAt: Double
    let serverId: String
}

enum LocalDeviceAdminClient {
    static func request(dataRoot: String, action: String? = nil, body: [String: String]? = nil,
                        approved: Bool? = nil, permissions: [String]? = nil) async throws -> Data {
        let endpoint = await CorptieAppEnvironment.backendEndpoint
        guard endpoint.isLoopback else { throw ClientConnectionError.outsideEndpoint }
        let secretURL = URL(fileURLWithPath: dataRoot, isDirectory: true)
            .appendingPathComponent("client-devices/admin-token")
        let secret = try await Task.detached {
            try String(contentsOf: secretURL, encoding: .utf8)
        }.value
        let transport = try BackendTransport(endpoint: endpoint, bearerToken: secret)
        var request = try endpoint.request(path: ["internal", "client-devices"] + (action.map { [$0] } ?? []))
        if action != nil {
            request.httpMethod = "POST"
            var value: [String: Any] = body ?? [:]
            if let approved { value["approved"] = approved }
            if let permissions { value["permissions"] = permissions }
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: value)
        }
        let (data, _) = try await transport.data(for: request)
        return data
    }
}

/// Local management only; never enables a listener implicitly or stores credentials in preferences.
struct ClientDevicesSettingsView: View {
    @ObservedObject private var backendClient = BackendClient.shared
    @State private var inventory: ClientDeviceInventory?
    @State private var invite: ClientDeviceInvite?
    @State private var busy = false
    @State private var message: String?
    @State private var confirmation: Action?
    private struct Action: Identifiable {
        let id: String
        let name: String
        let revoke: Bool
        var permissions: [String]? = nil
    }

    var body: some View {
        Form {
            Section("iPad 与其他设备") {
                Text("配对设备默认仅能读取列表。你可以为指定设备授予消息读取、发送与停止权限；远程文件访问暂未开放。")
                    .font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("刷新设备") { Task { await refresh() } }
                    Button("生成一次性配对信息") { Task { await generateInvite() } }
                        .disabled(inventory == nil)
                    if busy { ProgressView().controlSize(.small) }
                }
                if let message { Text(message).font(.callout).foregroundStyle(.secondary) }
                if let invite {
                    DevicePairingQRCodeView(invite: invite).id(invite.pairingId)
                    DisclosureGroup("一次性配对信息（请勿公开分享）") {
                        Text("服务器标识：\(invite.serverId)").textSelection(.enabled)
                        Text("申请 ID：\(invite.pairingId)").textSelection(.enabled)
                        Text("配对密钥：\(invite.pairingSecret)").textSelection(.enabled)
                        Text("有效期至 \(Date(timeIntervalSince1970: invite.expiresAt / 1000).formatted(date: .omitted, time: .standard))")
                        Text("在另一设备提交申请后，点击刷新，再核对设备并批准。连接地址与受信任 TLS 证书须事先配置。")
                            .foregroundStyle(.secondary)
                    }.font(.caption)
                }
            }
            if let inventory {
                Section("待批准") {
                    if inventory.pending.isEmpty { Text("暂无配对申请").foregroundStyle(.secondary) }
                    ForEach(inventory.pending) { item in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(item.name)
                                Text(item.pairingId).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            Button("拒绝") { Task { await decide(item.pairingId, approved: false) } }
                            Button("批准") { confirmation = Action(id: item.pairingId, name: item.name, revoke: false) }
                        }
                    }
                }
                Section("已配对设备") {
                    if inventory.devices.isEmpty { Text("暂无已配对设备").foregroundStyle(.secondary) }
                    ForEach(inventory.devices) { item in
                        HStack {
                            VStack(alignment: .leading) {
                                Text(item.name)
                                Text(item.id).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if item.revoked { Text("已撤销").foregroundStyle(.secondary) }
                            else {
                                Menu("权限") {
                                    Button("仅列表") { confirmation = Action(id: item.id, name: item.name, revoke: false, permissions: ["inventory.read"]) }
                                    Button("四个页面与消息只读") { confirmation = Action(id: item.id, name: item.name, revoke: false, permissions: ["inventory.read", "control.read", "messages.read"]) }
                                    Button("四个页面，允许消息发送与停止") { confirmation = Action(id: item.id, name: item.name, revoke: false, permissions: ["inventory.read", "control.read", "messages.read", "messages.write", "sessions.stop"]) }
                                }
                                .help((item.permissions ?? ["inventory.read"]).joined(separator: ", "))
                                Button("撤销", role: .destructive) { confirmation = Action(id: item.id, name: item.name, revoke: true) }
                            }
                        }
                    }
                }
            }
        }
        .formStyle(.grouped)
        .disabled(busy)
        .task(id: backendClient.settings?.dataRoot) { await refresh() }
        .onDisappear { invite = nil }
        .alert(confirmation?.permissions != nil ? "更改设备权限？" : (confirmation?.revoke == true ? "撤销设备访问？" : "批准设备访问？"),
               isPresented: Binding(get: { confirmation != nil }, set: { if !$0 { confirmation = nil } })) {
            if let action = confirmation {
                Button("取消", role: .cancel) { confirmation = nil }
                Button(action.permissions != nil ? "确认更改" : (action.revoke ? "撤销" : "批准")) {
                    confirmation = nil
                    Task {
                        if let permissions = action.permissions { await setPermissions(action.id, permissions) }
                        else if action.revoke { await revoke(action.id) }
                        else { await decide(action.id, approved: true) }
                    }
                }
            }
        } message: {
            Text("\(confirmation?.name ?? "")\n\(confirmation?.id ?? "")\n" +
                 (confirmation?.permissions.map { "将替换为以下权限：\($0.joined(separator: ", "))。现有连接会关闭；消息写入权限允许设备通过此 Mac 执行会话操作。" }
                  ?? (confirmation?.revoke == true ? "设备将失去访问权限，现有连接也会关闭。" : "仅批准你正在配对的设备。它将能够读取此服务器的工作与会话列表。")))
        }
    }

    private func perform(_ operation: (String) async throws -> Void) async {
        guard !busy else { return }
        guard let root = backendClient.settings?.dataRoot, !root.isEmpty else {
            message = "等待后端设置加载。"; return
        }
        busy = true
        defer { busy = false }
        do { try await operation(root); message = nil }
        catch {
            inventory = nil
            invite = nil
            message = "设备接入未启用或授权不可用。只读预览不会开启此功能；需先配置 HTTPS 入口。"
        }
    }
    private func refresh() async {
        await perform { root in
            inventory = try JSONDecoder().decode(ClientDeviceInventory.self,
                from: await LocalDeviceAdminClient.request(dataRoot: root))
        }
    }
    private func generateInvite() async {
        await perform { root in
            invite = try JSONDecoder().decode(ClientDeviceInvite.self,
                from: await LocalDeviceAdminClient.request(dataRoot: root, action: "invite"))
        }
    }
    private func decide(_ id: String, approved: Bool) async {
        await perform { root in
            _ = try await LocalDeviceAdminClient.request(dataRoot: root, action: "approve", body: ["pairingId": id], approved: approved)
            inventory = try JSONDecoder().decode(ClientDeviceInventory.self, from: await LocalDeviceAdminClient.request(dataRoot: root))
        }
    }
    private func revoke(_ id: String) async {
        await perform { root in
            _ = try await LocalDeviceAdminClient.request(dataRoot: root, action: "revoke", body: ["deviceId": id])
            inventory = try JSONDecoder().decode(ClientDeviceInventory.self, from: await LocalDeviceAdminClient.request(dataRoot: root))
        }
    }
    private func setPermissions(_ id: String, _ permissions: [String]) async {
        await perform { root in
            _ = try await LocalDeviceAdminClient.request(dataRoot: root, action: "permissions", body: ["deviceId": id], permissions: permissions)
            inventory = try JSONDecoder().decode(ClientDeviceInventory.self, from: await LocalDeviceAdminClient.request(dataRoot: root))
        }
    }
}
