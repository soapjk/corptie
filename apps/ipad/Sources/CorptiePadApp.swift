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
                    Text("在 Mac 点击开启设备接入即可。扫码会验证 Mac 的证书，无需安装系统证书；请允许局域网访问。批准后会直接开启移动端当前支持的全部功能。")
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
    var body: some View {
        NavigationSplitView {
            List(selection: $workspace.selection) {
                ForEach(workspace.works) { work in
                    DisclosureGroup(isExpanded: expansion(for: work.id)) {
                        ForEach(workspace.tasksByWork[work.id] ?? []) { task in
                            if let sessionID = task.currentSessionId, !workspace.sessionIsKnownUnavailable(sessionID) {
                                NavigationLink(value: sessionID) { ExecutionLabel(title: task.title, status: task.executionStatus) }
                            } else {
                                HStack {
                                    ExecutionLabel(title: task.title, status: task.executionStatus)
                                    Spacer()
                                    Text("会话不可用").font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                        }
                        ForEach(workspace.discussionsByWork[work.id] ?? []) { session in
                            NavigationLink(value: session.id) { ExecutionLabel(title: "讨论", status: session.executionStatus) }
                        }
                    } label: {
                        Label(work.name, systemImage: "shippingbox.fill")
                            .font(.headline).contentShape(Rectangle())
                    }
                }
                let independentSessions = workspace.sessions.filter { $0.workId == nil }
                if !independentSessions.isEmpty {
                    Section("聊天") {
                    ForEach(independentSessions) { session in
                        NavigationLink(value: session.id) { ExecutionLabel(title: session.title, status: session.executionStatus) }
                    }
                    }
                }
                if workspace.workCursor != nil || workspace.taskCursor != nil || workspace.sessionCursor != nil {
                    Button("加载更多 Work / Task / 会话") { Task { await workspace.inventory(connection, more: true) } }
                }
            }
            .disabled(connection.busy)
            .listStyle(.sidebar)
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
        .onChange(of: workspace.works.map(\.id), initial: true) { _, ids in
            if !initializedExpansion, !ids.isEmpty {
                expandedWorkIDs = Set(ids)
                initializedExpansion = true
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

    private func expansion(for workID: String) -> Binding<Bool> {
        Binding(get: { expandedWorkIDs.contains(workID) }, set: { expanded in
            withAnimation(.snappy(duration: 0.22)) {
                if expanded { expandedWorkIDs.insert(workID) } else { expandedWorkIDs.remove(workID) }
            }
        })
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
            VStack(spacing: 0) {
                ScrollView {
                    LazyVStack(spacing: 12) {
                        if workspace.before != nil {
                            Button("加载更早消息") { Task { await workspace.load(connection, older: true) } }
                                .buttonStyle(.bordered).disabled(connection.busy)
                        }
                        ForEach(workspace.messages) { message in
                            MobileMessageBubble(message: message).id(message.id)
                        }
                        Color.clear.frame(height: 1).id("latest")
                            .onAppear { followLatest = true }
                            .onDisappear { followLatest = false }
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                }
                .scrollDismissesKeyboard(.interactively)
                Divider()
                composer
            }
            .background(Color(uiColor: .systemGroupedBackground))
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
        VStack(alignment: .leading, spacing: 6) {
            if !workspace.status.isEmpty { Text(workspace.status).font(.caption).foregroundStyle(.secondary) }
            if let pending = workspace.pending {
                Text("有待核对的\(pending.kind == "send" ? "发送" : "停止")请求：\(pending.sessionID)")
                    .font(.caption).textSelection(.enabled)
                HStack {
                    Button("查询回执") { Task { await workspace.reconcile(connection) } }
                        .disabled(connection.busy || pending.serverID != connection.serverID || pending.address != connection.address)
                    Button("已人工核对…") { confirmForget = true }.disabled(connection.busy)
                }
            }
            HStack(alignment: .bottom, spacing: 10) {
                TextField("发消息…", text: draft, axis: .vertical).lineLimit(1...6)
                    .padding(.horizontal, 13).padding(.vertical, 10)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .focused($focused)
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
        .padding(.horizontal, 12).padding(.top, 10).padding(.bottom, 8).background(.bar)
    }
}

private struct MobileMessageBubble: View {
    let message: ClientMessage
    private var fromUser: Bool { message.type == "userMessage" }
    var body: some View {
        HStack(alignment: .bottom) {
            if fromUser { Spacer(minLength: 54) }
            VStack(alignment: .leading, spacing: 5) {
                Text(fromUser ? "你" : "Corptie").font(.caption2).foregroundStyle(.secondary)
                Text(message.text.isEmpty ? "此消息类型暂不支持展示" : message.text)
                    .textSelection(.enabled).font(.body)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(fromUser ? Color.accentColor.opacity(0.18) : Color(uiColor: .secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(.separator.opacity(fromUser ? 0 : 0.45), lineWidth: 0.5))
            if !fromUser { Spacer(minLength: 54) }
        }.frame(maxWidth: .infinity)
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
