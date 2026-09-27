import SwiftUI
import UIKit
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
    private enum Scanner: String, Identifiable { case camera; var id: String { rawValue } }
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button("扫码配对 Mac", systemImage: "qrcode.viewfinder") { scanner = .camera }
                        .disabled(connection.claim != nil)
                    Text("在 Mac 的设备接入设置中生成二维码，扫码后无需手填连接信息。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !connection.serverID.isEmpty {
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
                    Button("连接已配对的 Mac") { Task { await connection.reconnect() } }
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
                    if !connection.notice.isEmpty { Text(connection.notice).font(.callout) }
                    if connection.busy { ProgressView("连接中") }
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

struct WorkspaceView: View {
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    @State private var expandedWorkIDs = PadWorkExpansionStore().load()
    @State private var isChatExpanded = true
    @State private var taskCreationRoute: PadTaskCreationRoute?
    @State private var taskCreationStates: [String: PadTaskCreationState] = [:]
    @State private var columnVisibility = NavigationSplitViewVisibility.all
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
        NavigationSplitView(columnVisibility: $columnVisibility) {
            PadWorkOutline(connection: connection, workspace: workspace, workAvatars: workAvatars,
                entityCommands: commands, isActive: scenePhase == .active, expandedWorkIDs: $expandedWorkIDs,
                isChatExpanded: $isChatExpanded, createTask: openTaskCreation, onEntityRoute: { route in
                    entityRoute = route
                })
            .disabled(connection.busy)
            .safeAreaInset(edge: .top, spacing: 0) {
                if !commands.notice.isEmpty {
                    HStack(spacing: 8) {
                        Text(commands.notice)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        if commands.pending != nil {
                            Button("核对") {
                                Task { await commands.reconcile(connection) }
                            }
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
            .toolbar(removing: .sidebarToggle)
        } detail: {
            if let id = workspace.selection {
                ConversationView(connection: connection, workspace: workspace, sessionID: id,
                    messageImages: messageImages)
                    .id(id)
            } else {
                ContentUnavailableView("选择一个 Task 或会话", systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("消息与状态自动更新。"))
            }
        }
        .toolbar(removing: .sidebarToggle)
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: horizontalSizeClass, initial: true) { _, sizeClass in
            if sizeClass == .regular { columnVisibility = .all }
        }
        .onChange(of: workspace.selection) {
            if workspace.selection == nil { columnVisibility = .all }
        }
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
    @State private var confirmForget = false
    @AppStorage("conversation.showsDetailInspector") private var showsDetailInspector = false
    @State private var viewportState = ConversationViewportState()
    @State private var historyViewport = TimelineHistoryViewportState()
    @State private var historyAutoLoadGate = PadHistoryAutoLoadGate()
    @State private var timelineScrollView: UIScrollView?
    @State private var pendingHistoryViewport: PendingHistoryViewport?
    @State private var isUserInteractingWithTimeline = false
    /// Rounded whole-point lane width prevents sub-pixel geometry changes from
    /// invalidating every realized message row during keyboard/split resizing.
    @State private var laneWidth: CGFloat = 0
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
                        switch entry.kind {
                        case .message(let message):
                            if message.type == "userInput" {
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
                            } else {
                                MobileMessageBubble(message: message, deliveryState: workspace.outgoingStates[message.id],
                                    laneWidth: laneWidth, connection: connection, sessionID: sessionID,
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
                                               laneWidth: laneWidth,
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
                    Color.clear.frame(height: 1).id("latest")
                        .onAppear {
                            if #unavailable(iOS 18.0) { viewportState.setFollowsLatest(true) }
                        }
                        .onDisappear {
                            if #unavailable(iOS 18.0) { viewportState.setFollowsLatest(false) }
                            requestEarlierHistoryIfNeeded()
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
                        pendingHistoryViewport = nil
                        requestEarlierHistoryIfNeeded(userInitiated: true)
                    }
                }
            ))
            .scrollDismissesKeyboard(.interactively)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: TimelineViewportSizeKey.self, value: proxy.size)
                }
            }
            .onPreferenceChange(TimelineNearTopKey.self) { nearTop in
                guard nearTop != historyViewport.nearTop else { return }
                historyViewport.nearTop = nearTop
                requestEarlierHistoryIfNeeded()
            }
            .onPreferenceChange(TimelineContentHeightKey.self) { height in
                guard height != historyViewport.contentHeight else { return }
                historyViewport.contentHeight = height
                if pendingHistoryViewport != nil {
                    restoreHistoryViewportIfReady()
                } else if viewportState.followsLatest {
                    pinTimelineToLatestIfReady()
                }
                requestEarlierHistoryIfNeeded()
            }
            .onPreferenceChange(TimelineViewportSizeKey.self) { size in
                let roundedWidth = max(0, size.width - 32).rounded(.down)
                if roundedWidth != laneWidth { laneWidth = roundedWidth }
                let roundedHeight = size.height.rounded(.down)
                guard roundedHeight != historyViewport.viewportHeight else { return }
                historyViewport.viewportHeight = roundedHeight
                // Keyboard safe-area changes resize the timeline and composer
                // in the same animation. Pin a followed conversation to its
                // bottom on every distinct viewport step so the last message
                // travels with the composer instead of catching up afterward.
                if viewportState.followsLatest {
                    if !pinTimelineToLatestIfReady() {
                        reader.scrollTo("latest", anchor: .bottom)
                    }
                }
                requestEarlierHistoryIfNeeded()
            }
            .accessibilityIdentifier("conversation-timeline")
            .task {
                let hadCachedCapabilities = workspace.capabilities != nil
                await workspace.waitForRealtimeTimelineOrFallback(connection)
                guard !Task.isCancelled else { return }
                if !hadCachedCapabilities || viewportState.followsLatest {
                    reader.scrollTo("latest", anchor: .bottom)
                }
                await workspace.repairMissingUsage(connection)
            }
            .onChange(of: workspace.messageRevision) {
                if viewportState.timelineTailDidChange() {
                    reader.scrollTo("latest", anchor: .bottom)
                }
            }
            .onChange(of: workspace.scrollRequest) {
                viewportState.jumpToLatest()
                reader.scrollTo("latest", anchor: .bottom)
            }
            .onChange(of: workspace.before) {
                requestEarlierHistoryIfNeeded()
            }
            .onChange(of: workspace.isLoadingEarlier) { _, isLoading in
                if !isLoading {
                    if pendingHistoryViewport != nil {
                        restoreHistoryViewportIfReady()
                    } else if viewportState.followsLatest {
                        if !pinTimelineToLatestIfReady() {
                            reader.scrollTo("latest", anchor: .bottom)
                        }
                    }
                    requestEarlierHistoryIfNeeded()
                }
            }
            .onChange(of: connection.busy) { _, isBusy in
                if !isBusy { requestEarlierHistoryIfNeeded() }
            }
            .onChange(of: sessionID) { _, _ in
                viewportState.reset()
                pendingHistoryViewport = nil
                isUserInteractingWithTimeline = false
                timelineScrollView = nil
                historyViewport = TimelineHistoryViewportState()
                historyAutoLoadGate = PadHistoryAutoLoadGate()
            }
            .overlay(alignment: .bottomTrailing) {
                if viewportState.showsJumpToLatest {
                    Button {
                        pendingHistoryViewport = nil
                        viewportState.jumpToLatest()
                        reader.scrollTo("latest", anchor: .bottom)
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
                }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { conversationHeader }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .coordinateSpace(name: "conversation-viewport")
        .background(Color(uiColor: .systemGroupedBackground))
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
        .inspector(isPresented: $showsDetailInspector) {
            PadConversationInspector(workspace: workspace, connection: connection, sessionID: sessionID,
                close: { showsDetailInspector = false })
                .id(sessionID)
                .inspectorColumnWidth(min: 280, ideal: 320, max: 400)
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

    private func requestEarlierHistoryIfNeeded(userInitiated: Bool = false) {
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
        viewportState.prepareForHistoryPrepend(preservingLatestFollow: underfilled)
        if !viewportState.followsLatest, let timelineScrollView {
            pendingHistoryViewport = PendingHistoryViewport(
                contentHeight: timelineScrollView.contentSize.height,
                contentOffsetY: timelineScrollView.contentOffset.y
            )
        }
        Task {
            await workspace.loadEarlierMessagesIfNeeded(connection)
            restoreHistoryViewportIfReady()
        }
    }

    /// The native scroll view owns physical geometry just as AppKit does on
    /// macOS. Correcting its bottom offset synchronously avoids queueing a
    /// second SwiftUI `scrollTo` transaction during keyboard and row reflow.
    @discardableResult
    private func pinTimelineToLatestIfReady() -> Bool {
        guard let timelineScrollView else { return false }
        timelineScrollView.layoutIfNeeded()
        let minimumY = -timelineScrollView.adjustedContentInset.top
        let maximumY = max(
            minimumY,
            timelineScrollView.contentSize.height - timelineScrollView.bounds.height
                + timelineScrollView.adjustedContentInset.bottom
        )
        if abs(timelineScrollView.contentOffset.y - maximumY) >= 0.5 {
            timelineScrollView.setContentOffset(
                CGPoint(x: timelineScrollView.contentOffset.x, y: maximumY), animated: false
            )
        }
        return true
    }

    private func restoreHistoryViewportIfReady() {
        guard !workspace.isLoadingEarlier,
              let pendingHistoryViewport,
              let timelineScrollView else { return }
        timelineScrollView.layoutIfNeeded()
        let heightDelta = timelineScrollView.contentSize.height - pendingHistoryViewport.contentHeight
        guard abs(heightDelta) >= 0.5 else { return }
        let minimumY = -timelineScrollView.adjustedContentInset.top
        let maximumY = max(
            minimumY,
            timelineScrollView.contentSize.height - timelineScrollView.bounds.height
                + timelineScrollView.adjustedContentInset.bottom
        )
        let restoredY = min(maximumY, max(minimumY, pendingHistoryViewport.contentOffsetY + heightDelta))
        timelineScrollView.setContentOffset(
            CGPoint(x: timelineScrollView.contentOffset.x, y: restoredY), animated: false
        )
        self.pendingHistoryViewport = nil
    }

    private var conversationHeader: some View {
        let session = workspace.sessionsByID[sessionID]
        let title = workspace.tasks.first(where: { $0.id == session?.taskId })?.title
            ?? session?.title ?? "会话"

        return VStack(spacing: 4) {
            Text(title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "会话" : title)
                .font(.title3.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 12)
                .padding(.vertical, 5)
                .padGlassSurface(in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(maxWidth: 360)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("conversation-task-title")
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 56)
        .padding(.top, 4)
        .padding(.bottom, 8)
        .overlay(alignment: .trailing) {
            Button { showsDetailInspector.toggle() } label: {
                Image(systemName: "sidebar.right").frame(width: 44, height: 44)
            }
            .accessibilityLabel(showsDetailInspector ? "关闭详情" : "显示详情")
            .accessibilityIdentifier("conversation-detail-toggle")
            .padding(.trailing, 8)
        }
    }

    private var conversationStatusRow: some View {
        HStack(spacing: 8) {
            PadThreadMetaView(session: workspace.sessionsByID[sessionID],
                              capabilities: workspace.capabilities, usage: workspace.usage)
            Spacer(minLength: 0)
            let session = workspace.sessionsByID[sessionID]
            let isRunning = SessionExecutionState(executionStatus: session?.executionStatus) == .running
                || SessionExecutionState(executionStatus: workspace.executionByTaskID[session?.taskId ?? ""]) == .running
            let canStop = isRunning && workspace.capabilities?.stop.available == true
            ZStack {
              if canStop {
                Button {
                    Task { await workspace.command(connection, stop: true) }
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
            // Reserve the same slot while idle; stop visibility must not change
            // either the status row height or the space available to usage text.
            .frame(width: 44, height: 32)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                        scheduleMessage: { composerSheet = .schedule }) {
                conversationStatusRow
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .background { ConversationChromeBackdrop(isBottom: true) }
    }

    private func slashCommandPrefix(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), !trimmed.contains(where: { $0.isWhitespace }) else { return nil }
        return String(trimmed.dropFirst())
    }
}

/// Edge-only separation. The control row itself is transparent: each control
/// supplies its own glass surface, with no solid toolbar backing between them.
private struct ConversationChromeBackdrop: View {
    let isBottom: Bool
    private let depth: CGFloat = 18
    private var surface: Color { Color(uiColor: .systemGroupedBackground) }

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
        ).summary
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
            duration: presentation.duration).summary
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
            duration: duration).summary
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
    let contentHeight: CGFloat
    let contentOffsetY: CGFloat
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
                if plan.steps.count > 8 {
                    ScrollView {
                        ExecutionPlanChecklist(plan: plan)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 300)
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
        geometry.visibleRect.maxY >= geometry.contentSize.height - 40
    }
}

/// Resolves SwiftUI's native scroll view once. History prepends then compensate
/// the exact content-height delta, which is the UIKit equivalent of macOS
/// restoring a stable row plus its intra-row offset.
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
            var candidate = superview
            while let view = candidate {
                if let scrollView = view as? UIScrollView {
                    resolvedScrollView = scrollView
                    onResolve?(scrollView)
                    return
                }
                candidate = view.superview
            }
            guard resolutionAttempts < 4 else { return }
            resolutionAttempts += 1
            DispatchQueue.main.async { [weak self] in self?.resolve() }
        }
    }
}

struct PadAttachmentPreview: Identifiable {
    let sessionID: String
    let image: ClientMessageImage
    var id: String { sessionID + "\u{0}" + image.managedPath }
}

/// Ordinary text message. Card geometry (`MessageBubbleWidthPolicy`), the attachment
/// strip and the timestamp + copy action bar are the macOS row; only text
/// measurement (UIKit) and the always-visible action bar (no hover) differ.
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

private struct PadUserInputCard: View {
    let message: ClientMessage
    let connection: PadConnection
    let sessionID: String
    let onSubmitted: () async -> Void
    @State private var selected: [String: Set<String>] = [:]
    @State private var typed: [String: String] = [:]
    @State private var submitting = false
    @State private var submitted = false
    @State private var errorText: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("需要你的输入").font(.headline)
            if let request = message.userInput, request.schemaVersion == 1 {
                if message.status == "pending" && !submitted {
                    ConversationInputFields(request: request, selected: $selected, typed: $typed)
                        .disabled(submitting)
                    Button("提交答案") { Task { await submit(request) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(submitting || answers(for: request) == nil)
                        .accessibilityIdentifier("user-input-submit")
                    if request.canCancel == true {
                        Button("取消请求") { Task { await submit(request, cancelling: true) } }.disabled(submitting)
                    }
                } else {
                    Text(statusText).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Text(ConversationMessageDisplayText.resolve(text: message.text,
                    presentationText: message.presentationText, title: message.title, type: message.type))
                    .font(.subheadline)
                Text("当前客户端无法处理这种问题，请更新客户端。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let errorText { Text(errorText).font(.caption).foregroundStyle(.red) }
        }
        .frame(maxWidth: 560, alignment: .leading)
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("conversation-user-input")
    }

    private var statusText: String {
        padUserInputStatusText(message.status, submittedLocally: submitted)
    }

    private func answers(for request: ConversationUserInput) -> [String: [String]]? {
        request.answers(selected: selected, typed: typed)
    }

    private func submit(_ request: ConversationUserInput, cancelling: Bool = false) async {
        guard !submitting, !submitted, let answers = cancelling ? [:] : answers(for: request) else { return }
        submitting = true
        errorText = nil
        defer { submitting = false }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let response = try await api.respondToUserInput(sessionId: sessionID, itemId: message.id, answers: answers, action: cancelling ? "cancel" : "submit")
            guard ["submitted", "cancelled"].contains(response.status) else { return }
            submitted = true
            typed.removeAll()
            selected.removeAll()
            await onSubmitted()
        } catch {
            errorText = PadConnection.explain(error)
        }
    }
}

private struct MobileMessageBubble: View {
    let message: ClientMessage
    var deliveryState: String? = nil
    let laneWidth: CGFloat
    let connection: PadConnection
    let sessionID: String
    let images: PadMessageImageStore
    let openAttachment: (ClientMessageImage) -> Void
    let canSendSuggestedReply: Bool
    let sendSuggestedReply: (String) -> Void

    private var fromUser: Bool { message.type == "userMessage" }
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
        HStack(alignment: .bottom, spacing: 0) {
            if fromUser { Spacer(minLength: 0) }
            VStack(alignment: fromUser ? .trailing : .leading, spacing: 5) {
                MessageTextCard(messageID: message.id, role: fromUser ? .user : .agent,
                    timestamp: ConversationTimestampText.messageLabel(createdAt: message.createdAt),
                    showsActions: true, actionsAlwaysVisible: true, cardWidth: cardWidth,
                    status: messageStatus,
                    copy: { UIPasteboard.general.string = ConversationMessageDisplayText.copyText(
                        type: message.type, authoritativeText: message.text,
                        presentationText: message.presentationText, displayedText: displayText) }) {
                        VStack(alignment: .leading, spacing: MessageImageStripMetrics.bottomSpacing) {
                            if fromUser && !attachments.isEmpty { attachmentStrip }
                            ForEach(contentBlocks) { block in
                                switch block.content {
                                case .markdown(let text):
                                    if !text.isEmpty {
                                        PadMessageText(text: text, fromUser: fromUser)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                case .chart(let spec, _):
                                    ConversationChartView(spec: spec)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                case .invalidChart(let original, let reason):
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(reason).font(.caption2).foregroundStyle(.secondary)
                                        PadMessageText(text: original, fromUser: false)
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
