import AppKit
import Combine
import os
import SwiftUI
import CorptieConversation

private struct FirstRunFailure: Decodable { let error: String; var requestId: String? }
private let firstRunLogger = Logger(subsystem: "com.corptie.mac", category: "FirstRunSetup")

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

/// Import every discovered source even if another source fails.
@MainActor
enum FirstRunAccountImport {
    static func importAll(_ sources: [DiscoveredAccountSource],
                          using operation: (DiscoveredAccountSource) async throws -> Void) async -> Int {
        var failures = 0
        for source in sources {
            do { try await operation(source) }
            catch { failures += 1 }
        }
        return failures
    }
}

struct ProviderProgramChoice: Identifiable {
    let path: String
    let version: String?
    let sources: [String]
    let recommended: Bool
    let prerelease: Bool
    var id: String { path }

    static func rows(program: ProviderProgramInventory?, selectedPath: String,
                     addedPaths: [String] = []) -> [Self] {
        var rows: [Self] = []
        for candidate in program?.candidates ?? [] where !rows.contains(where: { $0.path == candidate.path }) {
            rows.append(Self(path: candidate.path, version: candidate.version, sources: candidate.sources,
                recommended: candidate.path == program?.recommendedPath, prerelease: candidate.prerelease))
        }
        for path in [program?.recommendedPath ?? "", program?.adoptedPath ?? "", selectedPath] + addedPaths
            where !path.isEmpty && !rows.contains(where: { $0.path == path }) {
            rows.append(Self(path: path, version: nil, sources: [], recommended: path == program?.recommendedPath, prerelease: false))
        }
        // Recommendation comes from backend discovery/version ordering, never path sorting.
        return rows.filter(\.recommended) + rows.filter { !$0.recommended }
    }
}

// Only startup/reconnect and explicit actions refresh this small projection.
// The main tab tree is not mounted behind the first-run page.
@MainActor
struct FirstRunSetupRoot<Content: View>: View {
    @ViewBuilder let content: () -> Content
    private let storeReadiness: AnyPublisher<Bool, Never>
    private let loadStatus: @MainActor () async throws -> FirstRunStatus
    private let onSetupRequired: @MainActor () -> Void
    @State private var storeReady = false
    @State private var status: FirstRunStatus?
    @State private var error: String?
    @State private var busy = false
    /// Onboarding owns the same draft-backed form as Settings. Every card edit
    /// is staged here and submitted through one `/first-run/settings` save.
    @State private var providerDraft = ProviderSettingsDraft()
    @State private var didAutoPrepare = false
    @State private var expandedProviderID: String?

    init(initialStatus: FirstRunStatus? = nil,
         storeReadiness: AnyPublisher<Bool, Never>? = nil,
         loadStatus: (@MainActor () async throws -> FirstRunStatus)? = nil,
         onSetupRequired: @escaping @MainActor () -> Void = {},
         @ViewBuilder content: @escaping () -> Content) {
        self.content = content
        self.onSetupRequired = onSetupRequired
        self.storeReadiness = storeReadiness ?? AppStateStore.shared.$isReachable.eraseToAnyPublisher()
        self.loadStatus = loadStatus ?? { try await FirstRunSetupAPI.request("first-run") }
        _status = State(initialValue: initialStatus)
        let draft = ProviderSettingsDraft()
        if let initialStatus { draft.receive(initialStatus) }
        _providerDraft = State(initialValue: draft)
    }

    private var canEnter: Bool {
        guard status != nil, !providerDraft.isSaving, !busy else { return false }
        return providerDraft.canEnterFirstRun
    }

    private var needsAccount: Bool {
        providerDraft.providers.contains {
            (providerDraft.values[$0.id]?.enabled ?? $0.enabled)
                && $0.accounts != nil && !providerDraft.hasSpecifiedAccount($0.id)
        }
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
        .onChange(of: status?.completed, initial: true) { _, completed in
            if completed == false { onSetupRequired() }
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
            VStack(spacing: 10) {
                HStack(spacing: 14) {
                    if let icon = FirstRunBrandAssets.appIcon {
                        Image(nsImage: icon).resizable().frame(width: 48, height: 48).accessibilityHidden(true)
                    }
                    Text(L10n("连接执行引擎")).font(.system(size: 30, weight: .semibold))
                }
                Text(L10n("corptie需至少配置一个agent引擎"))
                    .font(.callout).foregroundStyle(.secondary)
            }
            Spacer(minLength: 20)
            if let status {
                FirstRunProviderGallery(draft: providerDraft, busy: busy,
                    defaultProviderID: status.defaultProviderId,
                    expandedProviderID: $expandedProviderID,
                    updated: { _ in Task { try? await refresh() } },
                    save: {
                        perform {
                            try await providerDraft.save()
                            try await refresh()
                            expandedProviderID = nil
                        }
                    })
                    .frame(maxWidth: .infinity, alignment: .center)
            } else {
                VStack(spacing: 10) {
                    ProgressView(L10n("正在准备本地数据…"))
                    if !busy && storeReady { Button(L10n("重试")) { perform { try await refresh() } } }
                }
            }
            Spacer(minLength: 28)
            if let error {
                Label(error, systemImage: "exclamationmark.circle.fill")
                    .font(.callout).foregroundStyle(.red).textSelection(.enabled)
                    .accessibilityLabel(L10nFormat("设置失败：%@", error))
            }
            VStack(spacing: 12) {
                completionHint
                enterButton
            }
        }
        .frame(maxWidth: 840, maxHeight: .infinity)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .background {
            Color(nsColor: .windowBackgroundColor)
                .contentShape(Rectangle())
                .onTapGesture {
                    guard !busy, !providerDraft.isSaving else { return }
                    expandedProviderID = nil
                }
        }
        .accessibilityIdentifier("first-run.configuration")
    }

    private var completionHint: some View {
        Label(L10n(canEnter ? "执行引擎配置已就绪"
                    : needsAccount ? "请先为 Codex 指定账号" : "至少完成一个执行引擎配置才能继续"),
              systemImage: canEnter ? "checkmark.circle.fill" : "info.circle")
            .font(.caption)
            .foregroundStyle(canEnter ? Color.green : (needsAccount ? Color.orange : Color.secondary))
            .multilineTextAlignment(.center)
    }

    private var enterButton: some View {
        Button {
            perform {
                // Save once, explicitly check enabled engines, then initialize Chat.
                try await providerDraft.save()
                try await refresh()
                do {
                    self.status = try await FirstRunSetupAPI.request("first-run/check-and-complete",
                        body: ["language": AppLanguageController.shared.languageCode])
                } catch {
                    let failure = error
                    try? await refresh()
                    throw failure
                }
                if let sessionId = self.status?.assistantSessionId {
                    AppTabRouter.shared.openSession(sessionId, source: .userSelection)
                }
            }
        } label: {
            HStack(spacing: 8) {
                if busy { ProgressView().controlSize(.small) }
                Text(L10n(busy ? "正在准备配置或检测执行引擎…" : "检测已开启provider并进入corptie"))
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

    /// Account discovery/import is local preparation, never a model probe.
    private func autoPrepareIfNeeded() async {
        guard !didAutoPrepare, FirstRunStatus.requiresSetup(status) else { return }
        didAutoPrepare = true
        let accountProviders = providerDraft.providers.filter { $0.accounts != nil }
        guard !accountProviders.isEmpty else {
            providerDraft.stageReadyFirstRunProviders()
            return
        }
        var failures = 0
        for provider in accountProviders {
            let endpoint = "providers/\(provider.id)/accounts"
            do {
                let detected: ProviderAccountResponse = try await FirstRunSetupAPI.request(
                    endpoint, body: ["action": "discover"])
                failures += await FirstRunAccountImport.importAll(detected.discovered ?? []) { source in
                    let _: ProviderAccountResponse = try await FirstRunSetupAPI.request(endpoint,
                        body: ["action": "import", "source": ["kind": source.kind, "path": source.path]])
                }
            } catch { failures += 1 }
        }
        do {
            let next = try await loadStatus()
            status = next
            providerDraft.receive(next)
            providerDraft.stageReadyFirstRunProviders()
        } catch { self.error = error.localizedDescription }
        if failures > 0 {
            self.error = L10n("部分本机登录来源未能导入，其他账号已保留，可通过添加账号重试。")
        }
    }

    private func perform(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true
        error = nil
        Task { @MainActor in
            defer { busy = false }
            do { try await operation() }
            catch {
                let failure = error as NSError
                firstRunLogger.error("Setup action failed domain=\(failure.domain, privacy: .public) code=\(failure.code)")
                self.error = error.localizedDescription
            }
        }
    }

}

/// Only the selected card mounts its editor. The shared card's state and draft
/// survive summary/editor changes; no timers or geometry feedback drive the animation.
struct FirstRunProviderGallery: View {
    let draft: ProviderSettingsDraft
    let busy: Bool
    let defaultProviderID: String?
    @Binding var expandedProviderID: String?
    let updated: (FirstRunProvider) -> Void
    let save: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ForEach(draft.providers) { provider in
                FirstRunProviderCard(provider: provider, busy: busy || draft.isSaving,
                    scanGeneration: 0,
                    isDefault: defaultProviderID == provider.id, updated: updated,
                    settingsDraft: draft, automaticallyChecksChanges: false, compact: true,
                    presentation: .init(expanded: expandedProviderID == provider.id,
                        expand: { expandedProviderID = provider.id }, save: save))
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.25), value: expandedProviderID)
    }
}

/// Summary values come from the current draft, rather than a previous reply test.
@MainActor
struct FirstRunProviderSummary {
    let version: String
    let account: String
    let ready: Bool

    init(provider: FirstRunProvider, draft: ProviderSettingsDraft) {
        let value = draft.values[provider.id]
        let path = value?.path ?? provider.path
        let candidate = provider.program?.candidates.first { $0.path == path }
        version = path.isEmpty ? L10n("未找到程序")
            : candidate?.version.map { L10nFormat("版本号：%@", $0) } ?? L10n("版本号：未知")
        let hasProgram = !path.isEmpty && (path == provider.path
            ? provider.executable : candidate?.state == "discovered")
        let hasAccount: Bool
        if let accounts = provider.accounts {
            let selected = accounts.accounts.first { $0.id == value?.accountId }
            account = selected?.name ?? L10n("尚未指定账号")
            hasAccount = draft.hasSpecifiedAccount(provider.id)
        } else if let runtime = provider.runtime {
            let source = value?.source ?? runtime.source
            hasAccount = !runtime.sourceChanged && (["found", "legacy"].contains(runtime.state)
                || runtime.candidates.contains { $0.state == "found" && $0.kind == source?.kind && $0.path == source?.path })
            // Some adapters expose a credential source, not an account identity.
            account = L10n(hasAccount ? "本机登录" : "尚未指定账号")
        } else {
            hasAccount = provider.checkState == "available"
            account = L10n(hasAccount ? "本机登录" : "尚未指定账号")
        }
        ready = (value?.enabled ?? provider.enabled) && hasProgram && hasAccount
    }
}

@MainActor
enum FirstRunSetupAPI {
    static func request<T: Decodable>(_ path: String, body: [String: Any]? = nil) async throws -> T {
        var request = URLRequest(url: CorptieAppEnvironment.backendBaseURL.appending(path: path))
        request.timeoutInterval = path == "first-run/check-and-complete" ? 180 : 60
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let data: Data
        let response: URLResponse
        do { (data, response) = try await URLSession.shared.data(for: request) }
        catch {
            let failure = error as NSError
            firstRunLogger.error("Transport failure operation=\(path, privacy: .public) domain=\(failure.domain, privacy: .public) code=\(failure.code)")
            throw error
        }
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let failure = try? JSONDecoder().decode(FirstRunFailure.self, from: data)
            let message = failure?.error ?? L10n("无法连接本地服务，请重试。")
            firstRunLogger.error("HTTP failure operation=\(path, privacy: .public) status=\((response as? HTTPURLResponse)?.statusCode ?? 0) requestId=\(failure?.requestId ?? "unavailable", privacy: .public)")
            throw NSError(domain: "FirstRunSetup", code: 1, userInfo: [NSLocalizedDescriptionKey: L10n(message)])
        }
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch {
            firstRunLogger.error("Response decoding failed operation=\(path, privacy: .public)")
            throw error
        }
    }
}

struct FirstRunProviderCard: View {
    struct Presentation {
        let expanded: Bool
        let expand: () -> Void
        let save: () -> Void
    }
    let presentation: Presentation?
    /// Settings and onboarding share this one draft-backed form. There is no
    /// onboarding-only immediate-submit path anymore: every edit is staged here
    /// and reaches `/first-run/settings` through the shared save action.
    let settingsDraft: ProviderSettingsDraft
    let provider: FirstRunProvider
    let busy: Bool
    let scanGeneration: Int
    /// Optional shared-form trigger. First-run disables automatic checks and
    /// uses its explicit check-and-complete action instead.
    let autoCheckGeneration: Int
    let automaticallyChecksChanges: Bool
    let compact: Bool
    let isDefault: Bool
    let updated: (FirstRunProvider) -> Void
    @State private var path: String
    @State private var addedProgramPaths: [String] = []
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
    @State private var summaryHovered = false

    init(provider: FirstRunProvider, busy: Bool, scanGeneration: Int, isDefault: Bool,
         updated: @escaping (FirstRunProvider) -> Void, settingsDraft: ProviderSettingsDraft,
         autoCheckGeneration: Int = 0, automaticallyChecksChanges: Bool = true, compact: Bool = false,
         presentation: Presentation? = nil) {
        self.settingsDraft = settingsDraft
        self.provider = provider
        self.busy = busy
        self.scanGeneration = scanGeneration
        self.autoCheckGeneration = autoCheckGeneration
        self.automaticallyChecksChanges = automaticallyChecksChanges
        self.compact = compact
        self.presentation = presentation
        self.isDefault = isDefault
        self.updated = updated
        let automatic = provider.program.map { !["manual", "controlled"].contains($0.mode) } ?? false
        let initialPath = automatic && !settingsDraft.dirtyIDs.contains(provider.id)
            ? (provider.program?.recommendedPath ?? provider.path)
            : (settingsDraft.values[provider.id]?.path ?? provider.path)
        _path = State(initialValue: initialPath)
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
        if !automaticallyChecksChanges && (hasPendingSettings || !resultMatchesSelection || !available) {
            return L10n("配置待检测 · 点击底部按钮统一检测")
        }
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
        Group {
            if let presentation {
                VStack(alignment: .leading, spacing: 10) {
                    if presentation.expanded {
                        cardHeader
                        ScrollView(.vertical) {
                            configurationFields
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .accessibilityIdentifier("provider.editor." + provider.id)
                    } else {
                        Button(action: presentation.expand) {
                            summary.padding(12)
                                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                                .contentShape(Rectangle())
                        }
                            .buttonStyle(.plain)
                            .onHover { summaryHovered = $0 }
                            .disabled(controlsBusy)
                            .accessibilityIdentifier("provider.summary." + provider.id)
                            .help(L10nFormat("配置 %@", provider.name))
                            .accessibilityLabel(L10nFormat("配置 %@", provider.name))
                    }
                }
                .padding(presentation.expanded ? 12 : 0)
                .frame(width: presentation.expanded ? 440 : 164,
                       height: presentation.expanded ? 420 : 164, alignment: .topLeading)
                .background {
                    RoundedRectangle(cornerRadius: 14)
                        .fill(Color(nsColor: .controlBackgroundColor))
                        // Card padding belongs to the editor, not the page's dismissal area.
                        .onTapGesture { }
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 14)
                        .strokeBorder(summaryHovered && !presentation.expanded
                            ? Color.accentColor.opacity(0.5) : Color.primary.opacity(0.12), lineWidth: 1)
                }
                .clipped()
            } else {
                VStack(alignment: .leading, spacing: compact ? 8 : 16) {
                    cardHeader
                    configurationFields
                }
                .padding(compact ? 10 : 20)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: compact ? 10 : 16))
                .overlay {
                    RoundedRectangle(cornerRadius: compact ? 10 : 16)
                        .strokeBorder(available && displayEnabled ? Color.accentColor.opacity(0.45) : Color.primary.opacity(0.1), lineWidth: 1)
                }
            }
        }
        .font(compact ? .system(size: 12) : .body)
        .onAppear {
            if selectionMode == "auto", settingsDraft.values[provider.id]?.path != path {
                settingsDraft.edit(provider.id, path: path)
            }
        }
        .onChange(of: provider.lastCheckedAt) { _, _ in result = provider }
        .onChange(of: provider.accounts?.accounts.map(\.id)) { _, _ in result = provider }
        .onChange(of: provider.accounts?.selectedAccountId) { _, _ in result = provider }
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
            guard automaticallyChecksChanges, autoCheckTrigger > 0 else { return }
            await commitAndCheck()
        }
        .onDisappear { autoCheckDebounce?.cancel(); cancelCheck() }

    }

    private var summary: some View {
        let values = FirstRunProviderSummary(provider: result, draft: settingsDraft)
        return VStack(spacing: 10) {
            providerIcon(size: 40)
            Text(provider.name).font(.callout.weight(.semibold)).lineLimit(1)
            VStack(spacing: 4) {
                Text(values.version).font(.caption).lineLimit(1).truncationMode(.middle)
                Text(values.account).font(.caption).lineLimit(1).truncationMode(.middle)
            }
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .top)
        .overlay(alignment: .topTrailing) {
            Circle().fill(values.ready ? Color.green : Color.secondary.opacity(0.4))
                .frame(width: 8, height: 8)
                .accessibilityLabel(L10n(values.ready ? "执行引擎配置已就绪" : "配置未就绪"))
        }
    }

    private func saveButton(_ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: "checkmark").font(.system(size: 13, weight: .semibold))
                .frame(width: 30, height: 30).contentShape(Circle())
        }
        .buttonStyle(.plain)
        .modifier(FloatingCreationButtonGlassModifier())
        .disabled(controlsBusy || testing)
        .help(L10n("保存并收起"))
        .accessibilityLabel(L10n("保存并收起"))
        .accessibilityIdentifier("provider.save." + provider.id)
    }

    private var cardHeader: some View {
        HStack(spacing: compact ? 8 : 14) {
            providerIcon
            VStack(alignment: .leading, spacing: compact ? 2 : 5) {
                HStack(spacing: 8) {
                    Text(provider.name).font(WorkbenchTypography.font(for: .cardTitle)).lineLimit(1)
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
                    Text(statusLabel).lineLimit(2)
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
            .controlSize(compact ? .small : .regular)
            .accessibilityLabel(L10nFormat("启用 %@", provider.name))
            .disabled(controlsBusy || testing || (!displayEnabled && path.isEmpty))
            if let presentation { saveButton(presentation.save) }

        }
    }

    private var configurationFields: some View {
        VStack(alignment: .leading, spacing: compact ? 8 : 16) {
            Text(L10n("执行程序")).font(.callout.weight(.semibold)).accessibilityAddTraits(.isHeader)
            programList
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
                    accountChanged: { scheduleAutoCheck() }, updated: { row in
                        result = row
                        updated(row)
                    }, compact: compact)
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
    }

    /// Settings may debounce checks after edits; first-run only stages edits.
    private func scheduleAutoCheck() {
        guard automaticallyChecksChanges else { return }
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

    @ViewBuilder
    private var programList: some View {
        Group {
            if compact {
                LazyVStack(alignment: .leading, spacing: 0) { programRows }
            } else {
                VStack(alignment: .leading, spacing: 0) { programRows }
            }
        }
        .background(Color.primary.opacity(0.025), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.primary.opacity(0.10)))
        .accessibilityIdentifier("provider.program.list")

        if result.program?.mode == "controlled" {
            Text(L10n("程序路径由运行环境指定。")).font(.caption).foregroundStyle(.secondary)
        } else if path.isEmpty {
            Text(L10n("未找到程序，请添加已安装的执行引擎可执行文件。")).font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var programRows: some View {
            ForEach(ProviderProgramChoice.rows(program: result.program, selectedPath: path, addedPaths: addedProgramPaths)) { choice in
                Button {
                    selectionMode = choice.recommended ? "auto" : "manual"
                    path = choice.path
                } label: {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: path == choice.path ? "largecircle.fill.circle" : "circle")
                            .foregroundStyle(path == choice.path ? Color.accentColor : Color.secondary)
                            .padding(.top, 2)
                        VStack(alignment: .leading, spacing: compact ? 2 : 4) {
                            HStack(spacing: 6) {
                                Text(choice.version ?? URL(fileURLWithPath: choice.path).lastPathComponent)
                                    .font(.callout.weight(.medium)).lineLimit(1)
                                if choice.prerelease { Text(L10n("预发布")).font(.caption).foregroundStyle(.secondary) }
                                if choice.recommended { Text(L10n("推荐 · 最新版本")).font(.caption).foregroundStyle(Color.accentColor).lineLimit(1) }
                            }
                            let displaySources = choice.sources.filter { $0 != "saved" }
                            if !displaySources.isEmpty {
                                Text(displaySources.map { L10n($0) }.joined(separator: " / "))
                                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            } else {
                                Text(choice.path).font(.system(size: 11, design: .monospaced))
                                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(compact ? 6 : 10)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(choice.path)
                .accessibilityLabel(choice.path)
                .accessibilityValue(L10n(path == choice.path ? "已选择" : "未选择"))
                .disabled(controlsBusy || testing || result.program?.mode == "controlled")
                Divider()
            }
            Button { chooseBinary() } label: {
                Label(L10n("添加指定二进制文件路径"), systemImage: "plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(compact ? 6 : 10).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(controlsBusy || testing || result.program?.mode == "controlled")
            .accessibilityIdentifier("provider.program.add")
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

    private var providerIcon: some View { providerIcon(size: compact ? 26 : 40) }

    private func providerIcon(size: CGFloat) -> some View {
        Group {
            if let icon = ProviderBrandIcon.image(for: provider.id, providers: []) {
                Image(nsImage: icon).resizable().scaledToFit()
            } else {
                Image(systemName: "terminal").font(.title2)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
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
            if !addedProgramPaths.contains(url.path) { addedProgramPaths.append(url.path) }
            selectionMode = "manual"
            path = url.path
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
