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
    let origin: String?
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
    let discovered: [DiscoveredAccountSource]?
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
                Picker(L10n("当前使用账号"), selection: Binding(get: { selection }, set: select)) {
                    if selection.isEmpty { Text(L10n("请选择账号")).tag("") }
                    ForEach(projection.accounts.filter { $0.canSelect || $0.id == selection }) { account in
                        Text(account.name).tag(account.id)
                    }
                }
                .disabled(disabled || saving)
                Button(L10n("管理账号…")) { managing = true }.disabled(disabled || saving)
            }
            Text(L10n("新会话使用此账号。打开旧会话时，会用此账号恢复原线程。运行中的请求会先完成。"))
                .font(.caption).foregroundStyle(.secondary)
            if draft != nil {
                Text(L10n("切换账号在点击页面底部“保存设置”后生效。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
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

private struct DiscoveredAccountSource: Decodable, Identifiable {
    let kind: String
    let path: String
    let label: String
    var id: String { "\(kind)|\(path)" }
}

private struct ProviderAccountManagerSheet: View {
    private enum Page { case accounts, method, local }
    let providerId: String
    let changed: (ProviderAccountsProjection) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var projection: ProviderAccountsProjection
    @State private var page = Page.accounts
    @State private var sources: [DiscoveredAccountSource] = []
    @State private var target: ProviderAccount?
    @State private var editing: String?
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @State private var deletion: ProviderAccount?
    @State private var showDelete = false
    @State private var showCustomSource = false

    init(providerId: String, projection: ProviderAccountsProjection, changed: @escaping (ProviderAccountsProjection) -> Void) {
        self.providerId = providerId
        self.changed = changed
        _projection = State(initialValue: projection)
    }

    private var endpoint: String { "providers/\(providerId)/accounts" }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            Group {
                switch page {
                case .accounts: accountList
                case .method: addMethods
                case .local: localSources
                }
            }
            .disabled(busy)
            if let login = projection.activeLogin {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(L10n("等待浏览器完成登录…"))
                    Button(L10n("取消登录")) { perform("cancelLogin", fields: ["loginId": login.id]) }
                        .disabled(busy)
                }
                .font(.caption)
            }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            HStack {
                if page != .accounts {
                    Button(L10n("返回")) {
                        page = page == .local ? .method : .accounts
                        error = nil
                    }
                    .disabled(busy)
                }
                Spacer()
                Button(L10n("完成")) { dismiss() }
            }
        }
        .padding(18)
        .frame(width: 460)
        .confirmationDialog(L10n("删除此账号？"), isPresented: $showDelete, presenting: deletion) { account in
            Button(L10n("删除账号"), role: .destructive) {
                perform("delete", fields: ["accountId": account.id])
            }
        } message: { _ in
            Text(L10n("运行数据和原始凭证来源会保留。"))
        }
        .confirmationDialog(L10n("指定凭证路径"), isPresented: $showCustomSource) {
            if projection.sourceKinds.contains("file") {
                Button(L10n("选择凭证文件…")) { chooseSource(kind: "file") }
            }
            if projection.sourceKinds.contains("directory") {
                Button(L10n("选择 Codex Home…")) { chooseSource(kind: "directory") }
            }
            if projection.sourceKinds.contains("keychain") {
                Button(L10n("按 Codex Home 从钥匙串读取…")) { chooseSource(kind: "keychain") }
            }
        }
        .task(id: projection.activeLogin?.id) { await pollLogin() }
    }

    private var title: String {
        switch page {
        case .accounts: L10n("管理账号")
        case .method: target == nil ? L10n("添加账号") : L10n("更新凭证")
        case .local: L10n("本机已有登录")
        }
    }

    private var accountList: some View {
        VStack(alignment: .leading, spacing: 8) {
            if projection.accounts.isEmpty {
                Text(L10n("还没有登记的账号。")).foregroundStyle(.secondary)
            } else {
                List(projection.accounts) { account in accountRow(account) }
                    .frame(height: min(230, CGFloat(projection.accounts.count) * 54 + 10))
            }
            Button {
                target = nil
                error = nil
                page = .method
            } label: {
                Label(L10n("添加账号"), systemImage: "plus")
            }
            .disabled(projection.activeLogin != nil)
        }
    }

    private func accountRow(_ account: ProviderAccount) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 3) {
                if editing == account.id {
                    TextField(L10n("账号名称"), text: $name).onSubmit { rename(account) }
                } else {
                    Button(account.name) { name = account.name; editing = account.id }
                        .buttonStyle(.plain)
                        .help(L10n("点击改名"))
                }
                Text(originLabel(account))
                    .font(.caption).foregroundStyle(.secondary)
                if account.state != "ready" { Text(account.status).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            if editing == account.id {
                Button(L10n("保存")) { rename(account) }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(L10n("取消")) { editing = nil }
            } else if account.canReauthorize {
                Menu {
                    Button(L10n("更新凭证…")) { target = account; error = nil; page = .method }
                } label: {
                    Image(systemName: "ellipsis.circle").accessibilityLabel(L10n("账号操作"))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(projection.activeLogin != nil)
            }
            Button {
                if account.canDelete { deletion = account; showDelete = true }
                else { error = account.deletionReason ?? L10n("此账号暂时不能删除。") }
            } label: {
                Image(systemName: "trash").foregroundStyle(account.canDelete ? Color.primary : Color.secondary)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(L10nFormat("删除 %@", account.name))
            .help(account.deletionReason ?? L10n("删除账号"))
        }
    }

    private func originLabel(_ account: ProviderAccount) -> String {
        switch account.origin {
        case "legacy": L10n("原有 Corptie 环境")
        case "imported", "native": L10n("从本机导入")
        default: account.importedFrom == nil ? L10n("在 Corptie 中登录") : L10n("从本机导入")
        }
    }

    private var addMethods: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(L10n("登录 Codex")) {
                perform("login", fields: targetFields) { _ in page = .accounts }
            }
            Button(L10n("使用本机已有登录")) {
                perform("discover") { result in
                    sources = result.discovered ?? []
                    page = .local
                }
            }
        }
    }

    private var localSources: some View {
        VStack(alignment: .leading, spacing: 8) {
            if sources.isEmpty {
                Text(L10n("未发现本机登录凭证。")).foregroundStyle(.secondary)
            }
            List {
                ForEach(sources) { source in
                    Button {
                        importSource(kind: source.kind, path: source.path)
                    } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(source.label)
                            Text(source.path).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
                Button { showCustomSource = true } label: {
                    Label(L10n("指定路径…"), systemImage: "folder")
                }
                .buttonStyle(.plain)
            }
            .frame(height: min(210, CGFloat(sources.count) * 48 + 54))
        }
    }

    private var targetFields: [String: Any] { target.map { ["accountId": $0.id] } ?? [:] }

    private func rename(_ account: ProviderAccount) {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        perform("rename", fields: ["accountId": account.id, "name": name]) { _ in editing = nil }
    }

    private func chooseSource(kind: String) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = kind != "file"
        panel.canChooseFiles = kind == "file"
        panel.showsHiddenFiles = true
        if panel.runModal() == .OK, let url = panel.url { importSource(kind: kind, path: url.path) }
    }

    private func importSource(kind: String, path: String) {
        var fields = targetFields
        fields["source"] = ["kind": kind, "path": path]
        perform("import", fields: fields) { _ in page = .accounts }
    }

    private func apply(_ result: ProviderAccountResponse) {
        projection = result.accounts
        changed(projection)
        if let message = result.flow?.message { error = message }
    }

    private func pollLogin() async {
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

    private func perform(_ action: String, fields: [String: Any] = [:],
                         completed: @escaping (ProviderAccountResponse) -> Void = { _ in }) {
        busy = true
        error = nil
        var body = fields
        body["action"] = action
        Task {
            defer { busy = false }
            do {
                let result: ProviderAccountResponse = try await FirstRunSetupAPI.request(endpoint, body: body)
                apply(result)
                completed(result)
                if action == "login", let url = result.flow?.authUrl, url.scheme == "https",
                   let host = url.host, host == "chatgpt.com" || host.hasSuffix(".openai.com"),
                   url.user == nil, url.password == nil {
                    if !NSWorkspace.shared.open(url) { error = L10n("无法打开官方登录页面，请取消后重试。") }
                }
            } catch { self.error = error.localizedDescription }
        }
    }
}
