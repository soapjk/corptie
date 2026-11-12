import SwiftUI
import CorptieClientCore
import CorptieConversation
import UniformTypeIdentifiers

struct UnifiedCreationContext {
    var workID: String?
    var roleID: String?
    var providerID: String?
    var modelID: String?

    static func resolve(session: TaskSession?, workID: String?, chatSpace: Bool = false) -> Self {
        let targetWork = chatSpace ? nil : (workID ?? session?.workId)
        return .init(workID: targetWork, roleID: session?.roleId,
                     providerID: session?.external?.provider, modelID: session?.external?.currentModel)
    }
}

/// A local draft until submission. Creation and delivery retain separate retry identities.
struct UnifiedConversationCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backend = BackendClient.shared
    @ObservedObject private var catalog = BackendClient.shared.modelCatalog
    @Environment(\.dismiss) private var dismiss
    @FocusState private var inputFocused: Bool
    let context: UnifiedCreationContext
    var parentTaskID: String? = nil
    @State private var taskMode: Bool
    @State private var workID: String?
    @State private var roleID: String?
    @State private var providerID: String
    @State private var modelID: String
    @State private var prompt = ""
    @State private var busy = false
    @State private var error: String?
    @State private var editingWork = false
    @State private var choosingImages = false
    @State private var imageURLs: [URL] = []
    @State private var importedImages: [ChatImageReference] = []
    @State private var createdSession: TaskSession?
    @State private var submissionStarted = false
    @State private var requestID = UUID().uuidString.lowercased()
    @State private var messageID = "message:\(UUID().uuidString.lowercased())"
    @State private var deliveryID = "delivery:\(UUID().uuidString.lowercased())"

    init(context: UnifiedCreationContext, parentTaskID: String? = nil) {
        self.context = context; self.parentTaskID = parentTaskID
        _taskMode = State(initialValue: context.workID != nil)
        _workID = State(initialValue: context.workID)
        _roleID = State(initialValue: context.roleID)
        _providerID = State(initialValue: context.providerID ?? "")
        _modelID = State(initialValue: context.modelID ?? "")
    }

    private var work: Work? { client.works.first { $0.id == workID } }
    private var roles: [Role] {
        client.roles.filter { $0.status == "available" && (!taskMode || work?.contributorRoleIds.contains($0.roleId) == true) }
    }
    private var providers: [AgentProviderDescriptor] {
        catalog.agentProviders.filter { $0.supports("session.create") && $0.isExecutionEnabled }
    }
    private var validation: String? {
        if taskMode && work == nil { return L10n("请选择 Work。") }
        if !roles.contains(where: { $0.roleId == roleID }) { return L10n("请选择可用 Agent。") }
        if !providers.contains(where: { $0.id == providerID }) { return L10n("请选择可用执行引擎。") }
        return nil
    }

    var body: some View {
        Group {
            if editingWork {
                VStack(spacing: 0) {
                    HStack { Button { editingWork = false } label: { Label(L10n("返回"), systemImage: "chevron.left") }; Spacer() }.padding()
                    WorkCreateView(isFirstRun: true, dismissOnCreated: false, onCancel: { editingWork = false }, onCreated: { created in
                        workID = created.id; taskMode = true; editingWork = false; reconcile()
                    })
                }
            } else {
                draft
            }
        }
        .frame(width: 580, height: editingWork ? 640 : 420)
        .interactiveDismissDisabled(busy)
        .task {
            inputFocused = true
            if context.providerID == nil, let defaults = backend.settingsController.settings?.newSessionDefaults?.taskCreation {
                providerID = defaults.providerId ?? ""; modelID = defaults.model ?? ""
            }
            reconcile()
            if client.roles.isEmpty { await client.refreshRoles() }
            if client.works.isEmpty { await client.refreshWorks() }
            if catalog.agentProviders.isEmpty { await backend.loadProviders() }
            reconcile()
        }
        .onChange(of: taskMode) { _, _ in reconcile() }
        .onChange(of: workID) { _, _ in reconcile() }
        .onChange(of: client.roles) { _, _ in reconcile() }
        .onChange(of: client.works) { _, _ in reconcile() }
        .onChange(of: catalog.agentProviders) { _, _ in reconcile() }
        .fileImporter(isPresented: $choosingImages, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { imageURLs.append(contentsOf: urls) }
        }
    }

    private var draft: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text(L10n("新建")).font(.title3.bold())
                Spacer()
                Button(L10n("取消")) { dismiss() }.keyboardShortcut(.cancelAction).disabled(busy)
            }
            HStack {
                Picker(L10n("类型"), selection: $taskMode) {
                    Text(L10n("聊天")).tag(false); Text(L10n("任务")).tag(true)
                }.pickerStyle(.segmented).frame(width: 150)
                if taskMode {
                    Menu {
                        ForEach(client.works) { value in Button(value.name) { workID = value.id } }
                        Divider()
                        Button(L10n("新建 Work")) { editingWork = true }
                    } label: { Label(work?.name ?? L10n("选择 Work"), systemImage: "folder") }
                }
                Spacer()
            }.disabled(submissionStarted)
            TextEditor(text: $prompt)
                .font(WorkbenchTypography.font(for: .composerInput))
                .focused($inputFocused)
                .scrollContentBackground(.hidden)
                .padding(8)
                .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.quaternary))
                .disabled(submissionStarted)
                .accessibilityLabel(L10n("你想做什么？"))
            if !imageURLs.isEmpty {
                ScrollView(.horizontal) {
                    HStack {
                        ForEach(Array(imageURLs.enumerated()), id: \.offset) { index, url in
                            Button { imageURLs.remove(at: index) } label: { Label(url.lastPathComponent, systemImage: "xmark.circle") }
                        }
                    }
                }.disabled(submissionStarted)
            }
            if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            else if let validation { Text(validation).font(.caption).foregroundStyle(.secondary) }
            HStack(spacing: 8) {
                Button { choosingImages = true } label: { Image(systemName: "paperclip") }
                    .help(L10n("添加图片")).disabled(submissionStarted)
                Picker(L10n("Agent"), selection: $roleID) {
                    Text(L10n("选择 Agent")).tag(String?.none)
                    ForEach(roles) { Text($0.name).tag(Optional($0.roleId)) }
                }.labelsHidden().frame(maxWidth: 160).disabled(submissionStarted)
                Menu {
                    ForEach(providers) { provider in
                        Button(provider.displayName) { providerID = provider.id; modelID = "" }
                    }
                    Divider()
                    Button(L10n("默认模型")) { modelID = "" }
                    ForEach(catalog.models(for: providerID)) { model in Button(model.name) { modelID = model.id } }
                    Button(L10n("加载模型列表")) { Task { await backend.loadModels(for: providerID) } }
                } label: {
                    Text(modelID.isEmpty ? (providers.first { $0.id == providerID }?.displayName ?? L10n("执行引擎")) : modelID).lineLimit(1)
                }.disabled(submissionStarted)
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.small) }
                Button(createdSession == nil ? L10n(taskMode ? "开始任务" : "发送") : L10n("重试发送")) { submit() }
                    .buttonStyle(.borderedProminent).keyboardShortcut(.return, modifiers: .command)
                    .disabled(busy || validation != nil || (prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && imageURLs.isEmpty))
            }
        }.padding(20)
    }

    private func reconcile() {
        guard !submissionStarted else { return }
        if !roles.isEmpty, !roles.contains(where: { $0.roleId == roleID }) { roleID = roles.first?.roleId }
        if !providers.isEmpty, !providers.contains(where: { $0.id == providerID }) {
            providerID = providers.first(where: { $0.id == catalog.defaultSessionProviderId })?.id ?? providers.first?.id ?? ""
            modelID = ""
        }
    }

    private func submit() {
        guard !busy, validation == nil, let roleID else { return }
        busy = true; error = nil; submissionStarted = true
        Task { @MainActor in
            defer { busy = false }
            do {
                let session: TaskSession
                if let createdSession { session = createdSession }
                else if taskMode {
                    guard let workID, let task = await client.createCorptieTask(
                        id: "task:\(requestID)", workId: workID, title: "新任务_\(requestID.prefix(6))",
                        description: nil, mainRoleId: roleID, providerId: providerID,
                        model: modelID.isEmpty ? nil : modelID, parentTaskId: parentTaskID),
                          let currentID = task.currentSessionId,
                          let prepared = backend.sessions.first(where: { $0.id == currentID }) else {
                        throw BackendError.message(client.errorMessage ?? L10n("任务创建结果尚未确认，请重试查询原操作。"))
                    }
                    session = prepared
                } else {
                    session = try await createChat(roleID: roleID)
                }
                createdSession = session
                while importedImages.count < imageURLs.count {
                    importedImages.append(try await backend.importChatImage(at: imageURLs[importedImages.count], to: session, preserveOriginal: false))
                }
                try await submitMessage(to: session)
                backend.acceptCreatedSession(session)
                dismiss()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func createChat(roleID: String) async throws -> TaskSession {
        var request = URLRequest(url: CorptieAppEnvironment.backendBaseURL.appending(path: "desktop/chats/create"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["requestId": requestID, "title": "新对话",
            "agentId": roleID, "providerId": providerID, "model": modelID])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BackendError.message(L10n("创建结果未确认，请重试查询原操作。")) }
        let result = try JSONDecoder().decode(CreatedChat.self, from: data)
        guard result.receipt.status == "completed", let session = result.session else {
            throw BackendError.message(L10n("创建结果未确认，请勿重新创建。"))
        }
        return session
    }
    private func submitMessage(to session: TaskSession) async throws {
        var request = URLRequest(url: CorptieAppEnvironment.backendBaseURL.appending(path: "sessions/\(session.id)/messages"))
        request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["text": prompt, "messageId": messageID, "deliveryId": deliveryID,
            "images": importedImages.map { ["managedPath": $0.managedPath] }, "mentions": [], "isChoiceSelection": false])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let code = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(code) else {
            throw BackendError.message(BackendClient.errorMessage(from: data) ?? L10n("发送失败，重试会保留原会话。"))
        }
    }
    private struct CreatedChat: Decodable { let receipt: ClientCommandReceipt; let session: TaskSession? }
}
