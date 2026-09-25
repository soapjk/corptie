import SwiftUI
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
    let settings: () -> Void
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
    @State private var confirmDeleteTask: ClientTask?
    @State private var confirmDeleteWork: ClientWork?
    @Environment(\.scenePhase) private var scenePhase

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
                    switch route {
                    case .deleteTask(let task): confirmDeleteTask = task
                    case .deleteWork(let work): confirmDeleteWork = work
                    default: entityRoute = route
                    }
                })
            .disabled(connection.busy)
            .safeAreaInset(edge: .top, spacing: 0) {
                VStack(spacing: 4) {
                    if !commands.notice.isEmpty {
                        Text(commands.notice)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 16)
                    }
                    HStack(spacing: 8) {
                        Button("设置", systemImage: "gearshape") { settings() }
                            .accessibilityIdentifier("workspace-settings")
                        Spacer()
                        Button("刷新列表", systemImage: "arrow.clockwise") { Task { await workspace.inventory(connection) } }
                            .disabled(connection.busy)
                            .accessibilityIdentifier("workspace-refresh")
                    }
                    .labelStyle(.iconOnly).buttonStyle(.borderless)
                    .controlSize(.large)
                    .padding(.horizontal, 16).padding(.vertical, 6)
                }
                .background {
                    Rectangle()
                        .fill(.ultraThinMaterial)
                        .ignoresSafeArea(edges: .top)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .ignoresSafeArea(.container, edges: .top)
        } detail: {
            if let id = workspace.selection {
                ConversationView(connection: connection, workspace: workspace, sessionID: id,
                    messageImages: messageImages,
                    toggleSidebar: { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly })
                    .id(id)
            } else {
                ContentUnavailableView("选择一个 Task 或会话", systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("消息与状态自动更新。"))
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .ignoresSafeArea(.container, edges: .top)
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
            default:
                EmptyView()
            }
        }
        .confirmationDialog(
            "确定删除 Task「\(confirmDeleteTask?.title ?? "")」？",
            isPresented: Binding(get: { confirmDeleteTask != nil }, set: { if !$0 { confirmDeleteTask = nil } }),
            titleVisibility: .visible
        ) {
            if let task = confirmDeleteTask {
                Button("删除 Task", role: .destructive) {
                    Task {
                        _ = await commands.run(connection, target: .task(task.id), kind: "task_delete", label: "删除 Task") { api, requestID in
                            var req = ClientTaskDeletion(requestId: requestID)
                            req.mode = "safe"
                            return try await api.taskCommand(taskId: task.id, command: .delete, body: req)
                        }
                        await workspace.inventory(connection)
                    }
                }
            }
            Button("取消", role: .cancel) { confirmDeleteTask = nil }
        }
        .confirmationDialog(
            "确定删除 Work「\(confirmDeleteWork?.name ?? "")」？",
            isPresented: Binding(get: { confirmDeleteWork != nil }, set: { if !$0 { confirmDeleteWork = nil } }),
            titleVisibility: .visible
        ) {
            if let work = confirmDeleteWork {
                Button("删除 Work", role: .destructive) {
                    Task {
                        _ = await commands.run(connection, target: .work(work.id), kind: "work_delete", label: "删除 Work") { api, requestID in
                            try await api.workCommand(workId: work.id, command: .delete, body: ClientEntityRequest(requestId: requestID))
                        }
                        await workspace.inventory(connection)
                    }
                }
            }
            Button("取消", role: .cancel) { confirmDeleteWork = nil }
        }
        .onChange(of: workspace.works.map(\.id), initial: true) { _, ids in
            if !initializedExpansion, !ids.isEmpty {
                expandedWorkIDs = Set(ids)
                initializedExpansion = true
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
    let toggleSidebar: () -> Void
    @State private var confirmForget = false
    @State private var followLatest = true
    /// Content lane inside the timeline's 16pt gutters; one reader for the whole
    /// scroll view so rows never observe geometry themselves.
    @State private var laneWidth: CGFloat = 0
    @State private var attachmentPreview: PadAttachmentPreview?
    @State private var composerSheet: ComposerSheet?
    private enum ComposerSheet: String, Identifiable { case schedule; var id: String { rawValue } }
    private var draft: Binding<String> {
        Binding(get: { workspace.drafts[sessionID] ?? "" }, set: { workspace.drafts[sessionID] = $0 })
    }
    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(spacing: 12) {
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
                    } else if workspace.before != nil {
                        Color.clear.frame(height: 20)
                            .onAppear {
                                if !followLatest && !workspace.isLoadingEarlier {
                                    Task { await workspace.loadEarlierMessagesIfNeeded(connection) }
                                }
                            }
                        Button("加载更早消息") {
                            Task { await workspace.loadEarlierMessagesIfNeeded(connection) }
                        }
                        .buttonStyle(.plain)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .disabled(connection.busy)
                    } else if !workspace.messages.isEmpty {
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
                                    onSubmitted: { await workspace.load(connection) }).id(message.id)
                            } else if message.type == "choice" || message.type == "approval" {
                                PadApprovalCard(message: message, connection: connection, sessionID: sessionID,
                                    onSubmitted: { await workspace.load(connection) }).id(message.id)
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
                        case .process:
                            if let presentation = workspace.processPresentations[entry.id] {
                                PadProcessCard(steps: workspace.processSteps[entry.id] ?? [], presentation: presentation).id(sessionID + ":" + entry.id)
                            }
                        }
                    }
                    Color.clear.frame(height: 1).id("latest")
                        .onAppear {
                            if #unavailable(iOS 18.0) { followLatest = true }
                        }
                        .onDisappear {
                            if #unavailable(iOS 18.0) { followLatest = false }
                        }
                }
                .padding(.horizontal, 16).padding(.vertical, 12)
            }
            .modifier(TimelineFollowLatestModifier(followLatest: $followLatest))
            .scrollDismissesKeyboard(.interactively)
            .background {
                GeometryReader { proxy in
                    Color.clear.preference(key: TimelineLaneWidthKey.self, value: max(0, proxy.size.width - 32))
                }
            }
            .onPreferenceChange(TimelineLaneWidthKey.self) { width in
                // Whole points only: sub-pixel drift must not re-measure every card.
                let rounded = width.rounded(.down)
                if rounded != laneWidth { laneWidth = rounded }
            }
            .accessibilityIdentifier("conversation-timeline")
            .safeAreaInset(edge: .top, spacing: 0) { conversationHeader }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .ignoresSafeArea(.container, edges: .top)
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
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
    }

    private var conversationHeader: some View {
        HStack(spacing: 8) {
            Button("显示或隐藏侧栏", systemImage: "sidebar.left") { toggleSidebar() }
                .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                .accessibilityIdentifier("workspace-toggle-sidebar")
            PadThreadMetaView(session: workspace.sessionsByID[sessionID],
                              capabilities: workspace.capabilities, usage: workspace.usage)
            Button("停止", systemImage: "stop.circle.fill") { Task { await workspace.command(connection, stop: true) } }
                .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                .disabled(connection.busy || workspace.pending != nil || workspace.capabilities?.stop.available != true)
                .accessibilityIdentifier("conversation-stop")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background {
            Rectangle()
                .fill(.ultraThinMaterial)
                .ignoresSafeArea(edges: .top)
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
                        HStack(spacing: 8) {
                            ForEach(matching) { cmd in
                                Button {
                                    draft.wrappedValue = "/\(cmd.name) "
                                } label: {
                                    HStack(spacing: 4) {
                                        Text("/\(cmd.name)").font(.system(size: 12, weight: .semibold))
                                        Text(cmd.summary).font(.system(size: 11)).foregroundStyle(.secondary)
                                    }
                                    .padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(.quaternary, in: Capsule())
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
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8).background(.ultraThinMaterial)
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
    @State private var expanded = false
    private var latestPlan: ConversationExecutionPlan? { steps.compactMap(\.plan).last }
    private var state: ConversationProcessState { presentation.state }
    private var tint: Color {
        switch state {
        case .running: .accentColor
        case .completed: .green
        case .failed: .red
        case .cancelled: .secondary
        }
    }
    var body: some View {
        ProcessCard(summary: ConversationProcessPresentation(
                        state: presentation.state, count: presentation.count,
                        duration: presentation.duration).summary,
                    secondary: presentation.currentStepTitle,
                    symbol: state.symbolName, tint: tint, expanded: expanded,
                    progress: latestPlan?.completionFraction,
                    progressLabel: latestPlan.flatMap { plan in
                        plan.completionFraction == nil ? nil
                            : "计划 \(plan.steps.filter { $0.status == "completed" }.count)/\(plan.steps.count)"
                    },
                    toggle: { expanded.toggle() }) {
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(steps) { step in
                    PadExecutionStepCard(step: step)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("conversation-process")
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
                    .frame(maxWidth: .infinity)
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

private struct TimelineLaneWidthKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

private struct TimelineFollowLatestModifier: ViewModifier {
    @Binding var followLatest: Bool
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
                        isUserScrolling = true
                        followLatest = Self.isNearBottom(context.geometry)
                    } else if newPhase == .idle && isUserScrolling {
                        followLatest = Self.isNearBottom(context.geometry)
                        isUserScrolling = false
                    }
                }
        } else {
            content
        }
    }

    @available(iOS 18.0, *)
    private static func isNearBottom(_ geometry: ScrollGeometry) -> Bool {
        geometry.visibleRect.maxY >= geometry.contentSize.height - 40
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
                    ForEach(request.questions) { question in
                        VStack(alignment: .leading, spacing: 6) {
                            if !question.header.isEmpty {
                                Text(question.header).font(.caption).foregroundStyle(.secondary)
                            }
                            Text(question.question).font(.subheadline)
                            if let options = question.options {
                                ForEach(options, id: \.label) { option in
                                    Button {
                                        var values = selected[question.id, default: []]
                                        if !values.insert(option.label).inserted { values.remove(option.label) }
                                        selected[question.id] = values
                                    } label: {
                                        HStack(alignment: .top, spacing: 8) {
                                            Image(systemName: selected[question.id, default: []].contains(option.label)
                                                ? "checkmark.circle.fill" : "circle")
                                            VStack(alignment: .leading, spacing: 2) {
                                                Text(option.label)
                                                if !option.description.isEmpty {
                                                    Text(option.description).font(.caption).foregroundStyle(.secondary)
                                                }
                                            }
                                            Spacer(minLength: 0)
                                        }
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("user-input-option-\(question.id)-\(option.label)")
                                }
                                if question.isOther {
                                    TextField("其他答案", text: textBinding(question.id))
                                        .textFieldStyle(.roundedBorder)
                                }
                            } else if question.isSecret {
                                SecureField("输入答案", text: textBinding(question.id))
                                    .textFieldStyle(.roundedBorder)
                            } else {
                                TextField("输入答案", text: textBinding(question.id), axis: .vertical)
                                    .lineLimit(1...4)
                                    .textFieldStyle(.roundedBorder)
                            }
                        }
                    }
                    Button("提交答案") { Task { await submit(request) } }
                        .buttonStyle(.borderedProminent)
                        .disabled(submitting || answers(for: request) == nil)
                        .accessibilityIdentifier("user-input-submit")
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

    private func textBinding(_ id: String) -> Binding<String> {
        Binding(get: { typed[id] ?? "" }, set: { typed[id] = $0 })
    }

    private func answers(for request: ConversationUserInput) -> [String: [String]]? {
        var result: [String: [String]] = [:]
        for question in request.questions {
            let entered = (typed[question.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            var values = question.options?.compactMap { option in
                selected[question.id, default: []].contains(option.label) ? option.label : nil
            } ?? []
            if !entered.isEmpty { values.append(entered) }
            guard !values.isEmpty, values.count <= 12,
                  values.allSatisfy({ $0.count <= 4_000 }) else { return nil }
            result[question.id] = values
        }
        return result
    }

    private func submit(_ request: ConversationUserInput) async {
        guard !submitting, !submitted, let answers = answers(for: request) else { return }
        submitting = true
        errorText = nil
        defer { submitting = false }
        do {
            let api = ClientSessionAPI(transport: try await connection.transport())
            let response = try await api.respondToUserInput(sessionId: sessionID, itemId: message.id, answers: answers)
            guard response.status == "submitted" else { return }
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
    private var cardWidth: CGFloat? {
        guard laneWidth > 0 else { return nil }
        return MessageBubbleWidthPolicy.cardWidth(
            bodyWidth: PadMessageLayout.bodyWidth(text: displayText, style: fromUser ? .user : .agent),
            hasAttachments: !attachments.isEmpty || !suggestedReplies.isEmpty, laneWidth: laneWidth)
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
