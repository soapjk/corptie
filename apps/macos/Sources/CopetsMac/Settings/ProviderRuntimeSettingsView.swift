import AppKit
import SwiftUI
import Observation

struct ProviderCredentialSource: Decodable, Equatable, Identifiable {
    var id: String { "\(kind)|\(path)" }
    var state: String? = nil
    var label: String? = nil
    let kind: String
    let path: String
}

struct ProviderRuntimeSettingsProjection: Decodable, Equatable {
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
    var connection: ProviderConnectionConfiguration? = nil
}

struct ProviderConnectionDraft: Equatable {
    var endpoint: String
    var model: String
    var authType: String
    var credential: String?
}

struct ProviderConnectionConfiguration: Decodable, Equatable {
    struct Current: Decodable, Equatable {
        let endpoint: String
        let model: String
        let authType: String
        let credentialConfigured: Bool
    }
    let managedSource: ProviderCredentialSource
    let importKind: String
    let current: Current?
}

/// Local editor state has one owner in the resident provider card, so fitting a
/// short or scrollable presentation cannot reset an open configuration flow.
@MainActor @Observable
final class ProviderRuntimeEditorState {
    var selectedSource: ProviderCredentialSource?
    var showConnection = false
    var showAdvanced = false
    var endpoint: String
    var model: String
    var authType: String
    var credential = ""
    var saving = false
    var error: String?

    init(runtime: ProviderRuntimeSettingsProjection, source: ProviderCredentialSource?,
         connection: ProviderConnectionDraft?) {
        selectedSource = source ?? runtime.source
        endpoint = connection?.endpoint ?? runtime.connection?.current?.endpoint ?? ""
        model = connection?.model ?? runtime.connection?.current?.model ?? ""
        let auth = connection?.authType ?? runtime.connection?.current?.authType ?? "authToken"
        authType = auth == "helper" ? "authToken" : auth
    }
}

struct ProviderRuntimeSettingsView: View {
    let providerId: String
    let runtime: ProviderRuntimeSettingsProjection
    let busy: Bool
    let updated: (FirstRunProvider) -> Void
    let sourceDraft: ProviderCredentialSource?
    let sourceEdited: ((ProviderCredentialSource) -> Void)?
    let connectionDraft: ProviderConnectionDraft?
    let connectionEdited: ((ProviderConnectionDraft) -> Void)?
    @State private var editor: ProviderRuntimeEditorState

    init(providerId: String, runtime: ProviderRuntimeSettingsProjection, busy: Bool,
         sourceDraft: ProviderCredentialSource? = nil, sourceEdited: ((ProviderCredentialSource) -> Void)? = nil,
         connectionDraft: ProviderConnectionDraft? = nil, connectionEdited: ((ProviderConnectionDraft) -> Void)? = nil,
         editorState: ProviderRuntimeEditorState? = nil,
         updated: @escaping (FirstRunProvider) -> Void) {
        self.providerId = providerId
        self.runtime = runtime
        self.busy = busy
        self.updated = updated
        self.sourceDraft = sourceDraft
        self.sourceEdited = sourceEdited
        self.connectionDraft = connectionDraft
        self.connectionEdited = connectionEdited
        _editor = State(initialValue: editorState ?? ProviderRuntimeEditorState(
            runtime: runtime, source: sourceDraft, connection: connectionDraft))
    }

    private var selection: ProviderCredentialSource? { sourceDraft ?? editor.selectedSource ?? runtime.source }
    private var rows: [ProviderCredentialSource] {
        var rows = runtime.candidates
        if let selection, !rows.contains(where: { $0.id == selection.id }) { rows.append(selection) }
        return rows
    }
    private var canReuseCredential: Bool {
        if connectionDraft?.authType == editor.authType, connectionDraft?.credential != nil { return true }
        return selection?.id == runtime.connection?.managedSource.id
            && runtime.connection?.current?.authType == editor.authType
            && runtime.connection?.current?.credentialConfigured == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if runtime.sourceKinds.isEmpty {
                Text(L10n("此引擎暂不支持在此管理账号或模型来源。")).font(.caption).foregroundStyle(.secondary)
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(rows) { source in
                        Button { select(source) } label: {
                            HStack(spacing: 8) {
                                Image(systemName: selection?.id == source.id ? "checkmark.circle.fill" : "circle")
                                    .foregroundStyle(selection?.id == source.id ? Color.accentColor : Color.secondary)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(sourceName(source)).font(.callout).lineLimit(1)
                                    Text(sourceDetail(source)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .padding(.vertical, 6).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).help(source.path)
                        .accessibilityLabel(sourceName(source))
                        .accessibilityValue(L10n(selection?.id == source.id ? "已选择" : "未选择"))
                        Divider()
                    }
                    Menu {
                        if runtime.sourceKinds.contains("file") {
                            Button(L10n("选择账号凭证文件…")) { chooseSource(kind: "file") }
                        }
                        if runtime.sourceKinds.contains("directory") {
                            Button(L10n("选择账号配置目录…")) { chooseSource(kind: "directory") }
                        }
                        if let connection = runtime.connection {
                            Button(L10n("导入本机模型配置…")) { chooseSource(kind: connection.importKind) }
                            if connectionEdited != nil {
                                Button(L10n("手动添加模型来源…")) { beginConnection() }
                            }
                        }
                    } label: {
                        Label(L10n("添加账号或模型来源"), systemImage: "plus")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.vertical, 6)
                    }
                    .menuStyle(.borderlessButton)
                    .accessibilityIdentifier("provider.source.add")
                }
            }
            if runtime.sourceChanged && connectionDraft == nil {
                Text(L10n(runtime.message)).font(.caption).foregroundStyle(.orange)
            } else if ["missing", "unavailable"].contains(runtime.state) && connectionDraft == nil {
                Text(L10n(runtime.message)).font(.caption).foregroundStyle(.red)
            }
            if let error = editor.error { Text(error).font(.caption).foregroundStyle(.red) }
            DisclosureGroup(L10n("高级信息"), isExpanded: $editor.showAdvanced) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L10n("独立运行目录")).font(.caption.weight(.medium))
                    Text(verbatim: runtime.runtimeDirectory).font(.caption.monospaced()).textSelection(.enabled)
                    Button(L10n("在 Finder 中显示")) {
                        NSWorkspace.shared.open(URL(fileURLWithPath: runtime.runtimeDirectory, isDirectory: true))
                    }
                    if runtime.sourceKinds.isEmpty {
                        Text(L10n(runtime.message)).font(.caption).foregroundStyle(.secondary)
                    }
                    if let description = runtime.formatDescription {
                        Text(L10n(description)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.top, 6)
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .disabled(busy || editor.saving)
        .sheet(isPresented: $editor.showConnection) {
            VStack(alignment: .leading, spacing: 12) {
                Text(L10n("添加模型来源")).font(.headline)
                connectionFields
            }
            .padding(20).frame(width: 400)
        }
        .onChange(of: sourceDraft) { _, value in editor.selectedSource = value }
        .onChange(of: connectionDraft) { _, value in if value == nil { editor.credential = "" } }
    }

    private var connectionFields: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(L10n("服务地址"), text: $editor.endpoint).textFieldStyle(.roundedBorder)
                .accessibilityLabel(L10n("服务地址"))
            Picker(L10n("认证方式"), selection: $editor.authType) {
                Text("Bearer Token").tag("authToken")
                Text("API Key").tag("apiKey")
            }
            SecureField(L10n(canReuseCredential ? "留空保留当前密钥" : "密钥"), text: $editor.credential)
                .textFieldStyle(.roundedBorder).accessibilityLabel(L10n("密钥"))
            TextField(L10n("模型名称"), text: $editor.model).textFieldStyle(.roundedBorder)
                .accessibilityLabel(L10n("模型名称"))
            HStack {
                Button(L10n("取消")) { editor.showConnection = false; editor.credential = "" }
                    .keyboardShortcut(.cancelAction)
                Spacer()
                Button(L10n("添加到列表")) {
                    guard let connectionEdited else { return }
                    let key = editor.credential.trimmingCharacters(in: .whitespacesAndNewlines)
                    connectionEdited(.init(endpoint: editor.endpoint.trimmingCharacters(in: .whitespacesAndNewlines),
                        model: editor.model.trimmingCharacters(in: .whitespacesAndNewlines), authType: editor.authType,
                        credential: key.isEmpty ? connectionDraft?.credential : key))
                    editor.showConnection = false
                }
                .keyboardShortcut(.defaultAction)
                .disabled(editor.endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || editor.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || (editor.credential.isEmpty && !canReuseCredential))
            }
        }
        .font(.callout)
        .padding(.vertical, 6)
    }

    private func beginConnection() {
        editor.endpoint = connectionDraft?.endpoint ?? runtime.connection?.current?.endpoint ?? ""
        editor.model = connectionDraft?.model ?? runtime.connection?.current?.model ?? ""
        let auth = connectionDraft?.authType ?? runtime.connection?.current?.authType ?? "authToken"
        editor.authType = auth == "helper" ? "authToken" : auth
        editor.credential = ""
        editor.showConnection = true
    }

    private func sourceName(_ source: ProviderCredentialSource) -> String {
        if source.id == runtime.connection?.managedSource.id { return L10n("自定义模型来源") }
        if source.kind == runtime.connection?.importKind { return L10n("本机模型配置") }
        return source.label.map { L10n($0) } ?? L10n("本机账号")
    }

    private func sourceDetail(_ source: ProviderCredentialSource) -> String {
        if source.id == runtime.connection?.managedSource.id {
            if let draft = connectionDraft { return draft.model }
            return runtime.connection?.current?.model ?? L10n("模型来源")
        }
        if source.kind == runtime.connection?.importKind { return URL(fileURLWithPath: source.path).lastPathComponent }
        return L10n(source.kind == "directory" ? "配置目录" : "凭证文件")
    }

    private func select(_ source: ProviderCredentialSource) {
        editor.selectedSource = source
        if let sourceEdited { sourceEdited(source) }
        else { Task { await save(source) } }
    }

    private func chooseSource(kind: String) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = kind == "directory"
        panel.canChooseFiles = kind != "directory"
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        if panel.runModal() == .OK, let url = panel.url {
            select(.init(kind: kind, path: url.path))
        }
    }

    @MainActor private func save(_ source: ProviderCredentialSource) async {
        editor.saving = true
        editor.error = nil
        defer { editor.saving = false }
        do {
            let row: FirstRunProvider = try await FirstRunSetupAPI.request("first-run/credentials", body: [
                "providerId": providerId, "kind": source.kind, "path": source.path
            ])
            updated(row)
        } catch { editor.error = error.localizedDescription }
    }
}
