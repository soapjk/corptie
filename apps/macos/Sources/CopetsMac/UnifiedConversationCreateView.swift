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
    var taskMode: Bool { workID != nil }
    @Published var workID: String? = nil
    @Published var roleID: String? = nil
    @Published var providerID: String = ""
    @Published var modelID: String = ""
    @Published var permission = ComposerPermissionChoice(sandbox: "workspace-write", approval: "on-request")
    @Published var serviceTier = "default"
    var permissionInitialized = false
    var configurationApplied = false
    let editor = ComposerEditorController(draft: ComposerDraftBuffer())
    // Same buffer as the chat editor; keystrokes do not publish the whole page.
    var prompt: String {
        get { editor.draft.text }
        set { editor.draft.updateFromEditor(newValue) }
    }
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
    func selectWork(_ id: String?) {
        guard !submissionStarted else { return }
        if workID != id { parentTaskID = nil }
        workID = id
    }
    func prepare(_ context: UnifiedCreationContext, parentTaskID: String? = nil) {
        guard prompt.isEmpty, imageURLs.isEmpty, !submissionStarted, !editingWork else { return }
        self.context = context; self.parentTaskID = parentTaskID
        workID = context.workID; roleID = context.roleID
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
    @State private var hasSendableText = false
    @State private var choosingRole = false
    private var context: UnifiedCreationContext { draftState.context }
    private var parentTaskID: String? { draftState.parentTaskID }
    private var taskMode: Bool { draftState.taskMode }
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
    private var selectedProvider: AgentProviderDescriptor? { providers.first { $0.id == providerID } }
    private var fastTier: String? {
        guard selectedProvider?.supports("configuration.serviceTier.switch") == true else { return nil }
        let id = modelID.isEmpty ? catalog.defaultModel(for: providerID) : modelID
        return ComposerServiceTier.fastID(catalog.models(for: providerID).first { $0.id == id }?.serviceTiers)
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
                        draftState.selectWork(created.id); editingWork = false; reconcile()
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
            if !draftState.permissionInitialized {
                let defaults = backend.settingsController.settings?.newSessionDefaults
                draftState.permission = .init(sandbox: defaults?.sandbox ?? "workspace-write",
                                               approval: defaults?.approvalPolicy ?? "on-request")
                draftState.permissionInitialized = true
            }
            if !submissionStarted, providerID.isEmpty, context.providerID == nil, let defaults = backend.settingsController.settings?.newSessionDefaults?.taskCreation {
                providerID = defaults.providerId ?? ""; modelID = defaults.model ?? ""
            }
            reconcile()
            if client.roles.isEmpty { await client.refreshRoles() }
            if client.works.isEmpty { await client.refreshWorks() }
            if catalog.agentProviders.isEmpty { await backend.loadProviders() }
            reconcile()
        }
        .onChange(of: providerID) { _, _ in if !submissionStarted { draftState.serviceTier = "default" } }
        .onChange(of: modelID) { _, _ in if !submissionStarted { draftState.serviceTier = "default" } }
        .onChange(of: workID) { _, _ in reconcile() }
        .onChange(of: client.roles) { _, _ in reconcile() }
        .onChange(of: client.works) { _, _ in reconcile() }
        .onChange(of: catalog.agentProviders) { _, _ in reconcile() }
        .fileImporter(isPresented: $choosingImages, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case .success(let urls) = result { imageURLs.append(contentsOf: urls) }
        }
    }

    private var draft: some View {
        VStack(spacing: 28) {
            Text(L10n("今天想做什么？"))
                .font(.system(size: 26, weight: .semibold))
                .background(ComposerTransitionAnchor(sessionID: nil, decoration: "title"))
            VStack(spacing: 0) {
                ConversationComposerChrome(verticalPadding: 10, contentSpacing: 8, headerAtBottom: true) {
                    creationToolbar
                } content: {
                    VStack(alignment: .leading, spacing: 8) {
                        ComposerInputTextView(controller: draftState.editor,
                            placeholder: L10n("你想做什么？"),
                            font: WorkbenchTypography.nativeFont(for: .composerInput),
                            onSendableTextChange: { hasSendableText = $0 },
                            onSubmit: { _ in submit() })
                            .frame(height: 112)
                            .accessibilityLabel(L10n("你想做什么？"))
                        if !imageURLs.isEmpty {
                            ScrollView(.horizontal, showsIndicators: false) {
                                HStack(spacing: 8) {
                                    ForEach(Array(imageURLs.enumerated()), id: \.offset) { index, url in
                                        Button { imageURLs.remove(at: index) } label: {
                                            Label(url.lastPathComponent, systemImage: "xmark.circle")
                                        }.buttonStyle(.plain)
                                    }
                                }
                            }.disabled(submissionStarted)
                        }
                    }.padding(.horizontal, 10)
                }
                .background(ComposerTransitionAnchor(sessionID: nil))
                creationDestination
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .background(ComposerTransitionAnchor(sessionID: nil, decoration: "footer"))
            }
            .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 20))
            if let error {
                Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled)
            } else if let validation {
                Text(validation).font(.caption).foregroundStyle(.secondary)
            }
        }
        .onAppear {
            hasSendableText = draftState.editor.draft.hasSendableText
            if !submissionStarted {
                draftState.editor.resumePresentation()
                draftState.editor.draft.focusRequested = true
                draftState.editor.focusIfRequested()
            }
        }
        .onChange(of: submissionStarted) { _, started in
            if started { draftState.editor.suspendPresentation() }
        }
        .onDisappear { draftState.editor.suspendPresentation() }
    }

    private var creationToolbar: some View {
        HStack(spacing: 12) {
            Button { choosingImages = true } label: {
                Image(systemName: "plus").font(.system(size: 16))
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }.buttonStyle(.plain).help(L10n("添加图片")).disabled(submissionStarted)
            Spacer(minLength: 8)
            if selectedProvider?.supports("configuration.permissions.update") == true {
                ComposerPermissionMenu(selection: draftState.permission, disabled: submissionStarted) {
                    draftState.permission = $0
                }
            }
            Menu {
                ForEach(providers) { provider in
                    Button(provider.displayName) { providerID = provider.id; modelID = "" }
                }
                Divider()
                Button(L10n("默认模型")) { modelID = "" }
                ForEach(catalog.models(for: providerID)) { model in
                    Button(model.name) { modelID = model.id }
                }
                if let fastTier {
                    Divider()
                    Toggle("Fast", isOn: Binding(get: { ComposerServiceTier.isFast(draftState.serviceTier) },
                        set: { draftState.serviceTier = $0 ? fastTier : "default" }))
                }
                Button(L10n("加载模型列表")) { Task { await backend.loadModels(for: providerID) } }
            } label: {
                Text((ComposerServiceTier.isFast(draftState.serviceTier) ? "⚡ " : "") + (modelID.isEmpty ? (providers.first { $0.id == providerID }?.displayName ?? L10n("执行引擎")) : modelID))
                    .lineLimit(1).truncationMode(.middle)
            }.menuStyle(.borderlessButton).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: 176).disabled(submissionStarted)
            ComposerSendControl(disabled: busy || validation != nil || (!hasSendableText && imageURLs.isEmpty),
                                busy: busy, action: submit)
                .keyboardShortcut(.return, modifiers: .command)
        }
        .font(WorkbenchTypography.font(for: .composerInput))
    }

    private var creationDestination: some View {
        HStack(spacing: 18) {
            Menu {
                Button(L10n("聊天")) { draftState.selectWork(nil) }
                Divider()
                ForEach(client.works) { value in
                    Button(value.name) { draftState.selectWork(value.id) }
                }
                Divider()
                Button(L10n("新建 Work")) { editingWork = true }
            } label: {
                Label(work?.name ?? L10n("选择 Work"), systemImage: "folder")
                    .lineLimit(1)
            }
            .menuIndicator(.hidden)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: 220, alignment: .leading)
            .fixedSize(horizontal: true, vertical: true)
            .help(L10n("选择 Work"))
            Button { choosingRole = true } label: {
                HStack(spacing: 6) {
                    if let role = roles.first(where: { $0.roleId == roleID }) {
                        RoleCardAvatar(role: role, size: 20)
                        Text(role.name).lineLimit(1).truncationMode(.tail)
                    } else {
                        Image(systemName: "person.crop.circle")
                        Text(L10n("角色"))
                    }
                }.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: 180, alignment: .leading)
            .fixedSize(horizontal: true, vertical: true)
            .accessibilityLabel(L10n("角色"))
            .popover(isPresented: $choosingRole) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(roles) { role in
                            Button {
                                roleID = role.roleId
                                choosingRole = false
                            } label: {
                                HStack(spacing: 8) {
                                    RoleCardAvatar(role: role, size: 24)
                                    Text(role.name).lineLimit(1)
                                    Spacer(minLength: 12)
                                    if role.roleId == roleID { Image(systemName: "checkmark") }
                                }
                                .padding(8).contentShape(Rectangle())
                            }.buttonStyle(.plain)
                        }
                    }
                }
                .frame(width: 240, height: min(320, CGFloat(roles.count) * 44))
                .padding(8)
            }
            Spacer(minLength: 0)
        }
        .menuStyle(.borderlessButton)
        .font(.system(size: 12)).foregroundStyle(.secondary)
        .disabled(submissionStarted)
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
        guard !busy, validation == nil, let roleID,
              !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !imageURLs.isEmpty else { return }
        busy = true; error = nil; submissionStarted = true
        Task { @MainActor in
            defer { busy = false }
            do {
                var session: TaskSession
                if let createdSession { session = createdSession }
                else if taskMode {
                    guard let workID, let task = await client.createCorptieTask(
                        id: "task:\(requestID)", workId: workID, title: "新任务_\(requestID.prefix(6))",
                        mainRoleId: roleID, providerId: providerID,
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
                if !draftState.configurationApplied {
                    if selectedProvider?.supports("configuration.permissions.update") == true {
                        session = try await backend.configureComposer(session: session,
                            route: "permissions", values: ["sandbox": draftState.permission.sandbox,
                                                          "approvalPolicy": draftState.permission.approval])
                        createdSession = session
                    }
                    if selectedProvider?.supports("configuration.serviceTier.switch") == true {
                        session = try await backend.configureComposer(session: session,
                            route: "service-tier", values: ["serviceTier": draftState.serviceTier])
                        createdSession = session
                    }
                    draftState.configurationApplied = true
                }
                while importedImages.count < imageURLs.count {
                    importedImages.append(try await backend.importChatImage(at: imageURLs[importedImages.count], to: session, preserveOriginal: false))
                }
                try await submitMessage(to: session)
                ComposerCreationTransition.shared.begin(sessionID: session.id)
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
