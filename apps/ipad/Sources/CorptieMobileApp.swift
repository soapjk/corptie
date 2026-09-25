import SwiftUI
import UIKit
import CorptieClientCore
import CorptieConversation

@main
struct CorptieMobileApp: App {
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
    @State private var expandedWorkIDs: Set<String> = []
    @State private var isChatExpanded = true
    @State private var initializedExpansion = false
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
            case .editWork(let work):
                PadEditWorkSheet(connection: connection, commands: commands, work: work) {
                    Task { await workspace.inventory(connection) }
                }
            case .renameTask(let task):
                PadRenameTaskSheet(connection: connection, commands: commands, task: task) {
                    Task { await workspace.inventory(connection) }
                }
            case .editTask(let task):
                PadEditTaskSheet(connection: connection, commands: commands, task: task) {
                    Task { await workspace.inventory(connection) }
                }
            case .deleteTask(let task):
                PadDeleteTaskSheet(connection: connection, commands: commands, task: task) {
                    if let selected = workspace.selection,
                       workspace.sessionsByID[selected]?.taskId == task.id {
                        workspace.selection = nil
                    }
                    Task { await workspace.inventory(connection) }
                }
            case .deleteWork(let work):
                PadDeleteWorkSheet(connection: connection, commands: commands, work: work) {
                    if let selected = workspace.selection,
                       workspace.sessionsByID[selected]?.workId == work.id {
                        workspace.selection = nil
                    }
                    Task { await workspace.inventory(connection) }
                }
            }
        }
        .onChange(of: workspace.works.map(\.id), initial: true) { _, ids in
            if !initializedExpansion, !ids.isEmpty {
                expandedWorkIDs = Set(ids)
                initializedExpansion = true
            }
        }
        .task(id: "\(commands.pending?.requestID ?? ""):active=\(scenePhase == .active)") {
            guard scenePhase == .active, commands.pending != nil else { return }
            for seconds in [0, 1, 2, 4, 8, 16, 30] {
                do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
                guard !Task.isCancelled, commands.pending != nil else { return }
                await commands.reconcile(connection)
            }
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
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let sessionID: String
    let messageImages: PadMessageImageStore
    @State private var confirmForget = false
    @State private var followLatest = true
    @State private var historyViewport = TimelineHistoryViewportState()
    @State private var historyAutoLoadGate = PadHistoryAutoLoadGate()
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
                    } else if workspace.before == nil, !workspace.messages.isEmpty {
                        Text("已显示全部历史消息")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.vertical, 8)
                    }
                    ForEach(workspace.displayEntries) { entry in
                        switch entry.kind {
                        case .message(let message):
                            MobileMessageBubble(message: message, deliveryState: workspace.outgoingStates[message.id],
                                laneWidth: laneWidth, connection: connection, sessionID: sessionID,
                                images: messageImages,
                                openAttachment: { attachmentPreview = PadAttachmentPreview(sessionID: sessionID, image: $0) })
                                .id(message.id)
                        case .process:
                            if let presentation = workspace.processPresentations[entry.id] {
                                PadProcessCard(steps: workspace.processSteps[entry.id] ?? [], presentation: presentation,
                                               laneWidth: laneWidth)
                                    .id(sessionID + ":" + entry.id)
                            }
                        }
                    }
                    Color.clear.frame(height: 1).id("latest")
                        .onAppear { followLatest = true }
                        .onDisappear {
                            followLatest = false
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
            .coordinateSpace(name: timelineCoordinateSpace)
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
                requestEarlierHistoryIfNeeded()
            }
            .onPreferenceChange(TimelineViewportSizeKey.self) { size in
                let roundedWidth = max(0, size.width - 32).rounded(.down)
                if roundedWidth != laneWidth { laneWidth = roundedWidth }
                let roundedHeight = size.height.rounded(.down)
                guard roundedHeight != historyViewport.viewportHeight else { return }
                historyViewport.viewportHeight = roundedHeight
                requestEarlierHistoryIfNeeded()
            }
            .accessibilityIdentifier("conversation-timeline")
            .task {
                let hadCachedCapabilities = workspace.capabilities != nil
                await workspace.load(connection)
                guard !Task.isCancelled else { return }
                if !hadCachedCapabilities || followLatest {
                    reader.scrollTo("latest", anchor: .bottom)
                }
            }
            .onChange(of: workspace.historyRestorationAnchor) { _, anchor in
                if let anchor {
                    reader.scrollTo(anchor, anchor: .top)
                }
            }
            .onChange(of: workspace.messageRevision) {
                if followLatest { reader.scrollTo("latest", anchor: .bottom) }
            }
            .onChange(of: workspace.scrollRequest) {
                followLatest = true
                reader.scrollTo("latest", anchor: .bottom)
            }
            .onChange(of: workspace.before) {
                requestEarlierHistoryIfNeeded()
            }
            .onChange(of: workspace.isLoadingEarlier) { _, isLoading in
                if !isLoading { requestEarlierHistoryIfNeeded() }
            }
            .onChange(of: connection.busy) { _, isBusy in
                if !isBusy { requestEarlierHistoryIfNeeded() }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) { conversationHeader }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
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
    }

    private var timelineCoordinateSpace: String {
        "conversation-timeline-\(sessionID)"
    }

    private func requestEarlierHistoryIfNeeded() {
        let viewportReady = historyViewport.contentHeight > 0 && historyViewport.viewportHeight > 1
        let underfilled = viewportReady
            && historyViewport.contentHeight <= historyViewport.viewportHeight + 0.5
        guard historyAutoLoadGate.requestCursor(
            before: workspace.before,
            nearTop: historyViewport.nearTop,
            underfilled: underfilled,
            allowsNearTopRequest: !followLatest,
            isLoading: workspace.isLoadingEarlier,
            connectionBusy: connection.busy
        ) != nil else { return }
        Task { await workspace.loadEarlierMessagesIfNeeded(connection) }
    }

    private var conversationHeader: some View {
        HStack(spacing: 8) {
            PadThreadMetaView(session: workspace.sessionsByID[sessionID],
                              capabilities: workspace.capabilities, usage: workspace.usage)
            Spacer(minLength: 0)
            let session = workspace.sessionsByID[sessionID]
            let isRunning = SessionExecutionState(executionStatus: session?.executionStatus) == .running
                || SessionExecutionState(executionStatus: workspace.executionByTaskID[session?.taskId ?? ""]) == .running
            let canStop = isRunning && workspace.capabilities?.stop.available == true
            if canStop {
                Button {
                    Task { await workspace.command(connection, stop: true) }
                } label: {
                    Image(systemName: "stop.fill")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.red)
                        .frame(width: 28, height: 28)
                        .padGlassSurface(in: Circle(), interactive: true)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(connection.busy || workspace.pending != nil)
                .accessibilityLabel("停止当前运行")
                .accessibilityIdentifier("conversation-stop")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
        .background(alignment: .top) {
            Rectangle()
                .fill(.ultraThinMaterial)
                .mask {
                    LinearGradient(
                        colors: [.black, .black.opacity(0.72), .clear],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                }
                .frame(height: 72)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
        }
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
                        scheduleMessage: { composerSheet = .schedule })
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
    }

    private func slashCommandPrefix(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), !trimmed.contains(where: { $0.isWhitespace }) else { return nil }
        return String(trimmed.dropFirst())
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
    @State private var expanded = false
    private var state: ConversationProcessState { presentation.state }
    private var cardWidth: CGFloat {
        let availableLane = laneWidth > 0 ? laneWidth : MessageBubbleWidthPolicy.maximumWidth
        let summaryWidth = ceil((presentation.summary as NSString).size(withAttributes: [
            .font: UIFont.systemFont(ofSize: 10.5, weight: .medium)
        ]).width)
        return MessageBubbleWidthPolicy.processCardWidth(
            summaryWidth: summaryWidth,
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
        ProcessCard(summary: presentation.summary,
                    symbol: state.symbolName, tint: tint, expanded: expanded,
                    toggle: { expanded.toggle() }) {
            PadMessageText(text: "", fromUser: false, steps: steps)
                .frame(maxWidth: .infinity)
        }
        .frame(width: cardWidth, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("conversation-process")
    }
}

private struct TimelineHistoryViewportState: Equatable {
    var nearTop = false
    var contentHeight: CGFloat = 0
    var viewportHeight: CGFloat = 0
}

private struct TimelineNearTopKey: PreferenceKey {
    static let defaultValue = false
    static func reduce(value: inout Bool, nextValue: () -> Bool) {
        value = value || nextValue()
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

struct PadAttachmentPreview: Identifiable {
    let sessionID: String
    let image: ClientMessageImage
    var id: String { sessionID + "\u{0}" + image.managedPath }
}

/// Ordinary text message. Card geometry (`MessageBubbleWidthPolicy`), the attachment
/// strip and the timestamp + copy action bar are the macOS row; only text
/// measurement (UIKit) and the always-visible action bar (no hover) differ.
private struct MobileMessageBubble: View {
    let message: ClientMessage
    var deliveryState: String? = nil
    let laneWidth: CGFloat
    let connection: PadConnection
    let sessionID: String
    let images: PadMessageImageStore
    let openAttachment: (ClientMessageImage) -> Void

    private var fromUser: Bool { message.type == "userMessage" }
    private var displayText: String { message.text.isEmpty && message.images.isEmpty ? "此消息类型暂不支持展示" : message.text }
    private var attachments: ArraySlice<ClientMessageImage> { message.images.prefix(MessageImageStripMetrics.maximumCount) }
    private var processingLabel: String? {
        guard fromUser else { return nil }
        switch UserMessageProcessingState(authoritativeValue: message.userMessageStatus, legacyStatus: message.status) {
        case .queued: return message.queuePosition.map { "Queued · \($0)" } ?? "Queued"
        case .processing: return "Processing"
        case .failed: return "Processing failed"
        case .cancelled: return "Cancelled"
        case .consumed: return nil
        case .none: return deliveryState
        }
    }
    private var cardWidth: CGFloat {
        let availableLane = laneWidth > 0 ? laneWidth : MessageBubbleWidthPolicy.maximumWidth
        return MessageBubbleWidthPolicy.cardWidth(
            bodyWidth: PadMessageLayout.bodyWidth(text: displayText, style: fromUser ? .user : .agent),
            hasAttachments: !attachments.isEmpty, laneWidth: availableLane)
    }

    var body: some View {
        HStack(alignment: .bottom, spacing: 0) {
            if fromUser { Spacer(minLength: 0) }
            VStack(alignment: fromUser ? .trailing : .leading, spacing: 5) {
                if let processingLabel {
                    Text(processingLabel).font(.caption2).foregroundStyle(.secondary)
                        .accessibilityIdentifier("message-processing-state")
                }
                MessageTextCard(messageID: message.id, role: fromUser ? .user : .agent,
                    timestamp: ConversationTimestampText.messageLabel(createdAt: message.createdAt),
                    showsActions: true, actionsAlwaysVisible: true, cardWidth: cardWidth,
                    copy: { UIPasteboard.general.string = message.text }) {
                        VStack(alignment: .leading, spacing: MessageImageStripMetrics.bottomSpacing) {
                            if !attachments.isEmpty { attachmentStrip }
                            if !displayText.isEmpty {
                                PadMessageText(text: displayText, fromUser: fromUser)
                                    .frame(maxWidth: .infinity, alignment: .leading)
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
