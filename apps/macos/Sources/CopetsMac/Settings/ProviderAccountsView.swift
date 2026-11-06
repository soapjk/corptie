import AppKit
import SwiftUI

struct ProviderAccountsProjection: Decodable {
    let selectedAccountId: String?
    let accounts: [ProviderAccount]
    let sourceKinds: [String]
    let candidates: [ProviderCredentialSource]
    let activeLogin: ProviderAccountLogin?
}

struct ProviderAccount: Decodable, Identifiable {
    let id: String
    let name: String
    let accountLabel: String
    let state: String
    let runtimeDirectory: String
    let credentialPath: String
    let importedFrom: String?
    let sessionCount: Int
    let canSelect: Bool
    let canDelete: Bool
    let canReauthorize: Bool
    let deletionReason: String?

    @MainActor var status: String {
        switch state {
        case "ready": L10n("凭证已保存")
        case "external": L10n("由原生环境管理")
        case "signing_in": L10n("等待登录")
        case "identity_changed": L10n("凭证账号已变更")
        default: L10n("需要更新凭证")
        }
    }
}

struct ProviderAccountLogin: Decodable {
    let id: String
    let state: String
    let authUrl: URL?
    let message: String?
}

private struct ProviderAccountResponse: Decodable {
    let accounts: ProviderAccountsProjection
    let flow: ProviderAccountLogin?
}

struct ProviderAccountsView: View {
    let provider: FirstRunProvider
    let projection: ProviderAccountsProjection
    let draft: ProviderSettingsDraft?
    let disabled: Bool
    let updated: (FirstRunProvider) -> Void
    @State private var managing = false
    @State private var saving = false
    @State private var error: String?

    private var selection: String { draft?.values[provider.id]?.accountId ?? projection.selectedAccountId ?? "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Picker(L10n("默认账号"), selection: Binding(get: { selection }, set: select)) {
                    if selection.isEmpty { Text(L10n("请选择账号")).tag("") }
                    ForEach(projection.accounts.filter { $0.canSelect || $0.id == selection }) { account in
                        Text(account.name).tag(account.id)
                    }
                }
                .disabled(disabled || saving)
                Button(L10n("管理账号…")) { managing = true }.disabled(disabled || saving)
            }
            Text(L10n("默认账号用于新会话，已有会话继续使用原来绑定的账号。"))
                .font(.caption).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red).font(.caption) }
        }
        .sheet(isPresented: $managing) {
            ProviderAccountManagerSheet(providerId: provider.id, projection: projection, changed: refresh)
        }
    }

    private func select(_ id: String) {
        if let draft {
            draft.edit(provider.id, accountId: id)
        } else {
            saving = true
            Task {
                defer { saving = false }
                do {
                    let status: FirstRunStatus = try await FirstRunSetupAPI.request("first-run/settings", body: [
                        "providers": [["providerId": provider.id, "enabled": provider.enabled,
                                       "path": provider.program?.adoptedPath ?? provider.path, "accountId": id]]
                    ])
                    if let row = status.providers.first(where: { $0.id == provider.id }) { updated(row) }
                    error = nil
                } catch { self.error = error.localizedDescription }
            }
        }
    }

    private func refresh(_ accounts: ProviderAccountsProjection) {
        var row = provider
        row.accounts = accounts
        updated(row)
    }
}

private struct ProviderAccountManagerSheet: View {
    let providerId: String
    let changed: (ProviderAccountsProjection) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var projection: ProviderAccountsProjection
    @State private var selection = ""
    @State private var name = ""
    @State private var sourceKind = "file"
    @State private var sourcePath = ""
    @State private var busy = false
    @State private var error: String?
    @State private var confirmDelete = false

    init(providerId: String, projection: ProviderAccountsProjection, changed: @escaping (ProviderAccountsProjection) -> Void) {
        self.providerId = providerId
        self.changed = changed
        _projection = State(initialValue: projection)
    }

    private var account: ProviderAccount? { projection.accounts.first { $0.id == selection } }
    private var endpoint: String { "providers/\(providerId)/accounts" }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n("管理账号")).font(.title2)
            Text(L10n("每个账号使用独立的运行目录。导入会复制凭证，后续由该运行目录保存刷新结果。账号管理操作立即保存。"))
                .font(.caption).foregroundStyle(.secondary)
            Picker(L10n("账号"), selection: $selection) {
                Text(L10n("添加账号")).tag("")
                ForEach(projection.accounts) { Text($0.name).tag($0.id) }
            }
            .onChange(of: selection) { _, _ in name = account?.name ?? "" }
            if let account {
                Text("\(account.accountLabel) · \(account.status)")
                Text(L10nFormat("绑定会话：%@", String(account.sessionCount)))
                LabeledContent(L10n("运行目录"), value: account.runtimeDirectory).textSelection(.enabled)
                LabeledContent(L10n("凭证文件"), value: account.credentialPath).textSelection(.enabled)
                if let origin = account.importedFrom {
                    LabeledContent(L10n("导入来源"), value: origin).textSelection(.enabled)
                }
            }
            TextField(L10n("账号名称"), text: $name)
            HStack {
                if let account {
                    Button(L10n("保存名称")) { perform("rename") }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button(L10n("重新登录…")) { perform("login") }
                        .disabled(!account.canReauthorize || projection.activeLogin != nil)
                    Button(L10n("删除账号…"), role: .destructive) { confirmDelete = true }
                        .disabled(!account.canDelete)
                        .help(account.deletionReason ?? "")
                } else {
                    Button(L10n("通过官方页面登录…")) { perform("login") }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || projection.activeLogin != nil)
                }
            }
            Divider()
            if account?.canReauthorize != false {
                HStack {
                    Picker(L10n("凭证来源"), selection: $sourceKind) {
                        ForEach(projection.sourceKinds, id: \.self) { kind in
                            Text(sourceLabel(kind)).tag(kind)
                        }
                    }
                    Menu(L10n("本机来源")) {
                        ForEach(projection.candidates) { source in
                            Button("\(sourceLabel(source.kind)) · \(source.path)") {
                                sourceKind = source.kind
                                sourcePath = source.path
                            }
                        }
                    }.disabled(projection.candidates.isEmpty)
                }
                HStack {
                    TextField(L10n("凭证绝对路径"), text: $sourcePath)
                    Button(L10n("选择…"), action: chooseSource)
                    Button(account == nil ? L10n("导入账号") : L10n("更新凭证")) { perform("import") }
                        .disabled(!sourcePath.hasPrefix("/") || (account == nil && name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                if let login = projection.activeLogin {
                    Text(L10n("等待浏览器完成登录…")).foregroundStyle(.secondary)
                    Button(L10n("取消登录")) { perform("cancelLogin", loginId: login.id) }
                }
                Spacer()
                Button(L10n("完成")) { dismiss() }
            }
        }
        .disabled(busy)
        .padding(24)
        .frame(width: 660)
        .confirmationDialog(L10n("删除此账号保存的凭证？"), isPresented: $confirmDelete) {
            Button(L10n("删除账号"), role: .destructive) { perform("delete") }
        } message: {
            Text(L10n("运行数据和原始凭证来源会保留。"))
        }
        .task(id: projection.activeLogin?.id) {
            guard let id = projection.activeLogin?.id else { return }
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: .seconds(2))
                    if busy { continue }
                    let result: ProviderAccountResponse = try await FirstRunSetupAPI.request(endpoint,
                        body: ["action": "loginStatus", "loginId": id])
                    guard !Task.isCancelled else { return }
                    apply(result)
                    if result.flow?.state != "pending" { return }
                } catch {
                    if !Task.isCancelled { self.error = error.localizedDescription }
                    return
                }
            }
        }
    }

    private func sourceLabel(_ kind: String) -> String {
        switch kind {
        case "directory": L10n("Codex Home 目录")
        case "keychain": L10n("系统钥匙串（按 Codex Home）")
        default: L10n("凭证文件")
        }
    }

    private func chooseSource() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = sourceKind != "file"
        panel.canChooseFiles = sourceKind == "file"
        panel.showsHiddenFiles = true
        if panel.runModal() == .OK, let url = panel.url { sourcePath = url.path }
    }

    private func apply(_ result: ProviderAccountResponse) {
        projection = result.accounts
        changed(projection)
        if let message = result.flow?.message { error = message }
    }

    private func perform(_ action: String, loginId: String? = nil) {
        busy = true
        error = nil
        var body: [String: Any] = ["action": action, "name": name]
        if let account { body["accountId"] = account.id }
        if let loginId { body["loginId"] = loginId }
        if action == "import" { body["source"] = ["kind": sourceKind, "path": sourcePath] }
        Task {
            defer { busy = false }
            do {
                let result: ProviderAccountResponse = try await FirstRunSetupAPI.request(endpoint, body: body)
                apply(result)
                if action == "login", let url = result.flow?.authUrl, url.scheme == "https",
                   let host = url.host, host == "chatgpt.com" || host.hasSuffix(".openai.com"),
                   url.user == nil, url.password == nil {
                    if !NSWorkspace.shared.open(url) { error = L10n("无法打开官方登录页面，请取消后重试。") }
                }
                if action == "delete" { selection = "" }
            } catch { self.error = error.localizedDescription }
        }
    }
}
