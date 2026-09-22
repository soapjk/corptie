import SwiftUI
import CorptieClientCore
import CorptieConversation

@main
struct CorptiePadApp: App {
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
    @State private var initializedExpansion = false
    @State private var taskCreationRoute: PadTaskCreationRoute?
    @State private var taskCreationStates: [String: PadTaskCreationState] = [:]
    @State private var columnVisibility = NavigationSplitViewVisibility.all
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            List(selection: $workspace.selection) {
                ForEach(workspace.works) { work in
                    workCard(work)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 3, leading: 6, bottom: 3, trailing: 6))
                }
                let independentSessions = workspace.sessions.filter { $0.workId == nil }
                if !independentSessions.isEmpty {
                    Section("聊天") {
                    ForEach(independentSessions) { session in
                        NavigationLink(value: session.id) { ExecutionLabel(title: session.title, status: session.executionStatus) }
                            .tag(session.id)
                    }
                    }
                }
                if workspace.workCursor != nil || workspace.taskCursor != nil || workspace.sessionCursor != nil {
                    Button("加载更多 Work / Task / 会话") { Task { await workspace.inventory(connection, more: true) } }
                }
            }
            .disabled(connection.busy)
            .listStyle(.sidebar)
            .safeAreaInset(edge: .top, spacing: 0) {
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
            .toolbar(.hidden, for: .navigationBar)
        } detail: {
            if let id = workspace.selection {
                ConversationView(connection: connection, workspace: workspace, sessionID: id,
                    toggleSidebar: { columnVisibility = columnVisibility == .detailOnly ? .all : .detailOnly })
                    .id(id)
            } else {
                ContentUnavailableView("选择一个 Task 或会话", systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("消息与状态自动更新。"))
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .onChange(of: workspace.selection) {
            if workspace.selection == nil { columnVisibility = .all }
        }
        .sheet(item: $taskCreationRoute) { route in
            PadTaskCreationSheet(route: route, connection: connection, workspace: workspace, state: route.state)
        }
        .onChange(of: workspace.works.map(\.id), initial: true) { _, ids in
            if !initializedExpansion, !ids.isEmpty {
                expandedWorkIDs = Set(ids)
                initializedExpansion = true
            }
        }
    }

    private func expansion(for workID: String) -> Binding<Bool> {
        Binding(get: { expandedWorkIDs.contains(workID) }, set: { expanded in
            withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
                if expanded { expandedWorkIDs.insert(workID) } else { expandedWorkIDs.remove(workID) }
            }
        })
    }

    private func workCard(_ work: ClientWork) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Button {
                    expansion(for: work.id).wrappedValue.toggle()
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: expandedWorkIDs.contains(work.id) ? "chevron.down" : "chevron.right")
                            .font(.system(size: 9, weight: .semibold)).frame(width: 18)
                        ConsoleWorkTitle(title: work.name,
                            isWorking: workspace.processingWorkIDs.contains(work.id),
                            isActive: scenePhase == .active)
                            .font(.system(size: 11, weight: .semibold)).lineLimit(1)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(expandedWorkIDs.contains(work.id) ? "已展开" : "已折叠")
                ForEach(workspace.discussionsByWork[work.id] ?? []) { discussion in
                    WorkDiscussionButton(isSelected: workspace.selection == discussion.id,
                        isRunning: SessionExecutionState(executionStatus: discussion.executionStatus) == .running,
                        isActive: scenePhase == .active,
                        accessibilityState: workspace.selection == discussion.id ? "已选中" : "",
                        minimumHitHeight: 44) {
                            workspace.selection = discussion.id
                        }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("work-discussion-\(discussion.id)")
                }
                Spacer(minLength: 0)
                Button("创建 Task", systemImage: "plus") { openTaskCreation(work) }
                    .labelStyle(.iconOnly).buttonStyle(.plain)
                    .frame(width: 44, height: 44)
                    .accessibilityIdentifier("work-create-task-\(work.id)")
            }
            if expandedWorkIDs.contains(work.id) {
                ForEach(workspace.tasksByWork[work.id] ?? []) { task in
                    let sessionID = workspace.sessionIDByTaskID[task.id]
                    let available = sessionID.map { !workspace.sessionIsKnownUnavailable($0) } ?? false
                    Button {
                        workspace.selection = sessionID
                    } label: {
                        HStack {
                            ExecutionLabel(title: task.title,
                                status: workspace.executionByTaskID[task.id] ?? task.executionStatus,
                                activity: workspace.activityByTaskID[task.id], lifecycleState: task.lifecycleState)
                            Spacer(minLength: 0)
                            if !available { Text("会话不可用").font(.caption2).foregroundStyle(.tertiary) }
                        }
                        .padding(.horizontal, 6).frame(minHeight: 44)
                        .background(workspace.selection != nil && workspace.selection == sessionID
                            ? Color.accentColor.opacity(0.13) : Color.clear,
                            in: RoundedRectangle(cornerRadius: 6))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!available)
                    .padding(.leading, ConsoleWorkOutlineMetrics.childIndent)
                    .accessibilityIdentifier("work-task-\(task.id)")
                }
            }
        }
        .modifier(WorkGroupCardSurface())
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
    let toggleSidebar: () -> Void
    @FocusState private var focused: Bool
    @State private var confirmForget = false
    @State private var followLatest = true
    @State private var expandedComposer = false
    @State private var composerSheet: ComposerSheet?
    private enum ComposerSheet: String, Identifiable { case schedule; var id: String { rawValue } }
    private var draft: Binding<String> {
        Binding(get: { workspace.drafts[sessionID] ?? "" }, set: { workspace.drafts[sessionID] = $0 })
    }
    var body: some View {
        ScrollViewReader { reader in
            VStack(spacing: 0) {
                if let session = workspace.sessionsByID[sessionID],
                   let state = SessionExecutionState(executionStatus: session.executionStatus) {
                    HStack(spacing: 8) {
                        SessionExecutionStatusText(state: state)
                        if let activity = session.activityStatus, !activity.isEmpty {
                            ActivityStatusText(text: activity, isActive: state == .running)
                                .layoutPriority(-1)
                        }
                    }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 16).padding(.top, 4)
                        .accessibilityIdentifier("conversation-execution-state")
                }
                ScrollView {
                    LazyVStack(spacing: 12) {
                        if workspace.before != nil {
                            Button("加载更早消息") { Task { await workspace.load(connection, older: true) } }
                                .buttonStyle(.bordered).disabled(connection.busy)
                        }
                        ForEach(workspace.displayEntries) { entry in
                            switch entry.kind {
                            case .message(let message):
                                MobileMessageBubble(message: message, deliveryState: workspace.outgoingStates[message.id]).id(message.id)
                            case .process:
                                if let presentation = workspace.processPresentations[entry.id] {
                                    PadProcessCard(steps: workspace.processSteps[entry.id] ?? [], presentation: presentation).id(sessionID + ":" + entry.id)
                                }
                            }
                        }
                        Color.clear.frame(height: 1).id("latest")
                            .onAppear { followLatest = true }
                            .onDisappear { followLatest = false }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                .accessibilityIdentifier("conversation-timeline")
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { composer }
            .background(Color(uiColor: .systemGroupedBackground))
            .toolbar(.hidden, for: .navigationBar)
            .task {
                guard workspace.capabilities == nil else { return }
                await workspace.load(connection)
                guard !Task.isCancelled else { return }
                reader.scrollTo("latest", anchor: .bottom)
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
            HStack(alignment: .bottom, spacing: 10) {
                TextField("发送指令…", text: draft, axis: .vertical).lineLimit(1...(expandedComposer ? 12 : 6))
                    .accessibilityIdentifier("conversation-composer-input")
                    .padding(.horizontal, 13).padding(.vertical, 10)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .focused($focused)
                    .disabled(connection.busy || workspace.pending != nil)
                Button("发送", systemImage: "paperplane.fill") {
                    Task { await workspace.command(connection, stop: false) }
                }
                .labelStyle(.iconOnly).font(.title2)
                .keyboardShortcut(.return, modifiers: .command)
                .accessibilityIdentifier("conversation-composer-send")
                .frame(minWidth: 44, minHeight: 44)
                .disabled(connection.busy || workspace.pending != nil || workspace.capabilities?.send.available != true
                    || workspace.importingImagesForSession == sessionID
                    || (draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        && (workspace.draftImages[sessionID] ?? []).isEmpty)
                    || draft.wrappedValue.utf16.count > 16000)
            }
            HStack {
                Button("显示或隐藏侧栏", systemImage: "sidebar.left") { toggleSidebar() }
                    .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("workspace-toggle-sidebar")
                Button("停止", systemImage: "stop.circle.fill") { Task { await workspace.command(connection, stop: true) } }
                    .labelStyle(.iconOnly).frame(minWidth: 44, minHeight: 44)
                    .disabled(connection.busy || workspace.pending != nil || workspace.capabilities?.stop.available != true)
                    .accessibilityIdentifier("conversation-stop")
                PadComposerExtras(workspace: workspace, sessionID: sessionID,
                    disabled: connection.busy || workspace.pending != nil)
                Menu {
                    Button("创建定时消息", systemImage: "clock.badge.plus") { composerSheet = .schedule }
                        .disabled(workspace.capabilities?.scheduleMessage != true || workspace.pending != nil
                            || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || !(workspace.draftImages[sessionID] ?? []).isEmpty
                            || !(workspace.draftMentions[sessionID] ?? []).isEmpty)
                    Button(expandedComposer ? "收起编辑区" : "展开编辑区",
                           systemImage: expandedComposer ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") {
                        expandedComposer.toggle()
                    }
                    Text("Return 换行，⌘ Return 发送")
                } label: {
                    Image(systemName: "ellipsis").frame(minWidth: 44, minHeight: 44)
                }
                .accessibilityLabel("输入选项")
                Spacer()
                modelMenu
            }
        }
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8).background(.bar)
    }

    private var modelMenu: some View {
        Menu {
            if let config = workspace.composerConfiguration {
                ForEach(config.models) { model in
                    Button {
                        Task { await workspace.configureComposer(connection, update: ["model": model.id]) }
                    } label: {
                        if model.id == config.currentModel { Label(model.name, systemImage: "checkmark") }
                        else { Text(model.name) }
                    }.disabled(!config.switchModel.available)
                }
                let model = config.models.first { $0.id == config.currentModel }
                if config.switchReasoning.available {
                    Menu("推理强度", systemImage: "brain") {
                        ForEach(model?.reasoningLevels ?? [], id: \.self) { level in
                            Button {
                                Task { await workspace.configureComposer(connection, update: ["reasoningLevel": level]) }
                            } label: {
                                if level == config.currentReasoningLevel { Label(level, systemImage: "checkmark") }
                                else { Text(level) }
                            }
                        }
                    }
                }
            } else if workspace.capabilities?.composer != true {
                Text("当前 Mac 后端未提供移动端模型配置接口，需要更新后端。")
            }
            Button("重新加载模型", systemImage: "arrow.clockwise") {
                Task { await workspace.configureComposer(connection) }
            }.disabled(workspace.capabilities?.composer != true)
        } label: {
            HStack(spacing: 6) {
                if workspace.configuringComposer { ProgressView().controlSize(.small) }
                Text(workspace.composerConfiguration?.currentModel ?? "模型")
                if let level = workspace.composerConfiguration?.currentReasoningLevel {
                    Text(level).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.down").font(.caption2)
            }
            .font(.caption).lineLimit(1).frame(minHeight: 44)
        }
        .disabled(workspace.configuringComposer)
        .accessibilityIdentifier("conversation-composer-model")
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
        ProcessCard(summary: presentation.summary,
                    symbol: state.symbolName, tint: tint, expanded: expanded,
                    toggle: { expanded.toggle() }) {
            PadMessageText(text: "", fromUser: false, steps: steps)
                .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("conversation-process")
    }
}

private struct MobileMessageBubble: View {
    let message: ClientMessage
    var deliveryState: String? = nil
    private var fromUser: Bool { message.type == "userMessage" }
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
    var body: some View {
        HStack(alignment: .bottom) {
            if fromUser { Spacer(minLength: 54) }
            VStack(alignment: .leading, spacing: 5) {
                if let processingLabel {
                    Text(processingLabel).font(.caption2).foregroundStyle(.secondary)
                        .accessibilityIdentifier("message-processing-state")
                }
                MessageTextCard(messageID: message.id, role: fromUser ? .user : .agent,
                    timestamp: "", showsActions: true, actionsAlwaysVisible: true,
                    copy: { UIPasteboard.general.string = message.text }) {
                        PadMessageText(text: message.text.isEmpty ? "此消息类型暂不支持展示" : message.text,
                            fromUser: fromUser)
                            .frame(maxWidth: .infinity)
                    }
            }
            if !fromUser { Spacer(minLength: 54) }
        }.frame(maxWidth: .infinity)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("conversation-message")
    }
}

private struct ExecutionLabel: View {
    let title: String
    let status: String
    var activity: TaskSessionActivity? = nil
    var lifecycleState = ""
    private var resolved: TaskSessionActivity {
        activity ?? .resolve(hasBinding: true, sessionExecutionStatus: status, taskExecutionStatus: nil)
    }
    var body: some View {
        HStack(spacing: 9) {
            TaskActivityIndicator(activity: resolved, lifecycleState: lifecycleState)
            Text(title).font(.system(size: 12, weight: .semibold)).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(resolved.labelKey)
    }
}

#Preview { PairingView(connection: PadConnection()) }
