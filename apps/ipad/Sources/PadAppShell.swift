import SwiftUI
import UIKit
import Observation
import CorptieClientCore
import CorptieConversation
@preconcurrency import UserNotifications

/// Feature state and the single event subscription outlive individual navigation pages.
struct PadAppShell: View {
    @Environment(\.scenePhase) private var scenePhase
    let connection: PadConnection
    @State private var workspace = PadWorkspace()
    @State private var controls = PadControlStore()
    @State private var navigation = PadMobileNavigation()
    @State private var tabPreferences = PadTabPreferences()
    @State private var sheet: Sheet?
    @State private var wasBackgrounded = false
    private let notificationManager = PadNotificationManager.shared
    @AppStorage("corptie.mobile.navigationRailExpanded") private var navigationRailExpanded = true
    private enum Sheet: Identifiable {
        case operation(OperationNotificationEvent)
        var id: String {
            switch self { case .operation(let event): "operation:" + event.id }
        }
    }

    private var usesNavigationRail: Bool {
        UIDevice.current.userInterfaceIdiom == .pad
    }

    private var tab: PadTab {
        get { navigation.selection }
        nonmutating set {
            navigation.open(newValue, visibleTabs: tabPreferences.visibleTabs, usesRail: usesNavigationRail)
        }
    }
    private var keyboardViewport: PadKeyboardViewport {
        get { navigation.keyboardViewport }
        nonmutating set { navigation.keyboardViewport = newValue }
    }
    private var resourceFocus: ClientResourceFocus? {
        get { navigation.resourceFocus }
        nonmutating set { navigation.resourceFocus = newValue }
    }
    private var compactOpenSessionRequest: Int {
        get { navigation.compactOpenSessionRequest }
        nonmutating set { navigation.compactOpenSessionRequest = newValue }
    }

    var body: some View {
        synchronizedContent
    }

    private var appContent: some View {
        GeometryReader { _ in
        HStack(spacing: 0) {
            if usesNavigationRail {
                PadNavigationRail(
                    selection: $navigation.selection,
                    isExpanded: $navigationRailExpanded,
                    visibleTabs: tabPreferences.visibleTabs
                )
                .frame(width: navigationRailExpanded ? 200 : 64)
            }

            Group {
                if usesNavigationRail {
                    ZStack {
                        ForEach(PadTab.allCases) { page in
                            tabPage(page)
                                .opacity(tab == page ? 1 : 0)
                                .allowsHitTesting(tab == page)
                                .accessibilityHidden(tab != page)
                        }
                    }
                } else {
                    phoneTabs
                        // UIKit owns the home-indicator and tab-bar safe area.
                        // Do not reserve it a second time in the outer SwiftUI
                        // shell. Keyboard avoidance remains enabled.
                        .ignoresSafeArea(.container)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .sheet(item: $sheet) { destination in
            switch destination {
            case .operation(let event): PadOperationResultView(event: event)
            }
        }
        .environment(\.padKeyboardViewport, keyboardViewport)
        .onChange(of: scenePhase, initial: true) { _, phase in navigation.scenePhase = phase }
        .onChange(of: tabPreferences.visibleTabs) { _, tabs in
            if !tabs.contains(navigation.selection) { navigation.selection = .workspace }
        }
        .onChange(of: navigation.secondaryTab) { _, _ in
            if scenePhase == .active {
                controls.activate(navigation.secondaryTab ?? tab, connection: connection)
            }
            updateNotificationVisibility(sessionID: workspace.selection)
        }
        .onReceive(NotificationCenter.default.publisher(for: .corptieOpenResource)) { notification in
            guard let focus = notification.object as? ClientResourceFocus else { return }
            resourceFocus = focus; tab = .resources
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { notification in
            updateKeyboardViewport(notification, changing: true)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { notification in
            updateKeyboardViewport(notification, changing: false)
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
            controls.activate(navigation.secondaryTab ?? tab, connection: connection)
            // Keep the single server-pushed stream resident while the scene is
            // backgrounded. iPadOS may suspend the process, but the client must
            // not voluntarily tear down its only notification data source.
            await workspace.runRealtime(connection)
        }
        }
    }

    private var phoneTabs: PadPhoneTabs<PadResidentTabPage> {
        PadPhoneTabs(navigation: navigation, visibleTabs: tabPreferences.visibleTabs,
                     selection: navigation.selection, secondaryTab: navigation.secondaryTab,
                     isBarHidden: keyboardViewport.isVisible ||
                        (tab == .workspace && !navigation.compactWorkspaceIsRoot),
                     page: tabPage)
    }

    private func tabPage(_ page: PadTab) -> PadResidentTabPage {
        PadResidentTabPage(page: page, connection: connection, workspace: workspace,
                           controls: controls, navigation: navigation, preferences: tabPreferences,
                           usesRail: usesNavigationRail)
    }

    private func updateKeyboardViewport(_ notification: Notification, changing: Bool) {
        guard let frame = notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect,
              let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .flatMap(\.windows).first(where: \.isKeyWindow) else { return }
        let localFrame = window.convert(frame, from: window.screen.coordinateSpace)
        let visible = window.bounds.intersection(localFrame).height > 1
        guard visible != keyboardViewport.isVisible || changing != keyboardViewport.isChanging else { return }
        // System safe-area propagation owns the keyboard animation. Do not
        // run a second, independently timed composer/navigation animation.
        keyboardViewport.isVisible = visible
        keyboardViewport.isChanging = changing
        keyboardViewport.revision &+= 1
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
                controls.activate(navigation.secondaryTab ?? tab, connection: connection)
            }
            else { controls.pause() }
        }
        .onChange(of: tab) {
            if scenePhase == .active { controls.activate(navigation.secondaryTab ?? tab, connection: connection) }
        }
        .onChange(of: workspace.controlRevision) {
            if let snapshot = workspace.directControlSnapshot { controls.apply(snapshot) }
            else { controls.invalidate(connection) }
        }
        .onChange(of: workspace.directControlSnapshot?.resourceRevision) { _, _ in
            NotificationCenter.default.post(name: .corptieResourceCatalogChanged, object: nil)
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
        .task(id: "\(connection.serverID)|\(connection.address)") {
            notificationManager.setScope("\(connection.serverID)|\(connection.address)")
            notificationManager.updateVisibility(
                sessionID: workspace.selection,
                tab: navigation.secondaryTab ?? tab,
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
                tab: navigation.secondaryTab ?? tab,
                sceneIsActive: phase == .active
            )
            if phase == .active { PadOperationNotifications.shared.recover(connection: connection) }
        }
        .onDisappear { controls.pause() }
    }

    private func updateNotificationVisibility(sessionID: String?) {
        notificationManager.updateVisibility(
            sessionID: sessionID,
            tab: navigation.secondaryTab ?? tab,
            sceneIsActive: scenePhase == .active
        )
    }

    private func navigateFromNotification(_ userInfo: [AnyHashable: Any]) {
        if let scope = userInfo["operationScope"] as? String,
           scope != "\(connection.serverID)|\(connection.address)" { return }
        if userInfo["destination"] as? String == "operation", let id = userInfo["operationEventId"] as? String,
           let event = PadOperationNotifications.shared.result(id) { sheet = .operation(event) }
        if userInfo["destination"] as? String == "operation", let id = userInfo["repositoryId"] as? String {
            controls.selections[.repositories] = id
            controls.routes[.worktrees] = PadControlSelection(kind: .repositories, id: id)
            controls.worktrees.pendingNotificationJobID = userInfo["jobId"] as? String
            controls.worktrees.pendingNotificationWorktreeID = userInfo["worktreeId"] as? String
            tab = .worktrees
        } else if let sessionID = userInfo["sessionId"] as? String, !sessionID.isEmpty {
            workspace.selection = sessionID
            compactOpenSessionRequest &+= 1
            tab = .workspace
        } else if userInfo["destination"] as? String == "automation" {
            if let automationID = userInfo["automationId"] as? String {
                controls.selectAutomation(id: automationID)
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
    let visibleTabs: [PadTab]

    var body: some View {
        PlatformNavigationRail(
            items: visibleTabs.filter { $0 != .settings }.map {
                PlatformNavigationItem(id: String($0.rawValue), title: $0.title,
                                       symbol: $0.symbol,
                                       accessibilityID: "tab-\($0.rawValue)")
            },
            selectedID: String(selection.rawValue),
            expanded: isExpanded,
            settingsSelected: selection == .settings,
            settingsTitle: "设置",
            settingsAccessibilityID: "navigation-settings",
            onSelect: { id in
                if let rawValue = Int(id), let tab = PadTab(rawValue: rawValue) { selection = tab }
            },
            onSettings: { selection = .settings }
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

/// Presentation state crosses the SwiftUI/UIKit boundary without replacing any
/// hosting root on message delivery. Business stores remain owned by PadAppShell.
@MainActor @Observable
private final class PadMobileNavigation {
    var selection = PadTab.workspace
    var secondaryTab: PadTab?
    var resourceFocus: ClientResourceFocus?
    var compactWorkspaceIsRoot = true
    var compactOpenSessionRequest = 0
    var keyboardViewport = PadKeyboardViewport()
    var scenePhase = ScenePhase.active

    func open(_ destination: PadTab, visibleTabs: [PadTab], usesRail: Bool) {
        if usesRail || visibleTabs.contains(destination) {
            secondaryTab = nil
            selection = destination
        } else {
            // A business link may open a hidden module, but must not change the
            // user's Tab configuration or insert a sixth/temporary Tab.
            secondaryTab = destination
        }
    }
}

private struct PadResidentTabPage: View {
    let page: PadTab
    let connection: PadConnection
    let workspace: PadWorkspace
    let controls: PadControlStore
    @Bindable var navigation: PadMobileNavigation
    let preferences: PadTabPreferences
    let usesRail: Bool

    private var active: Bool {
        navigation.secondaryTab == page || (navigation.secondaryTab == nil && navigation.selection == page)
    }

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .environment(\.padKeyboardViewport, navigation.keyboardViewport)
            .environment(\.scenePhase, navigation.scenePhase)
            .safeAreaInset(edge: .top, spacing: 0) {
                if navigation.secondaryTab == page {
                    HStack {
                        Text(page.title).font(.headline)
                        Spacer()
                        Button("完成") { navigation.secondaryTab = nil }
                    }
                    .padding()
                }
            }
    }

    @ViewBuilder private var content: some View {
        switch page {
        case .workspace:
            WorkspaceView(connection: connection, workspace: workspace,
                compactOpenSessionRequest: navigation.compactOpenSessionRequest,
                onCompactRootChange: { navigation.compactWorkspaceIsRoot = $0 },
                onOpenWorktrees: { open(.worktrees) },
                onOpenAutomation: { id in
                    if let destination = controls.selectAutomation(id: id) { open(destination) }
                }, navigationGesturesEnabled: active)
        case .automations, .worktrees, .agents:
            PadControlView(tab: page, connection: connection, store: controls, openSession: openSession)
        case .resources:
            ResourceBrowser(focus: $navigation.resourceFocus, active: active,
                connected: connection.connected, works: workspace.works.map { ($0.id, $0.name) },
                currentWorkId: workspace.selection.flatMap { workspace.detailSession($0)?.workId },
                api: { ClientResourceAPI(transport: try await connection.transport(), route: .pairedDevice) },
                openSession: openSession)
                .id(connection.connectedCloudMacID?.uuidString ?? connection.serverID)
        case .settings:
            PadSettingsView(connection: connection, workspace: workspace,
                            tabPreferences: preferences, showsDoneButton: false)
        }
    }

    private func open(_ destination: PadTab) {
        navigation.open(destination, visibleTabs: preferences.visibleTabs, usesRail: usesRail)
    }
    private func openSession(_ id: String) {
        workspace.selection = id
        navigation.compactOpenSessionRequest &+= 1
        open(.workspace)
    }
}

/// UIKit owns the native selection lens, safe area and tab transitions. Cached
/// hosts also retain temporarily disabled pages; configuration never rebuilds
/// a message timeline, navigation stack, Detail state or network subscription.
private final class PadPhoneTabController: UITabBarController {
    var appeared: (() -> Void)?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        appeared?()
    }
}

private struct PadPhoneTabs<Page: View>: UIViewControllerRepresentable {
    let navigation: PadMobileNavigation
    let visibleTabs: [PadTab]
    let selection: PadTab
    let secondaryTab: PadTab?
    let isBarHidden: Bool
    @ViewBuilder let page: (PadTab) -> Page

    func makeCoordinator() -> Coordinator { Coordinator(navigation: navigation) }

    func makeUIViewController(context: Context) -> UITabBarController {
        let controller = PadPhoneTabController()
        controller.mode = .tabBar
        controller.tabBarMinimizeBehavior = .never
        controller.view.backgroundColor = .clear
        controller.delegate = context.coordinator
        controller.customizableViewControllers = []
        for tab in PadTab.allCases {
            let host = UIHostingController(rootView: page(tab))
            host.view.backgroundColor = .clear
            host.tabBarItem = UITabBarItem(title: tab.title, image: UIImage(systemName: tab.symbol), tag: tab.rawValue)
            host.tabBarItem.accessibilityIdentifier = "tab-\(tab.rawValue)"
            context.coordinator.hosts[tab] = host
        }
        context.coordinator.controller = controller
        controller.appeared = { [weak coordinator = context.coordinator] in
            coordinator?.reconcileSecondary()
        }
        updateUIViewController(controller, context: context)
        return controller
    }

    func updateUIViewController(_ controller: UITabBarController, context: Context) {
        let coordinator = context.coordinator
        let selected = visibleTabs.contains(selection) ? selection : .workspace
        if coordinator.visibleTabs != visibleTabs {
            // Select a surviving host before changing the list. Never give
            // UIKit >5 controllers, so it cannot synthesize a More item.
            if let host = coordinator.hosts[selected], controller.viewControllers?.contains(host) == true {
                controller.selectedViewController = host
            }
            controller.setViewControllers(visibleTabs.compactMap { coordinator.hosts[$0] }, animated: false)
            controller.customizableViewControllers = []
            coordinator.visibleTabs = visibleTabs
        }
        if let host = coordinator.hosts[selected], controller.selectedViewController !== host {
            controller.selectedViewController = host
        }
        if controller.isTabBarHidden != isBarHidden {
            controller.setTabBarHidden(isBarHidden, animated: controller.view.window != nil)
        }
        coordinator.reconcileSecondary()
    }

    final class Coordinator: NSObject, UITabBarControllerDelegate, UIAdaptivePresentationControllerDelegate {
        let navigation: PadMobileNavigation
        var hosts: [PadTab: UIHostingController<Page>] = [:]
        var visibleTabs: [PadTab] = []
        weak var controller: UITabBarController?
        private var presentedTab: PadTab?
        private var transitioning = false

        init(navigation: PadMobileNavigation) { self.navigation = navigation }

        func tabBarController(_ controller: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
            controller.selectedViewController !== viewController
        }

        func tabBarController(_ controller: UITabBarController, didSelect viewController: UIViewController) {
            guard let tab = PadTab(rawValue: viewController.tabBarItem.tag), navigation.selection != tab else { return }
            navigation.selection = tab
        }

        func reconcileSecondary() {
            guard let controller, !transitioning else { return }
            if let presentedTab, presentedTab != navigation.secondaryTab {
                guard controller.presentedViewController === hosts[presentedTab] else { return }
                transitioning = true
                controller.dismiss(animated: true) { [weak self] in
                    guard let self else { return }
                    self.presentedTab = nil
                    self.transitioning = false
                    self.reconcileSecondary()
                }
            } else if presentedTab == nil, let target = navigation.secondaryTab,
                      let host = hosts[target], controller.presentedViewController == nil,
                      controller.view.window != nil, !visibleTabs.contains(target) {
                presentedTab = target
                transitioning = true
                controller.present(host, animated: true) { [weak self] in
                    guard let self else { return }
                    self.transitioning = false
                    self.reconcileSecondary()
                }
                host.presentationController?.delegate = self
            }
        }

        func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
            presentedTab = nil
            navigation.secondaryTab = nil
        }
    }
}

private enum PadSettingsTab: String, CaseIterable, Hashable, Identifiable {
    case general
    case provider
    case appearance
    case notifications
    case devices

    var id: String { rawValue }
    var title: String {
        switch self {
        case .general: "通用"
        case .provider: "Provider"
        case .appearance: "外观"
        case .notifications: "通知"
        case .devices: "设备接入"
        }
    }
    var symbol: String {
        switch self {
        case .general: "gearshape"
        case .provider: "cpu"
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
    let tabPreferences: PadTabPreferences
    var showsDoneButton = true
    @State private var selectedTab = PadSettingsTab.general

    var body: some View {
        Group {
            if PadSettingsNavigationPolicy.usesStack(isCompactWidth: horizontalSizeClass == .compact) {
                compactSettings
            } else {
                regularSettings
            }
        }
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
            PadGeneralSettingsView(connection: connection, workspace: workspace, tabPreferences: tabPreferences)
        case .provider:
            Form {
                Section {
                    TaskCreationDefaultsSettingsView(load: { providerId in
                        let api = ClientSessionAPI(transport: try await connection.transport())
                        return try await api.taskCreationSettings(providerId: providerId)
                    }, save: { value in
                        let api = ClientSessionAPI(transport: try await connection.transport())
                        return try await api.saveTaskCreationSettings(value)
                    })
                }
            }
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
        if showsDoneButton {
            ToolbarItem(placement: .confirmationAction) {
                Button("完成") { dismiss() }
            }
        }
    }
}

private struct PadGeneralSettingsView: View {
    let connection: PadConnection
    let workspace: PadWorkspace
    let tabPreferences: PadTabPreferences

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
            Section {
                NavigationLink {
                    PadTabConfigurationView(preferences: tabPreferences)
                } label: {
                    LabeledContent("Tab 栏", value: "已启用 \(tabPreferences.visibleTabs.count) / 5 项")
                }
                .accessibilityIdentifier("settings.general.tabs")
            }
        }
    }
}

private struct PadTabConfigurationView: View {
    let preferences: PadTabPreferences

    var body: some View {
        Form {
            Section {
                ForEach(PadTab.allCases) { tab in
                    Toggle(isOn: Binding(get: { preferences.contains(tab) }, set: { preferences.setEnabled(tab, $0) })) {
                        Label {
                            HStack {
                                Text(tab.title)
                                if tab.isRequired { Text("必选").font(.caption).foregroundStyle(.secondary) }
                            }
                        } icon: { Image(systemName: tab.symbol) }
                    }
                    .disabled(tab.isRequired || !preferences.canEnable(tab))
                    .accessibilityIdentifier("settings.tabs.\(tab.preferenceID)")
                }
            } header: {
                Text("已启用 \(preferences.visibleTabs.count) / 5 项")
            } footer: {
                Text(preferences.visibleTabs.count == 5
                     ? "最多显示五项，请先关闭其他可选项。工作台和设置必须保留。"
                     : "工作台固定最前，设置固定最后。关闭 Tab 不会禁用对应功能，仍可通过业务入口打开。")
            }
            Section {
                Button("恢复默认") { preferences.restoreDefaults() }
                    .accessibilityIdentifier("settings.tabs.restore-defaults")
            } footer: {
                Text("默认显示工作台、Worktree 和设置。配置只保存在本机。")
            }
        }
        .navigationTitle("Tab 栏")
        .navigationBarTitleDisplayMode(.inline)
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
                    let macs = connection.cloudDevices.filter { $0.kind == .mac && $0.revokedAt == nil }
                    ForEach(macs) { mac in
                        CloudDeviceRow(device: mac, isCurrentDevice: false,
                            isConnected: connection.connectedCloudMacID == mac.id,
                            hasDuplicateName: macs.filter { $0.displayName == mac.displayName }.count > 1,
                            busy: connection.busy,
                            connect: { Task { await connection.connectCloud(to: mac) } },
                            remove: { cloudRevocation = mac })
                    }
                    let mobileDevices = connection.cloudDevices.filter { $0.kind == .mobile && $0.revokedAt == nil }
                    ForEach(mobileDevices) { device in
                        CloudDeviceRow(device: device,
                            isCurrentDevice: device.id == connection.cloudCurrentDeviceID,
                            hasDuplicateName: mobileDevices.filter { $0.displayName == device.displayName }.count > 1,
                            busy: connection.busy, remove: { cloudRevocation = device })
                    }
                    if !connection.cloudNotice.isEmpty {
                        Text(connection.cloudNotice).font(.callout).foregroundStyle(.secondary)
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
                    Text("点击 Mac 名称即可连接；菜单可移除旧设备。最近联系时间不表示实时在线状态。移除设备需要最近重新验证账号。")
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
        .alert("移除 Cloud 设备？", isPresented: Binding(
            get: { cloudRevocation != nil }, set: { if !$0 { cloudRevocation = nil } }
        )) {
            Button("取消", role: .cancel) { cloudRevocation = nil }
            Button("移除设备", role: .destructive) {
                if let device = cloudRevocation { Task { await connection.revokeCloudDevice(device) } }
                cloudRevocation = nil
            }
        } message: {
            CloudDeviceRemovalMessage(device: cloudRevocation,
                disconnectsCurrentMac: cloudRevocation?.id == connection.connectedCloudMacID)
        }
    }
}

private struct PadNotificationSettingsView: View {
    @Environment(\.scenePhase) private var scenePhase
    @Bindable private var preferences = PadNotificationPreferences.shared
    @Bindable private var operations = PadOperationNotifications.shared.preferences
    @State private var authorizationStatus: UNAuthorizationStatus?
    private let manager = PadNotificationManager.shared

    var body: some View {
        Form {
            Section("基础操作通知") {
                Toggle("启用基础操作通知", isOn: $operations.enabled)
                Group {
                    Toggle("操作完成", isOn: $operations.success)
                    Toggle("操作失败或部分完成", isOn: $operations.failure)
                    Toggle("需要人工处理", isOn: $operations.attention)
                    Toggle("操作取消", isOn: $operations.cancellation)
                    ForEach(OperationNotificationCategory.allCases, id: \.rawValue) { category in
                        Toggle(operationNotificationLabel(category.title), isOn: Binding(
                            get: { operations.categoryEnabled(category) },
                            set: { operations.setCategory(category, enabled: $0) }))
                    }
                    Toggle("通知声音", isOn: $operations.sound)
                    Toggle("隐藏通知中的操作详情", isOn: $operations.hideDetails)
                    Toggle("正在查看操作时不弹出", isOn: $operations.suppressWhenVisible)
                }.disabled(!operations.enabled)
                Text("只通知本设备发起的操作。关闭通知不会停止操作。App 被系统挂起时不保证即时通知。")
                    .font(.footnote).foregroundStyle(.secondary)
            }
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

private struct PadOperationResultView: View {
    @Environment(\.dismiss) private var dismiss
    let event: OperationNotificationEvent
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("操作", value: operationNotificationLabel(event.name))
                    LabeledContent("结果", value: operationNotificationLabel(event.outcome.title))
                    if !event.summary.isEmpty { Text(event.summary).textSelection(.enabled) }
                    if let counts = event.counts {
                        LabeledContent("已完成", value: "\(counts.completed)")
                        LabeledContent("失败", value: "\(counts.failed)")
                        LabeledContent("待处理", value: "\(counts.pending)")
                    }
                }
                if event.repositoryID != nil || event.sessionID != nil {
                    Section { Button("查看详情") { dismiss() } }
                }
            }
            .navigationTitle("操作结果")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
