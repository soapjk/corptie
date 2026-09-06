import AppKit
import Combine
import SwiftUI

private struct FirstRunAssistantResponse: Decodable { let sessionId: String }
private struct FirstRunFailure: Decodable { let error: String }

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
    let defaultProviderId: String?
    let assistantSessionId: String?
    let workSessionId: String?

    var canContinue: Bool { providers.contains { $0.enabled && $0.executable && $0.checkState == "available" } }

    static func requiresSetup(_ status: FirstRunStatus?) -> Bool {
        status?.completed == false
    }
}

// Only startup/reconnect and explicit actions refresh this small projection.
// The main tab tree is not mounted behind the first-run page.
struct FirstRunSetupRoot<Content: View>: View {
    @ViewBuilder let content: () -> Content
    @State private var status: FirstRunStatus?
    @State private var error: String?
    @State private var busy = false
    @State private var showingWork = false
    @State private var browsingHelp = false
    @State private var creatingWork = false
    @State private var dirtyProviders = Set<String>()
    @State private var scanGeneration = 0

    var body: some View {
        Group {
            if !FirstRunStatus.requiresSetup(status) {
                content()
            } else if browsingHelp {
                VStack(spacing: 0) {
                    HStack {
                        Text(L10n("使用问题随时问 Corptie；创建第一个 Work 后即可开始工作。"))
                        Spacer()
                        Button(L10n("返回首次设置")) { browsingHelp = false }
                    }
                    .padding(12)
                    content()
                }
            } else {
                setupPage
            }
        }
        .onReceive(BackendClient.shared.$isOnline.removeDuplicates()) { online in
            guard online, status == nil else { return }
            perform { try await refresh() }
        }
        .sheet(isPresented: $creatingWork) {
            WorkCreateView(isFirstRun: true) { _ in
                creatingWork = false
                perform { try await refresh() }
            }
        }
    }

    private var setupPage: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text("Corptie")
                    .font(.system(size: 30, weight: .semibold))
                Text(L10n(showingWork ? "2 / 2 · 创建第一个 Work" : "1 / 2 · 设置 Provider"))
                    .font(.headline)
                if let status {
                    if showingWork {
                        workStep(status)
                    } else {
                        Text(L10n("自动检测，启用即可开始。"))
                            .foregroundStyle(.secondary)
                        ForEach(status.providers) { provider in
                            FirstRunProviderCard(provider: provider, busy: busy, scanGeneration: scanGeneration, pathChanged: { dirty in
                                if dirty { dirtyProviders.insert(provider.id) }
                                else { dirtyProviders.remove(provider.id) }
                            }, updated: { row in
                                if let index = self.status?.providers.firstIndex(where: { $0.id == row.id }) {
                                    self.status?.providers[index] = row
                                }
                                dirtyProviders.remove(row.id)
                            })
                        }
                        HStack {
                            Button(L10n("重新检测")) { scanGeneration += 1 }
                            Spacer()
                            Button(L10n("继续")) { prepareAssistant() }
                                .buttonStyle(.borderedProminent)
                                .disabled(busy || !status.providers.contains {
                                    $0.enabled && $0.checkState == "available" && !dirtyProviders.contains($0.id)
                                })
                        }
                    }
                } else if !busy {
                    Text(L10n("正在等待本地服务启动。"))
                        .foregroundStyle(.secondary)
                    Button(L10n("重试")) { perform { try await refresh() } }
                }
                if busy {
                    ProgressView(L10n("正在准备…"))
                        .controlSize(.small)
                }
                if let error {
                    Text(error)
                        .foregroundStyle(.red)
                        .textSelection(.enabled)
                        .accessibilityLabel(L10nFormat("设置失败：%@", error))
                }
            }
            .frame(maxWidth: 640, alignment: .leading)
            .padding(32)
            .frame(maxWidth: .infinity)
        }
        .disabled(busy)
    }

    private func workStep(_ status: FirstRunStatus) -> some View {
        VStack(alignment: .leading, spacing: 20) {
            Text(L10n("Work 是你组织一项工作的空间。为它起个名字，选择工作目录和负责工作的 Agent。"))
                .foregroundStyle(.secondary)
            VStack(alignment: .leading, spacing: 8) {
                Label(L10n("Corptie Chat 已准备好"), systemImage: "bubble.left.and.bubble.right")
                    .font(.headline)
                Text(L10n("关于软件的使用、设置和管理，随时在 Chat 中问 Corptie。"))
                    .foregroundStyle(.secondary)
                Button(L10n("问问 Corptie")) {
                    guard let sessionId = status.assistantSessionId else { return }
                    AppTabRouter.shared.openSession(sessionId, source: .userSelection)
                    browsingHelp = true
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
            if status.hasWorks {
                Label(L10n("第一个 Work 已创建"), systemImage: "checkmark.circle")
                Button(L10n("开始使用")) {
                    perform {
                        self.status = try await FirstRunSetupAPI.request("first-run/complete", body: [:])
                        if let sessionId = self.status?.workSessionId {
                            AppTabRouter.shared.openSession(sessionId, source: .userSelection)
                        } else {
                            AppTabRouter.shared.selectTab(.console)
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
            } else {
                Button(L10n("创建第一个 Work")) { creatingWork = true }
                    .buttonStyle(.borderedProminent)
            }
            Button(L10n("返回 Provider 设置")) { showingWork = false }
        }
    }

    private func prepareAssistant() {
        perform {
            let _: FirstRunAssistantResponse = try await FirstRunSetupAPI.request("first-run/assistant", body: [:])
            try await refresh()
            showingWork = true
        }
    }

    private func refresh() async throws {
        let result: FirstRunStatus = try await FirstRunSetupAPI.request("first-run")
        status = result
        if result.canContinue && result.assistantSessionId != nil { showingWork = true }
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
    let pathChanged: (Bool) -> Void
    let updated: (FirstRunProvider) -> Void
    @State private var path: String
    @State private var result: FirstRunProvider
    @State private var testing = false
    @State private var saving = false
    @State private var error: String?
    @State private var checkGeneration = 0

    init(provider: FirstRunProvider, busy: Bool, scanGeneration: Int,
         pathChanged: @escaping (Bool) -> Void, updated: @escaping (FirstRunProvider) -> Void) {
        self.provider = provider
        self.busy = busy
        self.scanGeneration = scanGeneration
        self.pathChanged = pathChanged
        self.updated = updated
        _path = State(initialValue: provider.path)
        _result = State(initialValue: provider)
    }

    private var available: Bool {
        !testing && result.path == path && result.checkState == "available"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(provider.name).font(.headline)
                if testing {
                    ProgressView().controlSize(.small)
                        .accessibilityLabel(L10n("检测中"))
                } else if available {
                    Image(systemName: "checkmark.seal.fill")
                        .foregroundStyle(.green)
                        .accessibilityLabel(L10n("可用"))
                        .help(L10n("可用"))
                } else if result.checkState == "failed" {
                    Image(systemName: "exclamationmark.circle")
                        .foregroundStyle(.orange)
                        .accessibilityLabel(L10n("不可用"))
                }
                Spacer()
                Toggle(L10n("启用"), isOn: Binding(
                    get: { available && result.enabled },
                    set: { enabled in Task { await setEnabled(enabled) } }
                ))
                .toggleStyle(.checkbox)
                .disabled(!available || saving || busy)
            }
            HStack {
                TextField(L10n("二进制路径"), text: $path)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityLabel(L10nFormat("%@ 二进制路径", provider.name))
                    .disabled(saving)
                Button(L10n("选择…")) { chooseBinary() }
                    .disabled(saving)
                Button(L10n("重试")) { checkGeneration += 1 }
                    .disabled(testing || saving || path.isEmpty)
            }
            if let message = error ?? (result.path == path ? result.message : nil) {
                Text(message).font(.caption).foregroundStyle(.secondary)
            } else if path.isEmpty {
                Text(L10n("未找到程序，请选择路径。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
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
