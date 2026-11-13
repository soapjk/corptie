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

@MainActor
final class UnifiedCreationDraft: ObservableObject {
    var context = UnifiedCreationContext()
    var parentTaskID: String?
    @Published var taskMode: Bool = false
    @Published var workID: String? = nil
    @Published var roleID: String? = nil
    @Published var providerID: String = ""
    @Published var modelID: String = ""
    @Published var prompt = ""
    @Published var busy = false
    @Published var error: String? = nil
    @Published var editingWork = false
    @Published var choosingImages = false
    @Published var imageURLs: [URL] = []
    @Published var importedImages: [ChatImageReference] = []
    @Published var createdSession: TaskSession? = nil
    @Published var submissionStarted = false
    @Published var requestID = UUID().uuidString.lowercased()
    @Published var messageID = "message:\(UUID().uuidString.lowercased())"
    @Published var deliveryID = "delivery:\(UUID().uuidString.lowercased())"
    func prepare(_ context: UnifiedCreationContext, parentTaskID: String? = nil) {
        guard prompt.isEmpty, imageURLs.isEmpty, !submissionStarted, !editingWork else { return }
        self.context = context; self.parentTaskID = parentTaskID
        taskMode = context.workID != nil; workID = context.workID; roleID = context.roleID
        providerID = context.providerID ?? ""; modelID = context.modelID ?? ""
    }
}

/// A local draft until submission. Creation and delivery retain separate retry identities.
struct UnifiedConversationCreateView: View {
    @ObservedObject private var client = EntityAPIClient.shared
    @ObservedObject private var backend = BackendClient.shared
    @ObservedObject private var catalog = BackendClient.shared.modelCatalog
    @ObservedObject private var draftState: UnifiedCreationDraft
    var onSent: () -> Void
    @FocusState private var inputFocused: Bool
    private var context: UnifiedCreationContext { draftState.context }
    private var parentTaskID: String? { draftState.parentTaskID }
    @Binding private var taskMode: Bool
    @Binding private var workID: String?
    @Binding private var roleID: String?
    @Binding private var providerID: String
    @Binding private var modelID: String
    @Binding private var prompt: String
    @Binding private var busy: Bool
    @Binding private var error: String?
    @Binding private var editingWork: Bool
    @Binding private var choosingImages: Bool
    @Binding private var imageURLs: [URL]
    @Binding private var importedImages: [ChatImageReference]
    @Binding private var createdSession: TaskSession?
    @Binding private var submissionStarted: Bool
    @Binding private var requestID: String
    @Binding private var messageID: String
    @Binding private var deliveryID: String

    init(draft: UnifiedCreationDraft, onSent: @escaping () -> Void) {
        self.draftState = draft; self.onSent = onSent
        _taskMode = Binding(get: { draft.taskMode }, set: { draft.taskMode = $0 })
        _workID = Binding(get: { draft.workID }, set: { draft.workID = $0 })
        _roleID = Binding(get: { draft.roleID }, set: { draft.roleID = $0 })
        _providerID = Binding(get: { draft.providerID }, set: { draft.providerID = $0 })
        _modelID = Binding(get: { draft.modelID }, set: { draft.modelID = $0 })
        _prompt = Binding(get: { draft.prompt }, set: { draft.prompt = $0 })
        _busy = Binding(get: { draft.busy }, set: { draft.busy = $0 })
        _error = Binding(get: { draft.error }, set: { draft.error = $0 })
        _editingWork = Binding(get: { draft.editingWork }, set: { draft.editingWork = $0 })
        _choosingImages = Binding(get: { draft.choosingImages }, set: { draft.choosingImages = $0 })
        _imageURLs = Binding(get: { draft.imageURLs }, set: { draft.imageURLs = $0 })
        _importedImages = Binding(get: { draft.importedImages }, set: { draft.importedImages = $0 })
        _createdSession = Binding(get: { draft.createdSession }, set: { draft.createdSession = $0 })
        _submissionStarted = Binding(get: { draft.submissionStarted }, set: { draft.submissionStarted = $0 })
        _requestID = Binding(get: { draft.requestID }, set: { draft.requestID = $0 })
        _messageID = Binding(get: { draft.messageID }, set: { draft.messageID = $0 })
        _deliveryID = Binding(get: { draft.deliveryID }, set: { draft.deliveryID = $0 })
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
        .frame(maxWidth: 760)
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        .interactiveDismissDisabled(busy)
        .task {
            inputFocused = true
            if !submissionStarted, providerID.isEmpty, context.providerID == nil, let defaults = backend.settingsController.settings?.newSessionDefaults?.taskCreation {
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
            Text(L10n("今天想做什么？"))
                .font(.system(size: 28, weight: .semibold))
                .frame(maxWidth: .infinity).padding(.bottom, 24)
            TextEditor(text: $prompt)
                .font(WorkbenchTypography.font(for: .composerInput))
                .focused($inputFocused)
                .frame(minHeight: 160, idealHeight: 190, maxHeight: 240)
                .overlay(alignment: .topLeading) {
                    if prompt.isEmpty { Text(L10n("你想做什么？")).foregroundStyle(.tertiary).padding(12).allowsHitTesting(false) }
                }
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
                onSent()
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
