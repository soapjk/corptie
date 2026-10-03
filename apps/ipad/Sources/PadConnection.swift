import Foundation
import Observation
import CorptieClientCore
import CorptieClientSecurity

@MainActor @Observable
final class PadConnection {
    private struct CloudOfflineLANGrant: Decodable {
        let address: String
        let certificate: String
        let serverId: String
        let deviceId: String
        let accessToken: String
        let refreshToken: String
        let accessExpiresAt: Double
        let refreshExpiresAt: Double
        let cloudValidatedAt: Double
    }
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
    var cloudDevices: [CloudDevice] = []
    var cloudSignedIn = false
    var cloudCurrentDeviceID: UUID? { cloudCredential?.identity.id }
    private var endpoint: BackendEndpoint?
    private var credentials: DeviceCredentials?
    var deviceID: String? { credentials?.deviceId }
    private var pairingCertificate: String?
    private let vault = DeviceCredentialVault()
    private var refreshTask: Task<DeviceCredentials, Error>?
    private var cachedTransport: BackendTransport?
    private var cachedToken: String?
    private let transportOverride: BackendTransport?
    private let cloudVault = CloudCredentialVault()
    private var cloudCredential: CloudCredential?
    private var cloudAuthorization: CloudOAuthAuthorization?
    private var cloudClient: CloudRelayHTTPClient?

    init(transportOverride: BackendTransport? = nil) { self.transportOverride = transportOverride }

    private static func cloudConfiguration() throws -> CloudOAuthConfiguration {
        #if DEBUG
        let override = ProcessInfo.processInfo.environment["CORPTIE_CLOUD_BASE_URL"]
        #else
        let override: String? = nil
        #endif
        return try CorptieCloudService.nativeOAuth(clientID: "corptie-ios", developmentBaseURL: override)
    }

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
            case "INVALID_CREDENTIAL": return "设备凭据无效或已被撤销，请重新扫码配对。"
            case "DEVICE_REVOKED": return "此设备已被 Mac 撤销，请重新扫码配对。"
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
        if error is CloudOfflineLANDenial {
            return "离线局域网授权已过期或设备时间不可信；请恢复联网后重新连接 Corptie Cloud。"
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
        if UserDefaults.standard.string(forKey: "connectionMode") == "cloud" {
            await restoreCloudConnection()
            if connected { return }
        }
        guard !connected, !address.isEmpty, !serverID.isEmpty else { return }
        await reconnect()
    }

    func beginCloudSignIn() throws -> URL {
        let authorization = try CloudOAuthAuthorization(configuration: Self.cloudConfiguration())
        cloudAuthorization = authorization
        return authorization.url
    }

    func completeCloudSignIn(callback: URL, deviceName: String) async {
        await perform {
            guard let authorization = cloudAuthorization else { throw CloudOAuthError.invalidCallback }
            defer { cloudAuthorization = nil }
            let configuration = try Self.cloudConfiguration()
            let code = try authorization.code(from: callback, configuration: configuration)
            let tokens = try await CloudOAuthTokenClient(configuration: configuration).exchange(
                code: code, verifier: authorization.verifier
            )
            let identity = try CloudDeviceIdentity(
                kind: .mobile,
                displayName: deviceName,
                privateKey: CloudRelayDeviceKey().privateKeyData
            )
            let credential = CloudCredential(tokens: tokens, identity: identity)
            try await cloudVault.save(credential, configuration: configuration)
            cloudCredential = credential
            try await registerCloudDeviceAndRefresh(credential, configuration: configuration)
            cloudSignedIn = true
            let macs = cloudDevices.filter { $0.kind == .mac && $0.revokedAt == nil }
            if macs.count == 1 {
                try await connectCloudImpl(to: macs[0])
                notice = "已自动连接 \(macs[0].displayName)。"
            } else {
                notice = macs.isEmpty
                    ? "已登录 Corptie Cloud；请先在 Mac 上登录并开启远程连接。"
                    : "已登录 Corptie Cloud。请选择要连接的 Mac。"
            }
        }
    }

    func connectCloud(to mac: CloudDevice) async {
        await perform { try await connectCloudImpl(to: mac) }
    }

    func revokeCloudDevice(_ device: CloudDevice) async {
        guard !busy, device.kind == .mobile, device.revokedAt == nil,
              device.id != cloudCurrentDeviceID else { return }
        busy = true
        notice = ""
        defer { busy = false }
        do {
            let configuration = try Self.cloudConfiguration()
            let credential = try await validCloudCredential(configuration)
            let client = try CloudDeviceClient(
                endpoint: configuration.endpoint,
                accessToken: credential.tokens.accessToken
            )
            _ = try await client.revoke(device.id)
            cloudDevices = try await client.list()
            notice = "已撤销 \(device.displayName) 的 Cloud 访问。"
        } catch ClientConnectionError.httpStatus(403) {
            notice = "为保护账号，撤销设备需要最近 5 分钟内重新登录 Cloud。"
        } catch is CancellationError {
        } catch {
            notice = Self.explain(error)
        }
    }

    private func connectCloudImpl(to mac: CloudDevice) async throws {
        guard mac.kind == .mac, mac.revokedAt == nil else { throw ClientConnectionError.invalidResponse }
        let configuration = try Self.cloudConfiguration()
        let credential = try await validCloudCredential(configuration)
        let key = try CloudRelayDeviceKey(rawRepresentation: credential.identity.privateKey)
        let channel = try await CloudRelayMobileChannel.connect(
            cloudEndpoint: configuration.endpoint,
            accessToken: credential.tokens.accessToken,
            deviceID: credential.identity.id,
            targetMacID: mac.id,
            deviceKey: key
        )
        let relay = CloudRelayHTTPClient(
            endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!), channel: channel
        )
        do {
            let transport = relay.transport()
            let request = try transport.endpoint.request(path: ["client", "v1", "me"])
            _ = try await transport.data(for: request)
            var grantRequest = try transport.endpoint.request(path: ["client", "v1", "cloud", "offline-lan-grant"])
            grantRequest.httpMethod = "POST"
            let (grantData, _) = try await transport.data(for: grantRequest)
            let grant = try JSONDecoder().decode(CloudOfflineLANGrant.self, from: grantData)
            try await saveOfflineGrant(grant)
            let previous = cloudClient
            cloudClient = relay
            cachedTransport = transport
            cachedToken = nil
            connected = true
            UserDefaults.standard.set("cloud", forKey: "connectionMode")
            UserDefaults.standard.set(mac.id.uuidString, forKey: "cloudMacID")
            if let previous { await previous.close() }
        } catch {
            await relay.close()
            throw error
        }
    }

    func signOutCloud() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        if let cloudClient { await cloudClient.close() }
        var serverRevoked = false
        if let configuration = try? Self.cloudConfiguration(),
           let current = try? await validCloudCredential(configuration),
           let client = try? CloudDeviceClient(endpoint: configuration.endpoint, accessToken: current.tokens.accessToken) {
            serverRevoked = (try? await client.revokeCurrent()) != nil
        }
        do { try await cloudVault.remove(configuration: Self.cloudConfiguration()) }
        catch { notice = Self.explain(error); return }
        cloudClient = nil
        cloudCredential = nil
        cloudDevices = []
        cloudSignedIn = false
        connected = false
        cachedTransport = nil
        if let endpoint, !serverID.isEmpty { try? await vault.remove(endpoint: endpoint, serverId: serverID) }
        credentials = nil
        UserDefaults.standard.removeObject(forKey: "cloudMacID")
        UserDefaults.standard.removeObject(forKey: "connectionMode")
        notice = serverRevoked
            ? "已退出 Corptie Cloud，并撤销此设备的登录。"
            : "已退出本机 Cloud 登录；离线时无法确认服务端撤销状态。"
    }

    private func restoreCloudConnection() async {
        do {
            let configuration = try Self.cloudConfiguration()
            guard let saved = try await cloudVault.load(configuration: configuration) else { return }
            cloudCredential = saved
            let credential = try await validCloudCredential(configuration)
            try await registerCloudDeviceAndRefresh(credential, configuration: configuration)
            cloudSignedIn = true
            let macs = cloudDevices.filter { $0.kind == .mac && $0.revokedAt == nil }
            let remembered = UserDefaults.standard.string(forKey: "cloudMacID").flatMap(UUID.init(uuidString:))
            if let mac = macs.first(where: { $0.id == remembered }) ?? (macs.count == 1 ? macs[0] : nil) {
                await connectCloud(to: mac)
            }
        } catch {
            notice = Self.explain(error)
        }
    }

    private func validCloudCredential(_ configuration: CloudOAuthConfiguration) async throws -> CloudCredential {
        let loaded: CloudCredential?
        if let cloudCredential { loaded = cloudCredential }
        else { loaded = try await cloudVault.load(configuration: configuration) }
        guard var credential = loaded else {
            throw ClientConnectionError.invalidCredential
        }
        if credential.tokens.isNearExpiry {
            let tokens = try await CloudOAuthTokenClient(configuration: configuration).refresh(credential.tokens)
            credential = CloudCredential(tokens: tokens, identity: credential.identity)
            try await cloudVault.save(credential, configuration: configuration)
        }
        cloudCredential = credential
        return credential
    }

    private func registerCloudDeviceAndRefresh(_ credential: CloudCredential, configuration: CloudOAuthConfiguration) async throws {
        let key = try CloudRelayDeviceKey(rawRepresentation: credential.identity.privateKey)
        let client = try CloudDeviceClient(endpoint: configuration.endpoint, accessToken: credential.tokens.accessToken)
        _ = try await client.register(.init(
            id: credential.identity.id,
            kind: .mobile,
            displayName: credential.identity.displayName,
            publicKey: key.publicKeyBase64
        ))
        cloudDevices = try await client.list()
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
            if let validated = saved.cloudValidatedAt, let uptime = saved.cloudValidationUptime {
                let policy = try CloudOfflineLANPolicy(
                    validatedAt: Date(timeIntervalSince1970: validated / 1000),
                    validationUptime: uptime,
                    validUntil: Date(timeIntervalSince1970: saved.refreshExpiresAt / 1000)
                )
                try policy.authorize(
                    now: Date(), systemUptime: ProcessInfo.processInfo.systemUptime,
                    grantIssuedAt: Date(timeIntervalSince1970: validated / 1000),
                    grantExpiresAt: Date(timeIntervalSince1970: saved.refreshExpiresAt / 1000),
                    isKnownRevoked: false
                )
            }
            do {
                let transport = try await transport()
                let (_, _) = try await transport.data(for: endpoint.request(path: ["client", "v1", "me"]))
                remember(endpoint)
                connected = true
            } catch let error as DevicePairingFailure where error.code == "INVALID_CREDENTIAL" || error.code == "DEVICE_REVOKED" {
                hasSavedPairing = false
                try? await vault.remove(endpoint: endpoint, serverId: serverID)
                self.credentials = nil
                throw error
            }
        }
    }

    private func remember(_ endpoint: BackendEndpoint) {
        address = endpoint.baseURL.absoluteString
        UserDefaults.standard.set(address, forKey: "serverAddress")
        UserDefaults.standard.set(serverID, forKey: "serverID")
        UserDefaults.standard.set(credentials?.cloudValidatedAt == nil ? "lan" : "cloud", forKey: "connectionMode")
    }

    private func saveOfflineGrant(_ grant: CloudOfflineLANGrant) async throws {
        let lanEndpoint = try BackendEndpoint(URL(string: grant.address)!)
        var value = DeviceCredentials(
            certificate: grant.certificate, serverId: grant.serverId, deviceId: grant.deviceId,
            accessToken: grant.accessToken, refreshToken: grant.refreshToken,
            accessExpiresAt: grant.accessExpiresAt, refreshExpiresAt: grant.refreshExpiresAt,
            cloudValidatedAt: grant.cloudValidatedAt,
            cloudValidationUptime: ProcessInfo.processInfo.systemUptime
        )
        value.certificate = grant.certificate
        try await vault.save(value, endpoint: lanEndpoint, expectedServerId: grant.serverId)
        endpoint = lanEndpoint
        credentials = value
        address = lanEndpoint.baseURL.absoluteString
        serverID = grant.serverId
        hasSavedPairing = true
        UserDefaults.standard.set(address, forKey: "serverAddress")
        UserDefaults.standard.set(serverID, forKey: "serverID")
    }

    // Background reads and the event stream share one token rotation, never parallel refreshes.
    func transport() async throws -> BackendTransport {
        if let transportOverride { return transportOverride }
        if cloudClient != nil, let cachedTransport { return cachedTransport }
        guard let endpoint, var credentials else { throw ClientConnectionError.invalidCredential }
        if credentials.accessExpiresAt <= Date().timeIntervalSince1970 * 1000 + 30_000 {
            if refreshTask == nil {
                let saved = credentials, expectedID = serverID, vault = vault
                refreshTask = Task {
                    var updated = try await DevicePairingClient(endpoint: endpoint, certificate: saved.certificate).refresh(saved)
                    updated.certificate = saved.certificate
                    updated.cloudValidatedAt = saved.cloudValidatedAt
                    updated.cloudValidationUptime = saved.cloudValidationUptime
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
        if let cloudClient { Task { await cloudClient.close() } }
        cloudClient = nil
        endpoint = nil
        claim = nil
        notice = "现在已经断开连接。配对凭据保留在钥匙串中，可点击连接重新连接 Mac。"
    }
}
