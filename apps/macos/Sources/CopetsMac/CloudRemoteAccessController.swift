import AppKit
import AuthenticationServices
import Combine
import CorptieClientCore
import CorptieClientSecurity
import Foundation

final class WebAuthenticationCallbackBridge: @unchecked Sendable {
    typealias Delivery = @MainActor @Sendable (URL?, (any Error)?) -> Void

    private struct Payload: @unchecked Sendable {
        let callbackURL: URL?
        let error: (any Error)?
    }

    private let lock = NSLock()
    private let delivery: Delivery
    private var completed = false

    init(delivery: @escaping Delivery) {
        self.delivery = delivery
    }

    func makeCompletionHandler() -> ASWebAuthenticationSession.CompletionHandler {
        { [self] callbackURL, error in
            complete(callbackURL: callbackURL, error: error)
        }
    }

    func complete(callbackURL: URL?, error: (any Error)?) {
        lock.lock()
        guard !completed else {
            lock.unlock()
            return
        }
        completed = true
        lock.unlock()

        let payload = Payload(callbackURL: callbackURL, error: error)
        Task { @MainActor [delivery] in
            delivery(payload.callbackURL, payload.error)
        }
    }
}

@MainActor
final class CloudRemoteAccessController: NSObject, ObservableObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = CloudRemoteAccessController()

    @Published private(set) var signedIn = false
    @Published private(set) var enabled = false
    @Published private(set) var connected = false
    @Published private(set) var busy = false
    @Published private(set) var restoring = false
    @Published private(set) var devices: [CloudDevice] = []
    @Published private(set) var currentDeviceID: UUID?
    @Published private(set) var status = "尚未登录 Corptie Cloud"

    private let vault = CloudCredentialVault(service: "com.corptie.mac.cloud-credentials")
    private var credential: CloudCredential?
    private var webSession: ASWebAuthenticationSession?
    private var agent: CloudRelayMacAgent?
    private var agentTask: Task<Void, Never>?
    private var restored = false

    private override init() {
        enabled = CorptieAppEnvironment.userDefaults.bool(forKey: "cloudRemoteAccessEnabled")
        super.init()
    }

    func restore() async {
        guard !restored else { return }
        restored = true
        restoring = true
        defer { restoring = false }
        do {
            let configuration = try Self.configuration()
            guard let saved = try await vault.load(configuration: configuration) else { return }
            credential = saved
            currentDeviceID = saved.identity.id
            signedIn = true
            try await refreshDevices()
            if enabled { startAgent() }
            else { status = "已登录；远程连接已关闭" }
        } catch {
            status = "Cloud 凭据不可用，请重新登录"
        }
    }

    func signIn() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let configuration = try Self.configuration()
            let authorization = try CloudOAuthAuthorization(configuration: configuration)
            let callback = try await authenticate(at: authorization.url)
            let code = try authorization.code(from: callback, configuration: configuration)
            let tokens = try await CloudOAuthTokenClient(configuration: configuration).exchange(
                code: code, verifier: authorization.verifier
            )
            let name = Host.current().localizedName ?? "Corptie Mac"
            let identity = try CloudDeviceIdentity(
                kind: .mac, displayName: name, privateKey: CloudRelayDeviceKey().privateKeyData
            )
            let next = CloudCredential(tokens: tokens, identity: identity)
            try await vault.save(next, configuration: configuration)
            credential = next
            currentDeviceID = next.identity.id
            signedIn = true
            enabled = true
            CorptieAppEnvironment.userDefaults.set(true, forKey: "cloudRemoteAccessEnabled")
            try await registerAndLoad(next, configuration: configuration)
            status = "正在连接 Corptie Cloud…"
            startAgent()
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            status = "Cloud 登录已取消"
        } catch {
            status = "Cloud 登录未完成，请重试"
        }
    }

    func setEnabled(_ value: Bool) {
        guard signedIn else { return }
        enabled = value
        CorptieAppEnvironment.userDefaults.set(value, forKey: "cloudRemoteAccessEnabled")
        if value {
            status = "正在连接 Corptie Cloud…"
            startAgent()
        } else {
            stopAgent()
            status = "已登录；远程连接已关闭"
        }
    }

    func refreshDevices() async throws {
        let configuration = try Self.configuration()
        let current = try await validCredential(configuration)
        try await registerAndLoad(current, configuration: configuration)
    }

    func revoke(_ device: CloudDevice) async {
        guard !busy, device.revokedAt == nil else { return }
        busy = true
        defer { busy = false }
        do {
            let configuration = try Self.configuration()
            let current = try await validCredential(configuration)
            let client = try CloudDeviceClient(endpoint: configuration.endpoint, accessToken: current.tokens.accessToken)
            _ = try await client.revoke(device.id)
            devices = try await client.list()
            status = "已撤销 \(device.displayName)"
        } catch {
            status = "撤销失败；为保护账号，请重新登录后再试"
        }
    }

    func signOut() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        stopAgent()
        var serverRevoked = false
        if let configuration = try? Self.configuration(),
           let current = try? await validCredential(configuration),
           let client = try? CloudDeviceClient(endpoint: configuration.endpoint, accessToken: current.tokens.accessToken) {
            serverRevoked = (try? await client.revokeCurrent()) != nil
        }
        do { try await vault.remove(configuration: Self.configuration()) }
        catch { status = "无法清除本机 Cloud 凭据"; return }
        credential = nil
        signedIn = false
        enabled = false
        connected = false
        devices = []
        currentDeviceID = nil
        CorptieAppEnvironment.userDefaults.removeObject(forKey: "cloudRemoteAccessEnabled")
        status = serverRevoked
            ? "已退出 Corptie Cloud，并撤销此 Mac 的登录"
            : "已退出本机 Cloud 登录；离线时无法确认服务端撤销状态"
    }

    private func startAgent() {
        guard enabled, signedIn, agentTask == nil else { return }
        agentTask = Task { [weak self] in
            guard let self else { return }
            var delay = 1
            while !Task.isCancelled, self.enabled {
                do {
                    let configuration = try Self.configuration()
                    let current = try await self.validCredential(configuration)
                    try await self.registerAndLoad(current, configuration: configuration)
                    guard let dataRoot = BackendClient.shared.settings?.dataRoot, !dataRoot.isEmpty else {
                        throw ClientConnectionError.invalidResponse
                    }
                    let localAccessToken = try await LocalDeviceAdminClient.adminToken(dataRoot: dataRoot)
                    let key = try CloudRelayDeviceKey(rawRepresentation: current.identity.privateKey)
                    let next = try await CloudRelayMacAgent.connect(
                        cloudEndpoint: configuration.endpoint,
                        accessToken: current.tokens.accessToken,
                        deviceID: current.identity.id,
                        localBackend: CorptieAppEnvironment.backendEndpoint,
                        localAccessToken: localAccessToken,
                        deviceKey: key
                    )
                    self.agent = next
                    self.connected = true
                    self.status = "远程连接在线 · 通信内容端到端加密"
                    delay = 1
                    try await next.run()
                } catch is CancellationError { break }
                catch {
                    self.connected = false
                    self.agent = nil
                    self.status = "Cloud 连接中断，正在自动重连…"
                    do { try await Task.sleep(for: .seconds(delay)) } catch { break }
                    delay = min(delay * 2, 30)
                }
            }
            self.connected = false
            self.agent = nil
            self.agentTask = nil
        }
    }

    private func stopAgent() {
        agentTask?.cancel()
        agentTask = nil
        if let agent { Task { await agent.close() } }
        agent = nil
        connected = false
    }

    private func validCredential(_ configuration: CloudOAuthConfiguration) async throws -> CloudCredential {
        let loaded: CloudCredential?
        if let credential { loaded = credential }
        else { loaded = try await vault.load(configuration: configuration) }
        guard var current = loaded else { throw ClientConnectionError.invalidCredential }
        if current.tokens.isNearExpiry {
            let tokens = try await CloudOAuthTokenClient(configuration: configuration).refresh(current.tokens)
            current = CloudCredential(tokens: tokens, identity: current.identity)
            try await vault.save(current, configuration: configuration)
        }
        credential = current
        return current
    }

    private func registerAndLoad(_ current: CloudCredential, configuration: CloudOAuthConfiguration) async throws {
        let key = try CloudRelayDeviceKey(rawRepresentation: current.identity.privateKey)
        let client = try CloudDeviceClient(endpoint: configuration.endpoint, accessToken: current.tokens.accessToken)
        _ = try await client.register(.init(
            id: current.identity.id,
            kind: .mac,
            displayName: current.identity.displayName,
            publicKey: key.publicKeyBase64
        ))
        devices = try await client.list()
        guard let dataRoot = BackendClient.shared.settings?.dataRoot, !dataRoot.isEmpty else {
            throw ClientConnectionError.invalidResponse
        }
        let activeMobileIDs = devices.filter { $0.kind == .mobile && $0.revokedAt == nil }
            .map { $0.id.uuidString.lowercased() }
        _ = try await LocalDeviceAdminClient.request(
            dataRoot: dataRoot, action: "cloud-sync", body: ["activeCloudDeviceIds": activeMobileIDs]
        )
    }

    private func authenticate(at url: URL) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let bridge = WebAuthenticationCallbackBridge { [weak self] callback, error in
                self?.webSession = nil
                if let callback { continuation.resume(returning: callback) }
                else { continuation.resume(throwing: error ?? CloudOAuthError.invalidCallback) }
            }
            let session = ASWebAuthenticationSession(
                url: url,
                callbackURLScheme: "corptie",
                completionHandler: bridge.makeCompletionHandler()
            )
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            webSession = session
            if !session.start() {
                bridge.complete(callbackURL: nil, error: CloudOAuthError.invalidCallback)
            }
        }
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        NSApp.keyWindow ?? NSApp.windows.first ?? ASPresentationAnchor()
    }

    private static func configuration() throws -> CloudOAuthConfiguration {
        #if DEBUG
        let override = ProcessInfo.processInfo.environment["CORPTIE_CLOUD_BASE_URL"]
        #else
        let override: String? = nil
        #endif
        return try CorptieCloudService.nativeOAuth(clientID: "corptie-macos", developmentBaseURL: override)
    }
}
