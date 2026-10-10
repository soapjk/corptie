import AppKit
import Combine
import SwiftUI

private struct FirstRunFailure: Decodable { let error: String }

private enum FirstRunBrandAssets {
    // Copied SwiftPM resources are loaded by URL, rather than asset-catalog
    // lookup. Decode once, including when the page redraws during a check.
    static let appIcon: NSImage? = Bundle.module.url(forResource: "AppIcon", withExtension: "png")
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
    @State private var status: FirstRunStatus?
    @State private var error: String?
    @State private var busy = false
    @State private var dirtyProviders = Set<String>()
    @State private var scanGeneration = 0
    @State private var defaultRefreshGeneration = 0

    init(initialStatus: FirstRunStatus? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.content = content
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
        .onReceive(BackendClient.shared.$isOnline.removeDuplicates()) { online in
            guard online, status == nil else { return }
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
                                Label(L10n("重新检测"), systemImage: "arrow.clockwise")
                            }
                            .disabled(busy)
                        }
                        if let status {
                            ForEach(status.providers) { provider in
                                FirstRunProviderCard(provider: provider, busy: busy, scanGeneration: scanGeneration,
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
                                if busy {
                                    ProgressView(L10n("正在准备…"))
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
        status = try await FirstRunSetupAPI.request("first-run")
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
private enum FirstRunSetupAPI {
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
            throw NSError(domain: "FirstRunSetup", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

private struct FirstRunProviderCard: View {
    let provider: FirstRunProvider
    let busy: Bool
    let scanGeneration: Int
    let isDefault: Bool
    let pathChanged: (Bool) -> Void
    let updated: (FirstRunProvider) -> Void
    @State private var path: String
    @State private var result: FirstRunProvider
    @State private var testing = false
    @State private var saving = false
    @State private var error: String?
    @State private var checkGeneration = 0
    @State private var editingPath = false

    init(provider: FirstRunProvider, busy: Bool, scanGeneration: Int, isDefault: Bool,
         pathChanged: @escaping (Bool) -> Void, updated: @escaping (FirstRunProvider) -> Void) {
        self.provider = provider
        self.busy = busy
        self.scanGeneration = scanGeneration
        self.isDefault = isDefault
        self.pathChanged = pathChanged
        self.updated = updated
        _path = State(initialValue: provider.path)
        _result = State(initialValue: provider)
    }

    private var available: Bool {
        !testing && result.path == path && result.checkState == "available"
    }

    private var statusLabel: String {
        if testing { return L10n("检测中") }
        if saving { return L10n("正在保存…") }
        if path != result.path { return L10n("等待检测") }
        if available { return L10n(result.enabled ? "已就绪" : "可用 · 未启用") }
        switch result.checkState {
        case "missing": return L10n("未找到程序")
        case "failed": return L10n("需要修复")
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
                .disabled(!available || saving || busy)
            }
            if available && !editingPath {
                HStack {
                    Text(L10n("已通过实际回复检测"))
                        .font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button(L10n("更改配置…")) { editingPath = true }
                        .disabled(busy || saving)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
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
            if let message = error ?? (result.path == path ? result.message : nil) {
                Label(message, systemImage: "exclamationmark.circle")
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
        .onChange(of: path) { _, value in
            testing = false
            error = nil
            pathChanged(value != result.path)
        }
        .task(id: "\(path)|\(scanGeneration)|\(checkGeneration)") {
            let shouldCheck = result.path != path || (!path.isEmpty && (result.checkState == "unknown"
                || result.checkState == "checking" || scanGeneration > 0 || checkGeneration > 0))
            guard shouldCheck else { return }
            do {
                if result.path != path { try await Task.sleep(for: .milliseconds(600)) }
                try Task.checkCancellation()
                await check()
            } catch { }
        }
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
        TextField(L10n("二进制路径"), text: $path)
            .font(.system(.body, design: .monospaced))
            .textFieldStyle(.roundedBorder)
            .accessibilityLabel(L10nFormat("%@ 二进制路径", provider.name))
            .disabled(saving || busy)
    }

    private var pathActions: some View {
        HStack {
            Button(L10n("选择…")) { chooseBinary() }
                .disabled(saving || busy)
            Button(L10n("重试")) { checkGeneration += 1 }
                .disabled(testing || saving || busy || path.isEmpty)
        }
    }

    private func check() async {
        let requestedPath = path
        testing = true
        error = nil
        pathChanged(true)
        do {
            let row: FirstRunProvider = try await FirstRunSetupAPI.request("first-run/check", body: [
                "providerId": provider.id, "path": requestedPath
            ])
            guard !Task.isCancelled, requestedPath == path else { return }
            result = row
            updated(row)
            pathChanged(false)
        } catch {
            guard !Task.isCancelled, requestedPath == path else { return }
            self.error = error.localizedDescription
        }
        if requestedPath == path { testing = false }
    }

    private func setEnabled(_ enabled: Bool) async {
        guard !saving else { return }
        saving = true
        pathChanged(true)
        defer {
            saving = false
            pathChanged(path != result.path)
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
        if panel.runModal() == .OK, let url = panel.url { path = url.path }
    }
}
