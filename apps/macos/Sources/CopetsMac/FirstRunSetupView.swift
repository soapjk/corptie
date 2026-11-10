import AppKit
import Combine
import SwiftUI
import CorptieConversation

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
    var accounts: ProviderAccountsProjection? = nil
    var runtime: ProviderRuntimeSettingsProjection? = nil
    var lastCheckedAt: String? = nil
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


struct FirstRunStatus: Decodable {
    var providers: [FirstRunProvider]
    let completed: Bool
    let hasWorks: Bool
    var defaultProviderId: String?
    let assistantSessionId: String?
    let workSessionId: String?

    var canContinue: Bool { providers.contains { $0.enabled && $0.executable } }

    static func requiresSetup(_ status: FirstRunStatus?) -> Bool {
        status?.completed != true
    }
}

// Only startup/reconnect and explicit actions refresh this small projection.
// The main tab tree is not mounted behind the first-run page.
@MainActor
struct FirstRunSetupRoot<Content: View>: View {
    @ViewBuilder let content: () -> Content
    private let storeReadiness: AnyPublisher<Bool, Never>
    private let loadStatus: @MainActor () async throws -> FirstRunStatus
    @State private var storeReady = false
    @State private var status: FirstRunStatus?
    @State private var error: String?
    @State private var busy = false
    /// Onboarding owns the same draft-backed form as Settings. Every card edit
    /// is staged here and submitted through one `/first-run/settings` save.
    @State private var providerDraft = ProviderSettingsDraft()
    @State private var scanGeneration = 0
    /// Bumped exactly once after first-run picked the default binary + account.
    @State private var autoCheckGeneration = 0
    @State private var didAutoPrepare = false

    init(initialStatus: FirstRunStatus? = nil,
         storeReadiness: AnyPublisher<Bool, Never>? = nil,
         loadStatus: (@MainActor () async throws -> FirstRunStatus)? = nil,
         @ViewBuilder content: @escaping () -> Content) {
        self.content = content
        self.storeReadiness = storeReadiness ?? AppStateStore.shared.$isReachable.eraseToAnyPublisher()
        self.loadStatus = loadStatus ?? { try await FirstRunSetupAPI.request("first-run") }
        _status = State(initialValue: initialStatus)
        let draft = ProviderSettingsDraft()
        if let initialStatus { draft.receive(initialStatus) }
        _providerDraft = State(initialValue: draft)
    }

    private var canEnter: Bool {
        guard let status, !providerDraft.isSaving else { return false }
        return status.providers.contains { provider in
            let enabled = providerDraft.values[provider.id]?.enabled ?? provider.enabled
            let accountReady = provider.accounts == nil || providerDraft.hasSpecifiedAccount(provider.id)
            return enabled && provider.executable && accountReady
        }
    }

    private var needsAccount: Bool {
        status?.providers.contains { $0.accounts != nil && !providerDraft.hasSpecifiedAccount($0.id) } == true
    }

    var body: some View {
        Group {
            if !FirstRunStatus.requiresSetup(status) {
                content()
            } else if status == nil && error == nil {
                startupLoadingPage
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

    private var startupLoadingPage: some View {
        VStack(spacing: 20) {
            CorptieLoadingLogo()
                .frame(width: 128, height: 128)
                .accessibilityHidden(true)
            Text(L10n("正在准备本地数据…"))
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var setupPage: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    welcomeHeader
                    VStack(alignment: .leading, spacing: 12) {
                        HStack {
                            Text(L10n("本机执行引擎")).font(.headline)
                            Spacer()
                            Button {
                                scanGeneration += 1
                            } label: {
                                Label(L10n("重新扫描"), systemImage: "arrow.clockwise")
                            }
                            .disabled(busy)
                        }
                        if let status {
                            ForEach(providerDraft.providers) { provider in
                                FirstRunProviderCard(provider: provider, busy: busy || providerDraft.isSaving,
                                    scanGeneration: provider.program != nil ? scanGeneration : 0,
                                    isDefault: status.defaultProviderId == provider.id,
                                    updated: { _ in
                                        // A check or account refresh returns the authoritative
                                        // server row; re-sync both the page and the shared draft.
                                        Task { try? await refresh() }
                                    }, settingsDraft: providerDraft,
                                    autoCheckGeneration: autoCheckGeneration)
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
                    saveSettingsButton
                    enterButton
                }
                VStack(alignment: .leading, spacing: 12) {
                    completionHint
                    HStack(spacing: 12) {
                        saveSettingsButton
                        enterButton
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
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
            Text(L10n("让你的执行引擎准备就绪"))
                .font(.system(size: 30, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            Text(L10n("连接本机的执行引擎，开始在 Corptie 中工作。完成一个配置即可开始，其他配置可以稍后添加。"))
                .font(.body)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var completionHint: some View {
        VStack(alignment: .leading, spacing: 5) {
            Label(L10n(canEnter ? "执行引擎已准备就绪"
                        : needsAccount ? "请先为 Codex 指定账号" : "至少完成一个执行引擎配置才能继续"),
                  systemImage: canEnter ? "checkmark.circle.fill" : "info.circle")
                .font(.callout)
                .foregroundStyle(canEnter ? Color.accentColor : (needsAccount ? Color.orange : Color.secondary))
            Text(L10n(canEnter ? "默认程序与账号已自动检测完成，可直接进入。"
                      : needsAccount ? "请选择列表中的账号，或点击“添加账号”使用本机已有登录。"
                      : "完成配置后，Corptie 助理会陪你开始使用。"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var saveSettingsButton: some View {
        Button(L10n("Save Settings")) {
            perform {
                try await providerDraft.save()
                try await refresh()
            }
        }
        .disabled(busy || !providerDraft.isDirty || providerDraft.isSaving)
    }

    private var enterButton: some View {
        Button {
            perform {
                // Entering commits the same shared draft as Settings, then the
                // one-time completion action initializes Chat and saves the marker.
                try await providerDraft.save()
                try await refresh()
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

    private func refresh() async throws {
        let next = try await loadStatus()
        status = next
        providerDraft.receive(next)
        await autoPrepareIfNeeded()
    }

    /// First launch is zero-touch: use the discovered Codex binary, pick a
    /// usable local account and let the card run one background check. The user
    /// only has to read the result and press "进入 Corptie".
    private func autoPrepareIfNeeded() async {
        guard !didAutoPrepare, FirstRunStatus.requiresSetup(status),
              let codex = providerDraft.providers.first(where: { $0.accounts != nil }) else { return }
        didAutoPrepare = true
        if !providerDraft.hasSpecifiedAccount(codex.id), !providerDraft.stageDefaultAccount(for: codex) {
            await importDefaultLocalAccount(for: codex)
        }
        autoCheckGeneration += 1
    }

    /// A machine that only has a native Codex sign-in has no selectable account
    /// yet. Import the first discovered local credential and select it, so the
    /// default path never stalls on "请指定账号". Read-only preview backends
    /// reject account operations; that failure stays silent and falls back to
    /// the inline "添加账号" entry point.
    private func importDefaultLocalAccount(for provider: FirstRunProvider) async {
        let endpoint = "providers/\(provider.id)/accounts"
        guard let detected: ProviderAccountResponse = try? await FirstRunSetupAPI.request(
                endpoint, body: ["action": "discover"]),
              let source = detected.discovered?.first else { return }
        let imported: ProviderAccountResponse? = try? await FirstRunSetupAPI.request(endpoint,
            body: ["action": "import", "source": ["kind": source.kind, "path": source.path]])
        guard let id = imported?.accountId else { return }
        providerDraft.edit(provider.id, accountId: id)
        // Refresh the projection so the card can display the new account name.
        try? await refresh()
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
    /// Settings and onboarding share this one draft-backed form. There is no
    /// onboarding-only immediate-submit path anymore: every edit is staged here
    /// and reaches `/first-run/settings` through the shared save action.
    let settingsDraft: ProviderSettingsDraft
    let provider: FirstRunProvider
    let busy: Bool
    let scanGeneration: Int
    /// Bumped once by onboarding after it picked a default account. Settings
    /// leaves it at zero: there, only an explicit edit starts a check.
    let autoCheckGeneration: Int
    let isDefault: Bool
    let updated: (FirstRunProvider) -> Void
    @State private var path: String
    @State private var result: FirstRunProvider
    @State private var testing = false
    @State private var error: String?
    @State private var checkGeneration = 0
    @State private var autoCheckDebounce: Task<Void, Never>?
    @State private var environmentMode: String
    @State private var environmentHome: String
    @State private var selectionMode: String
    @State private var checkModel: String
    @State private var scanning = false
    @State private var activeCheckID: String?

    init(provider: FirstRunProvider, busy: Bool, scanGeneration: Int, isDefault: Bool,
         updated: @escaping (FirstRunProvider) -> Void, settingsDraft: ProviderSettingsDraft,
         autoCheckGeneration: Int = 0) {
        self.settingsDraft = settingsDraft
        self.provider = provider
        self.busy = busy
        self.scanGeneration = scanGeneration
        self.autoCheckGeneration = autoCheckGeneration
        self.isDefault = isDefault
        self.updated = updated
        let automatic = provider.program.map { !["manual", "controlled"].contains($0.mode) } ?? false
        _path = State(initialValue: settingsDraft.values[provider.id]?.path
            ?? (automatic ? (provider.program?.recommendedPath ?? provider.path) : provider.path))
        _result = State(initialValue: provider)
        _environmentMode = State(initialValue: provider.environment?.mode ?? "native")
        _environmentHome = State(initialValue: provider.environment?.home ?? "")
        _selectionMode = State(initialValue: automatic ? "auto" : (provider.program?.mode ?? "manual"))
        _checkModel = State(initialValue: provider.program?.model ?? "")
    }

    private var displayEnabled: Bool { settingsDraft.values[provider.id]?.enabled ?? result.enabled }
    private var hasPendingSettings: Bool { settingsDraft.dirtyIDs.contains(provider.id) }
    private var accountRequired: Bool { result.accounts != nil }
    private var hasAccount: Bool { !accountRequired || settingsDraft.hasSpecifiedAccount(provider.id) }
    private var autoCheckTrigger: Int { autoCheckGeneration + checkGeneration }

    private var selectedAccountName: String? {
        guard let id = settingsDraft.values[provider.id]?.accountId else { return nil }
        return result.accounts?.accounts.first(where: { $0.id == id })?.name
    }

    private var available: Bool {
        !testing && resultMatchesSelection && result.checkState == "available" && hasAccount
    }

    private var resultMatchesSelection: Bool {
        result.path == path && (result.program == nil ||
            (result.program?.model == checkModel && result.program?.mode == selectionMode)) && (result.environment == nil ||
            (result.environment?.mode == environmentMode && result.environment?.home == environmentHome))
    }

    private var selectionKey: String { "\(path)|\(environmentMode)|\(environmentHome)|\(selectionMode)|\(checkModel)" }
    private var controlsBusy: Bool { busy || scanning }

    /// The card tells the user the outcome of the automatic check, including
    /// which account it used. No manual test button exists anymore.
    private var statusLabel: String {
        if testing { return L10n("正在后台自动检测…") }
        if !hasAccount { return L10n("请指定账号") }
        if hasPendingSettings { return L10n("正在应用配置…") }
        if !resultMatchesSelection { return L10n("配置已更改 · 即将自动检测") }
        if available {
            if let name = selectedAccountName { return L10nFormat("已就绪 · 账号：%@", name) }
            return L10n(displayEnabled ? "已就绪" : "可用 · 未启用")
        }
        switch result.checkState {
        case "missing": return L10n("未找到程序")
        case "failed": return L10n(result.errorCode == "PROVIDER_LOGIN_REQUIRED" ? "请在官方工具中登录" : "自动检测失败")
        default: return L10n("正在准备自动检测…")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 14) {
                providerIcon
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 8) {
                        Text(provider.name).font(WorkbenchTypography.font(for: .cardTitle))
                        if isDefault && displayEnabled && available {
                            Text(L10n("默认"))
                                .font(.caption.weight(.medium))
                                .foregroundStyle(Color.accentColor)
                                .padding(.horizontal, 7)
                                .padding(.vertical, 3)
                                .background(Color.accentColor.opacity(0.1), in: Capsule())
                        }
                    }
                    HStack(spacing: 6) {
                        if testing {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: available ? "checkmark.circle.fill" : "info.circle")
                                .accessibilityHidden(true)
                        }
                        Text(statusLabel)
                    }
                    .font(WorkbenchTypography.font(for: .help))
                    .foregroundStyle(available && displayEnabled ? Color.accentColor : Color.secondary)
                }
                Spacer(minLength: 8)
                Toggle(L10n("启用"), isOn: Binding(
                    get: { displayEnabled },
                    set: { enabled in settingsDraft.edit(provider.id, enabled: enabled) }
                ))
                .toggleStyle(.switch)
                .accessibilityLabel(L10nFormat("启用 %@", provider.name))
                .disabled(controlsBusy || testing || (!displayEnabled && path.isEmpty))
            }
            Text(L10n("程序路径")).font(.callout.weight(.semibold)).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 8) {
                if let program = result.program { programSelection(program) }
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
                    Text(L10n("未找到程序，请选择已安装的执行引擎可执行文件。"))
                        .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
                }
            }
            if isDefault && !displayEnabled {
                Text(L10n("当前默认执行引擎已关闭；请启用或手动更改默认设置，不会自动改用其他引擎。"))
                    .font(.caption).foregroundStyle(.orange)
            }
            if result.accounts != nil || result.runtime != nil {
                Divider()
                Text(L10n("账号")).font(.callout.weight(.semibold)).accessibilityAddTraits(.isHeader)
            }
            if let accounts = result.accounts {
                ProviderAccountsView(provider: result, projection: accounts, draft: settingsDraft,
                    disabled: controlsBusy || testing,
                    accountChanged: { scheduleAutoCheck() }) { row in
                    result = row
                    updated(row)
                }
            } else if let runtime = result.runtime {
                ProviderRuntimeSettingsView(providerId: provider.id, runtime: runtime, busy: controlsBusy || testing,
                    sourceDraft: settingsDraft.values[provider.id]?.source,
                    sourceEdited: { source in settingsDraft.edit(provider.id, source: source) }) { row in
                    result = row
                    environmentMode = row.environment?.mode ?? environmentMode
                    environmentHome = row.environment?.home ?? environmentHome
                    updated(row)
                }
            }
            if let message = error ?? (resultMatchesSelection ? result.message : nil) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "exclamationmark.circle").accessibilityHidden(true)
                    Text(verbatim: L10n(message))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .font(WorkbenchTypography.font(for: .help))
                .foregroundStyle(.red)
                .textSelection(.disabled)
                .accessibilityElement(children: .combine)
            }
        }
        .padding(20)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .strokeBorder(available && displayEnabled ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.1), lineWidth: 1)
        }
        .onChange(of: selectionKey) { _, _ in
            if testing { cancelCheck() }
            testing = false
            error = nil
            settingsDraft.edit(provider.id, path: path)
            scheduleAutoCheck()
        }
        .task(id: scanGeneration) {
            guard provider.program != nil, scanGeneration > 0 else { return }
            await scanPrograms()
        }
        .task(id: autoCheckTrigger) {
            guard autoCheckTrigger > 0 else { return }
            await commitAndCheck()
        }
        .onDisappear { autoCheckDebounce?.cancel(); cancelCheck() }

    }

    /// Edits are debounced so typing a path does not fire one model request
    /// per keystroke. Root's first-run preparation uses `autoCheckGeneration`
    /// to skip the wait entirely.
    private func scheduleAutoCheck() {
        autoCheckDebounce?.cancel()
        autoCheckDebounce = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(700))
            guard !Task.isCancelled else { return }
            checkGeneration += 1
        }
    }

    /// The check must use the account the user just picked, so the shared
    /// draft is committed first. Both onboarding and Settings take this path.
    private func commitAndCheck() async {
        do { try await settingsDraft.save() }
        catch { self.error = error.localizedDescription; return }
        await check()
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
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private var environmentBody: [String: String] { ["mode": environmentMode, "home": environmentHome] }

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
        }
    }

    private func check() async {
        let requestedPath = path
        let requestedSelection = selectionKey
        let checkID = UUID().uuidString
        activeCheckID = checkID
        testing = true
        error = nil
        // A cancelled automatic check must never leave the card stuck on
        // "checking": the next trigger swaps in a new task id.
        defer { if activeCheckID == checkID { activeCheckID = nil; testing = false } }
        do {
            var body: [String: Any] = ["providerId": provider.id, "path": requestedPath, "checkId": checkID]
            if result.program != nil {
                body["selectionMode"] = selectionMode; body["model"] = checkModel; body["checkId"] = checkID
            }
            if provider.environment != nil { body["environment"] = environmentBody }
            let row: FirstRunProvider = try await FirstRunSetupAPI.request("first-run/check", body: body)
            guard !Task.isCancelled, requestedSelection == selectionKey, activeCheckID == checkID else { return }
            result = row
            if row.checkState == "available", let environment = row.environment { environmentHome = environment.home }
            updated(row)
        } catch {
            guard !Task.isCancelled, requestedSelection == selectionKey, activeCheckID == checkID else { return }
            self.error = error.localizedDescription
        }
    }

    private func cancelCheck() {
        guard let id = activeCheckID else { return }
        activeCheckID = nil
        testing = false
        let body: [String: Any] = ["providerId": provider.id, "checkId": id]
        Task { let _: FirstRunProvider? = try? await FirstRunSetupAPI.request("first-run/check/cancel", body: body) }
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
    let draft: ProviderSettingsDraft

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n("Provider 专属配置")).font(WorkbenchTypography.font(for: .sectionTitle))
            Text(L10n("执行程序、凭证来源和启用状态统一通过页面底部“保存设置”提交。"))
                .font(WorkbenchTypography.font(for: .help)).foregroundStyle(.secondary)
            if draft.isLoaded {
                ForEach(draft.providers) { provider in
                    FirstRunProviderCard(provider: provider, busy: draft.isSaving, scanGeneration: 0,
                        isDefault: defaultProviderId == provider.id,
                        updated: { _ in Task { await draft.load() } },
                        settingsDraft: draft)
                        .id("\(provider.id)|\(draft.refreshGeneration)")
                }
            } else if let error = draft.loadError {
                Text(error).font(.callout).foregroundStyle(.red)
                Button(L10n("重试")) { Task { await draft.load() } }
            } else {
                ProgressView(L10n("正在加载运行环境…"))
            }
        }
        .task { if !draft.isLoaded { await draft.load() } }
    }
}
