import AppKit
import SwiftUI

struct ProviderCredentialSource: Decodable, Equatable, Identifiable {
    var id: String { "\(kind)|\(path)" }
    var state: String? = nil
    let kind: String
    let path: String
}

struct ProviderRuntimeSettingsProjection: Decodable {
    let runtimeDirectory: String
    let credentialTarget: String?
    let formatDescription: String?
    let reuseMethod: String
    let sourceKinds: [String]
    let candidates: [ProviderCredentialSource]
    let source: ProviderCredentialSource?
    let state: String
    let message: String
    let sourceChanged: Bool
}

struct ProviderRuntimeSettingsView: View {
    let providerId: String
    let runtime: ProviderRuntimeSettingsProjection
    let busy: Bool
    let updated: (FirstRunProvider) -> Void
    let sourceDraft: ProviderCredentialSource?
    let sourceEdited: ((ProviderCredentialSource) -> Void)?
    @State private var kind: String
    @State private var path: String
    @State private var saving = false
    @State private var error: String?

    init(providerId: String, runtime: ProviderRuntimeSettingsProjection, busy: Bool,
         sourceDraft: ProviderCredentialSource? = nil, sourceEdited: ((ProviderCredentialSource) -> Void)? = nil,
         updated: @escaping (FirstRunProvider) -> Void) {
        self.providerId = providerId
        self.runtime = runtime
        self.busy = busy
        self.updated = updated
        self.sourceDraft = sourceDraft
        self.sourceEdited = sourceEdited
        _kind = State(initialValue: sourceDraft?.kind ?? runtime.source?.kind ?? runtime.candidates.first?.kind ?? "directory")
        _path = State(initialValue: sourceEdited != nil ? (sourceDraft?.path ?? "") : (runtime.source?.path ?? runtime.candidates.first?.path ?? ""))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Divider()
            Text(L10n("独立运行目录")).font(.callout.weight(.medium))
            Text(verbatim: runtime.runtimeDirectory).font(.caption.monospaced()).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text(L10n("由 Corptie 自动创建，用于保存此引擎的独立配置、运行数据和集成资源。"))
                .font(.caption).foregroundStyle(.secondary)
            Button(L10n("在 Finder 中显示")) {
                NSWorkspace.shared.open(URL(fileURLWithPath: runtime.runtimeDirectory, isDirectory: true))
            }
            Text(L10n("官方登录凭证来源")).font(.callout.weight(.medium))
            if runtime.sourceKinds.isEmpty {
                Text(L10n(runtime.message)).font(.caption).foregroundStyle(.secondary)
            } else {
                if let description = runtime.formatDescription {
                    Text(L10n(description)).font(.caption).foregroundStyle(.secondary)
                }
                Picker(L10n("来源类型"), selection: $kind) {
                    ForEach(runtime.sourceKinds, id: \.self) { value in
                        Text(label(value)).tag(value)
                    }
                }
                TextField(L10n("凭证来源的绝对路径"), text: $path)
                    .textFieldStyle(.roundedBorder).font(.caption.monospaced())
                    .accessibilityLabel(L10n("凭证来源路径"))
                HStack {
                    Button(L10n("选择来源…")) { chooseSource() }
                    if !runtime.candidates.isEmpty {
                        Menu(L10n("发现的候选来源")) {
                            ForEach(runtime.candidates) { candidate in
                                Button("\(candidate.path) · \(candidate.state == "found" ? L10n("本地可读取") : L10n("未找到或不可读取"))") { kind = candidate.kind; path = candidate.path }
                            }
                        }
                    }
                    if sourceEdited == nil {
                        Button(L10n("应用凭证来源")) { Task { await save() } }
                            .disabled(path.isEmpty)
                    }
                    if saving { ProgressView().controlSize(.small) }
                }
                .disabled(busy || saving)
                Text(L10n(runtime.message)).font(.caption).foregroundStyle(.secondary)
                Button(L10n("重新检查本地状态")) { Task { await refresh() } }
                    .disabled(busy || saving)
                Text(L10n("请在官方 CLI 或 App 中登录、退出或切换账号。Corptie 不提供登录流程；保存来源仅做本地检查，不会发送模型请求。"))
                    .font(.caption).foregroundStyle(.secondary)
                Text(L10n("保存来源将确认使用其中的当前账号，并影响此引擎后续的新请求；不会中断正在执行的请求。"))
                    .font(.caption).foregroundStyle(.secondary)
                if let target = runtime.credentialTarget {
                    Text(L10n("后续请求前会将所选来源的凭证同步到以下本地文件，不会写回来源。来源丢失时会停止使用，不会自动切换账号。"))
                        .font(.caption).foregroundStyle(.secondary)
                    Text(verbatim: target).font(.caption.monospaced()).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !runtime.sourceKinds.contains("keychain") {
                    Text(L10n("此适配器当前支持凭证目录和文件，不支持直接读取系统钥匙串。"))
                        .font(.caption).foregroundStyle(.secondary)
                } else if kind == "keychain" {
                    Text(L10n("请选择官方登录环境目录。读取其系统钥匙串凭证时，macOS 可能请求授权。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .onChange(of: kind) { _, _ in sourceEdited?(.init(kind: kind, path: path)) }
        .onChange(of: path) { _, _ in sourceEdited?(.init(kind: kind, path: path)) }
        .onChange(of: sourceDraft) { _, source in
            if let source { kind = source.kind; path = source.path }
        }
    }

    private func label(_ kind: String) -> String {
        L10n(kind == "file" ? "凭证文件" : kind == "keychain" ? "官方环境的钥匙串凭证" : "官方配置目录")
    }

    private func chooseSource() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = kind != "file"
        panel.canChooseFiles = kind == "file"
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        if panel.runModal() == .OK, let url = panel.url { path = url.path }
    }

    @MainActor private func refresh() async {
        saving = true
        error = nil
        defer { saving = false }
        do {
            let status: FirstRunStatus = try await FirstRunSetupAPI.request("first-run")
            if let row = status.providers.first(where: { $0.id == providerId }) { updated(row) }
        } catch { self.error = error.localizedDescription }
    }

    @MainActor private func save() async {
        saving = true
        error = nil
        defer { saving = false }
        do {
            let row: FirstRunProvider = try await FirstRunSetupAPI.request("first-run/credentials", body: [
                "providerId": providerId, "kind": kind, "path": path
            ])
            updated(row)
        } catch { self.error = error.localizedDescription }
    }
}
