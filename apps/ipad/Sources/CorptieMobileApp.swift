import SwiftUI
import UIKit
import AuthenticationServices
import CorptieClientCore
import CorptieConversation
import Observation
import OSLog
import ImageIO
import UniformTypeIdentifiers

@main
struct CorptieMobileApp: App {
    init() {
        #if DEBUG
        PadTimelineDiagnosticLog.shared.append(.init(event: "app-start-diagnostic-v1",
            page: UUID(), flags: [:], numbers: [:]))
        #endif
    }
    @UIApplicationDelegateAdaptor(PadAppDelegate.self) private var appDelegate
    @State private var connection = PadConnection()
    private var runsIsolatedNativeTests: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["CORPTIE_NATIVE_LAYOUT_TESTS"] == "1"
        #else
        false
        #endif
    }
    private var runsStandardTimelineFixture: Bool {
        #if DEBUG
        ProcessInfo.processInfo.environment["CORPTIE_STANDARD_TIMELINE_FIXTURE"] == "1"
        #else
        false
        #endif
    }
    var body: some Scene {
        WindowGroup {
            Group {
                if runsStandardTimelineFixture {
                    #if DEBUG
                    PadStandardTimelineFixture()
                    #else
                    Color.clear
                    #endif
                } else if runsIsolatedNativeTests {
                    Color.clear
                } else if connection.connected {
                    PadAppShell(connection: connection)
                } else if connection.restoringConnection {
                    ProgressView("正在连接上次的 Mac…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
                } else {
                    PairingView(connection: connection)
                }
            }
            .task {
                guard !runsIsolatedNativeTests,
                      !runsStandardTimelineFixture else { return }
                await connection.restoreLastConnection()
            }
        }
    }
}

struct PairingView: View {
    @Bindable var connection: PadConnection
    @State private var scanner: Scanner?
    @State private var scannedPayload: String?
    @State private var cloudSignIn = CloudSignInSession()
    @State private var cloudRevocation: CloudDevice?
    @State private var cloudLoginTask: Task<Void, Never>?
    @Environment(\.scenePhase) private var scenePhase
    private enum Scanner: String, Identifiable { case camera; var id: String { rawValue } }
    var body: some View {
        NavigationStack {
            Form {
                Section("Corptie Cloud") {
                    if connection.cloudSignedIn {
                        Label(connection.cloudAccountStatus, systemImage: "person.crop.circle")
                        let macs = connection.cloudDevices.filter { $0.kind == .mac && $0.revokedAt == nil }
                        if macs.isEmpty && connection.cloudAccountState == .authenticated {
                            ContentUnavailableView {
                                Label("没有可连接的 Mac", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
                            } description: {
                                Text("请在 Mac 上登录同一账号并开启远程连接。")
                            }
                        } else {
                            ForEach(macs) { mac in
                                Button("连接 \(mac.displayName)", systemImage: "desktopcomputer") {
                                    Task { await connection.connectCloud(to: mac) }
                                }
                            }
                        }
                        Button("刷新设备列表", systemImage: "arrow.clockwise") {
                            Task { await connection.refreshCloudDevices() }
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
                    } else if connection.cloudAccountState == .storageUnavailable {
                        Text(connection.cloudAccountStatus)
                        Button("重试读取账号凭据", systemImage: "arrow.clockwise") {
                            Task { await connection.retryCloudRestore() }
                        }
                    } else {
                        if connection.cloudAccountState == .reauthenticationRequired {
                            Text(connection.cloudAccountStatus)
                        }
                        Button("登录 Corptie Cloud", systemImage: "person.crop.circle") { startCloudSignIn() }
                            .buttonStyle(.borderedProminent)
                            .disabled(connection.cloudSignInPreparing)
                        Text("登录后可在外网连接同账号下的 Mac。账号凭据保存在系统钥匙串，通信内容端到端加密。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    if connection.busy { ProgressView("正在处理 Cloud 登录或连接…") }
                    if connection.cloudSignInPreparing { ProgressView("正在检查登录服务…") }
                    if !connection.cloudNotice.isEmpty {
                        Text(connection.cloudNotice)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("cloud-status")
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
                            .disabled(connection.lanConnecting || connection.busy)
                    }.disabled(connection.claim != nil)
                }
                if connection.lanConnecting || !connection.lanConnectionNotice.isEmpty {
                    Section {
                        if connection.lanConnecting { ProgressView("正在恢复局域网连接…") }
                        if !connection.lanConnectionNotice.isEmpty {
                            Text(connection.lanConnectionNotice).font(.footnote)
                                .foregroundStyle(.secondary)
                                .accessibilityIdentifier("lan-connection-status")
                        }
                    }
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
            .task(id: "\(scenePhase)-\(connection.cloudAccountNeedsRecovery)") {
                if scenePhase == .active { await connection.runCloudAccountRecovery() }
            }
            .onDisappear { cloudLoginTask?.cancel(); cloudLoginTask = nil }
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
        guard cloudLoginTask == nil else { return }
        cloudLoginTask = Task { @MainActor in
            defer { cloudLoginTask = nil }
            do {
                let url = try await connection.prepareCloudSignIn()
                try Task.checkCancellation()
                cloudSignIn.start(url: url) { result in
                switch result {
                case .success(let callback):
                    Task { await connection.completeCloudSignIn(callback: callback, deviceName: UIDevice.current.name) }
                case .failure(let error as ASWebAuthenticationSessionError) where error.code == .canceledLogin:
                    connection.cancelCloudSignIn()
                case .failure:
                    connection.cancelCloudSignIn()
                    connection.cloudNotice = "Cloud 登录未完成，请重试。"
                }
                }
            } catch is CancellationError { }
            catch {
                connection.cloudNotice = PadConnection.explainCloudSignIn(error)
            }
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
    @State private var outlineDragActive = false
    @State private var suppressOutlineTapUntil = Date.distantPast
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let compactOpenSessionRequest: Int
    let onCompactRootChange: (Bool) -> Void
    let onOpenWorktrees: () -> Void
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
            workColumn(commands, showsPersistentSelection: false, onOpenSession: { id in
                // A Button release can arrive after the drag's end callback.
                guard !outlineDragActive, Date() >= suppressOutlineTapUntil else { return }
                openCompactSession(id)
            })
                .simultaneousGesture(
                    DragGesture(minimumDistance: 12)
                        .onChanged { _ in
                            if !outlineDragActive { outlineDragActive = true }
                        }
                        .onEnded { value in
                            outlineDragActive = false
                            suppressOutlineTapUntil = Date().addingTimeInterval(0.15)
                            guard PadWorkReturnSwipePolicy.opensPreviousTask(
                                horizontal: value.translation.width, vertical: value.translation.height),
                                let id = workspace.previousMobileTaskSession(connection) else { return }
                            openCompactSession(id)
                        }
                )
                .onDisappear { outlineDragActive = false }
                .padWorkspaceNavigationBackground()
                .navigationDestination(for: CompactWorkspacePage.self) { page in
                    switch page {
                    case .conversation(let id):
                        ConversationView(connection: connection, workspace: workspace, sessionID: id,
                            messageImages: messageImages,
                            onBack: { if compactPath.last == .conversation(id) { compactPath.removeLast() } },
                            onOpenDetail: { if compactPath.last == .conversation(id) { compactPath.append(.detail(id)) } },
                            onOpenWorktrees: onOpenWorktrees)
                            .id(id)
                            .padWorkspaceNavigationBackground()
                    case .detail(let id):
                        PadConversationInspector(workspace: workspace, connection: connection, sessionID: id)
                            .safeAreaInset(edge: .top, spacing: 0) { compactDetailHeader }
                            .toolbar(.hidden, for: .navigationBar)
                            .modifier(CompactBackSwipe {
                                if compactPath.last == .detail(id) { compactPath.removeLast() }
                            })
                            .padWorkspaceNavigationBackground()
                    }
                }
        }
        .toolbar(.hidden, for: .navigationBar)
        .accessibilityIdentifier("compact-workspace")
        .onChange(of: compactPath, initial: true) { _, path in
            onCompactRootChange(path.isEmpty)
            if case .conversation(let id) = path.first {
                workspace.rememberOpenedMobileTask(connection, sessionID: id)
            }
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
        workspace.rememberOpenedMobileTask(connection, sessionID: id)
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
        .padding(.top, UIDevice.current.userInterfaceIdiom == .phone ? 0 : 4)
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
                onBack: nil, onOpenDetail: nil, onOpenWorktrees: onOpenWorktrees)
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
    let onOpenWorktrees: () -> Void
    @State private var headerMetadata: ClientInspectorValue = .null
    // User-authorized iPhone trial. Keep Release and native baseline tests unchanged.
    var standardTimeline = false
    private var usesStandardTimeline: Bool {
        #if DEBUG
        if standardTimeline { return true }
        let environment = ProcessInfo.processInfo.environment
        if environment["CORPTIE_NATIVE_LAYOUT_TESTS"] == "1"
            || environment["CORPTIE_STANDARD_TIMELINE"] == "0" { return false }
        return UIDevice.current.userInterfaceIdiom == .phone
            || environment["CORPTIE_STANDARD_TIMELINE"] == "1"
        #else
        return false
        #endif
    }
    @State private var copiedHeaderItem: HeaderCopiedItem?
    private enum HeaderCopiedItem: Hashable { case title, workspace }
    @State private var confirmForget = false
    @State private var nativeTimeline = PadNativeTimelineHandle()
    @State private var nativeHeaderHeight: CGFloat = 0
    @State private var timelineScrollView: UIScrollView?
    @State private var explicitJumpRevision: UInt64 = 0
    @Environment(\.padKeyboardViewport) private var keyboardViewport
    @State private var timelineReady = false
    @State private var savedNativePosition: PadTimelineReadingPosition?
    @State private var preserveSavedPosition = false
    @State private var readingScope: [String] = []
    @State private var historyAutoLoadGate = PadHistoryAutoLoadGate()
    @State private var nativeNearTop = false
    @State private var nativeHistoryUserInitiated = false
    @State private var nativeUnderfilled = false
    @State private var nativeHistoryTask: Task<Void, Never>?
    @State private var nativeHistoryGeneration: UInt64 = 0
    @State private var expandedProcessEntryIDs: Set<String> = []
    @State private var attachmentPreview: PadAttachmentPreview?
    @State private var quickMessageHintRevision = 0
    @State private var quickMessageSendRevision = 0
    @State private var quickMessageDropViewport: CGSize = .zero
    @State private var composerSheet: ComposerSheet?
    private enum ComposerSheet: String, Identifiable {
        case schedule
        var id: String { rawValue }
    }
    private var draft: Binding<String> {
        Binding(get: { workspace.drafts[sessionID] ?? "" }, set: { workspace.drafts[sessionID] = $0 })
    }
    var body: some View {
        Group {
            if usesStandardTimeline {
                GeometryReader { viewport in conversationContent(safeArea: viewport.safeAreaInsets) }
            } else {
                GeometryReader { viewport in conversationContent(safeArea: viewport.safeAreaInsets) }
                    .ignoresSafeArea(.keyboard)
            }
        }
    }

    private func conversationContent(safeArea: EdgeInsets) -> some View {
        let nativeScope = [connection.serverID, connection.deviceID ?? "", sessionID]
        let timeline = PadNativeTimeline(ids: ["__history__"] + workspace.displayEntries.map(\.id),
            versions: usesStandardTimeline ? [:] : nativeRowVersions, ready: timelineReady && readingScope == nativeScope,
            savedPosition: readingScope == nativeScope ? savedNativePosition
                : workspace.readingPosition(serverID: nativeScope[0], deviceID: nativeScope[1], sessionID: nativeScope[2]),
            jumpRevision: explicitJumpRevision, keyboard: keyboardViewport, handle: nativeTimeline,
            topOverlayHeight: nativeHeaderHeight + (usesStandardTimeline ? 0 : safeArea.top),
            tracksVisibleFrames: false,
            row: { id, width in timelineRow(id: id, width: width) },
            composer: Group {
                if usesStandardTimeline { composer }
                else { composer.ignoresSafeArea(.keyboard) }
            }.accessibilityElement(children: .contain)
                .accessibilityIdentifier("conversation-composer")
                .environment(\.padKeyboardViewport, keyboardViewport),
            onScrollView: { timelineScrollView = $0 },
            onNearTop: { top, user, underfilled in
                nativeNearTop = top
                nativeHistoryUserInitiated = user
                nativeUnderfilled = underfilled
            },
            onSave: { persistNativePosition($0, scope: nativeScope) },
            onUserInteraction: { preserveSavedPosition = false },
            onVisibleFrames: { _, _ in })
        return Group {
            if usesStandardTimeline {
                PadStandardTimeline(input: timeline, contentRevision: workspace.tailDisplayRevision)
            } else {
                timeline.ignoresSafeArea(.keyboard)
                    .ignoresSafeArea(.container, edges: .vertical)
            }
        }
        .coordinateSpace(name: "conversation-viewport")
        .onGeometryChange(for: CGSize.self) { $0.size } action: { quickMessageDropViewport = $0 }
        .dropDestination(for: ConversationQuickMessageDrag.self) { items, location in
            guard items.count == 1, let text = items[0].acceptedText(
                scope: quickMessageDragScope, enabled: canSendQuickMessage, location: location,
                viewport: quickMessageDropViewport, topInset: nativeHeaderHeight,
                bottomInset: quickMessageDropBottomInset) else { return false }
            sendQuickMessage(text)
            return true
        }
        .id([connection.serverID, connection.deviceID ?? "", sessionID])
        .overlay(alignment: .trailing) {
            TimelineDragOnlyScrollbar(scrollView: timelineScrollView,
                jumpRevision: explicitJumpRevision,
                onScroll: usesStandardTimeline ? { nativeTimeline.scrollToOffset?($0) } : nil) {
                    nativeTimeline.scrollbarInteraction?($0)
                }
                .frame(width: 24)
                .padding(.top, nativeHeaderHeight)
                .padding(.bottom, nativeTimeline.composerHeight)
        }
        .overlay(alignment: .bottomTrailing) {
            // The native container's geometry is the only bottom authority.
            if nativeTimeline.showsJump {
                Button {
                    preserveSavedPosition = false
                    explicitJumpRevision &+= 1
                    nativeTimeline.jump?()
                } label: {
                    Image(systemName: "arrow.down")
                        .font(.system(size: 14, weight: .bold))
                        .frame(width: 36, height: 36)
                        .contentShape(Circle())
                        .padGlassSurface(in: Circle(), interactive: true)
                        .overlay(alignment: .topTrailing) {
                            if nativeTimeline.hasNewMessagesBelow {
                                Circle().fill(Color.accentColor).frame(width: 8, height: 8)
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("跳到最新消息")
                .accessibilityIdentifier("conversation-jump-to-latest")
                .padding(.trailing, 14).padding(.bottom, nativeTimeline.composerHeight + 12)
            }
        }
        .overlay {
            if workspace.displayEntries.isEmpty {
                ContentUnavailableView(
                    workspace.selectedTimelineReady ? "暂无消息" : "正在同步消息…",
                    systemImage: workspace.selectedTimelineReady ? "bubble.left" : "arrow.triangle.2.circlepath")
                    .allowsHitTesting(false)
            }
        }
        .modifier(CompactPageSwipe(onBack: onBack, onOpenDetail: onOpenDetail))
        .overlay(alignment: .top) {
            conversationHeader
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { nativeHeaderHeight = $0 }
        }
        .overlay(alignment: .top) {
            PadQuickMessageHintToast(revision: quickMessageHintRevision)
                .padding(.top, nativeHeaderHeight + 4)
                .allowsHitTesting(false)
        }
        .background(WorkbenchCanvasSurface.color)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: [connection.serverID, connection.deviceID ?? "", sessionID]) {
            await prepareNativeTimeline()
            guard !Task.isCancelled else { return }
            await workspace.repairMissingUsage(connection)
        }
        .task(id: workspace.selectedCapabilityKey(connection)) {
            await workspace.refreshSelectedCapabilities(connection)
        }
        .onChange(of: "\(workspace.historyRequestCursor ?? ""):\(nativeNearTop):\(nativeHistoryUserInitiated):\(nativeUnderfilled):\(connection.busy):\(timelineReady)", initial: true) {
            requestNativeHistoryIfNeeded()
        }
        .onChange(of: workspace.scrollRequest) {
            preserveSavedPosition = false
            explicitJumpRevision &+= 1
            nativeTimeline.jump?()
        }
        .onDisappear {
            if let value = nativeTimeline.currentPosition?() { persistNativePosition(value, scope: nativeScope) }
            cancelNativeHistory()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active, let value = nativeTimeline.currentPosition?() { persistNativePosition(value, scope: nativeScope) }
        }
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
        .task(id: "\(connection.serverID):\(connection.address):\(sessionID)") {
            headerMetadata = .null
            do {
                let api = ClientInspectorAPI(transport: try await connection.transport())
                let metadata = try await api.read(sessionID: sessionID, resource: "header")
                if !Task.isCancelled, metadata["schemaVersion"].number == 1 {
                    headerMetadata = metadata
                }
            } catch { /* Older hosts can still show the title and usage route. */ }
        }
        .task(id: copiedHeaderItem) {
            guard copiedHeaderItem != nil else { return }
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { copiedHeaderItem = nil }
        }
    }

    private var timelineCoordinateSpace: String {
        "conversation-timeline-\(sessionID)"
    }

    @ViewBuilder
    private func processCard(entryID: String, items: [ClientMessage], laneWidth: CGFloat) -> some View {
        if let presentation = workspace.processPresentations[entryID] {
            PadProcessCard(entryID: entryID,
                           steps: workspace.processSteps[entryID] ?? [], presentation: presentation,
                           laneWidth: laneWidth, coordinateSpace: timelineCoordinateSpace,
                           startedAt: items.contains(where: { $0.processEndedAt != nil })
                               ? nil : ConversationProcessPresentation.startedAt(for: items),
                           canAdvance: PadProcessClockPolicy.canAdvance(
                               isActiveProcess: entryID == workspace.activeProcessEntryID,
                               clientIsOnline: connection.connected,
                               sessionExecutionStatus: workspace.sessions.first(where: { $0.id == sessionID })?.executionStatus,
                               sceneIsActive: scenePhase == .active),
                           expanded: expandedProcessEntryIDs.contains(entryID),
                           toggle: { toggleProcess(entryID) })
        }
    }

    private func toggleProcess(_ entryID: String) {
        if expandedProcessEntryIDs.contains(entryID) {
            expandedProcessEntryIDs.remove(entryID)
        } else {
            expandedProcessEntryIDs.insert(entryID)
        }
    }

    private var nativeRowVersions: [String: PadNativeTimelineRowVersion] {
        var result: [String: PadNativeTimelineRowVersion] = [
            "__history__": .init(decoration: "\(workspace.isLoadingEarlier):\(workspace.historyRequestCursor ?? "")")
        ]
        for entry in workspace.displayEntries {
            let messages: [ClientMessage]
            switch entry.kind {
            case .message(let message): messages = [message]
            case .process(_, let items): messages = items
            }
            let decoration = messages.map {
                "\(workspace.outgoingStates[$0.id] ?? ""):\(workspace.timeSeparatorTextByMessageID[$0.id] ?? "")"
            }.joined(separator: "|") + ":\(connection.connected):\(connection.busy):\(scenePhase == .active)"
            result[entry.id] = .init(messages: messages, decoration: decoration,
                expanded: expandedProcessEntryIDs.contains(entry.id),
                canRespond: workspace.capabilities?.collaborationConfirmation?.available == true)
        }
        return result
    }

    @ViewBuilder private func timelineRow(id: String, width: CGFloat) -> some View {
        if id == "__history__" {
            Group {
                if workspace.isLoadingEarlier {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("正在加载更早消息…").font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                } else if workspace.historyRequestCursor == nil, !workspace.messages.isEmpty {
                    Text("已显示全部历史消息").font(.caption2).foregroundStyle(.tertiary).padding(.vertical, 8)
                } else {
                    Color.clear.frame(height: 1)
                }
            }.frame(width: width)
        } else if let entry = workspace.displayEntryByID[id] {
            VStack(spacing: 0) {
                        switch entry.kind {
                        case .message(let message):
                            if message.presentationKind == .collaborationMessage
                                || message.presentationKind == .collaborationConfirmation {
                                PadCollaborationCard(message: message, connection: connection, sessionID: sessionID,
                                    canRespond: workspace.capabilities?.collaborationConfirmation?.available == true,
                                    onSubmitted: {
                                        let revision = workspace.lastTimelineRevision
                                        await workspace.waitForRealtimeTimelineOrFallback(connection, after: revision)
                                    })
                            } else if message.presentationKind == .automationEvent
                                        || message.presentationKind == .systemEvent
                                        || message.presentationKind == .unknown {
                                PadSpecialEventCard(message: message)
                            } else if message.type == "userInput" {
                                PadUserInputCard(message: message, connection: connection, sessionID: sessionID,
                                    onSubmitted: {
                                        let revision = workspace.lastTimelineRevision
                                        await workspace.waitForRealtimeTimelineOrFallback(connection, after: revision)
                                    })
                            } else if message.type == "choice" || message.type == "approval" {
                                PadApprovalCard(message: message, connection: connection, sessionID: sessionID,
                                    onSubmitted: {
                                        let revision = workspace.lastTimelineRevision
                                        await workspace.waitForRealtimeTimelineOrFallback(connection, after: revision)
                                    })
                            } else if (message.type == "executionPlan" || message.type == "plan"),
                                      let plan = message.executionPlan {
                                PadExecutionPlanTimelineCard(plan: plan, laneWidth: width)
                            } else {
                                MobileMessageBubble(message: message, deliveryState: workspace.outgoingStates[message.id],
                                    timeSeparatorText: workspace.timeSeparatorTextByMessageID[message.id],
                                    laneWidth: width, connection: connection, sessionID: sessionID,
                                    images: messageImages,
                                    openAttachment: { attachmentPreview = PadAttachmentPreview(sessionID: sessionID, image: $0) },
                                    canSendSuggestedReply: !connection.busy && workspace.pending == nil
                                        && workspace.capabilities?.send.available == true,
                                    sendSuggestedReply: { text in
                                        Task { await workspace.sendSuggestedReply(connection, sessionID: sessionID, text: text) }
                                    }, delete: workspace.canDeleteUnreceivedMessage(message) ? {
                                        Task { await workspace.deleteUnreceivedMessage(connection,
                                            sessionID: sessionID, messageID: message.id) }
                                    } : nil, cancelQueued: workspace.capabilities?.cancelQueuedMessage == true
                                        && message.cancellableQueuedMessageTaskID != nil ? {
                                        Task { await workspace.cancelQueuedMessage(connection,
                                            sessionID: sessionID, messageID: message.id) }
                                    } : nil)
                            }
                        case .process(_, let items):
                            processCard(entryID: entry.id, items: items, laneWidth: width)
                        }

            }
            .id(entry.id)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(entry.id == workspace.displayEntries.last?.id
                ? "conversation-latest-entry" : "conversation-entry-\(entry.id)")
        }
    }

    private func persistNativePosition(_ position: PadTimelineReadingPosition, scope: [String]) {
        guard timelineReady, !preserveSavedPosition, readingScope.count == 3, scope == readingScope else { return }
        workspace.saveReadingPosition(position, serverID: readingScope[0],
            deviceID: readingScope[1], sessionID: readingScope[2])
    }

    private func prepareNativeTimeline() async {
        cancelNativeHistory()
        timelineReady = false
        preserveSavedPosition = false
        let scope = [connection.serverID, connection.deviceID ?? "", sessionID]
        readingScope = scope
        savedNativePosition = workspace.readingPosition(serverID: scope[0],
            deviceID: scope[1], sessionID: scope[2])
        await workspace.waitForRealtimeTimelineOrFallback(connection)
        guard !Task.isCancelled, readingScope == scope, workspace.selection == sessionID else { return }
        if let saved = savedNativePosition, !saved.followsLatest, let id = saved.entryID {
            for _ in 0..<20 {
                guard !Task.isCancelled, readingScope == scope, workspace.selection == sessionID else { return }
                if workspace.displayEntries.contains(where: { $0.id == id }) { break }
                guard !connection.busy, !workspace.isLoadingEarlier,
                      let cursor = workspace.historyRequestCursor else { break }
                await workspace.loadEarlierMessagesIfNeeded(connection)
                guard workspace.historyRequestCursor != cursor else { break }
            }
            guard !Task.isCancelled, readingScope == scope, workspace.selection == sessionID else { return }
            if !workspace.displayEntries.contains(where: { $0.id == id }) {
                preserveSavedPosition = workspace.historyRequestCursor != nil
                savedNativePosition = workspace.displayEntries.first.map {
                    .init(followsLatest: false, entryID: $0.id, minY: 0)
                }
            }
        }
        timelineReady = true
    }

    private func cancelNativeHistory() {
        nativeHistoryGeneration &+= 1
        nativeHistoryTask?.cancel()
        nativeHistoryTask = nil
    }

    private func requestNativeHistoryIfNeeded() {
        guard timelineReady, nativeHistoryTask == nil,
              historyAutoLoadGate.requestCursor(scope: sessionID, before: workspace.historyRequestCursor,
                nearTop: nativeNearTop, userInitiated: nativeHistoryUserInitiated,
                underfilled: nativeUnderfilled, isLoading: workspace.isLoadingEarlier,
                connectionBusy: connection.busy) != nil else { return }
        let generation = nativeHistoryGeneration
        let scope = readingScope
        if !nativeUnderfilled { nativeHistoryUserInitiated = false }
        // Ending a drag must not cancel the page it requested. Only leaving
        // this scope cancels it; underfilled auto-fill is capped by the gate.
        nativeHistoryTask = Task {
            await workspace.loadEarlierMessagesIfNeeded(connection)
            guard !Task.isCancelled, generation == nativeHistoryGeneration, scope == readingScope else { return }
            nativeHistoryTask = nil
            if nativeUnderfilled { requestNativeHistoryIfNeeded() }
        }
    }

    private var conversationHeader: some View {
        let session = workspace.sessionsByID[sessionID]
        let rawTitle = workspace.tasks.first(where: { $0.id == session?.taskId })?.title
            ?? session?.title ?? "会话"
        let title = rawTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "会话" : rawTitle
        let inspector = workspace.inspectorStore(for: sessionID)
        let snapshot = inspector.snapshot?.sessionId == sessionID ? inspector.snapshot : nil
        let providerID = snapshot?.environment["provider"].text
            ?? headerMetadata["provider"].text
            ?? workspace.selectedSessionUsage?.route?.providerId
        let providerName = snapshot?.sections["providers"]?.items.first {
            $0["id"].text == providerID
        }?["name"].text ?? Self.providerName(providerID)
        let cwd = snapshot?.environment["cwd"].text ?? headerMetadata["cwd"].text
        let branch = headerMetadata["branchName"].text

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
            VStack(spacing: 3) {
                Button {
                    UIPasteboard.general.string = title
                    copiedHeaderItem = .title
                    UIAccessibility.post(notification: .announcement, argument: "标题已复制")
                } label: {
                    HStack(spacing: 4) {
                        Text(title)
                            .lineLimit(1)
                            .minimumScaleFactor(0.75)
                            .truncationMode(.tail)
                            .multilineTextAlignment(.center)
                        if copiedHeaderItem == .title {
                            Image(systemName: "checkmark")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.green)
                        }
                    }
                    .font(.title3.weight(.semibold))
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("复制标题：\(title)")
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("conversation-task-title")

                HStack(spacing: 6) {
                    if let providerID, !providerID.isEmpty {
                        HStack(spacing: 3) {
                            providerIcon(for: providerID)
                            Text(providerName).lineLimit(1)
                        }
                        .fixedSize(horizontal: true, vertical: false)
                        .accessibilityElement(children: .combine)
                    }
                    if let cwd, !cwd.isEmpty {
                        Button {
                            UIPasteboard.general.string = cwd
                            copiedHeaderItem = .workspace
                            UIAccessibility.post(notification: .announcement, argument: "工作空间路径已复制")
                        } label: {
                            HStack(spacing: 3) {
                                Text(URL(fileURLWithPath: cwd).lastPathComponent)
                                    .lineLimit(1)
                                    .truncationMode(.middle)
                                if copiedHeaderItem == .workspace {
                                    Image(systemName: "checkmark").foregroundStyle(.green)
                                }
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("复制工作空间路径：\(cwd)")
                        .accessibilityIdentifier("conversation-copy-workspace")
                    }
                    if let branch, !branch.isEmpty {
                        Button(action: onOpenWorktrees) {
                            HStack(spacing: 3) {
                                Image(systemName: "arrow.triangle.branch")
                                if UIDevice.current.userInterfaceIdiom == .pad {
                                    Text(branch).lineLimit(1)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("打开 Worktree：\(branch)")
                        .accessibilityIdentifier("conversation-open-worktrees")
                    }
                    if headerMetadata["continuationState"].text == "failed" {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                            .accessibilityLabel("Worktree 续接失败")
                    } else if headerMetadata["transitionStrategy"].text == "handoff" {
                        Image(systemName: "arrow.triangle.branch")
                            .accessibilityLabel("上下文移交")
                    }
                }
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)
                // Keep metadata compact regardless of which buttons are present.
                // Per-button minimum heights otherwise add a gap below the title.
                .frame(minHeight: 18)
                .frame(maxWidth: .infinity)
            }
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .padGlassSurface(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxWidth: onBack == nil ? 360 : .infinity)
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
        .padding(.top, UIDevice.current.userInterfaceIdiom == .phone ? 0 : 4)
        .padding(.bottom, 8)
    }

    @ViewBuilder private func providerIcon(for providerID: String) -> some View {
        let asset: String? = switch providerID.lowercased() {
        case "codex-app-server", "codex": "ProviderCodex"
        case "claude-sdk", "claude", "claude-code", "claude_code": "ProviderClaudeCode"
        case "openclacky", "clacky", "open-clacky": "ProviderOpenClacky"
        default: nil
        }
        if let asset {
            Image(asset).resizable().interpolation(.high).frame(width: 13, height: 13)
                .accessibilityHidden(true)
        } else {
            Image(systemName: "cpu").accessibilityHidden(true)
        }
    }

    private static func providerName(_ providerID: String?) -> String {
        switch providerID?.lowercased() {
        case "codex-app-server", "codex": "Codex"
        case "claude-sdk", "claude", "claude-code", "claude_code": "Claude Code"
        case "openclacky", "clacky", "open-clacky": "OpenClacky"
        default: providerID ?? ""
        }
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
                        .disabled(!workspace.stopControlEnabled(connection))
                        .accessibilityHint(workspace.stopControlReason(connection) ?? "停止当前运行")
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
        workspace.selectedSessionIsRunning
    }

    private func stopCurrentSession() {
        Task { await workspace.command(connection, stop: true) }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let reason = workspace.stopControlReason(connection) {
                Text(reason).font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("conversation-stop-status")
            }
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
                        canStop: canStopCurrentSession, stop: stopCurrentSession,
                        quickMessageDragScope: quickMessageDragScope,
                        quickMessageSendRevision: quickMessageSendRevision,
                        quickMessageSingleTap: { quickMessageHintRevision &+= 1 },
                        sendQuickMessage: sendQuickMessage) {
                conversationStatusRow
            }
        }
        .padding(.horizontal, 12)
        .background { ConversationChromeBackdrop(isBottom: true) }
    }

    private func slashCommandPrefix(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), !trimmed.contains(where: { $0.isWhitespace }) else { return nil }
        return String(trimmed.dropFirst())
    }

    private var quickMessageDragScope: String {
        "\(connection.serverID)|\(connection.deviceID ?? "")|\(sessionID)"
    }
    private var quickMessageDropBottomInset: CGFloat {
        // The native timeline draws beneath the keyboard. Its existing inset
        // already contains the keyboard and composer occlusion; do not derive
        // a second keyboard height or change scrolling to implement drop bounds.
        usesStandardTimeline ? nativeTimeline.composerHeight
            : max(nativeTimeline.composerHeight, timelineScrollView?.adjustedContentInset.bottom ?? 0)
    }
    private var canSendQuickMessage: Bool {
        !connection.busy && workspace.pending == nil && !workspace.outboxSaving
            && workspace.capabilities?.send.available == true
            && workspace.importingImagesForSession != sessionID
    }
    private func sendQuickMessage(_ text: String) {
        guard canSendQuickMessage else { return }
        Task {
            await workspace.sendSuggestedReply(connection, sessionID: sessionID, text: text)
            quickMessageSendRevision &+= 1
        }
    }
}

private struct PadQuickMessageHintToast: View {
    let revision: Int
    @State private var visible = false
    var body: some View {
        Group {
            if visible {
                Text("双击发送快捷消息")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Color(uiColor: .systemBackground))
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Color.primary.opacity(0.88), in: Capsule())
                    .accessibilityIdentifier("quick-message-tap-hint")
            }
        }
        .task(id: revision) {
            guard revision > 0 else { visible = false; return }
            visible = true
            do { try await Task.sleep(for: .seconds(1.5)) } catch { return }
            visible = false
        }
    }
}

private struct CompactPageSwipe: ViewModifier {
    let onBack: (() -> Void)?
    let onOpenDetail: (() -> Void)?

    @ViewBuilder func body(content: Content) -> some View {
        if onBack != nil || onOpenDetail != nil {
            content.background(CompactConversationPan(onBack: onBack, onOpenDetail: onOpenDetail))
        } else {
            content
        }
    }
}

/// UIKit's delegate can reject a pan before recognition, without stealing
/// vertical scrolling or content-owned horizontal/selection gestures.
private struct CompactConversationPan: UIViewRepresentable {
    let onBack: (() -> Void)?
    let onOpenDetail: (() -> Void)?

    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> AttachmentView {
        let view = AttachmentView()
        view.isUserInteractionEnabled = false
        updateUIView(view, context: context)
        return view
    }
    func updateUIView(_ view: AttachmentView, context: Context) {
        context.coordinator.onBack = onBack
        context.coordinator.onOpenDetail = onOpenDetail
        context.coordinator.region = view
        view.onAttachmentChange = { [weak coordinator = context.coordinator] in coordinator?.attach(to: $0) }
        view.refreshAttachment()
    }
    static func dismantleUIView(_ view: AttachmentView, coordinator: Coordinator) {
        view.onAttachmentChange = nil
        coordinator.detach()
    }

    /// Resolve the owning surface from lifecycle events, not timeline size
    /// estimates or a fixed number of asynchronous retries.
    final class AttachmentView: UIView {
        var onAttachmentChange: ((UIView?) -> Void)?
        override func didMoveToWindow() {
            super.didMoveToWindow()
            refreshAttachment()
        }
        override func didMoveToSuperview() {
            super.didMoveToSuperview()
            refreshAttachment()
        }
        override func layoutSubviews() {
            super.layoutSubviews()
            refreshAttachment()
        }
        func refreshAttachment() {
            guard window != nil else { onAttachmentChange?(nil); return }
            var ancestor = superview
            while let view = ancestor {
                if let scroll = view as? UIScrollView, !(scroll is UITextView) {
                    onAttachmentChange?(scroll)
                    return
                }
                ancestor = view.superview
            }
            // SwiftUI may place a background next to, not inside, its scroll
            // view. Attach to the page owner, restricted to this region below.
            var responder: UIResponder? = next
            while let current = responder {
                if let controller = current as? UIViewController,
                   let owner = controller.viewIfLoaded, owner.window === window {
                    onAttachmentChange?(owner)
                    return
                }
                responder = current.next
            }
            onAttachmentChange?(nil)
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onBack: (() -> Void)?
        var onOpenDetail: (() -> Void)?
        weak var region: UIView?
        private weak var attachmentView: UIView?
        private lazy var pan: UIPanGestureRecognizer = {
            let value = UIPanGestureRecognizer(target: self, action: #selector(handlePan(_:)))
            value.maximumNumberOfTouches = 1
            value.delegate = self
            return value
        }()
        func attach(to view: UIView?) {
            guard attachmentView !== view else { return }
            detach()
            attachmentView = view
            view?.addGestureRecognizer(pan)
        }
        func detach() { attachmentView?.removeGestureRecognizer(pan); attachmentView = nil }
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            let velocity = pan.velocity(in: attachmentView)
            guard PadConversationSwipePolicy.isHorizontal(x: velocity.x, y: velocity.y) else { return false }
            return velocity.x > 0 ? onBack != nil : onOpenDetail != nil
        }
        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard let region, region.window != nil,
                  region.bounds.contains(touch.location(in: region)) else { return false }
            var candidate = touch.view
            while let view = candidate, view !== attachmentView {
                if view is UIControl { return false }
                if let text = view as? UITextView,
                   text.isEditable || text.selectedRange.length > 0 {
                    return false
                }
                if let nested = view as? UIScrollView, nested.isScrollEnabled,
                   nested.contentSize.width > nested.bounds.width + 1 { return false }
                candidate = view.superview
            }
            return true
        }
        func gestureRecognizer(_ recognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
            // Only the timeline's vertical pan may run alongside page navigation.
            guard let scroll = other.view as? UIScrollView, !(scroll is UITextView),
                  other === scroll.panGestureRecognizer else { return false }
            return scroll.contentSize.width <= scroll.bounds.width + 1
        }
        @objc private func handlePan(_ recognizer: UIPanGestureRecognizer) {
            guard recognizer.state == .ended else { return }
            let value = recognizer.translation(in: attachmentView)
            switch PadConversationSwipePolicy.destination(horizontal: value.x, vertical: value.y) {
            case .taskList: onBack?()
            case .detail: onOpenDetail?()
            case nil: break
            }
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
    let entryID: String
    let steps: [ConversationExecutionStep]
    let presentation: ConversationProcessPresentation
    private let languageCode = Locale.preferredLanguages.first ?? "en"
    let laneWidth: CGFloat
    let coordinateSpace: String
    let startedAt: Date?
    let canAdvance: Bool
    let expanded: Bool
    let toggle: () -> Void
    @State private var locallyPausedAt: Date?
    private var latestPlan: ConversationExecutionPlan? { steps.compactMap(\.plan).last }
    private var state: ConversationProcessState { presentation.state }
    private var summary: String {
        ConversationProcessPresentation(
            state: presentation.state,
            count: presentation.count,
            duration: presentation.duration
        ).summary(languageCode: languageCode)
    }
    private var progressLabel: String? {
        latestPlan.flatMap { plan in
            plan.completionFraction == nil ? nil
                : "计划 \(plan.steps.filter { $0.status == "completed" }.count)/\(plan.steps.count)"
        }
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
                processCard(summary: summary(at: Date(), startedAt: startedAt),
                    liveSummary: { summary(at: $0, startedAt: startedAt) })
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
            duration: presentation.duration).summary(languageCode: languageCode)
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
            duration: duration).summary(languageCode: languageCode)
    }

    private func processCard(summary: String, liveSummary: ((Date) -> String)? = nil) -> some View {
        PadProcessCardLayout(expanded: expanded, laneWidth: laneWidth) {
            ProcessCard(summary: summary, liveSummary: liveSummary,
                        secondary: presentation.currentStepTitle,
                        symbol: state.symbolName, tint: tint, expanded: expanded,
                        progress: latestPlan?.completionFraction,
                        progressLabel: progressLabel,
                        toggle: toggle) {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(steps) { step in
                        PadExecutionStepCard(step: step)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

/// Measures only this card, using its actual scaled fonts and current summary.
/// No preference round-trip, extra timer, or timeline-wide state invalidation.
private struct PadProcessCardLayout: Layout {
    let expanded: Bool
    let laneWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let card = subviews.first else { return .zero }
        let available = laneWidth > 0 ? laneWidth : (proposal.width ?? MessageBubbleWidthPolicy.maximumWidth)
        let natural = expanded ? 0 : card.sizeThatFits(.unspecified).width
        let width = MessageBubbleWidthPolicy.processCardLayoutWidth(
            naturalWidth: natural, expanded: expanded, laneWidth: available)
        return CGSize(width: width, height: card.sizeThatFits(.init(width: width, height: proposal.height)).height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading,
            proposal: .init(width: bounds.width, height: bounds.height))
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

private struct TimelineDragOnlyScrollbar: UIViewRepresentable {
    let scrollView: UIScrollView?
    let jumpRevision: UInt64
    var onScroll: ((CGFloat) -> Void)? = nil
    let onInteraction: (Bool) -> Void

    func makeUIView(context: Context) -> IndicatorView { IndicatorView() }
    func updateUIView(_ view: IndicatorView, context: Context) {
        view.configure(scrollView: scrollView, jumpRevision: jumpRevision, onScroll: onScroll, onInteraction: onInteraction)
    }
    static func dismantleUIView(_ view: IndicatorView, coordinator: ()) { view.detach() }

    final class IndicatorView: UIView, UIGestureRecognizerDelegate {
        private weak var scrollView: UIScrollView?
        private var observations: [NSKeyValueObservation] = []
        private let thumb = UIView()
        private var onInteraction: ((Bool) -> Void)?
        private var onScroll: ((CGFloat) -> Void)?
        private var jumpRevision: UInt64 = 0
        private var dragGeometry: PadTimelineScrollbarGeometry?
        private var dragStartOffset: CGFloat = 0
        private lazy var pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))

        init() {
            super.init(frame: .zero)
            thumb.backgroundColor = .secondaryLabel
            thumb.alpha = 0.55
            thumb.layer.cornerRadius = 2
            thumb.isUserInteractionEnabled = false
            addSubview(thumb)
            pan.delegate = self
            addGestureRecognizer(pan)
            isAccessibilityElement = true
            accessibilityLabel = "消息滚动条"
            accessibilityTraits = .adjustable
        }
        required init?(coder: NSCoder) { fatalError() }

        func configure(scrollView: UIScrollView?, jumpRevision: UInt64, onScroll: ((CGFloat) -> Void)?, onInteraction: @escaping (Bool) -> Void) {
            self.onInteraction = onInteraction
            self.onScroll = onScroll
            if self.jumpRevision != jumpRevision {
                // Explicit latest jumps cancel an active thumb drag too.
                // Do not let its cancellation publish stale bottom proximity
                // over the explicit jump's new follow intent.
                dragGeometry = nil
                pan.isEnabled = false
                pan.isEnabled = true
                self.jumpRevision = jumpRevision
            }
            if self.scrollView !== scrollView {
                detach()
                self.scrollView = scrollView
                if let scrollView {
                    observations = [
                        scrollView.observe(\.contentOffset, options: [.new]) { [weak self] _, _ in
                            MainActor.assumeIsolated { self?.updateThumb() }
                        },
                        scrollView.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
                            MainActor.assumeIsolated { self?.updateThumb() }
                        },
                        scrollView.observe(\.bounds, options: [.new]) { [weak self] _, _ in
                            MainActor.assumeIsolated { self?.updateThumb() }
                        }
                    ]
                }
            }
            updateThumb()
        }

        func detach() {
            if dragGeometry != nil { dragGeometry = nil; onInteraction?(false) }
            observations.removeAll()
            scrollView = nil
        }

        private var geometry: PadTimelineScrollbarGeometry {
            let inset = scrollView?.adjustedContentInset ?? .zero
            return PadTimelineScrollbarGeometry(contentHeight: scrollView?.contentSize.height ?? 0,
                viewportHeight: scrollView?.bounds.height ?? 0, topInset: inset.top,
                bottomInset: inset.bottom, trackHeight: max(0, bounds.height - 8),
                offset: scrollView?.contentOffset.y ?? 0)
        }

        override func layoutSubviews() { super.layoutSubviews(); updateThumb() }

        private func updateThumb() {
            let metrics = geometry
            thumb.isHidden = !metrics.isScrollable
            accessibilityElementsHidden = !metrics.isScrollable
            let frame = CGRect(x: max(0, bounds.width - 7), y: 4 + metrics.thumbY,
                               width: 4, height: metrics.thumbHeight)
            if thumb.frame != frame { thumb.frame = frame }
        }

        override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
            // Empty track is transparent to input; a tap on the thumb also
            // does nothing until UIPanGestureRecognizer recognizes movement.
            !thumb.isHidden && bounds.contains(point)
                && thumb.frame.insetBy(dx: -20, dy: 0).contains(point)
        }

        override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            let velocity = pan.velocity(in: self)
            // A horizontal edge swipe belongs to page navigation, even if it
            // starts on the thumb. This control owns vertical drags only.
            return abs(velocity.y) > abs(velocity.x)
        }

        @objc private func drag(_ gesture: UIPanGestureRecognizer) {
            guard let scrollView else { return }
            switch gesture.state {
            case .began:
                dragGeometry = geometry
                dragStartOffset = scrollView.contentOffset.y
                if onScroll == nil { scrollView.setContentOffset(scrollView.contentOffset, animated: false) }
                onInteraction?(true)
                applyDrag(gesture)
            case .changed: applyDrag(gesture)
            case .ended, .cancelled, .failed:
                guard dragGeometry != nil else { return }
                dragGeometry = nil
                onInteraction?(false)
            default: break
            }
        }

        private func applyDrag(_ gesture: UIPanGestureRecognizer) {
            guard let scrollView, let dragGeometry else { return }
            let requested = dragGeometry.offset(start: dragStartOffset, translation: gesture.translation(in: self).y)
            let current = geometry
            move(to: min(current.maximumOffset, max(current.minimumOffset, requested)))
        }

        override func accessibilityIncrement() { accessibilityMove(1) }
        override func accessibilityDecrement() { accessibilityMove(-1) }
        private func accessibilityMove(_ direction: CGFloat) {
            guard let scrollView, geometry.isScrollable else { return }
            onInteraction?(true)
            let metrics = geometry
            move(to: min(metrics.maximumOffset, max(metrics.minimumOffset,
                scrollView.contentOffset.y + direction * scrollView.bounds.height * 0.8)))
            onInteraction?(false)
        }
        private func move(to offset: CGFloat) {
            if let onScroll { onScroll(offset) }
            else if let scrollView {
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: offset), animated: false)
            }
        }
    }
}

struct PadAttachmentPreview: Identifiable {
    let sessionID: String
    let image: ClientMessageImage
    var id: String { sessionID + "\u{0}" + image.managedPath }
}

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
        .modifier(ConversationContentSurface(cornerRadius: 14,
            tint: requiresAttention ? .orange : .secondary, tintOpacity: requiresAttention ? 0.065 : 0.04, isMessage: true))
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
    @Environment(\.colorScheme) private var colorScheme
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
    private var status: String { submitting ? "submitting" : (resolvedStatus ?? presentation?.status ?? "queued") }
    private var isPending: Bool {
        presentation?.isConfirmation == true && status.lowercased() == "pending"
    }
    private var title: String {
        if presentation?.isChannelAuthorization == true { return "首次授权并发送" }
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
        case "confirmed": return "已发送"
        case "submitting": return "正在提交…"
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
            if presentation?.isChannelAuthorization == true, isPending {
                Text("首次与此会话建立通道，或原通道已撤销。授权仅适用于这两个 Session，不会由同名会话或同一 Work 继承。")
                    .font(.caption).foregroundStyle(.secondary)
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
            if let errorText { Text(errorText).font(.caption).foregroundStyle(.red) }
        }
        .padding(14)
        .frame(maxWidth: 560, alignment: .leading)
        .modifier(ConversationContentSurface(cornerRadius: 14,
            tint: presentation?.isConfirmation == true ? .orange : MessageTextCardPalette.background(for: .collaboration, dark: colorScheme == .dark),
            tintOpacity: presentation?.isConfirmation == true ? 0.065 : ConversationContentSurfacePolicy.tintOpacity, isMessage: true))
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
    @Environment(\.locale) private var locale
    private var words: ConversationEventText { .init(languageCode: locale.identifier) }

    private var isSystemEvent: Bool { message.presentationKind == .systemEvent }
    private var title: String {
        if message.presentationKind == .automationEvent { return message.automationName ?? words.automationTitle }
        if isSystemEvent { return words.systemKind(message.systemEventKind) }
        return message.title ?? words.systemTitle
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
                Text(message.automationRunId == nil ? words.eventLabel(eventType) : words.runStatus(message.automationRunStatus))
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    .frame(height: 18)
                if message.automationRunError != nil {
                    Text(words.text("本次运行失败，请查看执行记录。", "This run failed. Check its execution history."))
                        .font(.caption).foregroundStyle(.red)
                }
                if let date = eventDate(message.automationEventOccurredAt ?? message.createdAt) {
                    LabeledContent(message.automationRunId == nil ? words.timeLabel(eventType)
                        : words.text("触发时间", "Triggered at"), value: date).font(.caption)
                }
                if let plan = words.executionPlan(trigger: message.automationTriggerType ?? message.automationScheduleType,
                    runAt: message.automationRunAt, nextRunAt: message.automationNextRunAt,
                    interval: message.automationIntervalSeconds, conditionInterval: message.automationConditionCheckIntervalSeconds,
                    processInterval: message.automationProcessPollIntervalSeconds, formatDate: eventDate) {
                    LabeledContent(words.text("执行计划", "Execution plan"), value: plan).font(.caption)
                }
                if let expires = eventDate(message.automationExpiresAt) {
                    LabeledContent(words.text("过期时间", "Expires at"), value: expires).font(.caption)
                }
            }
            if !isSystemEvent && message.automationRunId == nil && !bodyText.isEmpty {
                PadMessageText(text: bodyText, fromUser: false, isTextSelectionEnabled: .constant(true))
            }
            if let reason = message.systemEventReason {
                LabeledContent(words.reasonLabel, value: words.reason(reason)).font(.caption).textSelection(.enabled)
            }
            if isSystemEvent {
                Text(words.systemNotice).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: 560, alignment: .leading)
        .modifier(ConversationContentSurface(cornerRadius: 14, tint: .secondary, tintOpacity: 0.045, isMessage: true))
        .overlay { RoundedRectangle(cornerRadius: 14).strokeBorder(Color.secondary.opacity(0.14)) }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(isSystemEvent ? "conversation-system-event" : "conversation-special-event")
    }

    private func eventDate(_ value: String?) -> String? {
        guard let value, let date = ConversationTimestampText.date(from: value) else { return nil }
        return date.formatted(Date.FormatStyle(date: .numeric, time: .shortened).locale(locale))
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
        .modifier(ConversationContentSurface(cornerRadius: 14, isMessage: true))
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
        .modifier(ConversationContentSurface(cornerRadius: 14, tint: .secondary, tintOpacity: 0.06))
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
    var delete: (() -> Void)? = nil
    var cancelQueued: (() -> Void)? = nil
    @State private var selectedResource: ConversationLocalResource?
    @State private var selectedGallery: MobileImageGalleryPreview?
    @State private var linkFailed = false

    private var localResources: [ConversationLocalResource] {
        ConversationLocalResourceCache.shared.resources(messageID: message.id, text: rawDisplayText)
    }

    private func openMessageLink(_ url: URL) {
        if let resource = ConversationLocalResource(url: url) {
            selectedResource = resource
        } else if ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
            UIApplication.shared.open(url) { success in if !success { linkFailed = true } }
        } else { linkFailed = true }
    }

    private var fromUser: Bool { message.presentationKind == .userMessage }
    private var rawDisplayText: String {
        ConversationMessageDisplayText.resolve(text: message.text,
            presentationText: message.presentationText, title: message.title, type: message.type)
    }
    private var imageReferences: [ConversationMessageImageReference] {
        ConversationMessageImageReferenceCache.shared.references(messageID: message.id, text: rawDisplayText)
            .filter { ConversationLocalResource(url: $0.url) != nil || ["http", "https"].contains($0.url.scheme?.lowercased() ?? "") }
    }
    private var displayText: String {
        if message.type == "imageView", !message.images.isEmpty { return "" }
        return MessageImageGalleryLayout.bodyText(ConversationMessageImageReference.removing(imageReferences, from: rawDisplayText),
            hasImages: !message.images.isEmpty)
    }
    private var contentBlocks: [ConversationLocatedContentBlock] {
        guard displayText.contains("|") || (message.type == "agentMessage" && displayText.contains("```corptie-chart"))
        else { return [.init(messageID: message.id, startUTF16: 0, content: .markdown(displayText))] }
        return ConversationChartBlockCache.shared.locatedBlocks(
            messageID: message.id, authoritativeText: displayText)
    }
    private var attachments: [ClientMessageImage] { message.images }
    private var galleryResources: [ConversationMessageImageReference] {
        var seen = Set<String>()
        return imageReferences.filter { seen.insert($0.id).inserted }
    }
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
            bodyWidth: max(PadMessageLayout.bodyWidth(text: displayText, style: fromUser ? .user : .agent),
                attachments.isEmpty && galleryResources.isEmpty ? 0 : MessageImageGalleryLayout.preferredBodyWidth),
            hasAttachments: !attachments.isEmpty || !galleryResources.isEmpty || !suggestedReplies.isEmpty,
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
                MessageTextCard(messageID: message.id, role: fromUser ? .user :
                    (ConversationPresentationKind.isCommentary(type: message.type, presentationRole: message.presentationRole)
                        ? .commentary : .agent),
                    timestamp: "", showsActions: false, actionsAlwaysVisible: false, cardWidth: cardWidth,
                    status: messageStatus,
                    contextMenu: MessageTextCardMenuConfiguration(
                        timestampTitle: timestamp.isEmpty ? nil : "时间：\(timestamp)",
                        copyTitle: "复制消息", selectTextTitle: "选择文本",
                        canCopy: !copyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                        delete: fromUser ? delete : nil, cancelQueued: fromUser ? cancelQueued : nil),
                    copy: { UIPasteboard.general.string = copyText }) { isTextSelectionEnabled in
                        VStack(alignment: .leading, spacing: MessageImageStripMetrics.bottomSpacing) {
                            if message.messageOrigin == "scheduled_task" {
                                Label(ConversationEventText(languageCode: Locale.preferredLanguages.first ?? "en")
                                    .messageSource(name: message.automationName), systemImage: "clock")
                                    .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                            }
                            if fromUser && (!attachments.isEmpty || !galleryResources.isEmpty) { attachmentStrip }
                            ForEach(contentBlocks) { block in
                                switch block.content {
                                case .markdown(let text):
                                    if !text.isEmpty {
                                        PadMessageText(text: text, fromUser: fromUser,
                                            isTextSelectionEnabled: isTextSelectionEnabled, openLink: openMessageLink)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                case .chart(let spec, _):
                                    ConversationChartView(spec: spec)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                case .table(let table):
                                    ConversationMarkdownTableView(table: table,
                                        layout: .measured(table, width: cardWidth - MessageBubbleWidthPolicy.horizontalPadding,
                                            style: fromUser ? .user : .agent),
                                        allowsSelection: isTextSelectionEnabled.wrappedValue,
                                        openLink: openMessageLink,
                                        selectText: { isTextSelectionEnabled.wrappedValue = true })
                                case .invalidChart(let original, let reason):
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(reason).font(.caption2).foregroundStyle(.secondary)
                                        PadMessageText(text: original, fromUser: false,
                                            isTextSelectionEnabled: isTextSelectionEnabled)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                            if !fromUser && (!attachments.isEmpty || !galleryResources.isEmpty) { attachmentStrip }
                            ForEach(localResources.filter { !$0.isImage }.prefix(8)) { resource in
                                Button { selectedResource = resource } label: {
                                    HStack {
                                        Label(resource.fileName, systemImage: resource.isImage ? "photo" : "doc")
                                        .font(.caption).lineLimit(1)
                                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    }
                                }
                                .buttonStyle(.plain).foregroundStyle(.tint)
                                .onAppear {
                                    if resource.isImage {
                                        images.ensure(sessionID: sessionID, managedPath: resource.path,
                                            connection: connection, itemID: message.id)
                                    }
                                }
                            }
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
        .fullScreenCover(item: $selectedResource) { resource in
            PadMessageResourceViewer(connection: connection, sessionID: sessionID,
                itemID: message.id, resource: resource)
        }
        .fullScreenCover(item: $selectedGallery) { preview in
            MobileImageGalleryViewer(connection: connection, sessionID: sessionID, itemID: message.id, preview: preview)
        }
        .alert("无法打开链接", isPresented: $linkFailed) {
            Button("好", role: .cancel) { }
        } message: { Text("链接格式不受支持，或当前没有可打开它的应用。") }
    }

    private func resourceThumbnail(_ resource: ConversationMessageImageReference) -> MessageImageThumbnail.State {
        let local = ConversationLocalResource(url: resource.url)
        return switch images.entry(sessionID: sessionID, managedPath: local?.path ?? resource.url.absoluteString,
                           itemID: local == nil ? nil : message.id) {
        case .loaded(let image): .loaded(Image(uiImage: image))
        case .missing: .missing
        case .loading, nil: .loading
        }
    }

    private var attachmentStrip: some View {
        let count = attachments.count + galleryResources.count
        let frames = MessageImageGalleryLayout.frames(count: count,
            width: cardWidth - MessageBubbleWidthPolicy.horizontalPadding)
        return ZStack(alignment: .topLeading) {
            ForEach(Array(frames.enumerated()), id: \.offset) { index, frame in
                if index < attachments.count {
                    let attachment = attachments[index]
                    Button {
                        if images.entry(sessionID: sessionID, managedPath: attachment.managedPath) == .missing {
                            images.retry(sessionID: sessionID, managedPath: attachment.managedPath, connection: connection)
                        } else { showGallery(index: index) }
                    } label: {
                        MessageImageThumbnail(state: thumbnailState(attachment), index: index,
                            size: frame.size, fits: count == 1, extraCount: index == 3 ? max(0, count - 4) : 0)
                    }.buttonStyle(.plain)
                        .offset(x: frame.minX, y: frame.minY)
                        .accessibilityIdentifier("message-attachment-\(index)")
                        .onAppear { images.ensure(sessionID: sessionID, managedPath: attachment.managedPath, connection: connection) }
                } else {
                    let resource = galleryResources[index - attachments.count]
                    let local = ConversationLocalResource(url: resource.url)
                    let path = local?.path ?? resource.url.absoluteString
                    Button {
                        if images.entry(sessionID: sessionID, managedPath: path, itemID: local == nil ? nil : message.id) == .missing {
                            images.retry(sessionID: sessionID, managedPath: path, connection: connection, itemID: local == nil ? nil : message.id)
                        } else { showGallery(index: index) }
                    } label: {
                        MessageImageThumbnail(state: resourceThumbnail(resource), index: index,
                            size: frame.size, fits: count == 1, extraCount: index == 3 ? max(0, count - 4) : 0)
                    }.buttonStyle(.plain).offset(x: frame.minX, y: frame.minY)
                        .onAppear { images.ensure(sessionID: sessionID, managedPath: path, connection: connection, itemID: local == nil ? nil : message.id) }
                }
            }
        }
        .frame(width: frames.map(\.maxX).max() ?? 0, height: frames.map(\.maxY).max() ?? 0, alignment: .topLeading)
    }

    private func thumbnailState(_ attachment: ClientMessageImage) -> MessageImageThumbnail.State {
        switch images.entry(sessionID: sessionID, managedPath: attachment.managedPath) {
        case .loaded(let image): .loaded(Image(uiImage: image))
        case .missing: .missing
        case .loading, nil: .loading
        }
    }

    private func showGallery(index: Int) {
        selectedGallery = .init(items: attachments.map { .managed($0) } + galleryResources.map { .reference($0) }, selected: index)
    }
}

private struct MobileImageGalleryPreview: Identifiable {
    enum Item: Sendable {
        case managed(ClientMessageImage)
        case reference(ConversationMessageImageReference)
        var name: String {
            switch self {
            case .managed(let image): URL(fileURLWithPath: image.fileName ?? image.managedPath).lastPathComponent
            case .reference(let reference): reference.url.lastPathComponent
            }
        }
    }
    let id = UUID()
    let items: [Item]
    let selected: Int
}

/// One original at a time, with native Quick Look zoom/rotation. Moving between
/// images releases the previous temporary file instead of retaining an album
/// of full-resolution UIImages alongside the scrolling thumbnail cache.
private struct MobileImageGalleryViewer: View {
    let connection: PadConnection
    let sessionID: String
    let itemID: String
    let preview: MobileImageGalleryPreview
    @Environment(\.dismiss) private var dismiss
    @State private var selection: Int
    @State private var localURL: URL?
    @State private var failed = false
    @State private var retry = 0

    init(connection: PadConnection, sessionID: String, itemID: String, preview: MobileImageGalleryPreview) {
        self.connection = connection; self.sessionID = sessionID; self.itemID = itemID; self.preview = preview
        _selection = State(initialValue: preview.selected)
    }
    var body: some View {
        NavigationStack {
            Group {
                if let localURL { PadResourceQuickLook(url: localURL).id(localURL) }
                else if failed {
                    ContentUnavailableView {
                        Label("图片暂时无法打开", systemImage: "photo")
                    } description: { Text("请检查连接，或确认图片仍然可用。") }
                    actions: { Button("重试") { retry += 1 } }
                } else { ProgressView("正在加载图片…") }
            }
            .navigationTitle(preview.items[selection].name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                ToolbarItemGroup(placement: .bottomBar) {
                    Button { selection -= 1 } label: { Image(systemName: "chevron.left") }.disabled(selection == 0)
                    Spacer()
                    Text("\(selection + 1) / \(preview.items.count)").monospacedDigit()
                    Spacer()
                    Button { selection += 1 } label: { Image(systemName: "chevron.right") }.disabled(selection == preview.items.count - 1)
                }
            }
        }
        .task(id: "\(selection):\(retry)") {
            if let localURL { try? FileManager.default.removeItem(at: localURL.deletingLastPathComponent()) }
            localURL = nil; failed = false
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent("image-gallery-\(UUID())")
            do {
                let selected = preview.items[selection]
                let bytes: Data
                switch selected {
                case .managed(let image):
                    let api = ClientSessionAPI(transport: try await connection.transport())
                    guard let payload = try await api.image(sessionId: sessionID, managedPath: image.managedPath) else {
                        throw URLError(.fileDoesNotExist)
                    }
                    bytes = payload.data
                case .reference(let reference):
                    if let resource = ConversationLocalResource(url: reference.url) {
                        let api = ClientSessionAPI(transport: try await connection.transport())
                        bytes = try await api.resource(sessionId: sessionID, itemId: itemID, path: resource.path)
                    } else {
                        bytes = try await ClientRemoteImageDownload.read(reference.url)
                    }
                }
                try Task.checkCancellation()
                let url = try await Task.detached(priority: .userInitiated) {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let source = CGImageSourceCreateWithData(bytes as CFData, nil)
                    guard let source, let type = CGImageSourceGetType(source) as String? else { throw URLError(.cannotDecodeContentData) }
                    let ext = UTType(type)?.preferredFilenameExtension ?? "png"
                    let file = directory.appendingPathComponent("image.\(ext)")
                    try bytes.write(to: file, options: [.atomic, .completeFileProtection])
                    return file
                }.value
                try Task.checkCancellation()
                localURL = url
            } catch {
                try? FileManager.default.removeItem(at: directory)
                if !Task.isCancelled { failed = true }
            }
        }
        .onDisappear { if let localURL { try? FileManager.default.removeItem(at: localURL.deletingLastPathComponent()) } }
        .accessibilityIdentifier("attachment-gallery-viewer")
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
