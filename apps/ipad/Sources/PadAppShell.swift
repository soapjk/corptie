import SwiftUI
import UIKit
import CorptieClientCore
import CorptieConversation
@preconcurrency import UserNotifications

/// Feature state and the single event subscription outlive individual navigation pages.
struct PadAppShell: View {
    @Environment(\.scenePhase) private var scenePhase
    let connection: PadConnection
    @State private var workspace = PadWorkspace()
    @State private var controls = PadControlStore()
    @State private var tab = PadTab.workspace
    @State private var sheet: Sheet?
    @State private var isKeyboardVisible = false
    @State private var compactWorkspaceIsRoot = true
    @State private var compactOpenSessionRequest = 0
    @State private var wasBackgrounded = false
    private let notificationManager = PadNotificationManager.shared
    @AppStorage("corptie.mobile.navigationRailExpanded") private var navigationRailExpanded = true
    private enum Sheet: String, Identifiable { case settings; var id: String { rawValue } }

    private var usesNavigationRail: Bool {
        UIDevice.current.userInterfaceIdiom == .pad
    }

    var body: some View {
        synchronizedContent
    }

    private var appContent: some View {
        HStack(spacing: 0) {
            if usesNavigationRail {
                PadNavigationRail(
                    selection: $tab,
                    isExpanded: $navigationRailExpanded,
                    settings: { sheet = .settings }
                )
                .frame(width: navigationRailExpanded ? 200 : 64)
            }

            ZStack {
                WorkspaceView(connection: connection, workspace: workspace,
                    compactOpenSessionRequest: compactOpenSessionRequest,
                    onCompactRootChange: { compactWorkspaceIsRoot = $0 },
                    onOpenWorktrees: { tab = .worktrees })
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(tab == .workspace ? 1 : 0)
                    .allowsHitTesting(tab == .workspace)
                    .accessibilityHidden(tab != .workspace)
                ForEach([PadTab.automations, .worktrees, .agents]) { page in
                    PadControlView(tab: page, connection: connection, store: controls, openSession: { id in
                        workspace.selection = id
                        compactOpenSessionRequest &+= 1
                        tab = .workspace
                    })
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .opacity(tab == page ? 1 : 0)
                    .allowsHitTesting(tab == page)
                    .accessibilityHidden(tab != page)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !usesNavigationRail, !isKeyboardVisible,
               (tab != .workspace || compactWorkspaceIsRoot) {
                PadBottomTabBar(selection: $tab, settings: { sheet = .settings })
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .background {
            LocalWallpaperCanvas(fallbackColor: tab == .workspace
                ? WorkbenchCanvasSurface.defaultColor
                : Color(uiColor: .systemGroupedBackground))
        }
        .background { PadKeyboardDismissal().frame(width: 0, height: 0) }
        .modifier(PadUnifiedTopScrollEdges(enabled: usesNavigationRail && tab == .workspace))
        .overlay(alignment: .top) {
            if usesNavigationRail, tab == .workspace {
                PadUnifiedStatusBarBackdrop()
            }
        }
        .sheet(item: $sheet) { _ in PadSettingsView(connection: connection, workspace: workspace) }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            guard !usesNavigationRail else { return }
            withAnimation(.easeInOut(duration: 0.2)) { isKeyboardVisible = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            guard !usesNavigationRail else { return }
            withAnimation(.easeInOut(duration: 0.2)) { isKeyboardVisible = false }
        }
        .task(id: scenePhase == .active ? workspace.reconciliationKey(connection) : nil) {
            guard scenePhase == .active else { return }
            await workspace.reconcileAutomatically(connection)
        }
        // One foreground scene owns one resident event stream. Selecting a
        // Task only changes the local timeline projection; it must never tear
        // down the connection and request another bootstrap snapshot.
        .task { await connection.monitorNetwork() }
        .onChange(of: workspace.deliveryKey(connection), initial: true) {
            workspace.scheduleMessageDelivery(connection)
        }
        .task(id: connection.recoveryRevision) {
            guard connection.networkAvailable, connection.recoveryBlockedMessage == nil else {
                workspace.prepareForegroundRealtime()
                return
            }
            controls.activate(tab, connection: connection)
            // Keep the single server-pushed stream resident while the scene is
            // backgrounded. iPadOS may suspend the process, but the client must
            // not voluntarily tear down its only notification data source.
            await workspace.runRealtime(connection)
        }
    }

    private var synchronizedContent: some View {
        appContent
        .onChange(of: scenePhase) {
            workspace.messageDeliverySceneChanged(active: scenePhase == .active, connection: connection)
            if scenePhase == .background { wasBackgrounded = true }
            if scenePhase == .active {
                if wasBackgrounded {
                    wasBackgrounded = false
                    workspace.prepareForegroundRealtime()
                    connection.requestRealtimeRecovery()
                }
                controls.activate(tab, connection: connection)
            }
            else { controls.pause() }
        }
        .onChange(of: tab) { if scenePhase == .active { controls.activate(tab, connection: connection) } }
        .onChange(of: workspace.controlRevision) {
            if let snapshot = workspace.directControlSnapshot { controls.apply(snapshot) }
            else { controls.invalidate(connection) }
        }
        .onChange(of: workspace.sessions) { _, sessions in
            notificationManager.syncSessions(sessions, works: workspace.works, tasks: workspace.tasks)
        }
        .onChange(of: controls.items[.automations] ?? []) { _, automations in
            notificationManager.syncAutomations(
                automations,
                works: workspace.works,
                tasks: workspace.tasks,
                sessions: workspace.sessions
            )
        }
        .onChange(of: workspace.selection) { _, sessionID in
            updateNotificationVisibility(sessionID: sessionID)
        }
        .onChange(of: tab) { _, _ in
            updateNotificationVisibility(sessionID: workspace.selection)
        }
        .onReceive(NotificationCenter.default.publisher(for: .padNotificationNavigationRequested)) { notification in
            navigateFromNotification(notification.userInfo ?? [:])
        }
        .task {
            notificationManager.setScope("\(connection.serverID)|\(connection.address)")
            notificationManager.updateVisibility(
                sessionID: workspace.selection,
                tab: tab,
                sceneIsActive: scenePhase == .active
            )
            notificationManager.syncSessions(workspace.sessions, works: workspace.works, tasks: workspace.tasks)
            notificationManager.syncAutomations(
                controls.items[.automations] ?? [],
                works: workspace.works,
                tasks: workspace.tasks,
                sessions: workspace.sessions
            )
            if let pending = notificationManager.takePendingNavigation() {
                navigateFromNotification(pending)
            }
            await notificationManager.requestAuthorizationIfNeeded()
        }
        .onChange(of: scenePhase) { _, phase in
            notificationManager.updateVisibility(
                sessionID: workspace.selection,
                tab: tab,
                sceneIsActive: phase == .active
            )
        }
        .onDisappear { controls.pause() }
    }

    private func updateNotificationVisibility(sessionID: String?) {
        notificationManager.updateVisibility(
            sessionID: sessionID,
            tab: tab,
            sceneIsActive: scenePhase == .active
        )
    }

    private func navigateFromNotification(_ userInfo: [AnyHashable: Any]) {
        if let sessionID = userInfo["sessionId"] as? String, !sessionID.isEmpty {
            workspace.selection = sessionID
            compactOpenSessionRequest &+= 1
            tab = .workspace
        } else if userInfo["destination"] as? String == "automation" {
            if let automationID = userInfo["automationId"] as? String {
                controls.selections[.automations] = automationID
                controls.routes[.automations] = PadControlSelection(kind: .automations, id: automationID)
            }
            tab = .automations
        } else {
            tab = .workspace
        }
    }
}

/// One stationary backdrop for the entire iPad workspace, not one per column.
private struct PadUnifiedStatusBarBackdrop: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        GeometryReader { geometry in
            let topInset = geometry.safeAreaInsets.top
            let height = PadStatusBarBackdropLayout.height(topInset: topInset)
            Group {
                if reduceTransparency {
                    Rectangle().fill(WorkbenchCanvasSurface.defaultColor)
                } else {
                    Rectangle().fill(.regularMaterial)
                }
            }
            .frame(height: height)
            .mask {
                LinearGradient(stops: [
                    .init(color: .black, location: 0),
                    .init(color: .black, location: PadStatusBarBackdropLayout.solidStop(topInset: topInset)),
                    .init(color: .clear, location: 1)
                ], startPoint: .top, endPoint: .bottom)
            }
            .offset(y: -topInset)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

private struct PadUnifiedTopScrollEdges: ViewModifier {
    let enabled: Bool

    @ViewBuilder func body(content: Content) -> some View {
        if #available(iOS 26.0, *), enabled {
            content.scrollEdgeEffectHidden(true, for: .top)
        } else {
            content
        }
    }
}

private struct PadNavigationRail: View {
    @Binding var selection: PadTab
    @Binding var isExpanded: Bool
    let settings: () -> Void

    var body: some View {
        PlatformNavigationRail(
            items: PadTab.allCases.map {
                PlatformNavigationItem(id: String($0.rawValue), title: $0.title,
                                       symbol: $0.symbol,
                                       accessibilityID: "tab-\($0.rawValue)")
            },
            selectedID: String(selection.rawValue),
            expanded: isExpanded,
            settingsTitle: "设置",
            settingsAccessibilityID: "navigation-settings",
            onSelect: { id in
                if let rawValue = Int(id), let tab = PadTab(rawValue: rawValue) { selection = tab }
            },
            onSettings: settings
        )
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .frame(maxHeight: .infinity)
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(Color.clear)
                .frame(width: 24)
                .contentShape(Rectangle())
                .gesture(
                    DragGesture(minimumDistance: 8)
                        .onEnded { value in
                            let translation = value.translation.width
                            let predicted = value.predictedEndTranslation.width
                            let distance = abs(predicted) > abs(translation) ? predicted : translation
                            if distance <= -32 {
                                isExpanded = false
                            } else if distance >= 32 {
                                isExpanded = true
                            }
                        }
                )
                .accessibilityElement()
                .accessibilityLabel("调整导航栏宽度")
                .accessibilityValue(isExpanded ? "已展开" : "已折叠")
                .accessibilityHint("向左拖动收起，向右拖动展开")
                .accessibilityAction(named: isExpanded ? "收起导航" : "展开导航") {
                    isExpanded.toggle()
                }
                .accessibilityAdjustableAction { direction in
                    switch direction {
                    case .increment: isExpanded = true
                    case .decrement: isExpanded = false
                    @unknown default: break
                    }
                }
                .accessibilityIdentifier("navigation-rail-resizer")
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("navigation-rail")
    }

}

private struct PadBottomTabBar: View {
    @Binding var selection: PadTab
    let settings: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            HStack(spacing: 0) {
                ForEach(PadTab.allCases) { item in
                    let isSelected = selection == item
                    Button {
                        selection = item
                    } label: {
                        compactLabel(symbol: item.symbol, title: item.title, selected: isSelected)
                    }
                    .buttonStyle(PlatformTabButtonStyle())
                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    .accessibilityLabel(item.title)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .accessibilityIdentifier("tab-\(item.rawValue)")
                }
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 4)
            .frame(maxWidth: 360)
            .padGlassSurface(in: Capsule(), interactive: true)

            Button(action: settings) {
                Image(systemName: "gearshape")
                    .font(.system(size: 17, weight: .medium))
                    .frame(width: 50, height: 50)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .padGlassSurface(in: Circle(), interactive: true)
            .accessibilityLabel("设置")
            .accessibilityIdentifier("navigation-settings")
        }
        .frame(maxWidth: 430)
    }

    private func compactLabel(symbol: String, title: String, selected: Bool = false) -> some View {
        VStack(spacing: 3) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: selected ? .semibold : .regular))
            Text(title)
                .font(.system(size: 10, weight: selected ? .semibold : .regular))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, minHeight: 50)
        .contentShape(Rectangle())
    }
}

private enum PadSettingsTab: String, CaseIterable, Hashable, Identifiable {
    case general
    case appearance
    case notifications
    case devices

    var id: String { rawValue }
    var title: String {
        switch self {
        case .general: "通用"
        case .appearance: "外观"
        case .notifications: "通知"
        case .devices: "设备接入"
        }
    }
    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .appearance: "paintpalette"
        case .notifications: "bell"
        case .devices: "ipad.and.iphone"
        }
    }
}

private struct PadSettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let connection: PadConnection
    let workspace: PadWorkspace
    @State private var selectedTab = PadSettingsTab.general

    var body: some View {
        Group {
            if PadSettingsNavigationPolicy.usesStack(isCompactWidth: horizontalSizeClass == .compact) {
                compactSettings
            } else {
                regularSettings
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
    }

    private var compactSettings: some View {
        NavigationStack {
            List(PadSettingsTab.allCases) { tab in
                NavigationLink(value: tab) {
                    Label(tab.title, systemImage: tab.symbol)
                }
                .accessibilityIdentifier("settings.tab.\(tab.rawValue)")
            }
            .navigationTitle("设置")
            .toolbar { doneToolbar }
            .navigationDestination(for: PadSettingsTab.self) { tab in
                settingsDetail(for: tab)
                    .navigationTitle(tab.title)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { doneToolbar }
            }
        }
    }

    private var regularSettings: some View {
        NavigationSplitView {
            List {
                ForEach(PadSettingsTab.allCases) { tab in
                    Button {
                        selectedTab = tab
                    } label: {
                        Label(tab.title, systemImage: tab.symbol)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(selectedTab == tab ? Color.accentColor.opacity(0.12) : Color.clear)
                    .accessibilityIdentifier("settings.tab.\(tab.rawValue)")
                    .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                }
            }
            .navigationTitle("设置")
            .navigationSplitViewColumnWidth(min: 190, ideal: 220, max: 260)
        } detail: {
            NavigationStack {
                settingsDetail(for: selectedTab)
                .navigationTitle(selectedTab.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { doneToolbar }
            }
        }
    }

    @ViewBuilder
    private func settingsDetail(for tab: PadSettingsTab) -> some View {
        switch tab {
        case .general:
            PadGeneralSettingsView(connection: connection, workspace: workspace)
        case .appearance:
            LocalWallpaperSettingsView()
        case .notifications:
            PadNotificationSettingsView()
        case .devices:
            PadDeviceSettingsView(connection: connection, workspace: workspace) {
                dismiss()
            }
        }
    }

    @ToolbarContentBuilder
    private var doneToolbar: some ToolbarContent {
        ToolbarItem(placement: .confirmationAction) {
            Button("完成") { dismiss() }
        }
    }
}

private struct PadGeneralSettingsView: View {
    let connection: PadConnection
    let workspace: PadWorkspace

    var body: some View {
        Form {
            Section {
                LabeledContent("环境", value: "iPadOS Development")
                LabeledContent("服务器", value: connection.serverID)
                LabeledContent("实时同步", value: workspace.liveStatus)
            } header: {
                Text("通用")
            } footer: {
                Text("会话、自动化、Worktree 与 Agent 数据均由已配对的 Mac 通过长连接主动推送。")
            }

        }
    }
}

private struct PadDeviceSettingsView: View {
    let connection: PadConnection
    let workspace: PadWorkspace
    let disconnected: () -> Void
    @State private var cloudRevocation: CloudDevice?

    var body: some View {
        Form {
            Section("连接的 Mac") {
                LabeledContent("连接方式", value: connection.connectedThroughCloud ? "Corptie Cloud · 账号连接" : "局域网连接")
                if connection.connectedThroughCloud, let name = connection.connectedCloudMacName {
                    LabeledContent("当前 Mac", value: name)
                } else {
                    LabeledContent("地址", value: connection.address)
                    LabeledContent("服务器", value: connection.serverID)
                }
                let status = PadServerConnectionStatus.resolve(
                    hasPairing: connection.connected,
                    realtimeConnected: workspace.realtimeConnected,
                    hasInterrupted: workspace.realtimePausedAt != nil
                )
                Label(status == .connected ? workspace.liveStatus : status.title,
                      systemImage: status == .connected ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(workspace.realtimeConnected ? Color.green : Color.secondary)
            }
            if connection.cloudSignedIn {
                Section {
                    ForEach(connection.cloudDevices.filter { $0.kind == .mac && $0.revokedAt == nil }) { mac in
                        Button("切换到 \(mac.displayName)", systemImage: "arrow.triangle.2.circlepath") {
                            Task { await connection.connectCloud(to: mac) }
                        }
                        .disabled(connection.busy || UserDefaults.standard.string(forKey: "cloudMacID") == mac.id.uuidString)
                    }
                    ForEach(connection.cloudDevices.filter { $0.kind == .mobile && $0.revokedAt == nil }) { device in
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
                    Button("退出 Cloud 账号", role: .destructive) {
                        Task {
                            await connection.signOutCloud()
                            disconnected()
                        }
                    }
                    .disabled(connection.busy)
                } header: {
                    Text("Corptie Cloud 设备")
                } footer: {
                    Text("同账号只有一台可用 Mac 时会自动连接；多台时可在此切换。撤销移动设备需要最近重新认证。")
                }
            }
            Section {
                Button("断开连接", role: .destructive) {
                    connection.disconnect()
                    disconnected()
                }
                .disabled(connection.busy)
            } footer: {
                Text("此 iPad 已由你在 Mac 上扫码批准，使用与其他已批准客户端一致的功能权限。")
            }
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
            Text("\(cloudRevocation?.displayName ?? "") 将立即失去 Cloud 访问权限，现有 Relay 连接会关闭。")
        }
    }
}

private struct PadNotificationSettingsView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Bindable private var preferences = PadNotificationPreferences.shared
    @State private var authorizationStatus: UNAuthorizationStatus?
    private let manager = PadNotificationManager.shared

    var body: some View {
        Form {
            Section {
                notificationToggle(
                    "计划任务通知",
                    description: "计划任务完成、终态失败、取消或过期时通知；周期完成会自动覆盖，避免刷屏。",
                    isOn: $preferences.notifyOnAutomations
                )
            }

            Section("任务通知") {
                notificationToggle(
                    "所有会话都在等待交互",
                    description: "至少一个会话曾在运行，并且当前已无会话运行时通知一次。",
                    isOn: $preferences.notifyWhenAllSessionsWaiting
                )

                Picker("等待通知声音", selection: $preferences.waitingSoundEnabled) {
                    Text("默认").tag(true)
                    Text("关闭").tag(false)
                }
                .disabled(!preferences.notifyWhenAllSessionsWaiting)

                notificationToggle(
                    "会话完成",
                    description: "会话从运行变为完成，并且最终回复已经可靠写入时通知。",
                    isOn: $preferences.notifyOnComplete
                )
                notificationToggle(
                    "会话需要交互",
                    description: "会话从运行变为阻塞时通知。",
                    isOn: $preferences.notifyOnBlocked
                )
                notificationToggle(
                    "会话失败",
                    description: "会话从运行变为失败时通知。",
                    isOn: $preferences.notifyOnFailed
                )
            }

            Section {
                HStack {
                    Label(authorizationLabel, systemImage: authorizationSymbol)
                    Spacer()
                    if authorizationStatus == .notDetermined {
                        Button("允许通知") { Task { await requestAuthorization() } }
                    } else if authorizationStatus == .denied {
                        Button("打开系统设置") { openSystemSettings() }
                    }
                }
                Button("发送测试通知") {
                    Task {
                        await manager.sendTestNotification()
                        await refreshAuthorizationStatus()
                    }
                }
            } footer: {
                Text("如果最后一个会话的终态同时使全部会话停止运行，Corptie 只发送一条合并通知。当前正在查看目标会话时不会重复弹出横幅。")
            }
        }
        .task { await refreshAuthorizationStatus() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refreshAuthorizationStatus() } }
        }
    }

    private func notificationToggle(_ title: String, description: String, isOn: Binding<Bool>) -> some View {
        Toggle(isOn: isOn) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                Text(description)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var authorizationLabel: String {
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral: "系统通知已允许"
        case .denied: "系统通知已拒绝"
        case .notDetermined: "尚未请求系统通知权限"
        case nil: "正在检查通知权限…"
        @unknown default: "无法读取系统通知状态"
        }
    }

    private var authorizationSymbol: String {
        switch authorizationStatus {
        case .authorized, .provisional, .ephemeral: "checkmark.circle.fill"
        case .denied: "exclamationmark.triangle.fill"
        default: "bell.badge"
        }
    }

    private func requestAuthorization() async {
        await manager.requestAuthorizationIfNeeded()
        await refreshAuthorizationStatus()
    }

    private func refreshAuthorizationStatus() async {
        authorizationStatus = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openNotificationSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
