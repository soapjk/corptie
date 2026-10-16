import AppKit
import Combine
import SwiftUI

private struct FirstRunFailure: Decodable { let error: String }

private enum FirstRunBrandAssets {
    // Copied SwiftPM resources are loaded by URL, rather than asset-catalog
    // lookup. Decode once, including when the page redraws during a check.
    static let appIcon: NSImage? = AppResourceBundle.bundle.url(forResource: "AppIcon", withExtension: "png")
        .flatMap { NSImage(contentsOf: $0) }
}

struct FirstRunProvider: Decodable, Identifiable {
    let id: String
    let name: String
    let path: String
    let executable: Bool
    let enabled: Bool
    let checkState: String
    let message: String?
    var environment: ProviderRuntimeEnvironment? = nil
    var errorCode: String? = nil
    var program: ProviderProgramInventory? = nil
}

struct ProviderProgramInventory: Decodable, Equatable {
    struct Candidate: Decodable, Equatable, Identifiable {
        let id: String
        let path: String
        let resolvedPath: String
        let sources: [String]
        let version: String?
        let state: String
        let prerelease: Bool
    }
    struct Running: Decodable, Equatable, Identifiable {
        let profileId: String
        let path: String
        let pid: Int?
        let initialized: Bool
        var id: String { profileId }
    }
    let mode: String
    let recommendedPath: String
    let adoptedPath: String
    let model: String
    var effectiveModel: String? = nil
    let candidates: [Candidate]
    let running: [Running]
}

struct ProviderRuntimeEnvironment: Decodable, Equatable {
    struct Option: Decodable, Equatable, Identifiable {
        let mode: String
        let title: String
        let home: String
        var id: String { mode }
    }
    let profileId: String
    let mode: String
    let home: String
    let revision: Int
    let options: [Option]
    let canImportAuthentication: Bool
}

private struct ProviderAuthenticationResult: Decodable {
    let state: String
    let loginId: String?
    let authUrl: String?
}

struct FirstRunStatus: Decodable {
    var providers: [FirstRunProvider]
    let completed: Bool
    let hasWorks: Bool
    var defaultProviderId: String?
    let assistantSessionId: String?
    let workSessionId: String?

    var canContinue: Bool { providers.contains { $0.enabled && $0.executable && $0.checkState == "available" } }

    static func requiresSetup(_ status: FirstRunStatus?) -> Bool {
        status?.completed != true
    }
}

// Only startup/reconnect and explicit actions refresh this small projection.
// The main tab tree is not mounted behind the first-run page.
struct FirstRunSetupRoot<Content: View>: View {
    @ViewBuilder let content: () -> Content
    private let storeReadiness: AnyPublisher<Bool, Never>
    private let loadStatus: @MainActor () async throws -> FirstRunStatus
    @State private var storeReady = false
    @State private var status: FirstRunStatus?
    @State private var error: String?
    @State private var busy = false
    @State private var dirtyProviders = Set<String>()
    @State private var scanGeneration = 0
    @State private var defaultRefreshGeneration = 0

    init(initialStatus: FirstRunStatus? = nil,
         storeReadiness: AnyPublisher<Bool, Never>? = nil,
         loadStatus: (@MainActor () async throws -> FirstRunStatus)? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.content = content
        self.storeReadiness = storeReadiness ?? AppStateStore.shared.$isReachable.eraseToAnyPublisher()
        self.loadStatus = loadStatus ?? { try await FirstRunSetupAPI.request("first-run") }
        _status = State(initialValue: initialStatus)
    }

    private var canEnter: Bool {
        status?.providers.contains {
            $0.enabled && $0.executable && $0.checkState == "available" && !dirtyProviders.contains($0.id)
        } == true
    }

    var body: some View {
        Group {
            if !FirstRunStatus.requiresSetup(status) {
                content()
            } else {
                setupPage
            }
        }
        .onReceive(storeReadiness.removeDuplicates()) { ready in
            // SSE/health connectivity precedes SQLite initialization. The
            // existing snapshot-backed readiness signal crosses that boundary
            // and recovers automatically after delayed startup or reconnect.
            storeReady = ready
            guard ready, status == nil else { return }
            perform { try await refresh() }
        }
    }

    private var setupPage: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    welcomeHeader
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text(L10n("本机 Agent")).font(.headline)
                            Spacer()
                            Button {
                                scanGeneration += 1
                            } label: {
                                Label(L10n("重新扫描"), systemImage: "arrow.clockwise")
                            }
                            .disabled(busy)
                        }
                        if let status {
                            ForEach(status.providers) { provider in
                                FirstRunProviderCard(provider: provider, busy: busy, scanGeneration: provider.program != nil ? scanGeneration : 0,
                                    isDefault: status.defaultProviderId == provider.id,
                                    pathChanged: { dirty in
                                        if dirty { dirtyProviders.insert(provider.id) }
                                        else { dirtyProviders.remove(provider.id) }
                                    }, updated: { row in
                                        if let index = self.status?.providers.firstIndex(where: { $0.id == row.id }) {
                                            self.status?.providers[index] = row
                                        }
                                        dirtyProviders.remove(row.id)
                                        refreshDefaultProvider()
                                    })
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 12) {
                                if busy || !storeReady {
                                    ProgressView(L10n("正在准备本地数据…"))
                                } else {
                                    Text(L10n("正在等待本地服务启动。"))
                                        .foregroundStyle(.secondary)
                                    Button(L10n("重试")) { perform { try await refresh() } }
                                }
                            }
                            .padding(20)
                        }
                    }
                    if let error {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .foregroundStyle(.red)
                            .textSelection(.enabled)
                            .accessibilityLabel(L10nFormat("设置失败：%@", error))
                    }
                }
                .frame(maxWidth: 780, alignment: .leading)
                .padding(32)
                .frame(maxWidth: .infinity)
            }
            Divider()
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 24) {
                    completionHint
                    Spacer(minLength: 16)
                    enterButton
                }
                VStack(alignment: .leading, spacing: 12) {
                    completionHint
                    enterButton.frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            .frame(maxWidth: 780)
            .padding(.horizontal, 32)
            .padding(.vertical, 20)
            .frame(maxWidth: .infinity)
            .background(Color(nsColor: .controlBackgroundColor))
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var welcomeHeader: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                if let icon = FirstRunBrandAssets.appIcon {
                    Image(nsImage: icon)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 52, height: 52)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Corptie").font(.title3.weight(.semibold))
                    Text(L10n("欢迎开始")).font(.callout).foregroundStyle(.secondary)
                }
            }
            Text(L10n("让你的 Agent 准备就绪"))
                .font(.system(size: 30, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            Text(L10n("连接本机的 Agent，开始在 Corptie 中工作。完成一个配置即可开始，其他配置可以稍后添加。"))
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var completionHint: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(L10n(canEnter ? "Agent 已准备就绪" : "至少完成一个 Agent 配置才能继续"),
                  systemImage: canEnter ? "checkmark.circle.fill" : "info.circle")
                .font(.callout)
                .foregroundStyle(canEnter ? Color.accentColor : Color.secondary)
            Text(L10n("完成配置后，Corptie 助理会陪你开始使用。"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var enterButton: some View {
        Button {
            perform {
                // One explicit completion action initializes Chat and saves the
                // marker. Retry remains on this page and reuses the same Session.
                self.status = try await FirstRunSetupAPI.request("first-run/complete", body: ["language": AppLanguageController.shared.languageCode])
                if let sessionId = self.status?.assistantSessionId {
                    AppTabRouter.shared.openSession(sessionId, source: .userSelection)
                }
            }
        } label: {
            HStack(spacing: 8) {
                if busy { ProgressView().controlSize(.small) }
                Text(L10n(busy ? "正在准备助理…" : "进入 Corptie"))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
        }
        .buttonStyle(.borderedProminent)
        .controlSize(.large)
        .keyboardShortcut(.defaultAction)
        .disabled(busy || !canEnter)
    }

    private func refreshDefaultProvider() {
        defaultRefreshGeneration += 1
        let generation = defaultRefreshGeneration
        Task { @MainActor in
            guard let refreshed: FirstRunStatus = try? await FirstRunSetupAPI.request("first-run"),
                  generation == defaultRefreshGeneration else { return }
            // Cards own in-flight checks and path edits. A metadata refresh
            // must never overwrite a newer check result from another card.
            status?.defaultProviderId = refreshed.defaultProviderId
        }
    }

    private func refresh() async throws {
        status = try await loadStatus()
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await operation() }
            catch { self.error = error.localizedDescription }
        }
    }

}

@MainActor
enum FirstRunSetupAPI {
    static func request<T: Decodable>(_ path: String, body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: CorptieAppEnvironment.backendBaseURL.appending(path: path))
        request.timeoutInterval = 60
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(FirstRunFailure.self, from: data).error)
                ?? L10n("无法连接本地服务，请重试。")
            throw NSError(domain: "FirstRunSetup", code: 1, userInfo: [NSLocalizedDescriptionKey: L10n(message)])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

struct FirstRunProviderCard: View {
    let provider: FirstRunProvider
    let busy: Bool
    let scanGeneration: Int
    let isDefault: Bool
    let allowsAutomaticChecks: Bool
    let pathChanged: (Bool) -> Void
    let updated: (FirstRunProvider) -> Void
    @State private var path: String
    @State private var result: FirstRunProvider
    @State private var testing = false
    @State private var saving = false
    @State private var error: String?
    @State private var checkGeneration = 0
    @State private var editingPath = false
    @State private var environmentMode: String
    @State private var environmentHome: String
    @State private var authenticationBusy = false
    @State private var loginId: String?
    @State private var selectionMode: String
    @State private var checkModel: String
    @State private var scanning = false
    @State private var activeCheckID: String?

    init(provider: FirstRunProvider, busy: Bool, scanGeneration: Int, isDefault: Bool,
         pathChanged: @escaping (Bool) -> Void, updated: @escaping (FirstRunProvider) -> Void,
         allowsAutomaticChecks: Bool = true) {
        self.provider = provider
        self.busy = busy
        self.scanGeneration = scanGeneration
        self.isDefault = isDefault
        self.allowsAutomaticChecks = allowsAutomaticChecks
        self.pathChanged = pathChanged
        self.updated = updated
        let automatic = provider.program.map { !["manual", "controlled"].contains($0.mode) } ?? false
        _path = State(initialValue: automatic ? (provider.program?.recommendedPath ?? provider.path) : provider.path)
        _result = State(initialValue: provider)
        _environmentMode = State(initialValue: "native")
        _environmentHome = State(initialValue: provider.environment?.options.first(where: { $0.mode == "native" })?.home ?? "")
        _selectionMode = State(initialValue: automatic ? "auto" : (provider.program?.mode ?? "manual"))
        _checkModel = State(initialValue: "")
    }

    private var available: Bool {
        !testing && resultMatchesSelection && result.checkState == "available"
    }

    private var resultMatchesSelection: Bool {
        result.path == path && (result.program == nil ||
            (result.program?.model == checkModel && result.program?.mode == selectionMode)) && (result.environment == nil ||
            (result.environment?.mode == environmentMode && result.environment?.home == environmentHome))
    }

    private var selectionKey: String { "\(path)|\(environmentMode)|\(environmentHome)|\(selectionMode)|\(checkModel)" }
    private var controlsBusy: Bool { busy || saving || authenticationBusy || scanning }

    private var statusLabel: String {
        if testing { return L10n("检测中") }
        if authenticationBusy { return L10n("登录中") }
        if saving { return L10n("正在保存…") }
        if !resultMatchesSelection { return L10n("等待检测") }
        if available { return L10n(result.enabled ? "已就绪" : "可用 · 未启用") }
        switch result.checkState {
        case "missing": return L10n("未找到程序")
        case "failed": return L10n(result.errorCode == "PROVIDER_LOGIN_REQUIRED" ? "需要登录" : "需要修复")
        default: return L10n("等待检测")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                providerIcon
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text(provider.name).font(.headline)
                        if isDefault && result.enabled && available {
                            Text(L10n("默认"))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Color.accentColor.opacity(0.1), in: Capsule())
                        }
                    }
                    HStack(spacing: 6) {
                        if testing || saving {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: available ? "checkmark.circle.fill" : "info.circle")
                                .accessibilityHidden(true)
                        }
                        Text(statusLabel)
                    }
                    .font(.callout)
                    .foregroundStyle(available && result.enabled ? Color.accentColor : Color.secondary)
                }
                Spacer(minLength: 8)
                Toggle(L10n("启用"), isOn: Binding(
                    get: { available && result.enabled },
                    set: { enabled in Task { await setEnabled(enabled) } }
                ))
                .toggleStyle(.switch)
                .accessibilityLabel(L10nFormat("启用 %@", provider.name))
                .disabled(!available || controlsBusy)
            }
            if available && !editingPath && result.program == nil {
                HStack {
                    Text(L10n("已通过实际回复检测"))
                        .font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button(L10n("更改配置…")) { editingPath = true }
                        .disabled(busy || saving)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    if let program = result.program { programSelection(program) }
                    Text(L10n("程序路径")).font(.callout.weight(.medium))
                    ViewThatFits(in: .horizontal) {
                        HStack {
                            pathField.frame(minWidth: 180)
                            pathActions
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            pathField
                            pathActions
                        }
                    }
                    if path.isEmpty {
                        Text(L10n("未找到程序，请选择已安装的 Agent 可执行文件。"))
                            .font(.callout).foregroundStyle(.secondary)
                    }
                }
            }
            if let environment = provider.environment {
                environmentSelection(environment)
            }
            if result.program != nil {
                Text(L10n("检测会发送最小测试请求，可能消耗额度；不会读取项目或加入聊天历史。"))
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                if let model = result.program?.effectiveModel {
                    Text(L10nFormat("已验证模型：%@", model)).font(.caption).foregroundStyle(.secondary)
                }
            }
            if let message = error ?? (resultMatchesSelection ? result.message : nil) {
                Label(L10n(message), systemImage: "exclamationmark.circle")
                    .font(.callout).foregroundStyle(.red)
                    .textSelection(.enabled)
            }
        }
        .padding(20)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(available && result.enabled ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.1), lineWidth: 1)
        }
        .onChange(of: selectionKey) { _, _ in
            if testing, result.program != nil { cancelCheck() }
            testing = false
            error = nil
            pathChanged(!resultMatchesSelection)
        }
        .task(id: "\(selectionKey)|\(scanGeneration)|\(checkGeneration)") {
            // Multi-installation discovery never triggers a paid reply test.
            // Its explicit check action has a separate task identity below.
            guard provider.program == nil else { return }
            // Opening Settings must never start an implicit model reply test.
            guard allowsAutomaticChecks || checkGeneration > 0 else { return }
            let shouldCheck = provider.environment != nil
                ? (!authenticationBusy && !path.isEmpty && (scanGeneration > 0 || checkGeneration > 0))
                : !resultMatchesSelection || (!path.isEmpty && (result.checkState == "unknown"
                || result.checkState == "checking" || scanGeneration > 0 || checkGeneration > 0))
            guard shouldCheck else { return }
            do {
                if !resultMatchesSelection { try await Task.sleep(for: .milliseconds(600)) }
                try Task.checkCancellation()
                await check()
            } catch { }
        }
        .task(id: scanGeneration) {
            guard provider.program != nil, scanGeneration > 0 else { return }
            await scanPrograms()
        }
        .task(id: checkGeneration) {
            guard provider.program != nil, checkGeneration > 0 else { return }
            await check()
        }
        .onDisappear { if result.program != nil { cancelCheck() } }
        .task(id: loginId) {
            guard let id = loginId else { return }
            let requested = selectionKey
            let cancelBody = authenticationBody("cancel", login: id)
            defer { if loginId == id { authenticationBusy = false; loginId = nil } }
            do {
                for _ in 0..<150 {
                    try await Task.sleep(for: .seconds(2))
                    try Task.checkCancellation()
                    guard requested == selectionKey else { throw CancellationError() }
                    let status: ProviderAuthenticationResult = try await FirstRunSetupAPI.request(
                        "first-run/authentication", body: authenticationBody("status", login: id))
                    if status.state == "completed" { checkGeneration += 1; return }
                    if status.state != "pending" { throw NSError(domain: "ProviderLogin", code: 1,
                        userInfo: [NSLocalizedDescriptionKey: L10n("登录未完成，请重试。")]) }
                }
                error = L10n("登录超时，请重试。")
            } catch {
                if !Task.isCancelled && requested == selectionKey { self.error = error.localizedDescription }
            }
            Task { let _: ProviderAuthenticationResult? = try? await FirstRunSetupAPI.request("first-run/authentication", body: cancelBody) }
        }
    }

    private func programSelection(_ program: ProviderProgramInventory) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if program.candidates.contains(where: { $0.path != path }) {
            Text(L10n("本机发现有其他版本的 Codex"))
                .font(.caption).foregroundStyle(.secondary)
            Picker(L10n("其他本机版本"), selection: Binding(
                get: { selectionMode == "auto" ? "__auto__" : path },
                set: { value in
                    if value == "__auto__" {
                        selectionMode = "auto"
                        path = program.recommendedPath
                    } else { selectionMode = "manual"; path = value }
                }
            )) {
                Text(L10n("自动选择最新版本")) .tag("__auto__")
                ForEach(program.candidates) { candidate in
                    Text("\(candidate.sources.map { L10n($0) }.joined(separator: "/")) · \(candidate.version ?? L10n("版本未知"))\(candidate.prerelease ? " · " + L10n("预发布") : "")")
                        .tag(candidate.path)
                }
                if !path.isEmpty && !program.candidates.contains(where: { $0.path == path }) {
                    Text(path).tag(path)
                }
            }
            .disabled(controlsBusy || testing || program.mode == "controlled")
            }
            if program.mode == "controlled" {
                Text(L10n("程序路径由运行环境指定。")) .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func scanPrograms() async {
        guard !scanning else { return }
        scanning = true
        let requested = selectionKey
        defer { scanning = false }
        do {
            let row: FirstRunProvider = try await FirstRunSetupAPI.request("first-run/programs", body: ["providerId": provider.id])
            guard !Task.isCancelled, requested == selectionKey else { return }
            result = row
            if selectionMode == "auto" { path = row.program?.recommendedPath ?? "" }
            updated(row)
            pathChanged(!resultMatchesSelection)
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func environmentSelection(_ environment: ProviderRuntimeEnvironment) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L10n("使用本机已有配置和登录状态，认证由 Codex 管理。Codex 自身可能请求系统授权。"))
                .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            if !available {
                HStack {
                    Button(L10n("登录 Codex")) { Task { await authenticate("login") } }
                        .disabled(authenticationBusy)
                    if loginId != nil {
                        Button(L10n("取消登录")) { loginId = nil; authenticationBusy = false }
                    }
                    Button(L10n("重新检测")) { checkGeneration += 1 }
                        .disabled(authenticationBusy)
                }
                .disabled((controlsBusy && loginId == nil) || testing || path.isEmpty)
            }
        }
    }

    private var environmentBody: [String: String] { ["mode": environmentMode, "home": environmentHome] }

    private func authenticationBody(_ action: String, login: String? = nil) -> [String: Any] {
        var body: [String: Any] = ["providerId": provider.id, "path": path, "environment": environmentBody,
                                   "action": action, "confirmed": action == "import"]
        if let login { body["loginId"] = login }
        return body
    }

    private func authenticate(_ action: String) async {
        guard !authenticationBusy else { return }
        authenticationBusy = true
        error = nil
        let requested = selectionKey
        defer { if loginId == nil { authenticationBusy = false } }
        do {
            let result: ProviderAuthenticationResult = try await FirstRunSetupAPI.request(
                "first-run/authentication", body: authenticationBody(action))
            guard requested == selectionKey else { return }
            if let id = result.loginId, let address = result.authUrl, let url = URL(string: address),
               url.scheme == "https", let host = url.host, host == "auth.openai.com" || host.hasSuffix(".openai.com") {
                loginId = id
                NSWorkspace.shared.open(url)
            } else if result.state == "imported" { checkGeneration += 1 }
            else { error = L10n("无法启动 Codex 登录，请在 Codex 中登录后重新检测。") }
        } catch { if requested == selectionKey { self.error = error.localizedDescription } }
    }

    private var providerIcon: some View {
        Group {
            if let icon = ProviderBrandIcon.image(for: provider.id, providers: []) {
                Image(nsImage: icon).resizable().scaledToFit()
            } else {
                Image(systemName: "terminal").font(.title2)
            }
        }
        .frame(width: 40, height: 40)
        .accessibilityHidden(true)
    }

    private var pathField: some View {
        TextField(L10n("二进制路径"), text: Binding(get: { path }, set: {
            path = $0
            if result.program != nil { selectionMode = "manual" }
        }))
            .font(.system(.body, design: .monospaced))
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel(L10nFormat("%@ 二进制路径", provider.name))
            .disabled(controlsBusy || result.program?.mode == "controlled")
    }

    private var pathActions: some View {
        HStack {
            Button(L10n("选择…")) { chooseBinary() }
                .disabled(controlsBusy || result.program?.mode == "controlled")
                Button(L10n(result.program != nil ? "检测并采用" : (provider.environment != nil ? "检测" : "重试"))) { checkGeneration += 1 }
                .disabled(testing || controlsBusy || path.isEmpty)
            if testing && result.program != nil {
                Button(L10n("取消")) { cancelCheck() }
            }
        }
    }

    private func check() async {
        let requestedPath = path
        let requestedSelection = selectionKey
        let checkID = UUID().uuidString
        activeCheckID = checkID
        testing = true
        error = nil
        pathChanged(true)
        do {
            var body: [String: Any] = ["providerId": provider.id, "path": requestedPath]
            if result.program != nil {
                body["selectionMode"] = selectionMode; body["model"] = checkModel; body["checkId"] = checkID
            }
            if provider.environment != nil { body["environment"] = environmentBody }
            let row: FirstRunProvider = try await FirstRunSetupAPI.request("first-run/check", body: body)
            guard !Task.isCancelled, requestedSelection == selectionKey, activeCheckID == checkID else { return }
            result = row
            if row.checkState == "available", let environment = row.environment { environmentHome = environment.home }
            updated(row)
            pathChanged(false)
        } catch {
            guard !Task.isCancelled, requestedSelection == selectionKey, activeCheckID == checkID else { return }
            self.error = error.localizedDescription
        }
        if activeCheckID == checkID { activeCheckID = nil; testing = false }
    }

    private func cancelCheck() {
        guard let id = activeCheckID else { return }
        activeCheckID = nil
        testing = false
        let body: [String: Any] = ["providerId": provider.id, "checkId": id]
        Task { let _: FirstRunProvider? = try? await FirstRunSetupAPI.request("first-run/check/cancel", body: body) }
    }

    private func setEnabled(_ enabled: Bool) async {
        guard !saving else { return }
        saving = true
        pathChanged(true)
        defer {
            saving = false
            pathChanged(!resultMatchesSelection)
        }
        do {
            let row: FirstRunProvider = try await FirstRunSetupAPI.request("first-run/provider", body: [
                "providerId": provider.id, "path": path, "enabled": enabled
            ])
            result = row
            updated(row)
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func chooseBinary() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.message = L10nFormat("选择 %@ 的二进制文件", provider.name)
        if panel.runModal() == .OK, let url = panel.url {
            path = url.path
            if result.program != nil { selectionMode = "manual" }
        }
    }
}

// Settings and onboarding deliberately share the exact same provider card.
struct ProviderEnvironmentSettingsView: View {
    var defaultProviderId: String? = nil
    @State private var status: FirstRunStatus?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("Provider 专属配置")).font(.title3.weight(.semibold))
            Text(L10n("各 Provider 的程序路径、可用状态与认证配置分别管理，不影响上方的共用模型设置。"))
                .font(.caption).foregroundStyle(.secondary)
            if let status {
                ForEach(status.providers) { provider in
                    FirstRunProviderCard(provider: provider, busy: false, scanGeneration: 0,
                        isDefault: (defaultProviderId ?? status.defaultProviderId) == provider.id, pathChanged: { _ in },
                        updated: { row in
                            if let index = self.status?.providers.firstIndex(where: { $0.id == row.id }) {
                                self.status?.providers[index] = row
                            }
                        }, allowsAutomaticChecks: false)
                }
            } else if let error {
                Text(error).font(.callout).foregroundStyle(.red)
                Button(L10n("重试")) { Task { await load() } }
            } else {
                ProgressView(L10n("正在加载运行环境…"))
            }
        }
        .task { await load() }
    }

    private func load() async {
        do { status = try await FirstRunSetupAPI.request("first-run"); error = nil }
        catch { self.error = error.localizedDescription }
    }
}
