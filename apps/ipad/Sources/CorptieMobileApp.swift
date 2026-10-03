import SwiftUI
import UIKit
import AuthenticationServices
import CorptieClientCore
import CorptieConversation

@main
struct CorptieMobileApp: App {
    @UIApplicationDelegateAdaptor(PadAppDelegate.self) private var appDelegate
    @State private var connection = PadConnection()
    var body: some Scene {
        WindowGroup {
            Group {
                if connection.connected {
                    PadAppShell(connection: connection)
                } else if connection.restoringConnection {
                    ProgressView("正在连接上次的 Mac…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
                } else {
                    PairingView(connection: connection)
                }
            }
            .task { await connection.restoreLastConnection() }
        }
    }
}

struct PairingView: View {
    @Bindable var connection: PadConnection
    @State private var scanner: Scanner?
    @State private var scannedPayload: String?
    @State private var cloudSignIn = CloudSignInSession()
    @State private var cloudRevocation: CloudDevice?
    private enum Scanner: String, Identifiable { case camera; var id: String { rawValue } }
    var body: some View {
        NavigationStack {
            Form {
                Section("Corptie Cloud") {
                    if connection.cloudSignedIn {
                        let macs = connection.cloudDevices.filter { $0.kind == .mac && $0.revokedAt == nil }
                        if macs.isEmpty {
                            Text("没有可连接的 Mac。请在 Mac 上登录同一账号并开启远程连接。")
                                .font(.footnote).foregroundStyle(.secondary)
                        } else {
                            ForEach(macs) { mac in
                                Button("连接 \(mac.displayName)", systemImage: "desktopcomputer") {
                                    Task { await connection.connectCloud(to: mac) }
                                }
                            }
                        }
                        let mobileDevices = connection.cloudDevices.filter { $0.kind == .mobile && $0.revokedAt == nil }
                        if !mobileDevices.isEmpty {
                            ForEach(mobileDevices) { device in
                                HStack {
                                    Label(device.displayName, systemImage: "ipad.and.iphone")
                                    Spacer()
                                    if device.id == connection.cloudCurrentDeviceID {
                                        Text("此设备").font(.caption).foregroundStyle(.secondary)
                                    } else {
                                        Button("撤销", role: .destructive) { cloudRevocation = device }
                                    }
                                }
                            }
                        }
                        Button("退出 Cloud 账号", role: .destructive) {
                            Task { await connection.signOutCloud() }
                        }
                    } else {
                        Button("登录 Corptie Cloud", systemImage: "person.crop.circle") { startCloudSignIn() }
                        Text("使用独立 Corptie 账号，在外网安全连接同账号下的 Mac。通信内容端到端加密。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section {
                    Button("扫码配对 Mac", systemImage: "qrcode.viewfinder") { scanner = .camera }
                        .disabled(connection.claim != nil)
                    Text("在 Mac 的设备接入设置中生成二维码；扫码后会自动申请配对，请在 Mac 上批准。")
                        .font(.footnote).foregroundStyle(.secondary)
                    if connection.claim == nil, !connection.pairingID.isEmpty, !connection.secret.isEmpty {
                        Button("重试申请配对") { Task { await connection.requestPairing() } }
                            .accessibilityIdentifier("pairing-retry-request")
                    }
                    if connection.busy { ProgressView("正在连接 Mac…") }
                    if !connection.notice.isEmpty {
                        Text(connection.notice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("pairing-status")
                    }
                }
                if connection.hasSavedPairing, !connection.serverID.isEmpty {
                    Section("已配对的 Mac") {
                        Text(connection.address).font(.footnote)
                        Button("连接") { Task { await connection.reconnect() } }
                    }.disabled(connection.claim != nil)
                }
                DisclosureGroup("手动连接（高级）") {
                    TextField("HTTPS 地址（含端口）", text: $connection.address)
                        .keyboardType(.URL)
                        .disabled(connection.claim != nil)
                    TextField("Server ID（来自 Mac）", text: $connection.serverID)
                        .disabled(connection.claim != nil)
                    TextField("Pairing ID", text: $connection.pairingID)
                        .disabled(connection.claim != nil)
                    SecureField("配对密钥", text: $connection.secret)
                        .disabled(connection.claim != nil)
                    if connection.claim != nil {
                        Button("重试完成配对") { Task { await connection.finishPairing() } }
                        Button("重新填写配对信息") { connection.claim = nil }
                    } else {
                        Button("请求配对") { Task { await connection.requestPairing() } }
                            .disabled(connection.pairingID.isEmpty || connection.secret.isEmpty)
                    }
                }
                if connection.claim != nil {
                    Section {
                        Text("等待 Mac 批准，批准后将自动连接。")
                        Button("重试连接") { Task { await connection.finishPairing() } }
                        Button("取消配对") { connection.claim = nil }
                    }
                }
                Section {
                    Text("在 Mac 点击开启设备接入即可。扫码会验证 Mac 的证书，无需安装系统证书；请允许局域网访问。批准后可浏览、发送和停止；修改类会话命令与清空上下文需在 Mac 设备设置中另外授权。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .disabled(connection.busy)
            .navigationTitle("连接 Corptie")
            .task(id: connection.claim?.pairingId) { await connection.waitForApproval() }
            .sheet(item: $scanner, onDismiss: consumeScan) { _ in
                PairingScannerView(onScan: { scannedPayload = $0 })
            }
            .alert("撤销移动设备？", isPresented: Binding(
                get: { cloudRevocation != nil }, set: { if !$0 { cloudRevocation = nil } }
            )) {
                Button("取消", role: .cancel) { cloudRevocation = nil }
                Button("撤销", role: .destructive) {
                    if let device = cloudRevocation { Task { await connection.revokeCloudDevice(device) } }
                    cloudRevocation = nil
                }
            } message: {
                Text("\(cloudRevocation?.displayName ?? "") 将立即失去 Cloud 访问权限。此操作需要最近重新认证。")
            }
        }
    }

    private func startCloudSignIn() {
        do {
            let url = try connection.beginCloudSignIn()
            cloudSignIn.start(url: url) { result in
                switch result {
                case .success(let callback):
                    Task { await connection.completeCloudSignIn(callback: callback, deviceName: UIDevice.current.name) }
                case .failure(let error as ASWebAuthenticationSessionError) where error.code == .canceledLogin:
                    break
                case .failure:
                    connection.notice = "Cloud 登录未完成，请重试。"
                }
            }
        } catch {
            connection.notice = "Cloud 登录配置无效，请更新应用后重试。"
        }
    }

    private func consumeScan() {
        guard let payload = scannedPayload else { return }
        scannedPayload = nil
        do {
            try connection.applyPairingCode(payload)
            Task { await connection.requestPairing() }
        } catch DevicePairingCode.CodeError.expired {
            connection.notice = "配对二维码已过期，请在 Mac 上重新生成。"
        } catch {
            connection.notice = "不是有效的 Corptie 配对二维码，请扫描 Mac 设备设置中的二维码。"
        }
    }
}

private enum CompactWorkspacePage: Hashable {
    case conversation(String)
    case detail(String)
}

struct WorkspaceView: View {
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let compactOpenSessionRequest: Int
    let onCompactRootChange: (Bool) -> Void
    @State private var expandedWorkIDs = PadWorkExpansionStore().load()
    @State private var isChatExpanded = PadWorkExpansionStore().loadChat()
    @State private var taskCreationRoute: PadTaskCreationRoute?
    @State private var taskCreationStates: [String: PadTaskCreationState] = [:]
    @State private var compactPath: [CompactWorkspacePage] = []
    @State private var workAvatars = PadWorkAvatarStore()
    @State private var messageImages = PadMessageImageStore()
    @State private var entityCommands: PadEntityCommandState?
    @State private var entityRoute: PadEntityRoute?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var activeEntityCommands: PadEntityCommandState {
        if let existing = entityCommands, existing.matches(connection) { return existing }
        let created = PadEntityCommandState(connection: connection)
        entityCommands = created
        return created
    }

    var body: some View {
        let commands = activeEntityCommands
        GeometryReader { geometry in
            // 312 Work + 440 conversation + 320 Detail. Narrower windows
            // present the same pages one at a time instead of squeezing cards.
            if PadWorkspaceLayoutPolicy.showsPersistentOutlineSelection(
                isRegularWidth: horizontalSizeClass == .regular,
                width: geometry.size.width
            ) {
                HStack(spacing: 0) {
                    workColumn(
                        commands,
                        showsPersistentSelection: true,
                        onOpenSession: { workspace.selection = $0 }
                    )
                        .frame(width: 312)
                    conversationColumn
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    if let id = workspace.selection {
                        PadConversationInspector(workspace: workspace, connection: connection, sessionID: id)
                            .id(id)
                            .frame(width: 320)
                    }
                }
                .background(WorkbenchCanvasSurface.color)
            } else {
                compactWorkspace(commands)
            }
        }
        .toolbar(removing: .sidebarToggle)
        .toolbar(.hidden, for: .navigationBar)
        // Same trigger set as macOS `markOpenedSessionRead`: open, scene active, new agent output.
        .onChange(of: readAcknowledgementKey, initial: true) {
            workspace.acknowledgeOpenedSession(connection, isActive: scenePhase == .active)
        }
        .sheet(item: $taskCreationRoute) { route in
            PadTaskCreationSheet(route: route, connection: connection, workspace: workspace, state: route.state)
        }
        .sheet(item: $entityRoute) { route in
            switch route {
            case .createWork:
                PadCreateWorkSheet(connection: connection, commands: commands)
            case .editWork(let work):
                PadEditWorkSheet(connection: connection, commands: commands, work: work) { }
            case .renameTask(let task):
                PadRenameTaskSheet(connection: connection, commands: commands, task: task) { }
            case .editTask(let task):
                PadEditTaskSheet(connection: connection, commands: commands, task: task) { }
            case .deleteTask(let task):
                PadDeleteTaskSheet(connection: connection, commands: commands, task: task) {
                    if let selected = workspace.selection,
                       workspace.sessionsByID[selected]?.taskId == task.id {
                        workspace.selection = nil
                    }
                }
            case .deleteWork(let work):
                PadDeleteWorkSheet(connection: connection, commands: commands, work: work) {
                    expandedWorkIDs.remove(work.id)
                    if let selected = workspace.selection,
                       workspace.sessionsByID[selected]?.workId == work.id {
                        workspace.selection = nil
                    }
                }
            }
        }
        .onChange(of: expandedWorkIDs) { _, workIDs in
            PadWorkExpansionStore().save(workIDs)
        }
        .onChange(of: isChatExpanded) { _, expanded in
            PadWorkExpansionStore().saveChat(expanded)
        }
        .task(id: "\(commands.pending?.requestID ?? ""):active=\(scenePhase == .active)") {
            guard scenePhase == .active, commands.pending != nil else { return }
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            guard !Task.isCancelled, commands.pending != nil else { return }
            await commands.reconcile(connection)
        }
        .onChange(of: workspace.pushedReceiptRevision) {
            if let receipt = workspace.pushedReceipt { commands.acceptPushed(receipt) }
        }
    }

    private func compactWorkspace(_ commands: PadEntityCommandState) -> some View {
        NavigationStack(path: $compactPath) {
            workColumn(commands, showsPersistentSelection: false, onOpenSession: openCompactSession)
                .navigationDestination(for: CompactWorkspacePage.self) { page in
                    switch page {
                    case .conversation(let id):
                        ConversationView(connection: connection, workspace: workspace, sessionID: id,
                            messageImages: messageImages,
                            onBack: { if compactPath.last == .conversation(id) { compactPath.removeLast() } },
                            onOpenDetail: { if compactPath.last == .conversation(id) { compactPath.append(.detail(id)) } })
                            .id(id)
                    case .detail(let id):
                        PadConversationInspector(workspace: workspace, connection: connection, sessionID: id)
                            .safeAreaInset(edge: .top, spacing: 0) { compactDetailHeader }
                            .toolbar(.hidden, for: .navigationBar)
                            .modifier(CompactBackSwipe {
                                if compactPath.last == .detail(id) { compactPath.removeLast() }
                            })
                    }
                }
        }
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityIdentifier("compact-workspace")
        .onChange(of: compactPath, initial: true) { _, path in
            onCompactRootChange(path.isEmpty)
        }
        .onChange(of: workspace.selection) { _, id in
            guard let id else { compactPath = []; return }
            guard compactPath.last != .conversation(id), compactPath.last != .detail(id) else { return }
            compactPath = [.conversation(id)]
        }
        .onChange(of: compactOpenSessionRequest) {
            if let id = workspace.selection { compactPath = [.conversation(id)] }
        }
    }

    private func openCompactSession(_ id: String) {
        workspace.selection = id
        compactPath = [.conversation(id)]
    }

    private var compactDetailHeader: some View {
        HStack(spacing: 8) {
            Button {
                if !compactPath.isEmpty { compactPath.removeLast() }
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .padGlassSurface(in: Circle(), interactive: true)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("返回聊天")
            .accessibilityIdentifier("conversation-detail-back")
            Spacer(minLength: 0)
            Text("Detail")
                .font(.title3.weight(.semibold))
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            Color.clear.frame(width: 44, height: 44)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    private func workColumn(_ commands: PadEntityCommandState,
                            showsPersistentSelection: Bool,
                            onOpenSession: @escaping (String) -> Void) -> some View {
        PadWorkOutline(connection: connection, workspace: workspace, workAvatars: workAvatars,
            entityCommands: commands, isActive: scenePhase == .active, expandedWorkIDs: $expandedWorkIDs,
            isChatExpanded: $isChatExpanded, showsPersistentSelection: showsPersistentSelection,
            onOpenSession: onOpenSession,
            createTask: openTaskCreation, onEntityRoute: { route in
                entityRoute = route
        })
        .disabled(connection.busy)
        .safeAreaInset(edge: .top, spacing: 0) {
            if !commands.notice.isEmpty {
                HStack(spacing: 8) {
                    Text(commands.notice).font(.caption2).foregroundStyle(.secondary)
                    if commands.pending != nil {
                        Button("核对") { Task { await commands.reconcile(connection) } }
                            .font(.caption2.weight(.semibold))
                            .buttonStyle(.plain)
                            .disabled(commands.checking)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .background(.ultraThinMaterial, in: Capsule())
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 4)
            }
        }
    }

    @ViewBuilder private var conversationColumn: some View {
        if let id = workspace.selection {
            ConversationView(connection: connection, workspace: workspace, sessionID: id,
                messageImages: messageImages,
                onBack: nil, onOpenDetail: nil)
                .id(id)
        } else {
            ContentUnavailableView("选择一个 Task 或会话", systemImage: "bubble.left.and.text.bubble.right",
                description: Text("消息与状态自动更新。"))
        }
    }

    private struct ReadAcknowledgementKey: Equatable {
        let sessionID: String?
        let lastAgentMessageSequence: Int
        let isActive: Bool
    }

    private var readAcknowledgementKey: ReadAcknowledgementKey {
        let session = workspace.selection.flatMap { workspace.sessionsByID[$0] }
        return ReadAcknowledgementKey(sessionID: workspace.selection,
            lastAgentMessageSequence: session?.lastAgentMessageSequence ?? 0, isActive: scenePhase == .active)
    }

    private func openTaskCreation(_ work: ClientWork) {
        let candidates = workspace.sessions.filter { $0.workId == work.id }
        if let existing = taskCreationStates[work.id], existing.matches(connection),
           existing.pending != nil || candidates.contains(where: { $0.id == existing.sourceSessionID }) {
            taskCreationRoute = PadTaskCreationRoute(workName: work.name, state: existing)
            return
        }
        taskCreationStates[work.id]?.flush()
        guard let source = candidates.first(where: { $0.id == workspace.selection })
            ?? candidates.first(where: { $0.sessionKind == "workChat" }) ?? candidates.first else {
            connection.notice = "此 Work 尚无来源会话，暂时无法创建 Task。请先在 Mac 上建立 Work 讨论。"
            return
        }
        let state = PadTaskCreationState(workID: work.id, sourceSessionID: source.id, connection: connection)
        taskCreationStates[work.id] = state
        taskCreationRoute = PadTaskCreationRoute(workName: work.name, state: state)
    }
}

struct ConversationView: View {
    @Environment(\.scenePhase) private var scenePhase
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let sessionID: String
    let messageImages: PadMessageImageStore
    let onBack: (() -> Void)?
    let onOpenDetail: (() -> Void)?
    @State private var confirmForget = false
    @State private var viewportState = ConversationViewportState()
    @State private var historyViewport = TimelineHistoryViewportState()
    @State private var historyAutoLoadGate = PadHistoryAutoLoadGate()
    @State private var timelineScrollView: UIScrollView?
    @State private var pendingHistoryViewport: PendingHistoryViewport?
    @State private var historyAnchorGeometry = TimelineAnchorGeometry()
    @State private var deferredHistoryLoad = false
    @State private var isUserInteractingWithTimeline = false
    /// Rounded whole-point lane width prevents sub-pixel geometry changes from
    /// invalidating every realized message row during keyboard/split resizing.
    @State private var laneWidth: CGFloat = 0
    @State private var latestPlacementTask: Task<Void, Never>?
    @State private var historyRestorationTask: Task<Void, Never>?
    @State private var didPlaceInitialTimeline = false
    @State private var pendingLatestJump = false
    @State private var latestJumpGeneration: UInt64 = 0
    @State private var attachmentPreview: PadAttachmentPreview?
    @State private var composerSheet: ComposerSheet?
    private enum ComposerSheet: String, Identifiable {
        case schedule
        var id: String { rawValue }
    }
    private var draft: Binding<String> {
        Binding(get: { workspace.drafts[sessionID] ?? "" }, set: { workspace.drafts[sessionID] = $0 })
    }
    var body: some View {
        GeometryReader { viewport in
        let cardLaneWidth = max(0, viewport.size.width - 32).rounded(.down)
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(spacing: 12) {
                    Color.clear
                        .frame(height: 1)
                        .background {
                            GeometryReader { proxy in
                                Color.clear.preference(
                                    key: TimelineNearTopKey.self,
                                    value: proxy.frame(in: .named(timelineCoordinateSpace)).minY >= -8
                                )
                            }
                        }
                        .accessibilityHidden(true)
                    if workspace.isLoadingEarlier {
                        HStack(spacing: 8) {
                            ProgressView()
                                .controlSize(.small)
                            Text("正在加载更早消息…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                    } else if workspace.before == nil, !workspace.hasHiddenDisplayHistory,
                              !workspace.messages.isEmpty {
                        Text("已显示全部历史消息")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.vertical, 8)
                    }
                    ForEach(workspace.displayEntries) { entry in
                        Group {
                        switch entry.kind {
                        case .message(let message):
                            if message.presentationKind == .collaborationMessage
                                || message.presentationKind == .collaborationConfirmation {
                                PadCollaborationCard(message: message, connection: connection, sessionID: sessionID,
                                    canRespond: workspace.capabilities?.collaborationConfirmation?.available == true,
                                    onSubmitted: {
                                        let revision = workspace.lastTimelineRevision
                                        await workspace.waitForRealtimeTimelineOrFallback(connection, after: revision)
                                    }).id(message.id)
                            } else if message.presentationKind == .automationEvent
                                        || message.presentationKind == .systemEvent
                                        || message.presentationKind == .unknown {
                                PadSpecialEventCard(message: message).id(message.id)
                            } else if message.type == "userInput" {
                                PadUserInputCard(message: message, connection: connection, sessionID: sessionID,
                                    onSubmitted: {
                                        let revision = workspace.lastTimelineRevision
                                        await workspace.waitForRealtimeTimelineOrFallback(connection, after: revision)
                                    }).id(message.id)
                            } else if message.type == "choice" || message.type == "approval" {
                                PadApprovalCard(message: message, connection: connection, sessionID: sessionID,
                                    onSubmitted: {
                                        let revision = workspace.lastTimelineRevision
                                        await workspace.waitForRealtimeTimelineOrFallback(connection, after: revision)
                                    }).id(message.id)
                            } else if (message.type == "executionPlan" || message.type == "plan"),
                                      let plan = message.executionPlan {
                                PadExecutionPlanTimelineCard(plan: plan, laneWidth: cardLaneWidth)
                                    .id(message.id)
                            } else {
                                MobileMessageBubble(message: message, deliveryState: workspace.outgoingStates[message.id],
                                    timeSeparatorText: workspace.timeSeparatorTextByMessageID[message.id],
                                    laneWidth: cardLaneWidth, connection: connection, sessionID: sessionID,
                                    images: messageImages,
                                    openAttachment: { attachmentPreview = PadAttachmentPreview(sessionID: sessionID, image: $0) },
                                    canSendSuggestedReply: !connection.busy && workspace.pending == nil
                                        && workspace.capabilities?.send.available == true,
                                    sendSuggestedReply: { text in
                                        Task { await workspace.sendSuggestedReply(connection, sessionID: sessionID, text: text) }
                                    })
                                    .id(message.id)
                            }
                        case .process(_, let items):
                            if let presentation = workspace.processPresentations[entry.id] {
                                PadProcessCard(steps: workspace.processSteps[entry.id] ?? [], presentation: presentation,
                                               laneWidth: cardLaneWidth,
                                               startedAt: items.contains(where: { $0.processEndedAt != nil })
                                                   ? nil : ConversationProcessPresentation.startedAt(for: items),
                                               canAdvance: PadProcessClockPolicy.canAdvance(
                                                   isActiveProcess: entry.id == workspace.activeProcessEntryID,
                                                   clientIsOnline: connection.connected,
                                                   sessionExecutionStatus: workspace.sessions.first(where: {
                                                       $0.id == sessionID
                                                   })?.executionStatus,
                                                   sceneIsActive: scenePhase == .active))
                                    .id(sessionID + ":" + entry.id)
                            }
                        }
                        }
                        .id(entry.id)
                        .background {
                            if entry.id == workspace.displayEntries.first?.id
                                || entry.id == pendingHistoryViewport?.entryID {
                                GeometryReader { proxy in
                                    Color.clear.preference(
                                        key: TimelineAnchorPositionKey.self,
                                        value: TimelineAnchorPosition(
                                            entryID: entry.id,
                                            minY: proxy.frame(in: .named(timelineCoordinateSpace)).minY
                                        )
                                    )
                                }
                            }
                        }
                    }
                    Color.clear.frame(height: 1).id("latest")
                        .onAppear {
                            if #unavailable(iOS 18.0) { viewportState.setFollowsLatest(true) }
                        }
                        .onDisappear {
                            if #unavailable(iOS 18.0) { viewportState.setFollowsLatest(false) }
                            requestEarlierHistoryIfNeeded(reader)
                        }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: TimelineContentHeightKey.self,
                            value: proxy.size.height.rounded(.up)
                        )
                    }
                }
            }
            .defaultScrollAnchor(.bottom)
            .coordinateSpace(name: timelineCoordinateSpace)
            .background(TimelineScrollViewResolver { scrollView in
                if timelineScrollView !== scrollView { timelineScrollView = scrollView }
            })
            .modifier(TimelineFollowLatestModifier(
                followLatest: followsLatestBinding,
                onUserInteractionChange: { interacting in
                    isUserInteractingWithTimeline = interacting
                    if interacting {
                        cancelPendingTimelinePlacement()
                        pendingLatestJump = false
                        pendingHistoryViewport = nil
                        requestEarlierHistoryIfNeeded(reader, userInitiated: true)
                    } else {
                        finishDeferredHistoryLoadIfReady(reader)
                        if pendingHistoryViewport != nil { restoreHistoryViewportIfReady(reader) }
                    }
                },
                onBottomProximityChange: { nearBottom in
                    guard pendingLatestJump else { return }
                    if nearBottom {
                        pendingLatestJump = false
                    }
                }
            ))
            .scrollDismissesKeyboard(.interactively)
            .overlay {
                if workspace.displayEntries.isEmpty {
                    ContentUnavailableView(
                        workspace.selectedTimelineReady ? "暂无消息" : "正在同步消息…",
                        systemImage: workspace.selectedTimelineReady ? "bubble.left" : "arrow.triangle.2.circlepath"
                    )
                    .allowsHitTesting(false)
                }
            }
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: TimelineViewportSizeKey.self, value: proxy.size)
                }
            }
            .onPreferenceChange(TimelineNearTopKey.self) { nearTop in
                guard nearTop != historyViewport.nearTop else { return }
                historyViewport.nearTop = nearTop
                requestEarlierHistoryIfNeeded(reader)
            }
            .onPreferenceChange(TimelineAnchorPositionKey.self) { position in
                historyAnchorGeometry.latest = position
                correctHistoryAnchorIfReady(position)
            }
            .onPreferenceChange(TimelineContentHeightKey.self) { height in
                guard height != historyViewport.contentHeight else { return }
                historyViewport.contentHeight = height
                placeInitialTimelineIfReady(reader)
                // Measuring lazy rows is not a new scroll intent. Scrolling
                // here can change the estimate and recursively request another
                // jump. Tail revisions and viewport changes schedule placement.
                requestEarlierHistoryIfNeeded(reader)
            }
            .onPreferenceChange(TimelineViewportSizeKey.self) { size in
                let roundedWidth = max(0, size.width - 32).rounded(.down)
                if roundedWidth != laneWidth { laneWidth = roundedWidth }
                let roundedHeight = size.height.rounded(.down)
                guard roundedHeight != historyViewport.viewportHeight else { return }
                historyViewport.viewportHeight = roundedHeight
                placeInitialTimelineIfReady(reader)
                // Keyboard safe-area changes resize the timeline and composer
                // in the same animation. Follow the stable SwiftUI tail identity
                // so the last message travels with the composer without bypassing
                // the lazy row virtualization pipeline.
                if didPlaceInitialTimeline && viewportState.followsLatest {
                    scheduleLatestPlacement(reader)
                }
                requestEarlierHistoryIfNeeded(reader)
            }
            .accessibilityIdentifier("conversation-timeline")
            .modifier(CompactPageSwipe(onBack: onBack, onOpenDetail: onOpenDetail,
                viewportWidth: viewport.size.width))
            .task(id: sessionID) {
                let hadCachedCapabilities = workspace.capabilities != nil
                await workspace.waitForRealtimeTimelineOrFallback(connection)
                guard !Task.isCancelled else { return }
                if !hadCachedCapabilities || viewportState.followsLatest { placeInitialTimelineIfReady(reader) }
                await workspace.repairMissingUsage(connection)
            }
            .onChange(of: workspace.messageRevision) {
                if viewportState.timelineTailDidChange() {
                    if didPlaceInitialTimeline { scheduleLatestPlacement(reader) }
                    else { placeInitialTimelineIfReady(reader) }
                }
            }
            .onChange(of: workspace.scrollRequest) {
                jumpToLatest(reader)
            }
            .onChange(of: workspace.before) {
                requestEarlierHistoryIfNeeded(reader)
            }
            .onChange(of: workspace.isLoadingEarlier) { _, isLoading in
                if !isLoading {
                    if pendingHistoryViewport != nil {
                        restoreHistoryViewportIfReady(reader)
                    } else if viewportState.followsLatest {
                        scheduleLatestPlacement(reader)
                    }
                    requestEarlierHistoryIfNeeded(reader)
                }
            }
            .onChange(of: connection.busy) { _, isBusy in
                if !isBusy {
                    finishDeferredHistoryLoadIfReady(reader)
                    requestEarlierHistoryIfNeeded(reader)
                }
            }
            .onChange(of: sessionID) { _, _ in
                viewportState.reset()
                pendingHistoryViewport = nil
                historyAnchorGeometry.latest = nil
                deferredHistoryLoad = false
                isUserInteractingWithTimeline = false
                timelineScrollView = nil
                historyViewport = TimelineHistoryViewportState()
                historyAutoLoadGate = PadHistoryAutoLoadGate()
                didPlaceInitialTimeline = false
                cancelPendingTimelinePlacement()
                pendingLatestJump = false
            }
            .onDisappear { cancelPendingTimelinePlacement() }
            .overlay(alignment: .bottomTrailing) {
                if viewportState.showsJumpToLatest || pendingLatestJump {
                    Button {
                        jumpToLatest(reader)
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: 14, weight: .bold))
                            .frame(width: 36, height: 36)
                            .contentShape(Circle())
                            .padGlassSurface(in: Circle(), interactive: true)
                            .overlay(alignment: .topTrailing) {
                                if viewportState.hasNewMessagesBelow {
                                    Circle().fill(Color.accentColor).frame(width: 8, height: 8)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("跳到最新消息")
                    .accessibilityIdentifier("conversation-jump-to-latest")
                    .padding(.trailing, 14)
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .scale(scale: 0.85)))
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { conversationHeader }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .coordinateSpace(name: "conversation-viewport")
        .background(WorkbenchCanvasSurface.color)
        .toolbar(.hidden, for: .navigationBar)
        .confirmationDialog("已核对消息与执行状态？清除记录不会取消后台执行。", isPresented: $confirmForget, titleVisibility: .visible) {
            Button("已核对，清除本机待核对记录", role: .destructive) { workspace.forgetPending() }
        }
        .sheet(item: $composerSheet) { _ in
            PadScheduleMessageView(connection: connection, workspace: workspace, sessionID: sessionID)
        }
        .sheet(item: $workspace.commandConfirmation) { proposal in
            PadCommandConfirmationView(connection: connection, workspace: workspace, proposal: proposal)
        }
        .sheet(item: $attachmentPreview) { preview in
            PadAttachmentViewer(connection: connection, preview: preview)
        }
        }
    }

    private var timelineCoordinateSpace: String {
        "conversation-timeline-\(sessionID)"
    }

    private var followsLatestBinding: Binding<Bool> {
        Binding(
            get: { viewportState.followsLatest },
            set: { viewportState.setFollowsLatest($0) }
        )
    }

    /// Explicit intent shares the same coalesced placement as tail updates.
    private func jumpToLatest(_ reader: ScrollViewProxy) {
        historyRestorationTask?.cancel()
        historyRestorationTask = nil
        pendingHistoryViewport = nil
        deferredHistoryLoad = false
        withAnimation(.easeInOut(duration: 0.2)) {
            viewportState.jumpToLatest()
        }
        pendingLatestJump = true
        scheduleLatestPlacement(reader)
    }

    /// Coalesce tail, send/receipt and keyboard requests into one placement
    /// after the current layout transaction. Never drive this from row heights.
    private func scheduleLatestPlacement(_ reader: ScrollViewProxy) {
        guard latestPlacementTask == nil, !isUserInteractingWithTimeline,
              viewportState.followsLatest, pendingHistoryViewport == nil,
              !workspace.displayEntries.isEmpty,
              historyViewport.viewportHeight > 1, laneWidth > 0 else { return }
        let generation = latestJumpGeneration
        let targetSessionID = sessionID
        latestPlacementTask = Task { @MainActor in
            defer {
                if generation == latestJumpGeneration { latestPlacementTask = nil }
            }
            do { try await Task.sleep(for: .milliseconds(16)) } catch { return }
            guard !Task.isCancelled, generation == latestJumpGeneration,
                  workspace.selection == targetSessionID,
                  !isUserInteractingWithTimeline, viewportState.followsLatest,
                  pendingHistoryViewport == nil, !workspace.displayEntries.isEmpty else { return }
            withTransaction(Transaction(animation: nil)) {
                reader.scrollTo("latest", anchor: .bottom)
            }
            didPlaceInitialTimeline = true
            pendingLatestJump = false
        }
    }

    private func cancelPendingTimelinePlacement() {
        latestJumpGeneration &+= 1
        latestPlacementTask?.cancel()
        latestPlacementTask = nil
        historyRestorationTask?.cancel()
        historyRestorationTask = nil
    }

    private func isTimelineAtLatest() -> Bool {
        guard let timelineScrollView else { return false }
        let maximumY = max(
            -timelineScrollView.adjustedContentInset.top,
            timelineScrollView.contentSize.height - timelineScrollView.bounds.height
                + timelineScrollView.adjustedContentInset.bottom
        )
        return maximumY - timelineScrollView.contentOffset.y <= 24
    }

    /// ScrollViewReader cannot reliably resolve the lazy tail marker before
    /// the first message rows and viewport have both completed layout. Wait
    /// one UI turn, then perform the initial semantic jump exactly once.
    private func placeInitialTimelineIfReady(_ reader: ScrollViewProxy) {
        guard !didPlaceInitialTimeline else { return }
        scheduleLatestPlacement(reader)
    }

    private func requestEarlierHistoryIfNeeded(_ reader: ScrollViewProxy, userInitiated: Bool = false) {
        let viewportReady = historyViewport.contentHeight > 0 && historyViewport.viewportHeight > 1
        let underfilled = viewportReady
            && historyViewport.contentHeight <= historyViewport.viewportHeight + 0.5
        guard historyAutoLoadGate.requestCursor(
            scope: sessionID,
            before: workspace.historyRequestCursor,
            nearTop: historyViewport.nearTop,
            userInitiated: userInitiated || isUserInteractingWithTimeline,
            underfilled: underfilled,
            isLoading: workspace.isLoadingEarlier,
            connectionBusy: connection.busy
        ) != nil else { return }
        // A local history window can expand in the same frame as the reader's
        // drag. Wait for the gesture to settle before changing the lazy stack;
        // otherwise the newly inserted rows become visible before restoration.
        if isUserInteractingWithTimeline && !underfilled {
            deferredHistoryLoad = true
            return
        }
        startEarlierHistoryLoad(reader, preservingLatestFollow: underfilled)
    }

    private func finishDeferredHistoryLoadIfReady(_ reader: ScrollViewProxy) {
        guard deferredHistoryLoad, !isUserInteractingWithTimeline else { return }
        guard historyViewport.nearTop else {
            deferredHistoryLoad = false
            return
        }
        guard !connection.busy, !workspace.isLoadingEarlier else { return }
        deferredHistoryLoad = false
        startEarlierHistoryLoad(reader, preservingLatestFollow: false)
    }

    private func startEarlierHistoryLoad(_ reader: ScrollViewProxy, preservingLatestFollow: Bool) {
        viewportState.prepareForHistoryPrepend(preservingLatestFollow: preservingLatestFollow)
        if !viewportState.followsLatest,
           let entryID = workspace.displayEntries.first?.id,
           let position = historyAnchorGeometry.latest,
           position.entryID == entryID {
            pendingHistoryViewport = PendingHistoryViewport(
                entryID: entryID,
                minY: position.minY
            )
        }
        let generation = latestJumpGeneration
        let targetSessionID = sessionID
        Task {
            await workspace.loadEarlierMessagesIfNeeded(connection)
            guard !Task.isCancelled, generation == latestJumpGeneration,
                  workspace.selection == targetSessionID else { return }
            restoreHistoryViewportIfReady(reader)
        }
    }

    private func restoreHistoryViewportIfReady(_ reader: ScrollViewProxy) {
        guard !workspace.isLoadingEarlier,
              var pending = pendingHistoryViewport,
              !pending.isRestorationScheduled,
              !isUserInteractingWithTimeline else { return }
        guard workspace.displayEntries.contains(where: { $0.id == pending.entryID }) else {
            pendingHistoryViewport = nil
            return
        }
        pending.isRestorationScheduled = true
        pendingHistoryViewport = pending
        let generation = latestJumpGeneration
        let targetSessionID = sessionID
        historyRestorationTask?.cancel()
        historyRestorationTask = Task { @MainActor in
            defer {
                if generation == latestJumpGeneration { historyRestorationTask = nil }
            }
            await Task.yield()
            guard !Task.isCancelled, generation == latestJumpGeneration,
                  workspace.selection == targetSessionID,
                  pendingHistoryViewport?.entryID == pending.entryID else { return }
            guard !isUserInteractingWithTimeline else {
                pendingHistoryViewport?.isRestorationScheduled = false
                return
            }
            historyAnchorGeometry.latest = nil
            pendingHistoryViewport?.didScrollToAnchor = true
            withTransaction(Transaction(animation: nil)) {
                reader.scrollTo(pending.entryID, anchor: .top)
            }
            await Task.yield()
            guard !Task.isCancelled, generation == latestJumpGeneration,
                  workspace.selection == targetSessionID else { return }
            correctHistoryAnchorIfReady(historyAnchorGeometry.latest)
        }
    }

    private func correctHistoryAnchorIfReady(_ position: TimelineAnchorPosition?) {
        guard !workspace.isLoadingEarlier,
              let pendingHistoryViewport,
              pendingHistoryViewport.didScrollToAnchor,
              let position, position.entryID == pendingHistoryViewport.entryID,
              let timelineScrollView else { return }
        timelineScrollView.layoutIfNeeded()
        let minimumY = -timelineScrollView.adjustedContentInset.top
        let maximumY = max(
            minimumY,
            timelineScrollView.contentSize.height - timelineScrollView.bounds.height
                + timelineScrollView.adjustedContentInset.bottom
        )
        let delta = position.minY - pendingHistoryViewport.minY
        let restoredY = min(maximumY, max(minimumY, timelineScrollView.contentOffset.y + delta))
        if abs(restoredY - timelineScrollView.contentOffset.y) >= 0.5 {
            timelineScrollView.setContentOffset(
                CGPoint(x: timelineScrollView.contentOffset.x, y: restoredY), animated: false
            )
        }
        self.pendingHistoryViewport = nil
    }

    private var conversationHeader: some View {
        let session = workspace.sessionsByID[sessionID]
        let title = workspace.tasks.first(where: { $0.id == session?.taskId })?.title
            ?? session?.title ?? "会话"

        return HStack(spacing: 8) {
            if let onBack {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 16, weight: .semibold))
                        .frame(width: 44, height: 44)
                        .padGlassSurface(in: Circle(), interactive: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("返回 Work")
                .accessibilityIdentifier("conversation-back")
            }
            Text(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "会话" : title)
                .font(.title3.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .padGlassSurface(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxWidth: onBack == nil ? 360 : .infinity)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("conversation-task-title")
            if let onOpenDetail {
                Button(action: onOpenDetail) {
                    Image(systemName: "sidebar.right")
                        .font(.system(size: 16, weight: .medium))
                        .frame(width: 44, height: 44)
                        .padGlassSurface(in: Circle(), interactive: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("打开 Detail")
                .accessibilityIdentifier("conversation-open-detail")
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 16)
        .padding(.top, 4)
        .padding(.bottom, 8)
    }

    private var conversationStatusRow: some View {
        HStack(spacing: 8) {
            PadThreadMetaView(session: workspace.sessionsByID[sessionID],
                              capabilities: workspace.capabilities, usage: workspace.selectedSessionUsage,
                              refreshAccount: { await workspace.refreshFreshAccountUsage(connection, sessionID: sessionID) },
                              compactUsage: UIDevice.current.userInterfaceIdiom == .phone)
            Spacer(minLength: 0)
            if UIDevice.current.userInterfaceIdiom != .phone {
                ZStack {
                    if canStopCurrentSession {
                        Button {
                            stopCurrentSession()
                        } label: {
                            Image(systemName: "stop.fill")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundStyle(.red)
                                .frame(width: 28, height: 28)
                                .padGlassSurface(in: Circle(), tint: .red.opacity(0.12))
                                .overlay {
                                    Circle().strokeBorder(Color.red.opacity(0.45), lineWidth: 1)
                                        .allowsHitTesting(false)
                                }
                                .frame(width: 44, height: 32)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(connection.busy || workspace.pending != nil)
                        .accessibilityLabel("停止当前运行")
                        .accessibilityIdentifier("conversation-stop")
                    }
                }
                // iPad keeps its stable status-row slot; iPhone puts Stop in the editor.
                .frame(width: 44, height: 32)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var canStopCurrentSession: Bool {
        let session = workspace.sessionsByID[sessionID]
        let isRunning = SessionExecutionState(executionStatus: session?.executionStatus) == .running
            || SessionExecutionState(executionStatus: workspace.executionByTaskID[session?.taskId ?? ""]) == .running
        return isRunning && workspace.capabilities?.stop.available == true
    }

    private func stopCurrentSession() {
        Task { await workspace.command(connection, stop: true) }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !workspace.conversationNotice.isEmpty {
                Label(workspace.conversationNotice, systemImage: "exclamationmark.circle")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("conversation-notice")
            }
            if !workspace.status.isEmpty { Text(workspace.status).font(.caption).foregroundStyle(.secondary) }
            if let pending = workspace.pending, !connection.busy, !workspace.automaticReconciliationActive {
                Text("有待核对的\(pending.kind == "send" ? "发送" : pending.kind == "conversation_command" ? "命令" : "停止")请求：\(pending.sessionID)")
                    .font(.caption).textSelection(.enabled)
                HStack {
                    Button("查询回执") { Task { await workspace.reconcile(connection) } }
                        .disabled(connection.busy || pending.serverID != connection.serverID || pending.address != connection.address)
                    Button("已人工核对…") { confirmForget = true }.disabled(connection.busy)
                }
            }
            if let catalog = workspace.commandCatalog,
               let prefix = slashCommandPrefix(draft.wrappedValue),
               !catalog.commands.isEmpty {
                let matching = catalog.commands.filter { prefix.isEmpty || $0.name.lowercased().hasPrefix(prefix.lowercased()) }
                if !matching.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyHStack(spacing: 8) {
                            ForEach(matching) { cmd in
                                Button {
                                    draft.wrappedValue = "/\(cmd.name) "
                                } label: {
                                    HStack(spacing: 4) {
                                        Text("/\(cmd.name)").font(.system(size: 12, weight: .semibold))
                                        Text(cmd.summary).font(.system(size: 11)).foregroundStyle(.secondary)
                                    }
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .padGlassSurface(in: Capsule(), interactive: true,
                                                     fallbackUsesMaterial: false)
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("command-suggestion-\(cmd.name)")
                            }
                        }
                        .padding(.horizontal, 4).padding(.vertical, 2)
                    }
                }
            }
            PadComposer(connection: connection, workspace: workspace, sessionID: sessionID,
                        scheduleMessage: { composerSheet = .schedule },
                        canStop: canStopCurrentSession, stop: stopCurrentSession) {
                conversationStatusRow
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .background { ConversationChromeBackdrop(isBottom: true) }
    }

    private func slashCommandPrefix(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), !trimmed.contains(where: { $0.isWhitespace }) else { return nil }
        return String(trimmed.dropFirst())
    }
}

private struct CompactPageSwipe: ViewModifier {
    let onBack: (() -> Void)?
    let onOpenDetail: (() -> Void)?
    let viewportWidth: CGFloat

    @ViewBuilder func body(content: Content) -> some View {
        if onBack != nil || onOpenDetail != nil {
            content.simultaneousGesture(
                DragGesture(minimumDistance: 20).onEnded { gesture in
                    guard viewportWidth > 0 else { return }
                    let horizontal = gesture.translation.width
                    guard abs(horizontal) > 64,
                          abs(horizontal) > abs(gesture.translation.height) * 1.5 else { return }
                    if horizontal > 0, gesture.startLocation.x <= 48 {
                        onBack?()
                    } else if horizontal < 0,
                              gesture.startLocation.x >= viewportWidth - 48 {
                        onOpenDetail?()
                    }
                }
            )
        } else {
            content
        }
    }
}

private struct CompactBackSwipe: ViewModifier {
    let onBack: () -> Void

    func body(content: Content) -> some View {
        content.simultaneousGesture(
            DragGesture(minimumDistance: 20).onEnded { gesture in
                let horizontal = gesture.translation.width
                guard gesture.startLocation.x <= 48, horizontal > 64,
                      horizontal > abs(gesture.translation.height) * 1.5 else { return }
                onBack()
            }
        )
    }
}

/// Edge-only separation. The control row itself is transparent: each control
/// supplies its own glass surface, with no solid toolbar backing between them.
private struct ConversationChromeBackdrop: View {
    let isBottom: Bool
    private let depth: CGFloat = 18
    private var surface: Color { WorkbenchCanvasSurface.color }

    var body: some View {
        VStack(spacing: 0) {
            if isBottom { fade }
            Color.clear
            if !isBottom { fade }
        }
        .mask {
            HStack(spacing: 0) {
                LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing)
                    .frame(width: 12)
                Rectangle()
                LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: 12)
            }
        }
        .padding(isBottom ? .top : .bottom, -depth)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

    private var fade: some View {
        // Fade to zero on both sides so there is no seam at the transparent row.
        LinearGradient(colors: [.clear, surface.opacity(0.35), .clear],
                       startPoint: .top, endPoint: .bottom)
            .frame(height: depth)
    }
}

private struct PadCommandConfirmationView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var submitting = false
    let connection: PadConnection
    let workspace: PadWorkspace
    let proposal: CommandConfirmation

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 16) {
                Text("后端要求确认此命令。执行后可能清除目标或会话上下文，请核对命令和会话。")
                Text(proposal.text).font(.body.monospaced()).textSelection(.enabled)
                LabeledContent("会话", value: workspace.sessionsByID[proposal.draftSessionID]?.title ?? proposal.draftSessionID)
                LabeledContent("Mac", value: proposal.address)
                Button("确认执行", role: .destructive) {
                    submitting = true
                    Task {
                        await workspace.command(connection, stop: false, confirmation: proposal)
                        dismiss()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(submitting || connection.busy)
                .accessibilityIdentifier("confirm-conversation-command")
            }
            .padding(24)
            .navigationTitle("确认命令")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(submitting)
                }
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(submitting)
    }
}

private struct PadProcessCard: View {
    let steps: [ConversationExecutionStep]
    let presentation: ConversationProcessPresentation
    @Environment(\.locale) private var locale
    let laneWidth: CGFloat
    let startedAt: Date?
    let canAdvance: Bool
    @State private var expanded = false
    @State private var locallyPausedAt: Date?
    private var latestPlan: ConversationExecutionPlan? { steps.compactMap(\.plan).last }
    private var state: ConversationProcessState { presentation.state }
    private var summary: String {
        ConversationProcessPresentation(
            state: presentation.state,
            count: presentation.count,
            duration: presentation.duration
        ).summary(languageCode: locale.language.languageCode?.identifier ?? "en")
    }
    private var progressLabel: String? {
        latestPlan.flatMap { plan in
            plan.completionFraction == nil ? nil
                : "计划 \(plan.steps.filter { $0.status == "completed" }.count)/\(plan.steps.count)"
        }
    }
    private func cardWidth(summary: String) -> CGFloat {
        let availableLane = laneWidth > 0 ? laneWidth : MessageBubbleWidthPolicy.maximumWidth
        let summaryWidth = ceil((summary as NSString).size(withAttributes: [
            .font: UIFont.systemFont(ofSize: 10.5, weight: .medium)
        ]).width)
        let secondaryWidth = presentation.currentStepTitle.map {
            ceil(($0 as NSString).size(withAttributes: [
                .font: UIFont.systemFont(ofSize: 9.5)
            ]).width)
        } ?? 0
        let progressWidth = progressLabel.map {
            ceil(($0 as NSString).size(withAttributes: [
                .font: UIFont.systemFont(ofSize: 9, weight: .semibold)
            ]).width)
        } ?? 0
        return MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: summaryWidth,
            secondaryWidth: secondaryWidth,
            progressLabelWidth: progressWidth,
            expanded: expanded,
            laneWidth: availableLane)
    }
    private var tint: Color {
        switch state {
        case .running: .accentColor
        case .completed: .green
        case .failed: .red
        case .cancelled: .secondary
        }
    }
    var body: some View {
        Group {
            if canAdvance, state == .running, let startedAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    processCard(summary: summary(at: context.date, startedAt: startedAt))
                }
            } else {
                processCard(summary: pausedSummary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("conversation-process")
        .onChange(of: canAdvance, initial: true) { previous, current in
            if previous && !current {
                locallyPausedAt = Date()
            } else if current {
                locallyPausedAt = nil
            }
        }
    }

    private var staticSummary: String {
        ConversationProcessPresentation(state: presentation.state, count: presentation.count,
            duration: presentation.duration).summary(languageCode: locale.language.languageCode?.identifier ?? "en")
    }

    private var pausedSummary: String {
        guard state == .running, let startedAt, let locallyPausedAt else {
            return staticSummary
        }
        return summary(at: locallyPausedAt, startedAt: startedAt)
    }

    private func summary(at date: Date, startedAt: Date) -> String {
        let duration = ConversationProcessPresentation.durationText(
            startedAt: startedAt, endingAt: date, showSeconds: true)
            ?? presentation.duration
        return ConversationProcessPresentation(state: presentation.state, count: presentation.count,
            duration: duration).summary(languageCode: locale.language.languageCode?.identifier ?? "en")
    }

    private func processCard(summary: String) -> some View {
        ProcessCard(summary: summary,
                    secondary: presentation.currentStepTitle,
                    symbol: state.symbolName, tint: tint, expanded: expanded,
                    progress: latestPlan?.completionFraction,
                    progressLabel: progressLabel,
                    toggle: { expanded.toggle() }) {
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(steps) { step in
                    PadExecutionStepCard(step: step)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(width: cardWidth(summary: summary), alignment: .leading)
    }
}

private struct TimelineHistoryViewportState: Equatable {
    var nearTop = false
    var contentHeight: CGFloat = 0
    var viewportHeight: CGFloat = 0
}

private struct PendingHistoryViewport: Equatable {
    let entryID: String
    let minY: CGFloat
    var isRestorationScheduled = false
    var didScrollToAnchor = false
}

private struct TimelineAnchorPosition: Equatable {
    let entryID: String
    let minY: CGFloat
}

private final class TimelineAnchorGeometry {
    var latest: TimelineAnchorPosition?
}

private struct TimelineAnchorPositionKey: PreferenceKey {
    static let defaultValue: TimelineAnchorPosition? = nil
    static func reduce(value: inout TimelineAnchorPosition?, nextValue: () -> TimelineAnchorPosition?) {
        value = nextValue() ?? value
    }
}

private struct TimelineNearTopKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
    }
}

private struct PadExecutionStepCard: View {
    let step: ConversationExecutionStep
    let presentation: ExecutionStepDetailPresentation
    let structuredPresentation: ExecutionStructuredStepPresentation?
    @State private var showsFull = false

    init(step: ConversationExecutionStep) {
        self.step = step
        self.presentation = ExecutionStepDetailPresentation(step: step)
        self.structuredPresentation = step.tool != nil || step.changeSet != nil
            ? ExecutionStructuredStepPresentation(step: step) : nil
    }

    var tint: Color {
        switch step.state {
        case .running: .accentColor
        case .completed: .green
        case .failed: .red
        case .cancelled, .unknown: .secondary
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let plan = step.plan {
                if plan.steps.count > 12 {
                    ScrollView {
                        ExecutionPlanChecklist(plan: plan)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 300)
                } else {
                    ExecutionPlanChecklist(plan: plan)
                }
            } else if let structuredPresentation {
                ExecutionStructuredStepView(presentation: structuredPresentation)
            } else {
                PadMessageText(text: "", fromUser: false,
                               steps: [presentation.displayedStep])
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if structuredPresentation?.hasOverflow ?? presentation.hasOverflow {
                Button("查看完整内容") { showsFull = true }
                    .font(.caption2)
                    .accessibilityIdentifier("execution-step-full-details")
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint.opacity(0.045), in: RoundedRectangle(cornerRadius: 8))
        .overlay {
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(tint.opacity(0.16), lineWidth: 1)
        }
        .sheet(isPresented: $showsFull) {
            PadExecutionFullDetails(step: step)
        }
    }
}

private struct PadExecutionFullDetails: View {
    let step: ConversationExecutionStep
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(ExecutionStepDetailPresentation.fullText(step))
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle("执行详情")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

private struct TimelineContentHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

private struct TimelineViewportSizeKey: PreferenceKey {
    static let defaultValue: CGSize = .zero
    static func reduce(value: inout CGSize, nextValue: () -> CGSize) {
        value = nextValue()
    }
}

private struct TimelineFollowLatestModifier: ViewModifier {
    @Binding var followLatest: Bool
    let onUserInteractionChange: (Bool) -> Void
    let onBottomProximityChange: (Bool) -> Void
    @State private var isUserScrolling = false

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .onScrollGeometryChange(for: Bool.self) { geometry in
                    Self.isNearBottom(geometry)
                } action: { _, nearBottom in
                    // Content growth can move the bottom without any user scroll.
                    // Only a user-driven phase may change the follow preference.
                    if isUserScrolling { followLatest = nearBottom }
                    onBottomProximityChange(nearBottom)
                }
                .onScrollPhaseChange { _, newPhase, context in
                    if newPhase == .interacting {
                        if !isUserScrolling {
                            isUserScrolling = true
                            onUserInteractionChange(true)
                        }
                        followLatest = Self.isNearBottom(context.geometry)
                    } else if newPhase == .idle && isUserScrolling {
                        followLatest = Self.isNearBottom(context.geometry)
                        isUserScrolling = false
                        onUserInteractionChange(false)
                    }
                }
        } else {
            content.simultaneousGesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { _ in
                        if !isUserScrolling {
                            isUserScrolling = true
                            onUserInteractionChange(true)
                        }
                    }
                    .onEnded { _ in
                        isUserScrolling = false
                        onUserInteractionChange(false)
                    }
            )
        }
    }

    @available(iOS 18.0, *)
    private static func isNearBottom(_ geometry: ScrollGeometry) -> Bool {
        if geometry.contentSize.height <= geometry.visibleRect.height {
            return true
        }
        return geometry.visibleRect.maxY >= geometry.contentSize.height - 40
    }
}

/// Resolves SwiftUI's native scroll view for physical viewport corrections.
/// History prepends use a stable row identity and its on-screen offset instead
/// of the lazy stack's estimated total content height.
private struct TimelineScrollViewResolver: UIViewRepresentable {
    let onResolve: (UIScrollView) -> Void

    func makeUIView(context: Context) -> ResolverView {
        let view = ResolverView()
        view.onResolve = onResolve
        return view
    }

    func updateUIView(_ uiView: ResolverView, context: Context) {
        uiView.onResolve = onResolve
        uiView.resolve()
    }

    final class ResolverView: UIView {
        var onResolve: ((UIScrollView) -> Void)?
        private weak var resolvedScrollView: UIScrollView?
        private var resolutionAttempts = 0

        override func didMoveToWindow() {
            super.didMoveToWindow()
            resolutionAttempts = 0
            resolve()
        }

        func resolve() {
            if let resolvedScrollView {
                onResolve?(resolvedScrollView)
                return
            }
            if let scrollView = findScrollView() {
                resolvedScrollView = scrollView
                onResolve?(scrollView)
                return
            }
            guard resolutionAttempts < 6 else { return }
            resolutionAttempts += 1
            DispatchQueue.main.async { [weak self] in self?.resolve() }
        }

        private func findScrollView() -> UIScrollView? {
            var candidate = superview
            while let view = candidate {
                if let scrollView = view as? UIScrollView {
                    return scrollView
                }
                if let scrollView = findScrollView(in: view) {
                    return scrollView
                }
                candidate = view.superview
            }
            return nil
        }

        private func findScrollView(in root: UIView) -> UIScrollView? {
            for subview in root.subviews {
                if subview === self { continue }
                if let scrollView = subview as? UIScrollView {
                    return scrollView
                }
                if let found = findScrollView(in: subview) {
                    return found
                }
            }
            return nil
        }
    }
}

struct PadAttachmentPreview: Identifiable {
    let sessionID: String
    let image: ClientMessageImage
    var id: String { sessionID + "\u{0}" + image.managedPath }
}

/// Ordinary text message. Card geometry (`MessageBubbleWidthPolicy`), attachments
/// and the product-owned message menu are shared; iPad invokes the menu by long press.
private struct PadApprovalCard: View {
    let message: ClientMessage
    let connection: PadConnection
    let sessionID: String
    let onSubmitted: () async -> Void
    @State private var submitting = false
    @State private var submitted = false
    @State private var errorText: String?

    private var displayText: String {
        ConversationMessageDisplayText.resolve(text: message.text,
            presentationText: message.presentationText, title: message.title, type: message.type)
    }

    private var requiresAttention: Bool { message.status == "pending" && !submitted }
    private var statusSymbol: String {
        if requiresAttention { return "exclamationmark.circle.fill" }
        if submitted || ["submitted", "dispatching", "unknown"].contains(message.status ?? "") {
            return "clock"
        }
        if ["selected", "completed", "resolved"].contains(message.status ?? "") {
            return "checkmark.circle"
        }
        return "circle.dashed"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Image(systemName: statusSymbol)
                    .foregroundStyle(requiresAttention ? .orange : .secondary)
                    .accessibilityHidden(true)
                Text(message.title ?? "需要你的选择").font(.headline)
            }
            Text(displayText).font(.subheadline).textSelection(.enabled)
            if submitting {
                Text("正在提交，等待确认")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if message.status == "pending" && !submitted, !(message.options ?? []).isEmpty {
                ForEach(message.options ?? []) { option in
                    Button(option.label) { Task { await respond(option) } }
                        .disabled(submitting)
                        .accessibilityIdentifier("approval-option-\(option.id)")
                }
            } else {
                Text(statusText)
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let errorText {
                Text(errorText).font(.caption).foregroundStyle(.red)
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .padding(14)
        .background(requiresAttention ? Color.orange.opacity(0.065) : Color.secondary.opacity(0.04),
                    in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(requiresAttention ? Color.orange.opacity(0.36) : Color.secondary.opacity(0.12),
                              lineWidth: 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-approval")
    }

    private var statusText: String {
        if ["selected", "completed", "resolved"].contains(message.status ?? "") { return "已处理" }
        if submitted || message.status == "submitted" { return "已提交，等待会话更新" }
        switch message.status {
        case "dispatching": return "正在提交，等待确认"
        case "unknown": return "提交结果待同步，请勿重复选择"
        case "pending": return "暂无可用选项"
        default: return "已处理"
        }
    }

    private func respond(_ option: ClientApprovalOption) async {
        guard !submitting, !submitted else { return }
        submitting = true
        errorText = nil
        defer { submitting = false }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let response = try await api.respondToApproval(sessionId: sessionID, itemId: message.id, optionId: option.id)
            guard response.status == "submitted" else { return }
            submitted = true
            await onSubmitted()
        } catch {
            errorText = PadConnection.explain(error)
        }
    }
}

private struct PadCollaborationCard: View {
    let message: ClientMessage
    let connection: PadConnection
    let sessionID: String
    let canRespond: Bool
    let onSubmitted: () async -> Void
    @State private var isExpanded = false
    @State private var submitting = false
    @State private var resolvedStatus: String?
    @State private var errorText: String?

    private var presentation: ClientCollaborationPresentation? { message.collaborationPresentation }
    private var status: String { resolvedStatus ?? presentation?.status ?? "queued" }
    private var isPending: Bool {
        presentation?.isConfirmation == true && status.lowercased() == "pending"
    }
    private var title: String {
        if presentation?.isChannelAuthorization == true { return "授权 Session 通信渠道" }
        if presentation?.isConfirmation == true { return "确认发送协作任务" }
        return "跨会话协作 · \(kindLabel)"
    }
    private var kindLabel: String {
        switch presentation?.messageKind.lowercased() {
        case "change_request": return "修改请求"
        case "needs_information": return "澄清请求"
        case "update_ready": return "结果"
        case "verification_result": return "验收结果"
        case "question": return "请求"
        default: return "协作消息"
        }
    }
    private var statusLabel: String {
        switch status.lowercased() {
        case "sent", "delivered": return "已发送"
        case "confirmed": return presentation?.isChannelAuthorization == true ? "已授权" : "已确认"
        case "completed", "complete": return "已处理"
        case "running", "processing": return "处理中"
        case "failed": return "处理失败"
        case "rejected", "cancelled", "canceled": return "已取消"
        default: return presentation?.isConfirmation == true ? "等待确认" : "等待处理"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Group {
                    if presentation?.isChannelAuthorization == true {
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                    } else {
                        CollaborationHandshakeIcon().frame(width: 18, height: 18)
                    }
                }
                    .foregroundStyle(.orange)
                    .accessibilityHidden(true)
                Text(title).font(.headline)
                Spacer(minLength: 8)
                Text(statusLabel).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            if let source = presentation?.sourceSession, let target = presentation?.targetSession {
                Text("\(source) → \(target)")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    .accessibilityLabel("来源 Session：\(source)，目标 Session：\(target)")
            }
            if let body = presentation?.body, !body.isEmpty {
                PadMessageText(text: body, fromUser: false, isTextSelectionEnabled: .constant(true))
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if hasDetails {
                DisclosureGroup(isExpanded: $isExpanded) {
                    VStack(alignment: .leading, spacing: 6) {
                        detail("来源 Work", presentation?.sourceWork)
                        detail("目标 Work", presentation?.targetWork)
                        detail("来源 Task", presentation?.sourceTaskID)
                        detail("目标 Task", presentation?.targetTaskID)
                        detail("Channel", presentation?.channelID)
                        if let criteria = presentation?.acceptanceCriteria, !criteria.isEmpty {
                            Text("验收标准").font(.caption.weight(.semibold)).padding(.top, 2)
                            ForEach(Array(criteria.enumerated()), id: \.offset) { _, criterion in
                                Text("• \(criterion)").font(.caption).textSelection(.enabled)
                            }
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Text("路由详情").font(.caption.weight(.semibold))
                }
            }
            if isPending {
                if canRespond {
                    HStack(spacing: 10) {
                        Button(presentation?.isChannelAuthorization == true ? "授权" : "确认发送") {
                            Task { await respond(approve: true) }
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(submitting)
                        .accessibilityIdentifier("collaboration-confirm")
                        Button("取消", role: .cancel) { Task { await respond(approve: false) } }
                            .buttonStyle(.bordered)
                            .disabled(submitting)
                            .accessibilityIdentifier("collaboration-reject")
                    }
                    .frame(minHeight: 44)
                } else {
                    Text("当前连接不支持处理此协作确认。")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            if submitting { Text("正在提交，等待会话同步…").font(.caption).foregroundStyle(.secondary) }
            if let errorText { Text(errorText).font(.caption).foregroundStyle(.red) }
        }
        .padding(14)
        .frame(maxWidth: 560, alignment: .leading)
        .background(Color.orange.opacity(0.065), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.orange.opacity(0.34), lineWidth: 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(presentation?.isConfirmation == true
            ? "conversation-collaboration-confirmation" : "conversation-collaboration-message")
    }

    private var hasDetails: Bool {
        [presentation?.sourceWork, presentation?.targetWork, presentation?.sourceTaskID,
         presentation?.targetTaskID, presentation?.channelID].contains { $0 != nil }
        || !(presentation?.acceptanceCriteria.isEmpty ?? true)
    }

    @ViewBuilder private func detail(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            LabeledContent(label, value: value).font(.caption).textSelection(.enabled)
        }
    }

    private func respond(approve: Bool) async {
        guard !submitting, isPending else { return }
        submitting = true
        errorText = nil
        defer { submitting = false }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let response = try await api.respondToCollaborationConfirmation(
                sessionId: sessionID, itemId: message.id, approve: approve)
            resolvedStatus = response.status
            await onSubmitted()
        } catch {
            errorText = PadConnection.explain(error)
        }
    }
}

private struct PadSpecialEventCard: View {
    let message: ClientMessage

    private var isSystemEvent: Bool { message.presentationKind == .systemEvent }
    private var title: String {
        if message.presentationKind == .automationEvent { return message.automationName ?? "自动化事件" }
        if isSystemEvent { return "System Event · \(message.systemEventKind ?? "diagnostic")" }
        return message.title ?? "Timeline 事件"
    }
    private var bodyText: String {
        ConversationMessageDisplayText.resolve(text: message.text,
            presentationText: message.presentationText, title: message.title, type: message.type)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 7) {
                Image(systemName: isSystemEvent ? "exclamationmark.triangle" : "clock.arrow.circlepath")
                    .foregroundStyle(isSystemEvent ? .orange : .secondary)
                    .accessibilityHidden(true)
                Text(title).font(.headline)
            }
            if let eventType = message.automationEventType {
                Text(eventType).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            }
            if !bodyText.isEmpty {
                PadMessageText(text: bodyText, fromUser: false, isTextSelectionEnabled: .constant(true))
            }
            if let reason = message.systemEventReason {
                LabeledContent("Reason", value: reason).font(.caption).textSelection(.enabled)
            }
            if isSystemEvent {
                Text("此事件不可作为协作请求执行。").font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: 560, alignment: .leading)
        .background(Color.secondary.opacity(0.045), in: RoundedRectangle(cornerRadius: 14))
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Color.secondary.opacity(0.14)) }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(isSystemEvent ? "conversation-system-event" : "conversation-special-event")
    }
}

private struct PadUserInputCard: View {
    let message: ClientMessage
    let connection: PadConnection
    let sessionID: String
    let onSubmitted: () async -> Void
    var body: some View {
        Group {
            if let request = message.userInput, request.schemaVersion == 1 {
                ConversationInlineUserInput(request: request, status: message.status,
                    respond: { answers, action in
                        let api = ClientSessionAPI(transport: try await connection.transport())
                        let response = try await api.respondToUserInput(
                            sessionId: sessionID, itemId: message.id, answers: answers, action: action)
                        guard ["submitted", "cancelled"].contains(response.status) else {
                            throw NSError(domain: "CorptieUserInput", code: 1,
                                userInfo: [NSLocalizedDescriptionKey: "提交尚未确认，请等待同步。"])
                        }
                    }, afterSubmit: onSubmitted)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                Text(ConversationMessageDisplayText.resolve(text: message.text,
                    presentationText: message.presentationText, title: message.title, type: message.type))
                    .font(.subheadline)
                Text("当前客户端无法处理这种问题，请更新客户端。")
                    .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct PadExecutionPlanTimelineCard: View {
    let plan: ConversationExecutionPlan
    let laneWidth: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if plan.steps.count > 12 {
                ScrollView {
                    ExecutionPlanChecklist(plan: plan)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 300)
            } else {
                ExecutionPlanChecklist(plan: plan)
            }
        }
        .padding(14)
        .frame(maxWidth: laneWidth > 0 ? min(560, laneWidth) : 560, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Color.secondary.opacity(0.2), lineWidth: 1)
        }
    }
}

private struct MobileMessageBubble: View {
    let message: ClientMessage
    var deliveryState: String? = nil
    var timeSeparatorText: String? = nil
    let laneWidth: CGFloat
    let connection: PadConnection
    let sessionID: String
    let images: PadMessageImageStore
    let openAttachment: (ClientMessageImage) -> Void
    let canSendSuggestedReply: Bool
    let sendSuggestedReply: (String) -> Void

    private var fromUser: Bool { message.presentationKind == .userMessage }
    private var displayText: String {
        ConversationMessageDisplayText.resolve(text: message.text,
            presentationText: message.presentationText, title: message.title, type: message.type)
    }
    private var contentBlocks: [ConversationLocatedContentBlock] {
        guard message.type == "agentMessage", displayText.contains("```corptie-chart")
        else { return [.init(messageID: message.id, startUTF16: 0, content: .markdown(displayText))] }
        return ConversationChartBlockCache.shared.locatedBlocks(
            messageID: message.id, authoritativeText: displayText)
    }
    private var attachments: ArraySlice<ClientMessageImage> { message.images.prefix(MessageImageStripMetrics.maximumCount) }
    private var suggestedReplies: [ClientApprovalOption] {
        guard message.type == "agentMessage", message.status != "selected" else { return [] }
        return message.options ?? []
    }
    private var messageStatus: UserMessageStatusPresentation? {
        guard fromUser else { return nil }
        return UserMessageStatusPresentation(
            authoritativeStatus: message.userMessageStatus,
            legacyStatus: message.status,
            localDeliveryState: deliveryState,
            queuePosition: message.queuePosition,
            processingError: message.processingError
        )
    }
    private var cardWidth: CGFloat {
        let availableLane = laneWidth > 0 ? laneWidth : MessageBubbleWidthPolicy.maximumWidth
        return MessageBubbleWidthPolicy.cardWidth(
            bodyWidth: PadMessageLayout.bodyWidth(text: displayText, style: fromUser ? .user : .agent),
            hasAttachments: !attachments.isEmpty || !suggestedReplies.isEmpty,
            laneWidth: availableLane)
    }

    var body: some View {
        let timestamp = ConversationTimestampText.messageLabel(createdAt: message.createdAt)
        let copyText = ConversationMessageDisplayText.copyText(
            type: message.type, authoritativeText: message.text,
            presentationText: message.presentationText, displayedText: displayText)
        VStack(spacing: 0) {
            if let timeSeparatorText {
                Text(timeSeparatorText)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 28, maxHeight: 28)
                    .accessibilityLabel("时间：\(timeSeparatorText)")
                    .accessibilityIdentifier("chat.timeline.time-separator")
            }
            HStack(alignment: .bottom, spacing: 0) {
            if fromUser { Spacer(minLength: 0) }
            VStack(alignment: fromUser ? .trailing : .leading, spacing: 5) {
                MessageTextCard(messageID: message.id, role: fromUser ? .user : .agent,
                    timestamp: "", showsActions: false, actionsAlwaysVisible: false, cardWidth: cardWidth,
                    status: messageStatus,
                    contextMenu: MessageTextCardMenuConfiguration(
                        timestampTitle: timestamp.isEmpty ? nil : "时间：\(timestamp)",
                        copyTitle: "复制消息", selectTextTitle: "选择文本",
                        canCopy: !copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty),
                    copy: { UIPasteboard.general.string = copyText }) { isTextSelectionEnabled in
                        VStack(alignment: .leading, spacing: MessageImageStripMetrics.bottomSpacing) {
                            if fromUser && !attachments.isEmpty { attachmentStrip }
                            ForEach(contentBlocks) { block in
                                switch block.content {
                                case .markdown(let text):
                                    if !text.isEmpty {
                                        PadMessageText(text: text, fromUser: fromUser,
                                            isTextSelectionEnabled: isTextSelectionEnabled)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                case .chart(let spec, _):
                                    ConversationChartView(spec: spec)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                case .invalidChart(let original, let reason):
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(reason).font(.caption2).foregroundStyle(.secondary)
                                        PadMessageText(text: original, fromUser: false,
                                            isTextSelectionEnabled: isTextSelectionEnabled)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            if !fromUser && !attachments.isEmpty { attachmentStrip }
                            if !suggestedReplies.isEmpty {
                                ScrollView(.horizontal) {
                                    HStack(spacing: 6) {
                                        ForEach(suggestedReplies) { option in
                                            Button(option.label) { sendSuggestedReply(option.label) }
                                                .buttonStyle(.bordered)
                                                .controlSize(.small)
                                                .frame(minHeight: 44)
                                                .disabled(!canSendSuggestedReply)
                                                .accessibilityIdentifier("message-suggested-reply-\(option.id)")
                                        }
                                    }
                                }
                                .scrollIndicators(.hidden)
                            }
                        }
                    }
            }
            if !fromUser { Spacer(minLength: 0) }
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-message")
    }

    private var attachmentStrip: some View {
        ScrollView(.horizontal) {
            HStack(spacing: MessageImageStripMetrics.spacing) {
                ForEach(Array(attachments.enumerated()), id: \.element.id) { index, attachment in
                    Button { openAttachment(attachment) } label: {
                        MessageImageThumbnail(state: thumbnailState(attachment), index: index)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("message-attachment-\(index)")
                    .onAppear { images.ensure(sessionID: sessionID, managedPath: attachment.managedPath, connection: connection) }
                }
            }
        }
        .scrollIndicators(.hidden)
        .frame(height: MessageImageStripMetrics.thumbnailEdge)
    }

    private func thumbnailState(_ attachment: ClientMessageImage) -> MessageImageThumbnail.State {
        switch images.entry(sessionID: sessionID, managedPath: attachment.managedPath) {
        case .loaded(let image): .loaded(Image(uiImage: image))
        case .missing: .missing
        case .loading, nil: .loading
        }
    }
}

/// Full-size attachment sheet (the desktop opens the managed file in Preview).
/// Fetches on demand and never retains the raster beyond the sheet's lifetime.
struct PadAttachmentViewer: View {
    let connection: PadConnection
    let preview: PadAttachmentPreview
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Group {
                if let image {
                    ScrollView([.horizontal, .vertical]) {
                        Image(uiImage: image).resizable().aspectRatio(contentMode: .fit)
                            .containerRelativeFrame([.horizontal, .vertical])
                    }
                } else if failed {
                    ContentUnavailableView("图片不可用", systemImage: "exclamationmark.triangle",
                        description: Text("主机上没有这张图片的托管副本。"))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle(preview.image.fileName ?? "附件")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .task {
                do {
                    let api = ClientSessionAPI(transport: try await connection.transport())
                    guard let payload = try await api.image(sessionId: preview.sessionID, managedPath: preview.image.managedPath),
                          let decoded = UIImage(data: payload.data) else { failed = true; return }
                    image = await decoded.byPreparingForDisplay() ?? decoded
                } catch { failed = true }
            }
        }
        .accessibilityIdentifier("attachment-viewer")
    }
}

#Preview { PairingView(connection: PadConnection()) }
