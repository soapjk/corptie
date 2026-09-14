import SwiftUI
import CorptieClientCore

@main
struct CorptiePadApp: App {
    @State private var connection = PadConnection()
    var body: some Scene {
        WindowGroup {
            if connection.connected {
                PadAppShell(connection: connection)
            } else {
                PairingView(connection: connection)
            }
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
                Section("你的 Mac") {
                    TextField("HTTPS 地址（含端口）", text: $connection.address)
                        .keyboardType(.URL)
                    TextField("Server ID（来自 Mac）", text: $connection.serverID)
                    Button("连接已配对的 Mac") { Task { await connection.reconnect() } }
                }
                .disabled(connection.claim != nil)
                Section("首次配对") {
                    TextField("Pairing ID", text: $connection.pairingID)
                        .disabled(connection.claim != nil)
                    SecureField("配对密钥", text: $connection.secret)
                        .disabled(connection.claim != nil)
                    if connection.claim != nil {
                        Button("Mac 已批准，完成配对") { Task { await connection.finishPairing() } }
                        Button("重新填写配对信息") { connection.claim = nil }
                    } else {
                        Button("请求配对") { Task { await connection.requestPairing() } }
                            .disabled(connection.pairingID.isEmpty || connection.secret.isEmpty)
                    }
                }
                Section {
                    Text("需要 Mac 已开启 HTTPS 接入，并使用此设备信任的证书。不接受跳过证书校验。设备默认只读，额外页面与消息操作需在 Mac 上授权。")
                        .font(.footnote).foregroundStyle(.secondary)
                    if !connection.notice.isEmpty { Text(connection.notice).font(.callout) }
                    if connection.busy { ProgressView("连接中") }
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .disabled(connection.busy)
            .navigationTitle("连接 Corptie")
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
    var body: some View {
        NavigationSplitView {
            List(selection: $workspace.selection) {
                ForEach(workspace.works) { work in
                    Section(work.name) {
                        ForEach(workspace.tasksByWork[work.id] ?? []) { task in
                            if let sessionID = task.currentSessionId {
                                NavigationLink(value: sessionID) { ExecutionLabel(title: task.title, status: task.executionStatus) }
                            } else {
                                Label(task.title, systemImage: "checklist").foregroundStyle(.secondary)
                            }
                        }
                        ForEach(workspace.discussionsByWork[work.id] ?? []) { session in
                            NavigationLink(value: session.id) { ExecutionLabel(title: "讨论", status: session.executionStatus) }
                        }
                    }
                }
                Section("会话 · 已加载") {
                    ForEach(workspace.sessions) { session in
                        NavigationLink(value: session.id) { ExecutionLabel(title: session.title, status: session.executionStatus) }
                    }
                }
                if workspace.workCursor != nil || workspace.taskCursor != nil || workspace.sessionCursor != nil {
                    Button("加载更多 Work / Task / 会话") { Task { await workspace.inventory(connection, more: true) } }
                }
            }
            .disabled(connection.busy)
            .navigationTitle("工作台")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("设置", systemImage: "gearshape") { settings() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("刷新列表", systemImage: "arrow.clockwise") { Task { await workspace.inventory(connection) } }
                        .disabled(connection.busy)
                }
            }
        } detail: {
            if let id = workspace.selection {
                ConversationView(connection: connection, workspace: workspace, sessionID: id)
                    .id(id)
            } else {
                ContentUnavailableView("选择一个 Task 或会话", systemImage: "bubble.left.and.text.bubble.right",
                    description: Text("消息与状态自动更新；第一版暂不支持图片。"))
            }
        }
        .safeAreaInset(edge: .top) {
            if connection.busy { ProgressView().accessibilityLabel("正在加载") }
            if !connection.notice.isEmpty {
                Text(connection.notice).font(.footnote).padding(8).frame(maxWidth: .infinity)
                    .background(.regularMaterial)
            }
        }
    }
}

struct ConversationView: View {
    let connection: PadConnection
    @Bindable var workspace: PadWorkspace
    let sessionID: String
    @FocusState private var focused: Bool
    @State private var confirmForget = false
    @State private var followLatest = true
    private var draft: Binding<String> {
        Binding(get: { workspace.drafts[sessionID] ?? "" }, set: { workspace.drafts[sessionID] = $0 })
    }
    var body: some View {
        ScrollViewReader { reader in
            List {
                if workspace.before != nil {
                    Button("加载更早消息") { Task { await workspace.load(connection, older: true) } }
                        .disabled(connection.busy)
                }
                ForEach(workspace.messages) { message in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(message.type == "userMessage" ? "你" : "会话消息")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(message.text.isEmpty ? "此消息类型暂不支持展示" : message.text)
                            .textSelection(.enabled)
                    }
                    .padding(.vertical, 4)
                    .id(message.id)
                }
                Color.clear.frame(height: 1).id("latest")
                    .onAppear { followLatest = true }
                    .onDisappear { followLatest = false }
            }
            .listStyle(.plain)
            .safeAreaInset(edge: .bottom) { composer }
            .navigationTitle(workspace.sessionsByID[sessionID]?.title ?? "Task 会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button("停止", systemImage: "stop.circle.fill") { Task { await workspace.command(connection, stop: true) } }
                        .disabled(connection.busy || workspace.pending != nil || workspace.capabilities?.stop.available != true)
                    Button("刷新消息", systemImage: "arrow.clockwise") { Task { await workspace.load(connection) } }
                        .disabled(connection.busy)
                    Button("最新消息", systemImage: "arrow.down.to.line") {
                        followLatest = true
                        reader.scrollTo("latest", anchor: .bottom)
                    }
                }
            }
            .task {
                guard workspace.capabilities == nil else { return }
                await workspace.load(connection)
                guard !Task.isCancelled else { return }
                reader.scrollTo("latest", anchor: .bottom)
                focused = workspace.capabilities?.send.available == true
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
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(workspace.liveStatus).font(.caption).foregroundStyle(.secondary)
            if !workspace.status.isEmpty { Text(workspace.status).font(.caption) }
            if let pending = workspace.pending {
                Text("有待核对的\(pending.kind == "send" ? "发送" : "停止")请求：\(pending.sessionID)")
                    .font(.caption).textSelection(.enabled)
                HStack {
                    Button("查询回执") { Task { await workspace.reconcile(connection) } }
                        .disabled(connection.busy || pending.serverID != connection.serverID || pending.address != connection.address)
                    Button("已人工核对…") { confirmForget = true }.disabled(connection.busy)
                }
            }
            HStack(alignment: .bottom) {
                TextField("消息", text: draft, axis: .vertical).lineLimit(1...6)
                    .textFieldStyle(.roundedBorder).focused($focused)
                    .disabled(connection.busy)
                Button("发送", systemImage: "arrow.up.circle.fill") {
                    Task { await workspace.command(connection, stop: false) }
                }
                .labelStyle(.iconOnly).font(.title2)
                .frame(minWidth: 44, minHeight: 44)
                .disabled(connection.busy || workspace.pending != nil || workspace.capabilities?.send.available != true
                    || draft.wrappedValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || draft.wrappedValue.utf16.count > 16000)
            }
        }
        .padding().background(.bar)
    }
}

private struct ExecutionLabel: View {
    let title: String
    let status: String
    var body: some View {
        HStack {
            Circle().fill(["running", "working", "processing"].contains(status) ? Color.green : Color.secondary)
                .frame(width: 7, height: 7).accessibilityHidden(true)
            Text(title)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(status)
    }
}

#Preview { PairingView(connection: PadConnection()) }
