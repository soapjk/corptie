import Combine
import CorptieClientCore
import CorptieConversation
import CorptieClientSecurity
import AppKit
import SwiftUI

struct SessionDetailPanel: View {
    private static let detailJournalKeyOwner = ReliableMessageOutbox()
    @ObservedObject private var modelCatalog = BackendClient.shared.modelCatalog
    @ObservedObject private var entityClient = EntityAPIClient.shared
    private let backendClient = BackendClient.shared
    let session: TaskSession
    var railWidth: CGFloat = 280
    @State private var contextReferenceAddMode: ContextReferenceAddMode?
    @State private var contextReferences: [SessionContextReference] = []
    @State private var isLoadingContextReferences = false
    @State private var providerCatalogRevision = 0
    @State private var pendingProviderId: String?
    @State private var showProviderSwitchConfirmation = false
    @State private var isSwitchingProvider = false
    @State private var providerSwitchError: String?
    @State private var isLoadingProviderCatalog = false
    @State private var providerCatalogLoadFailed = false
    @State private var showsAllContextReferences = false
    private enum DetailNativeSheet: Identifiable {
        case artifact(WorkArtifact), task(CorptieTask), provider(String), worktree(String)
        var id: String {
            switch self {
            case .artifact(let value): "artifact:\(value.artifactId)"
            case .task(let value): "task:\(value.id)"
            case .provider(let id): "provider:\(id)"
            case .worktree(let id): "worktree:\(id)"
            }
        }
    }
    @State private var detailNativeSheet: DetailNativeSheet?
    @State private var detailOpeningGeneration = UUID()
    @State private var richDetailReady: Bool?
    let detailPresentation: ConversationDetailPresentationRepository
    @State private var nativeManagementExpanded = false

    private var detailKind: ConversationDetailKind? {
        ConversationDetailKind.resolve(session.resolvedSessionKind)
    }

    private static let iso8601Formatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let iso8601NoFractionFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.unitsStyle = .short
        return formatter
    }()

    var body: some View {
        sessionCard
        .frame(width: railWidth)
        .task(id: session.id) {
            showsAllContextReferences = false
            detailNativeSheet = nil
            contextReferences = []
            await loadProviderCatalogIfNeeded()
        }
        .onReceive(backendClient.supplementaryDataController.$selectedContextReferences) { references in
            contextReferences = references
        }
        .onReceive(backendClient.supplementaryDataController.$isLoadingContextReferences) { isLoading in
            isLoadingContextReferences = isLoading
        }
        .onReceive(modelCatalog.$agentProviders) { _ in
            providerCatalogRevision &+= 1
        }
        .sheet(item: $contextReferenceAddMode) { mode in
            ContextReferenceAddSheet(session: session, mode: mode)
        }
        .sheet(item: $detailNativeSheet) { destination in
            switch destination {
            case .artifact(let artifact):
                ArtifactDetailContainer(artifactId: artifact.artifactId, workId: artifact.workId, taskId: session.taskId) { }
            case .task(let task):
                CorptieTaskEditView(task: task) { }
            case .provider:
                VStack(alignment: .leading, spacing: 12) {
                    Text(L10n("Provider 管理")).font(.headline)
                    providerPicker
                    providerSwitchStatus
                    Button(L10n("重新加载")) { Task { await reloadProviderCatalog() } }
                    Button(L10n("关闭")) { detailNativeSheet = nil }
                }.padding(20).frame(minWidth: 320)
                    .interactiveDismissDisabled(isSwitchingProvider)
                    .alert(L10n("切换 Provider？"), isPresented: $showProviderSwitchConfirmation) {
                        Button(L10n("切换")) { performProviderSwitch() }
                        Button(L10n("取消"), role: .cancel) { pendingProviderId = nil }
                    } message: { Text(providerSwitchConfirmationMessage) }
            case .worktree(let id):
                VStack(alignment: .leading, spacing: 12) {
                    ConversationWorktreeCard(sessionID: session.id, refreshID: session.updatedAt,
                        api: { ClientSessionWorktreeAPI(transport: try BackendTransport(endpoint: BackendEndpoint(CorptieAppEnvironment.backendBaseURL)),
                            route: .desktop, expectedWorktreeID: id) }, onJob: { job in
                            if job.status != "awaiting_confirmation" {
                                OperationNotificationManager.shared.track(jobID: job.id, resourceName: "Worktree")
                                if let notification = job.notification { OperationNotificationManager.shared.observe(notification) }
                            }
                        }, localize: { L10n($0) })
                    Button(L10n("关闭")) { detailNativeSheet = nil }
                }.padding(20).frame(minWidth: 360)
            }
        }
        .onChange(of: session.id) { _, _ in richDetailReady = nil; nativeManagementExpanded = false; retireDetailDestination() }
        .onChange(of: session.taskId) { _, _ in retireDetailDestination() }
        .onChange(of: session.workId) { _, _ in retireDetailDestination() }
        .onChange(of: session.external?.provider) { _, _ in retireDetailDestination() }
        .onDisappear { retireDetailDestination() }
        .alert(L10n("切换 Provider？"), isPresented: Binding(
            get: { showProviderSwitchConfirmation && detailNativeSheet == nil },
            set: { showProviderSwitchConfirmation = $0 })) {
            Button(L10n("切换")) { performProviderSwitch() }
            Button(L10n("取消"), role: .cancel) { pendingProviderId = nil }
        } message: {
            Text(providerSwitchConfirmationMessage)
        }
    }

    private var sessionCard: some View {
        ConversationDetailDashboard {
            sessionDetailContent.background(ConsoleOverlayScroller())
        }
    }

    private var sessionDetailContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            ConversationServerDetail(scope: "\(CorptieAppEnvironment.backendBaseURL):\(session.id)", sessionID: session.id,
                context: ClientDetailContext(sessionKind: session.resolvedSessionKind.rawValue, taskID: session.taskId, workID: session.workId),
                actions: nativeDetailNavigation,
                coordinator: { selected, canonical in try await detailCoordinator(selected: selected, canonicalSessionID: canonical) },
                onPresentationChanged: { richDetailReady = $0 },
                repository: backendClient.detailBusinessRepository,
                displayScope: ClientDetailBusinessScope(serverID: CorptieAppEnvironment.backendBaseURL.absoluteString,
                    ownerID: backendClient.detailBusinessOwnerID, principalID: "local-user", sessionID: session.id,
                    taskID: session.taskId, workID: session.workId),
                presentationRepository: detailPresentation,
                adapters: detailAdapters,
                api: { [baseURL = CorptieAppEnvironment.backendBaseURL] in
                    ClientDetailAPI(transport: try BackendTransport(endpoint: BackendEndpoint(baseURL)), route: .desktop)
                })
                .id(session.id)
            if richDetailReady != false {
                ConversationDetailResourceMenu(items: detailResourceItems)
            } else { nativeDetailContent }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    private var detailResourceItems: [ConversationDetailResourceMenu.Item] {
        var items: [ConversationDetailResourceMenu.Item] = [.init(.addReference) { contextReferenceAddMode = .webURL }]
        if let id = session.taskId { items.append(.init(.manageMemory) { AppTabRouter.shared.openMemory(ownerType: "task", ownerId: id) }) }
        else if let id = session.workId { items.append(.init(.manageMemory) { AppTabRouter.shared.openMemory(ownerType: "work", ownerId: id) }) }
        return items
    }
    private var detailAdapters: ConversationDetailAdapters {
        let task = entityClient.tasks.first { $0.id == session.taskId }
        let work = entityClient.works.first { $0.id == session.workId }
        return ConversationDetailAdapters(configuration: detailConfiguration, selectConfiguration: selectDetailConfiguration,
            reloadConfiguration: {
                await reloadProviderCatalog()
                if backendClient.selectedSession?.id == session.id { await backendClient.loadModelsForSelectedSession(forceRefresh: true) }
            }, readTurnSummary: { execution in
                let value = try await TurnObservabilityClient.shared.latestSummary(sessionId: session.id)
                guard value.turnExecutionId == execution else { throw ClientDetailFailure.invalidGraph }
                return value
            }, readTurnTrace: { try await TurnObservabilityClient.shared.rawTrace(turnExecutionId: $0, cursor: $1) },
            worktreeAPI: { expected in
                ClientSessionWorktreeAPI(transport: try BackendTransport(endpoint: BackendEndpoint(CorptieAppEnvironment.backendBaseURL)),
                    route: .desktop, expectedWorktreeID: expected)
            }, onWorktreeJob: { job in
                if job.status != "awaiting_confirmation" {
                    OperationNotificationManager.shared.track(jobID: job.id, resourceName: "Worktree")
                    if let notification = job.notification { OperationNotificationManager.shared.observe(notification) }
                }
            }, resident: .init(taskTitle: task?.title ?? "", workName: work?.name ?? "", workDescription: work?.description ?? ""))
    }
    private var providerConfigurationCard: some View {
        ConversationDetailProviderCard(configuration: detailConfiguration, scope: session.id, select: selectDetailConfiguration) {
            await reloadProviderCatalog()
            if backendClient.selectedSession?.id == session.id { await backendClient.loadModelsForSelectedSession(forceRefresh: true) }
        }
    }
    private var detailConfiguration: ClientDetailConfiguration {
        let models = modelCatalog.models(for: session.external?.provider)
        let modelID = session.external?.currentModel ?? ""
        let current = models.first { $0.id == modelID }
        let levels = SessionReasoningSelection.availableLevels(modelID: modelID, models: models,
            supportsSwitch: session.canSwitchReasoningNow)
        let level = SessionReasoningSelection.currentLevel(sessionLevel: session.external?.currentReasoningLevel,
            providerDefaultLevel: modelCatalog.defaultReasoning(for: session.external?.provider), model: current)
        let selected = backendClient.selectedSession?.id == session.id
        let providerID = modelCatalog.agentProviders.canonicalProviderId(for: session.external?.provider) ?? session.external?.provider ?? ""
        return ClientDetailConfiguration(
            provider: .init(id: providerID, title: currentProviderDisplayName,
                choices: creatableProviders.map { .init(id: $0.id, title: $0.displayName,
                    available: $0.supports("session.create")) }, canSelect: selected && session.canSwitchProviderNow),
            model: .init(id: modelID, title: current?.name ?? modelID,
                choices: models.map { .init(id: $0.id, title: $0.name) }, canSelect: selected && session.canSwitchModelNow),
            reasoning: .init(id: level, title: ComposerModelLabel.reasoningTitle(level),
                choices: levels.map { .init(id: $0, title: ComposerModelLabel.reasoningTitle($0)) }, canSelect: selected && session.canSwitchReasoningNow),
            busy: isSwitchingProvider || backendClient.isSwitchingModel || backendClient.isSwitchingReasoning || session.external?.providerSwitchInFlight == true,
            error: providerSwitchError)
    }
    private func selectDetailConfiguration(_ field: ClientDetailConfiguration.Field, _ id: String) async throws {
        guard backendClient.selectedSession?.id == session.id,
              backendClient.selectedSession?.external?.provider == session.external?.provider else { throw ClientDetailConfigurationFailure.unavailable }
        switch field {
        case .provider:
            guard session.canSwitchProviderNow, alternativeProviders.contains(where: { $0.id == id }) else { throw ClientDetailConfigurationFailure.unavailable }
            isSwitchingProvider = true; providerSwitchError = nil
            defer { isSwitchingProvider = false }
            if !(await backendClient.switchProvider(session: session, to: id)) {
                throw ClientDetailConfigurationFailure.unconfirmed(backendClient.lastError ?? "Provider 切换未完成，请核对当前配置")
            }
        case .model: try await backendClient.configureDetailModel(session: session, id: id)
        case .reasoning: try await backendClient.configureDetailReasoning(session: session, level: id)
        }
    }
    private var nativeDetailContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            if detailKind == .taskDetail, let taskId = session.taskId, !taskId.isEmpty {
                SessionCorptieTaskDetailCard(
                    taskId: taskId,
                    decoratesSurface: false,
                    showsHeader: false,
                    embedsInParentScroll: true
                )
            }


            if detailKind == .workDetail { workDetailContent }

            contextReferencesSection

            ScheduledSessionStrip(session: session)

            ConversationWorktreeCard(sessionID: session.id, refreshID: session.updatedAt,
                api: {
                    ClientSessionWorktreeAPI(transport: try BackendTransport(
                        endpoint: BackendEndpoint(CorptieAppEnvironment.backendBaseURL)), route: .desktop)
                }, onJob: { job in
                    if job.status != "awaiting_confirmation" {
                        OperationNotificationManager.shared.track(jobID: job.id, resourceName: "Worktree")
                        if let notification = job.notification { OperationNotificationManager.shared.observe(notification) }
                    }
                }, localize: { L10n($0) })
                .id(session.id)

            if detailKind == .workDetail,
               let work = entityClient.works.first(where: { $0.id == session.workId }) {
                Button {
                    AppTabRouter.shared.openMemory(ownerType: "work", ownerId: work.id)
                } label: {
                    Label("Work 记忆", systemImage: "brain")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
            }

            SessionMemoryDiagnosticsView(session: session)
                .modifier(ConversationDetailModuleSurface())
            SessionTurnObservabilityView(sessionId: session.id, canonicalID: session.external?.logicalSessionId)

            providerConfigurationCard
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var nativeDetailNavigation: ConversationDetailActions {
        ConversationDetailActions(canPerform: { action in
            guard action.available, action.kind == "navigation",
                  let target = action.target else { return false }
            if action.operation == "editor.open" {
                if target.resourceType == "provider" { return session.external?.provider == target.id && !isSwitchingProvider }
                if target.resourceType == "worktree" { return !target.id.isEmpty && session.archived != true }
                return target.resourceType == "task" && target.id == session.taskId
                    && backendClient.appState.task(target.id).map { action.expectedResourceRevision == String($0.revision) } == true
            }
            guard action.operation == "resource.open" else { return false }
            if target.resourceType == "task" {
                return entityClient.tasks.first(where: { $0.id == target.id })?.currentSessionId != nil
            }
            if target.resourceType == "session" { return residentDetailSessionID(target.id) != nil }
            if target.resourceType == "artifact" { return true } // Host registers the exact destination; catalog reads reauthorize it.
            if target.resourceType == "reference" { return detailReferenceURL(target.id) != nil }
            return target.resourceType == "schedule"
        }, perform: { action, fields in
            guard action.available, action.kind == "navigation",
                  let target = action.target else { return }
            if action.operation == "editor.open" {
                if target.resourceType == "provider", session.external?.provider == target.id, !isSwitchingProvider {
                    detailNativeSheet = .provider(target.id)
                } else if target.resourceType == "worktree" {
                    let token = detailOpeningGeneration, sessionID = session.id, expected = target.id
                    Task {
                        do {
                            _ = try await ClientSessionWorktreeAPI(transport: BackendTransport(endpoint: BackendEndpoint(CorptieAppEnvironment.backendBaseURL)),
                                route: .desktop, expectedWorktreeID: expected).detail(sessionID: sessionID)
                            guard token == detailOpeningGeneration, let current = backendClient.appState.session(sessionID),
                                  current.archived != true, current.workId == session.workId, current.taskId == session.taskId else { return }
                            detailNativeSheet = .worktree(expected)
                        } catch { if token == detailOpeningGeneration { providerSwitchError = L10n("Worktree 绑定已变化或无权读取") } }
                    }
                }
                if target.resourceType == "task", target.id == session.taskId,
                   let task = backendClient.appState.task(target.id), action.expectedResourceRevision == String(task.revision) {
                    detailNativeSheet = .task(task)
                }
                return
            }
            guard action.operation == "resource.open" else { return }
            switch target.resourceType {
            case "session":
                if let id = residentDetailSessionID(target.id, expectedTaskID: fields["sourceResourceType"]?.text == "task" ? fields["sourceResourceId"]?.text : nil) {
                    AppTabRouter.shared.openSession(id, source: .userSelection)
                }
            case "task":
                if let id = entityClient.tasks.first(where: { $0.id == target.id })?.currentSessionId {
                    AppTabRouter.shared.openTaskSession(taskId: target.id, sessionId: id, source: .userSelection)
                }
            case "schedule": AppTabRouter.shared.openAutomation(target.id)
            case "artifact":
                let token = detailOpeningGeneration
                Task {
                    do {
                        let detail = try await ClientResourceAPI(transport: CorptieAppEnvironment.backendTransport, route: .desktop).detail(target.id)
                        guard token == detailOpeningGeneration else { return }
                        let pin = detail.references.first { ($0.taskId != nil && $0.taskId == session.taskId) || $0.sessionId == session.id }
                        AppTabRouter.shared.openResource(.init(id: target.id, version: pin?.version, hash: pin?.hash, workId: detail.resource.workId ?? ""))
                    } catch { AppTabRouter.shared.navigationError = "资源打开失败，请在资源管理中重试" }
                }
            case "reference": if let url = detailReferenceURL(target.id) { NSWorkspace.shared.open(url) }
            default: break
            }
        })
    }
    private func detailReferenceURL(_ id: String) -> URL? {
        guard let reference = contextReferences.first(where: { $0.id == id && $0.enabled && $0.status == "available" }),
              reference.targetType == .webURL, let locator = reference.locator, let url = URL(string: locator),
              ["http", "https"].contains(url.scheme?.lowercased() ?? ""), url.host != nil, url.user == nil, url.password == nil else { return nil }
        return url
    }
    private func retireDetailDestination() {
        detailOpeningGeneration = UUID(); detailNativeSheet = nil
        pendingProviderId = nil; showProviderSwitchConfirmation = false
    }
    private func residentDetailSessionID(_ id: String, expectedTaskID: String? = nil) -> String? {
        guard let destination = backendClient.appState.session(id) else { return nil }
        let task = destination.taskId.flatMap { backendClient.appState.task($0) }
        let bound = task?.currentSessionId.flatMap { backendClient.appState.session($0)?.id }
        guard ClientDetailNavigationPolicy.permitsSession(targetID: destination.id, sourceWorkID: session.workId,
            destinationWorkID: destination.workId ?? task?.workId, destinationTaskID: destination.taskId,
            taskID: task?.id, taskWorkID: task?.workId, taskCurrentSessionID: bound,
            retired: destination.archived == true || task?.archived == true || task?.deletionStatus != nil,
            expectedTaskID: expectedTaskID) else { return nil }
        return destination.id
    }
    private func detailCoordinator(selected: ClientDetailAPI, canonicalSessionID: String) async throws -> ClientDetailActionCoordinator {
        let origin = CorptieAppEnvironment.backendBaseURL
        let scope = ClientDetailActionScope(serverID: origin.absoluteString, principalID: "local-user",
            sessionID: canonicalSessionID, accountID: "os-user:\(NSUserName())",
            credentialBindingID: "local-loopback:\(NSUserName()):\(Bundle.main.bundleIdentifier ?? "corptie")",
            catalog: selected.negotiation.catalog, capabilityDigest: selected.negotiation.capabilityDigest)
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: false).appendingPathComponent("Corptie/DetailActionRecovery", isDirectory: true)
        let journal = ClientDetailActionFileJournal(directory: directory, key: try await Self.detailJournalKeyOwner.timelinePersistenceKey())
        let transport = ClientDetailDynamicActionTransport(api: {
            ClientDetailActionAPI(transport: try BackendTransport(endpoint: BackendEndpoint(origin)), route: .desktop,
                negotiation: selected.negotiation)
        })
        return ClientDetailActionCoordinator(scope: scope, transport: transport, journal: journal,
            navigation: .init(registrations: ["resource.open": ["task", "schedule"]]))
    }

    private var statusCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label(session.executionTaskStatus.label, systemImage: "circle.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(session.executionTaskStatus.color)
                Spacer()
                Text(friendlyUpdatedAt)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .background(Color.accentColor.opacity(0.055), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private var workDetailContent: some View {
        if let work = entityClient.works.first(where: { $0.id == session.workId }) {
            ConversationWorkOverviewCard(description: work.description)
            let relevantTasks = entityClient.tasks.filter {
                $0.workId == work.id && $0.archived != true && $0.deletionStatus == nil
                    && $0.lifecycleState != "done"
            }.sorted {
                if $0.summaryNeedsIntervention != $1.summaryNeedsIntervention {
                    return $0.summaryNeedsIntervention
                }
                return $0.updatedAt > $1.updatedAt
            }
            let focusTasks = relevantTasks.prefix(3).map { task in
                ConversationFocusTask(id: task.id, title: task.title,
                    sessionID: task.currentSessionId, summary: task.conversationDetailSummary)
            }
            ConversationFocusTasksCard(tasks: focusTasks) { taskID, sessionID in
                AppTabRouter.shared.openTaskSession(taskId: taskID, sessionId: sessionID, source: .userSelection)
            }
            ArtifactSectionView(workId: work.id, taskId: nil)
                .id(work.id)
                .modifier(ConversationDetailModuleSurface())
        }
    }

    private var assistantSection: some View {
        detailSection(title: "Assistant", systemImage: "person.crop.circle") {
            HStack(alignment: .top, spacing: 9) {
                SessionAvatarView(session: session, avatarSize: 32)
                VStack(alignment: .leading, spacing: 3) {
                    Text(agentDisplayName)
                        .font(.system(size: 12, weight: .semibold))
                    if let description = assistantAgent?.description, !description.isEmpty {
                        CollapsibleDetailText(
                            text: description,
                            font: .system(size: 11),
                            lineSpacing: 1
                        )
                    }
                }
            }
        }
    }

    private var contextReferencesSection: some View {
        ConversationDetailModuleCard(title: L10n("引用内容"), systemImage: "link", headerActions: {
            Menu {
                    Button("本地文件…", systemImage: "doc") { chooseLocalFile() }
                    Button("网页链接…", systemImage: "globe") { contextReferenceAddMode = .webURL }
                    Divider()
                    Button("Work…", systemImage: "scope") { contextReferenceAddMode = .work }
                    Button("CorptieTask…", systemImage: "checklist") { contextReferenceAddMode = .task }
                    Button("Agent…", systemImage: "person.2") { contextReferenceAddMode = .agent }
                    Button("其他会话…", systemImage: "bubble.left.and.bubble.right") { contextReferenceAddMode = .session }
            } label: { ConversationDetailHeaderIcon(systemName: "plus") }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .help("添加上下文引用")
            .accessibilityLabel("添加上下文引用")
            if contextReferences.count > 2 {
                Button { showsAllContextReferences.toggle() } label: {
                    ConversationDetailHeaderIcon(systemName: showsAllContextReferences ? "chevron.up" : "chevron.down")
                }
                .buttonStyle(.plain)
                .help(showsAllContextReferences ? "收起引用" : "展开全部引用")
                .accessibilityLabel(showsAllContextReferences ? "收起引用" : "展开全部引用（\(contextReferences.count)）")
            }
        }) {
            if isLoadingContextReferences && contextReferences.isEmpty {
                ProgressView().controlSize(.small)
            } else if !contextReferences.isEmpty {
                LazyVStack(spacing: 6) {
                    ForEach(showsAllContextReferences ? contextReferences : Array(contextReferences.prefix(2))) { reference in
                        contextReferenceRow(reference)
                    }
                }
            }
        }
    }

    private func contextReferenceRow(_ reference: SessionContextReference) -> some View {
        ConversationReferenceRow(title: reference.displayName,
            status: ConversationReferenceStatus.label(for: reference.status,
                targetType: reference.targetType.rawValue, enabled: reference.enabled),
            systemImage: reference.targetType.systemImage,
            enabled: reference.enabled, statusAvailable: reference.status == "available",
            localPath: reference.targetType == .localFile ? reference.locator : nil,
            checkError: reference.targetType == .localFile ? reference.metadata?.lastError : nil) {
            Toggle("启用引用", isOn: Binding(
                get: { reference.enabled },
                set: { enabled in Task { await backendClient.setContextReferenceEnabled(reference, enabled: enabled) } }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.mini)
            Menu {
                if reference.targetType == .webURL {
                    Button("刷新快照", systemImage: "arrow.clockwise") {
                        Task { await backendClient.refreshContextReference(reference) }
                    }
                }
                if reference.targetType == .localFile, let path = reference.locator {
                    Button("复制文件路径", systemImage: "doc.on.doc") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(path, forType: .string)
                    }
                    Button("重新检查文件", systemImage: "arrow.clockwise") {
                        Task { await backendClient.refreshContextReference(reference) }
                    }
                    Button("重新选择文件", systemImage: "doc") { chooseLocalFile(replacing: reference) }
                    Button("在 Finder 中显示", systemImage: "folder") {
                        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
                    }
                } else if reference.targetType == .webURL, let locator = reference.locator, let url = URL(string: locator) {
                    Button("打开网页", systemImage: "safari") { NSWorkspace.shared.open(url) }
                }
                Divider()
                Button("移除引用", systemImage: "trash", role: .destructive) {
                    Task { await backendClient.deleteContextReference(reference) }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 16, height: 18)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .accessibilityLabel("引用操作")
        }
        .detailRailReferenceRowStyle()
    }

    private func chooseLocalFile(replacing reference: SessionContextReference? = nil) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        Task {
            if let reference {
                await backendClient.replaceContextReferenceFile(reference, path: url.path)
            } else {
                _ = await backendClient.addContextReference(to: session, type: .localFile, locator: url.path)
            }
        }
    }

    private func detailSection<Content: View>(
        title: String,
        systemImage: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        ConversationDetailModuleCard(title: title, systemImage: systemImage, content: content)
    }

    @ViewBuilder private var providerSwitchStatus: some View {
            if isSwitchingProvider || session.external?.providerSwitchInFlight == true {
                Text(L10n("正在切换 Provider…")).font(.caption2)
            }
            if providerCatalogLoadFailed {
                Text(L10n("Provider 列表加载失败，请点击菜单重试")).font(.caption2).foregroundStyle(.secondary)
            }
            if let providerSwitchError {
                Text(providerSwitchError).font(.caption2).foregroundStyle(.red)
            }
    }

    private var providerMenuItems: some View {
        ForEach(creatableProviders) { provider in
            Button {
                guard !provider.matches(session.external?.provider) else { return }
                pendingProviderId = provider.id
                showProviderSwitchConfirmation = true
            } label: {
                if provider.matches(session.external?.provider) {
                    Label(provider.displayName, systemImage: "checkmark")
                } else {
                    Text(provider.displayName)
                }
            }
            .disabled(provider.matches(session.external?.provider) || !session.canSwitchProviderNow || isSwitchingProvider)
        }
    }

    private var providerPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            if session.external?.providerSwitchInFlight == true || isSwitchingProvider {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L10n("正在切换 Provider…"))
                        .font(.system(size: 11, weight: .medium))
                }
            } else if isLoadingProviderCatalog && creatableProviders.isEmpty {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L10n("正在加载 Provider…"))
                        .font(.system(size: 11, weight: .medium))
                }
            } else if alternativeProviders.isEmpty {
                providerValueRow
                if providerCatalogLoadFailed {
                    Button(L10n("重新加载 Provider")) {
                        Task { await reloadProviderCatalog() }
                    }
                    .buttonStyle(.link)
                    .font(.system(size: 10))
                } else {
                    Text(L10n("没有其他可用 Provider"))
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
            } else {
                Menu {
                    providerMenuItems
                } label: {
                    HStack {
                        Text(currentProviderDisplayName)
                            .font(.system(size: 12, weight: .medium))
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 8)
                    .frame(height: 28)
                    .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 7))
                }
                .menuStyle(.borderlessButton)
                .disabled(isSwitchingProvider || session.external?.providerSwitchInFlight == true)
                .accessibilityLabel(L10n("切换 Provider"))
            }
        }
    }

    private var creatableProviders: [AgentProviderDescriptor] {
        _ = providerCatalogRevision
        return modelCatalog.agentProviders.filter { $0.supports("session.create") }
    }

    private var alternativeProviders: [AgentProviderDescriptor] {
        _ = providerCatalogRevision
        return modelCatalog.agentProviders.sessionProviderAlternatives(to: session.external?.provider)
    }

    private var providerValueRow: some View {
        HStack {
            Text(currentProviderDisplayName)
                .font(.system(size: 12, weight: .medium))
            Spacer()
        }
        .padding(.horizontal, 8)
        .frame(height: 28)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 7))
    }

    private var currentProviderDisplayName: String {
        guard let provider = session.external?.provider, !provider.isEmpty else { return L10n("未知") }
        return backendClient.providerDisplayName(for: provider) ?? provider
    }

    private var pendingProviderDisplayName: String {
        guard let pendingProviderId else { return L10n("未知") }
        return backendClient.providerDisplayName(for: pendingProviderId) ?? pendingProviderId
    }

    private var providerSwitchConfirmationMessage: String {
        L10nFormat("系统会为当前会话创建新的 Provider 线程。现有聊天记录和工作空间会保留，后续消息将从 %@ 切换到 %@。", currentProviderDisplayName, pendingProviderDisplayName)
    }

    private func performProviderSwitch() {
        guard let target = pendingProviderId, session.canSwitchProviderNow else { return }
        pendingProviderId = nil
        providerSwitchError = nil
        isSwitchingProvider = true
        Task {
            let success = await backendClient.switchProvider(session: session, to: target)
            isSwitchingProvider = false
            if !success {
                providerSwitchError = backendClient.lastError ?? L10n("Provider 切换失败")
            }
        }
    }

    private func loadProviderCatalogIfNeeded() async {
        guard modelCatalog.agentProviders.isEmpty else {
            providerCatalogLoadFailed = false
            return
        }
        await reloadProviderCatalog()
    }

    private func reloadProviderCatalog() async {
        guard !isLoadingProviderCatalog else { return }
        isLoadingProviderCatalog = true
        providerCatalogLoadFailed = false
        await backendClient.loadProviders()
        isLoadingProviderCatalog = false
        providerCatalogLoadFailed = modelCatalog.agentProviders.isEmpty
    }

    private var runtimeFields: [(String, String)] {
        _ = providerCatalogRevision
        var fields = [("Agent", agentDisplayName)]
        if let cwd = session.external?.cwd, !cwd.isEmpty {
            fields.append(("工作空间", compactPath(cwd)))
        }
        return fields
    }

    private var agentDisplayName: String {
        sessionAgentDisplayName(session: session, agents: entityClient.agents)
    }

    private var assistantAgent: Agent? {
        guard let agentId = session.agentId else { return nil }
        return entityClient.agents.first { $0.agentId == agentId }
    }

    private var friendlyUpdatedAt: String {
        let date = Self.iso8601Formatter.date(from: session.updatedAt)
            ?? Self.iso8601NoFractionFormatter.date(from: session.updatedAt)
        guard let date else {
            return session.updatedAt
        }
        return Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    private func compactPath(_ path: String) -> String {
        let url = URL(fileURLWithPath: path).standardizedFileURL
        let components = url.pathComponents.filter { $0 != "/" }
        guard components.count > 3 else { return url.path }
        return "…/" + components.suffix(3).joined(separator: "/")
    }

}
