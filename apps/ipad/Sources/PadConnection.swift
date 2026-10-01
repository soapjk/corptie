import Foundation
import Observation
import CorptieClientCore
import CorptieClientSecurity

@MainActor @Observable
final class PadConnection {
    var address = UserDefaults.standard.string(forKey: "serverAddress") ?? ""
    var serverID = UserDefaults.standard.string(forKey: "serverID") ?? ""
    var pairingID = ""
    var secret = ""
    var claim: DevicePairingClaim?
    var connected = false
    var hasSavedPairing = false
    var restoringConnection = true
    private var attemptedStartupConnection = false
    var busy = false
    var notice = ""
    private var endpoint: BackendEndpoint?
    private var credentials: DeviceCredentials?
    var deviceID: String? { credentials?.deviceId }
    private var pairingCertificate: String?
    private let vault = DeviceCredentialVault()
    private var refreshTask: Task<DeviceCredentials, Error>?
    private var cachedTransport: BackendTransport?
    private var cachedToken: String?
    private let transportOverride: BackendTransport?

    init(transportOverride: BackendTransport? = nil) { self.transportOverride = transportOverride }

    func perform(_ operation: () async throws -> Void) async {
        guard !busy else { return }
        busy = true
        notice = ""
        defer { busy = false }
        do { try await operation() }
        catch is CancellationError { }
        catch { notice = Self.explain(error) }
    }

    static func explain(_ error: Error) -> String {
        if let error = error as? DevicePairingFailure {
            switch error.code {
            case "PAIRING_DENIED": return "Mac 已拒绝此设备。请核对设备后重新扫码。"
            case "PAIRING_EXPIRED": return "配对已过期，请重新扫描 Mac 上的二维码。"
            case "PAIRING_NOT_APPROVED": return "等待 Mac 批准设备…"
            default: return "配对信息已失效，请重新扫码。"
            }
        }
        if let error = error as? ClientServiceFailure {
            switch error.code {
            case "INVALID_MESSAGE": return "消息未发送：内容不符合后端要求；当前后端可能尚未支持此斜杠命令。"
            case "INVALID_COMMAND": return "请求格式不正确，未执行。"
            case "INVALID_COMMAND_ARGUMENTS": return "命令参数不正确，未执行。请查看该命令的用法。"
            case "INVALID_ENTITY_NAME": return "名称只能包含中文、英文字母和数字，草稿已保留。"
            case "TASK_OUTSIDE_WORK", "SOURCE_SESSION_CHANGED": return "来源会话与 Work 不匹配，请关闭表单后重新打开。草稿已保留。"
            case "AGENT_OUTSIDE_WORK", "AGENT_NOT_FOUND": return "所选 Agent 已不可用于此 Work，请重新加载执行选项。"
            case "SOURCE_SESSION_NOT_FOUND": return "来源会话尚未就绪，请先在 Mac 上恢复该会话。草稿已保留。"
            case "PROVIDER_CAPABILITY_UNAVAILABLE": return "所选 Provider 不支持创建此工作会话，请选择其他可用 Provider。"
            case "PROVIDER_COMMAND_UNSUPPORTED": return "当前会话不支持此命令。请使用 /help 查看可用命令。"
            case "COMMAND_CONFIRMATION_REQUIRED": return "此命令需要确认后才能执行，草稿已保留。"
            case "INVALID_IMAGES": return "图片格式或大小不符合要求，消息未发送。"
            case "INVALID_MENTIONS": return "引用信息不符合要求，消息未发送。"
            case "INVALID_SCHEDULE": return "定时发送参数无效，请检查时间和重复设置。"
            case "CAPABILITY_UNSUPPORTED": return "当前会话暂不支持此操作，未执行。"
            case "COMMAND_JOURNAL_FULL": return "后端请求记录已满，暂时无法接受新请求。"
            case "SESSION_NOT_AVAILABLE": return "无法打开这个会话。列表可能已过期，请刷新后重试。"
            case "ROUTE_NOT_AVAILABLE": return "Mac 端暂不支持这项功能，请更新并重启 Corptie。"
            case "INVALID_CREDENTIAL": return "设备凭据无效或已被撤销，请重新连接。"
            default: return "操作未完成（\(error.code)），请刷新后重试。"
            }
        }
        if let error = error as? ClientConnectionError {
            switch error {
            case .httpStatus(401): return "凭据无效或已过期，请重新连接；不要重复发送消息。"
            case .httpStatus(403): return "Mac 拒绝了这项操作，请刷新状态后重试。"
            case .httpStatus(404): return "请求的内容暂时不可用，请刷新后重试。"
            case .httpStatus(409): return "会话状态或请求发生冲突。请刷新并核对命令回执。"
            default: break
            }
        }
        return "操作未完成。请检查 HTTPS 地址、证书信任、局域网权限和 Mac 后端状态。"
    }

    private func configuredEndpoint() throws -> BackendEndpoint {
        guard let url = URL(string: address.trimmingCharacters(in: .whitespacesAndNewlines)),
              url.scheme == "https", !serverID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ClientConnectionError.invalidResponse
        }
        return try BackendEndpoint(url)
    }

    func requestPairing() async {
        await perform {
            let endpoint = try configuredEndpoint()
            claim = try await DevicePairingClient(endpoint: endpoint, certificate: pairingCertificate).claim(pairingId: pairingID, pairingSecret: secret, name: "Corptie Mobile")
            self.endpoint = endpoint
            secret = ""
            notice = "请在 Mac 的设备设置中批准，然后点击完成配对。"
        }
    }

    /// Validate atomically before replacing any manual pairing state or networking.
    func applyPairingCode(_ payload: String) throws {
        guard !busy, !connected, claim == nil else { throw ClientConnectionError.invalidResponse }
        let code = try DevicePairingCode.decode(payload)
        address = code.address; serverID = code.serverId
        pairingID = code.pairingId; secret = code.pairingSecret
        pairingCertificate = code.certificate
        hasSavedPairing = false
        notice = "已识别 Mac，正在申请配对。"
    }

    func finishPairing() async {
        await perform {
            guard let endpoint, let claim else { return }
            credentials = try await vault.exchangeAndStore(claim: claim, endpoint: endpoint, expectedServerId: serverID, certificate: pairingCertificate)
            self.claim = nil
            hasSavedPairing = true
            remember(endpoint)
            connected = true
        }
    }

    func waitForApproval() async {
        guard let pending = claim, let endpoint else { return }
        while !Task.isCancelled && claim?.pairingId == pending.pairingId && !connected {
            do {
                try await Task.sleep(for: .seconds(2))
                guard !busy else { continue }
                guard pending.expiresAt > Date().timeIntervalSince1970 * 1000 else {
                    notice = "配对已过期，请重新扫码。"; claim = nil; return
                }
                busy = true
                defer { busy = false }
                credentials = try await vault.exchangeAndStore(claim: pending, endpoint: endpoint,
                    expectedServerId: serverID, certificate: pairingCertificate)
                hasSavedPairing = true
                remember(endpoint)
                claim = nil; connected = true
                return
            } catch is CancellationError { return }
            catch let error as DevicePairingFailure where error.code == "PAIRING_NOT_APPROVED" {
                notice = "等待 Mac 批准设备…"
            } catch {
                notice = Self.explain(error)
                if let error = error as? DevicePairingFailure,
                   ["PAIRING_DENIED", "PAIRING_EXPIRED", "PAIRING_INVALID"].contains(error.code) { claim = nil }
                return
            }
        }
    }

    /// Run once per app launch, so an explicit disconnect stays disconnected.
    func restoreLastConnection() async {
        guard !attemptedStartupConnection else { return }
        attemptedStartupConnection = true
        defer { restoringConnection = false }
        guard !connected, !address.isEmpty, !serverID.isEmpty else { return }
        await reconnect()
    }

    func reconnect() async {
        await perform {
            let endpoint = try configuredEndpoint()
            guard let saved = try await vault.load(endpoint: endpoint, serverId: serverID) else {
                hasSavedPairing = false
                notice = "此 Mac 没有已保存的配对，请先配对。"
                return
            }
            hasSavedPairing = true
            self.endpoint = endpoint
            credentials = saved
            let transport = try await transport()
            let (_, _) = try await transport.data(for: endpoint.request(path: ["client", "v1", "me"]))
            remember(endpoint)
            connected = true
        }
    }

    private func remember(_ endpoint: BackendEndpoint) {
        address = endpoint.baseURL.absoluteString
        UserDefaults.standard.set(address, forKey: "serverAddress")
        UserDefaults.standard.set(serverID, forKey: "serverID")
    }

    // Background reads and the event stream share one token rotation, never parallel refreshes.
    func transport() async throws -> BackendTransport {
        if let transportOverride { return transportOverride }
        guard let endpoint, var credentials else { throw ClientConnectionError.invalidCredential }
        if credentials.accessExpiresAt <= Date().timeIntervalSince1970 * 1000 + 30_000 {
            if refreshTask == nil {
                let saved = credentials, expectedID = serverID, vault = vault
                refreshTask = Task {
                    var updated = try await DevicePairingClient(endpoint: endpoint, certificate: saved.certificate).refresh(saved)
                    updated.certificate = saved.certificate
                    try await vault.save(updated, endpoint: endpoint, expectedServerId: expectedID)
                    return updated
                }
            }
            let task = refreshTask!
            defer { refreshTask = nil }
            credentials = try await task.value
            guard self.endpoint?.baseURL == endpoint.baseURL, self.credentials?.deviceId == credentials.deviceId else { throw CancellationError() }
            self.credentials = credentials
        }
        if cachedTransport == nil || cachedToken != credentials.accessToken {
            cachedTransport = try BackendTransport(endpoint: endpoint, bearerToken: credentials.accessToken, certificate: credentials.certificate)
            cachedToken = credentials.accessToken
        }
        return cachedTransport!
    }

    func disconnect() {
        guard !busy else { return }
        connected = false
        credentials = nil
        refreshTask?.cancel()
        refreshTask = nil
        cachedTransport = nil
        cachedToken = nil
        endpoint = nil
        claim = nil
        notice = "已断开；配对凭据保留在钥匙串中。撤销设备请在 Mac 上操作。"
    }
}
