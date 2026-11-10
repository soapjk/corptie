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
    let removesListingOnly: Bool?
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
    let accountId: String?
}

/// Shared with the onboarding container so first run can import the machine's
/// default local sign-in without reimplementing the account response shape.
struct ProviderAccountResponse: Decodable {
    let accounts: ProviderAccountsProjection
    let flow: ProviderAccountLogin?
    let discovered: [DiscoveredAccountSource]?
    let accountId: String?
}

struct DiscoveredAccountSource: Decodable, Identifiable {
    let kind: String
    let path: String
    let label: String
    var id: String { "\(kind)|\(path)" }
}

/// Account selection lives inline in the provider card. Registered accounts and
/// locally discovered logins are listed together so either can be used with a
/// single click. There is no separate "管理账号" sheet: the trailing plus is
/// the only entry point for adding an account.
struct ProviderAccountsView: View {
    let provider: FirstRunProvider
    let projection: ProviderAccountsProjection
    let draft: ProviderSettingsDraft
    let disabled: Bool
    /// Choosing (or importing) an account saves the shared draft and runs the
    /// background connection check. There is no manual "check" button.
    let accountChanged: () -> Void
    let updated: (FirstRunProvider) -> Void

    private enum AddPage { case hidden, method, local }
    @State private var addPage = AddPage.hidden
    @State private var sources: [DiscoveredAccountSource] = []
    @State private var target: ProviderAccount?
    @State private var editing: String?
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?
    @State private var deletion: ProviderAccount?
    @State private var showDelete = false
    @State private var showCustomSource = false

    private var endpoint: String { "providers/\(provider.id)/accounts" }
    private var selection: String { draft.values[provider.id]?.accountId ?? projection.selectedAccountId ?? "" }

    /// Locally detected logins that have not been registered as accounts yet.
    private var availableLocalSources: [DiscoveredAccountSource] {
        sources.filter { source in
            !projection.accounts.contains { account in
                account.importedFrom == source.path || account.runtimeDirectory == source.path
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            accountList
            if addPage != .hidden { addFlow }
            if let login = projection.activeLogin { pendingLogin(login) }
            if let error { Text(error).font(.caption).foregroundStyle(.red) }
            if !draft.hasSpecifiedAccount(provider.id) {
                Label(L10n("尚未指定账号：请选择上方列表中的账号，或点击“添加账号”。"),
                      systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.orange)
            }
        }
        .task { await detectLocalAccounts() }
        .task(id: projection.activeLogin?.id) { await pollLogin() }
        .confirmationDialog(L10n("删除此账号？"), isPresented: $showDelete, presenting: deletion) { account in
            Button(L10n(account.removesListingOnly == true ? "从列表移除" : "删除账号"), role: .destructive) {
                perform("delete", fields: ["accountId": account.id])
            }
        } message: { account in
            Text(L10n(account.removesListingOnly == true
                ? "只从 Corptie 的账号列表移除。官方登录凭证和已有会话的绑定会保留。"
                : "运行数据和原始凭证来源会保留。"))
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
    }

    private var accountList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(projection.accounts) { account in
                accountRow(account)
                Divider()
            }
            ForEach(availableLocalSources) { source in
                localSourceRow(source)
                Divider()
            }
            Button {
                target = nil
                error = nil
                addPage = .method
            } label: {
                Label(L10n("添加账号"), systemImage: "plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.vertical, 7)
            .disabled(projection.activeLogin != nil)
        }
        .disabled(disabled || busy)
    }

    private func accountRow(_ account: ProviderAccount) -> some View {
        HStack(spacing: 8) {
            Button {
                if account.canSelect {
                    select(account.id)
                } else if account.origin == "native", projection.sourceKinds.contains("directory") {
                    target = nil
                    importSource(kind: "directory", path: account.runtimeDirectory)
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: account.id == selection ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(account.id == selection ? Color.accentColor : Color.secondary)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 2) {
                        if editing == account.id {
                            TextField(L10n("账号名称"), text: $name).onSubmit { rename(account) }
                        } else {
                            Text(account.name)
                        }
                        Text(originLabel(account)).font(.caption).foregroundStyle(.secondary)
                        if account.state != "ready" {
                            Text(account.status).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Spacer(minLength: 4)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!account.canSelect && !(account.origin == "native" && projection.sourceKinds.contains("directory")))
            if editing == account.id {
                Button(L10n("保存")) { rename(account) }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Button(L10n("取消")) { editing = nil }
            } else {
                Menu {
                    Button(L10n("改名")) { name = account.name; editing = account.id }
                    if account.canReauthorize {
                        Button(L10n("更新凭证…")) { target = account; error = nil; addPage = .method }
                    }
                    Button(L10n("删除"), role: .destructive) {
                        if account.canDelete { deletion = account; showDelete = true }
                        else { error = account.deletionReason ?? L10n("此账号暂时不能删除。") }
                    }
                } label: {
                    Image(systemName: "ellipsis.circle").accessibilityLabel(L10n("账号操作"))
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
        }
        .padding(.vertical, 6)
    }

    private func localSourceRow(_ source: DiscoveredAccountSource) -> some View {
        Button {
            target = nil
            importSource(kind: source.kind, path: source.path)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "plus.circle")
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(source.label)
                    Text(L10n("本机已有登录 · 点按直接使用"))
                        .font(.caption).foregroundStyle(.secondary)
                    Text(source.path).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 6)
    }

    @ViewBuilder private var addFlow: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            HStack {
                Text(L10n(target == nil ? "添加账号" : "更新凭证"))
                    .font(.caption.weight(.semibold))
                Spacer()
                Button(L10n("收起")) { addPage = .hidden; target = nil; error = nil }
                    .buttonStyle(.plain)
            }
            switch addPage {
            case .hidden:
                EmptyView()
            case .method:
                HStack(spacing: 12) {
                    Button(L10n("使用本机已有登录")) {
                        perform("discover") { result in
                            sources = result.discovered ?? []
                            addPage = .local
                        }
                    }
                    Button(L10n("登录 Codex")) {
                        perform("login", fields: targetFields) { _ in
                            addPage = .hidden
                            target = nil
                        }
                    }
                }
                Text(L10n("检测到的本机登录已直接列在上方，可点按使用；这里用于指定其他路径或在 Corptie 内登录。"))
                    .font(.caption).foregroundStyle(.secondary)
            case .local:
                if sources.isEmpty {
                    Text(L10n("未发现本机登录凭证。")).font(.caption).foregroundStyle(.secondary)
                } else {
                    ForEach(sources) { source in
                        Button {
                            target = nil
                            importSource(kind: source.kind, path: source.path)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(source.label)
                                Text(source.path).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                Button { showCustomSource = true } label: {
                    Label(L10n("指定路径…"), systemImage: "folder")
                }
                .buttonStyle(.plain)
                Button(L10n("返回")) { addPage = .method }.buttonStyle(.plain)
            }
        }
        .disabled(disabled || busy)
    }

    private func pendingLogin(_ login: ProviderAccountLogin) -> some View {
        HStack {
            ProgressView().controlSize(.small)
            Text(L10n("等待浏览器完成登录…"))
            Button(L10n("取消登录")) { perform("cancelLogin", fields: ["loginId": login.id]) }
        }
        .font(.caption)
    }

    private func originLabel(_ account: ProviderAccount) -> String {
        switch account.origin {
        case "legacy": L10n("原有 Corptie 环境")
        case "native": L10n("本机已有登录 · 点按使用")
        case "imported": L10n("从本机导入")
        default: account.importedFrom == nil ? L10n("在 Corptie 中登录") : L10n("从本机导入")
        }
    }

    private var targetFields: [String: Any] { target.map { ["accountId": $0.id] } ?? [:] }

    private func select(_ id: String) {
        guard id != selection, projection.accounts.contains(where: { $0.id == id && $0.canSelect }) else { return }
        // Both onboarding and settings stage the change in the same draft;
        // the shared automation then saves it and checks the connection.
        draft.edit(provider.id, accountId: id)
        accountChanged()
    }

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
        perform("import", fields: fields) { _ in
            addPage = .hidden
            target = nil
            editing = nil
        }
    }

    private func apply(_ result: ProviderAccountResponse) {
        let before = draft.values[provider.id]?.accountId
        // Importing a local login (or finishing a login) immediately stages
        // that account as the selected one; the shared save action commits it.
        if let id = result.accountId ?? result.flow?.accountId,
           result.accounts.accounts.contains(where: { $0.id == id && $0.canSelect }) {
            draft.edit(provider.id, accountId: id)
        }
        changed(result.accounts)
        if draft.values[provider.id]?.accountId != before { accountChanged() }
        if let message = result.flow?.message { error = message }
    }

    private func changed(_ accounts: ProviderAccountsProjection) {
        var row = provider
        row.accounts = accounts
        updated(row)
    }

    /// Detecting local logins is a best-effort enhancement. A read-only preview
    /// backend rejects account operations, which must not surface an error on
    /// every provider card; the plus button remains the explicit fallback.
    private func detectLocalAccounts() async {
        do {
            let result: ProviderAccountResponse = try await FirstRunSetupAPI.request(endpoint,
                body: ["action": "discover"])
            sources = result.discovered ?? []
        } catch {
            sources = []
        }
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
