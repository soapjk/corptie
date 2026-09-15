import SwiftUI
import CorptieClientCore

struct ClientDeviceInventory: Decodable {
    let state: String?
    let address: String?
    let errorCode: String?
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
    let address: String?
    let certificate: String?
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
        let secret: String?
        do {
            secret = try await Task.detached { try String(contentsOf: secretURL, encoding: .utf8) }.value
        } catch {
            guard action == nil else { throw error }
            secret = nil // Only the unavailable/preview status is public on loopback.
        }
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
    @State private var confirmReset = false
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
            Section("连接手机或 iPad") {
                Text("让同一局域网内的设备访问这台 Mac。扫码验证身份后，仍需你批准；配对默认仅允许读取列表。")
                    .font(.callout).foregroundStyle(.secondary)
                Text(statusText).font(.callout)
                HStack {
                    if inventory?.state == "disabled" || inventory?.state == "error" {
                        Button(inventory?.state == "error" ? "重试开启" : "开启设备接入") { Task { await configure("enable") } }
                            .buttonStyle(.borderedProminent)
                    } else if inventory?.state == "ready" || (inventory != nil && inventory?.state == nil) {
                        Button("配对新设备") { Task { await generateInvite() } }
                        if inventory?.state == "ready" {
                            Button("关闭接入") { Task { await configure("disable") } }
                        }
                    }
                    Button("刷新") { Task { await refresh() } }
                    if busy { ProgressView().controlSize(.small) }
                }
                if let message { Text(message).font(.callout).foregroundStyle(.secondary) }
                if inventory?.state == "error", ["NETWORK_CHANGED", "CERTIFICATE_EXPIRED"].contains(inventory?.errorCode ?? "") {
                    Button("重新配置连接…") { confirmReset = true }
                }
                if let invite {
                    DevicePairingQRCodeView(invite: invite).id(invite.pairingId)
                    DisclosureGroup("一次性配对信息（请勿公开分享）") {
                        Text("服务器标识：\(invite.serverId)").textSelection(.enabled)
                        Text("申请 ID：\(invite.pairingId)").textSelection(.enabled)
                        Text("配对密钥：\(invite.pairingSecret)").textSelection(.enabled)
                        Text("有效期至 \(Date(timeIntervalSince1970: invite.expiresAt / 1000).formatted(date: .omitted, time: .standard))")
                        Text("请只扫描你自己的 Mac 显示的二维码，并核对待批准设备。")
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
        .task(id: invite?.pairingId) {
            guard let invite else { return }
            while !Task.isCancelled && Date().timeIntervalSince1970 * 1000 < invite.expiresAt {
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
                await refresh()
            }
        }
        .onDisappear { invite = nil }
        .alert("重新配置设备连接？", isPresented: $confirmReset) {
            Button("取消", role: .cancel) { }
            Button("重新配置", role: .destructive) { Task { await configure("reset") } }
        } message: {
            Text("将更新本机证书并撤销已配对设备。手机和 iPad 需要重新扫码配对；不会删除工作或会话。")
        }
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
            if (error as NSError).code == NSFileReadNoSuchFileError {
                message = "设备管理尚未就绪。请稍后刷新；只读预览模式不提供设备接入。"
            } else {
                message = "操作未完成，请刷新后重试。若持续失败，请检查后端是否在线。"
            }
        }
    }
    private func refresh() async {
        await perform { root in
            inventory = try JSONDecoder().decode(ClientDeviceInventory.self,
                from: await LocalDeviceAdminClient.request(dataRoot: root))
        }
    }
    private var statusText: String {
        switch inventory?.state {
        case "disabled": return "尚未开启 · 无需手动配置证书"
        case "starting": return "正在准备安全连接…"
        case "initializing": return "后端正在准备设备管理，请稍后刷新。"
        case "preview": return "只读预览模式 · 设备接入已禁用，不会开启局域网监听。"
        case "ready": return inventory?.pending.isEmpty == false ? "等待批准设备" : "已开启 · 可以扫码配对"
        case "error":
            switch inventory?.errorCode {
            case "LOCAL_NETWORK_UNAVAILABLE": return "未找到局域网连接，请连接 Wi-Fi 或以太网后重试。"
            case "NETWORK_CHANGED": return "网络地址已变化，请恢复原网络或重新配置连接。"
            case "CERTIFICATE_EXPIRED": return "设备接入证书已过期，需要更新后重新配对。"
            case "EADDRINUSE": return "接入端口已被占用，请点击重试开启以选择可用端口。"
            default: return "接入服务启动失败，请重试。"
            }
        default: return inventory == nil ? "正在读取设备接入状态…" : "已开启（手动配置）"
        }
    }
    private func configure(_ action: String) async {
        invite = nil
        await perform { root in
            inventory = try JSONDecoder().decode(ClientDeviceInventory.self,
                from: await LocalDeviceAdminClient.request(dataRoot: root, action: action))
        }
        await refresh()
        if action != "disable", inventory?.state == "ready" { await generateInvite() }
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
