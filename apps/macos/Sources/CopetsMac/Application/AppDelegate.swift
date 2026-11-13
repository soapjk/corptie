import AppKit
import Combine
import os
import QuartzCore
import SwiftUI
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static weak var shared: AppDelegate?

    private let backendClient = BackendClient.shared
    private let appLanguage = AppLanguageController.shared
    private var agentOrbManager: AgentOrbManager?
    private var completionSoundManager: SessionCompletionSoundManager?
    private var automationNotificationManager: AutomationNotificationManager?
    private var resetNotificationManager: CodexResetSystemNotificationManager?
    private let softwareUpdater = SoftwareUpdater()
    private var statusItem: NSStatusItem?
    private var statusMenu: NSMenu?
    private var collaborationWindow: NSWindow?
    private var warRoomWindow: NSWindow?
    private var assistantWindow: NSWindow?
    private var cancellables = Set<AnyCancellable>()
    private var mainWindowActivationRestorationGeneration = 0
    private var suppressAutomaticWindowPresentation = DevelopmentLaunchPolicy.startsInBackground(
        environment: ProcessInfo.processInfo.environment,
        isProductionBundle: Bundle.main.bundleIdentifier == "com.corptie.mac"
    )

    // AppKit owns our startup window. Do not let the sole SwiftUI Settings
    // scene serve as an automatic untitled launch/reopen window.
    func applicationShouldOpenUntitledFile(_ sender: NSApplication) -> Bool { false }

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.shared = self
        softwareUpdater.start()

        // The main window is a first-class macOS app window. A regular
        // activation policy keeps Corptie in the Dock and Command-Tab switcher;
        // the status item and auxiliary floating panels remain available.
        NSApp.setActivationPolicy(.regular)
        configureApplicationIcon()

        // Restore only roots that were explicitly selected before the backend
        // starts. No launch-time directory enumeration is performed here.
        WorkspaceAccessStore.shared.restore()

        // Start the backend immediately; the main content hosts first-run setup.
        CorptieBackendSupervisor.ensureBackendStarted()
        Task { await CloudRemoteAccessController.shared.restore() }

        // The production backend is started alongside the app, so the first
        // Entity request can legitimately race its launch. Refresh the Entity
        // projections whenever the canonical backend connection comes online;
        // this also covers a later backend restart without rebuilding a Tab.
        backendClient.$isOnline
            .removeDuplicates()
            .filter { $0 }
            .sink { _ in
                BackgroundTaskCenter.shared.completeSuccessfully(
                    id: BackgroundTaskCenter.backendConnectionTaskID,
                    detail: L10n("Connected to the server")
                )
                Task { @MainActor in
                    await EntityAPIClient.shared.refreshAfterBackendConnected()
                }
            }
            .store(in: &cancellables)
        backendClient.start()
        NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didWakeNotification)
            .receive(on: DispatchQueue.main)
            .sink { _ in
                // A suspended TCP connection can look healthy after wake while
                // no longer delivering SSE frames. Recreate the canonical state
                // stream instead of waiting for the user to open a Session.
                AppStateSyncController.shared.recoverAfterWake()
            }
            .store(in: &cancellables)
        let connectionStatus = BackendConnectionStatusOperation(
            isConnected: { [weak backendClient] in backendClient?.isOnline == true },
            errorMessage: { [weak backendClient] in
                backendClient?.lastError ?? AppStateStore.shared.syncError
            },
            retryConnection: {
                await AppStateSyncController.shared.refreshSnapshot()
            }
        )
        BackgroundTaskCenter.shared.start(
            id: BackgroundTaskCenter.backendConnectionTaskID,
            title: L10n("Connect to the server")
        ) {
            await connectionStatus.run()
        }
        if CodexResetSystemNotificationManager.canUseUserNotificationCenter {
            UNUserNotificationCenter.current().delegate = self
        }

        if !suppressAutomaticWindowPresentation { openWarRoom() }

        // Agent 浮球：订阅 sessions + agents 变化驱动 sync（通知聚合 + 生命周期）
        let agentOrbManager = AgentOrbManager(
            client: backendClient,
            showMain: { [weak self] in self?.openWarRoom() },
            openSession: { [weak self] sessionID in self?.openSessionInMainWindow(sessionID: sessionID) }
        )
        self.agentOrbManager = agentOrbManager
        // `AgentOrbManager.sync` only reads roles — its sessions argument is
        // deliberately ignored, and `EntityAPIClient.roles` is just
        // `AppStateStore.roles`. Two global subscriptions therefore did the
        // same window-level work for every State frame. Observe only the roles
        // commit counter (O(1) rather than deep-comparing the roles dictionary)
        // so streaming bursts no longer rebuild orb visibility on the main thread.
        AppStateStore.shared.$commitToken
            .receive(on: DispatchQueue.main)
            .map(\.roles)
            .removeDuplicates()
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    guard self?.suppressAutomaticWindowPresentation != true else { return }
                    self?.agentOrbManager?.sync(
                        roles: AppStateStore.shared.roles,
                        sessions: []
                    )
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .showAgentOrb)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] notification in
                guard let roleID = notification.userInfo?["agentId"] as? String,
                      let agent = AppStateStore.shared.roles.first(where: { $0.roleId == roleID })
                        ?? EntityAPIClient.shared.roles.first(where: { $0.roleId == roleID }) else {
                    return
                }
                self?.agentOrbManager?.show(agent: agent)
            }
            .store(in: &cancellables)

        let soundManager = SessionCompletionSoundManager(
            client: backendClient,
            isSessionVisible: { [weak self] sessionID in
                guard let self else { return false }
                let isSelected = self.backendClient.selectedSession?.id == sessionID
                let isVisibleInSessionOverview = NSApp.isActive
                    && self.warRoomWindow?.isVisible == true
                    && AppTabRouter.shared.selectedTab == .console
                    && isSelected
                return isVisibleInSessionOverview
            },
            isOverviewVisible: { [weak self] in
                NSApp.isActive
                    && self?.warRoomWindow?.isVisible == true
                    && AppTabRouter.shared.selectedTab == .console
            }
        )
        completionSoundManager = soundManager
        soundManager.start()
        let automationNotificationManager = AutomationNotificationManager(client: backendClient)
        self.automationNotificationManager = automationNotificationManager
        automationNotificationManager.start()
        let resetNotificationManager = CodexResetSystemNotificationManager(client: backendClient)
        self.resetNotificationManager = resetNotificationManager
        resetNotificationManager.start()
        installStatusItem()

        // Open task conversations and notification targets in the main window.
        NotificationCenter.default.publisher(for: .openSessionConversation)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] notification in
                guard let sessionId = notification.userInfo?["sessionId"] as? String else { return }
                self?.openSessionInMainWindow(sessionID: sessionId)
            }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: .openSessionOverview)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.openSessionOverview()
            }
            .store(in: &cancellables)
        appLanguage.$selection
            .dropFirst()
            .sink { [weak self] _ in
                self?.refreshLocalizedChrome()
            }
            .store(in: &cancellables)
    }

    func applicationWillTerminate(_ notification: Notification) {
        // The App owns its backend lifetime. This is an idempotent final guard
        // for termination paths that do not pass through the normal Quit menu.
        CorptieBackendSupervisor.stopDevelopmentBackendBestEffort()
        // Capture the final semantic anchor and flush the sole SQLite viewport
        // authority. There is no UserDefaults rollback copy.
        NotificationCenter.default.post(name: .captureSessionTimelinePositions, object: nil)
        _ = SessionViewportController.shared.persistSynchronouslyForTermination()
        agentOrbManager?.closeAll()
        DetachedChatWindowManager.shared.closeAll()
        completionSoundManager?.stop()
        automationNotificationManager?.stop()
        resetNotificationManager?.stop()
        backendClient.stop()
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let sessionID = response.notification.request.content.userInfo["sessionId"] as? String
        let automationID = response.notification.request.content.userInfo["automationId"] as? String
        completionHandler()
        Task { @MainActor in
            if let automationID {
                self.openWarRoom()
                AppTabRouter.shared.openAutomation(automationID)
            } else if let sessionID {
                NotificationCenter.default.post(
                    name: .openSessionConversation,
                    object: nil,
                    userInfo: ["sessionId": sessionID]
                )
            }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        // AppKit delivers didBecomeActive before the inactive window's first
        // click has finished establishing its key window. Defer one main-loop
        // turn so clicking a detached chat keeps that panel in front instead
        // of racing the main window for focus.
        let restorationGeneration = mainWindowActivationRestorationGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self,
                  !self.suppressAutomaticWindowPresentation,
                  restorationGeneration == self.mainWindowActivationRestorationGeneration,
                  NSApp.isActive,
                  MainWindowActivationPolicy.shouldPresentMainWindow(
                    detachedChatWindowIsKey: DetachedChatWindowManager.shared.hasKeyWindow
                  ) else { return }
            self.presentMainWindowAfterActivation()
        }
        // Queue recovery after native window restoration, rather than putting
        // foreground model invalidation ahead of the queued ordering request.
        DispatchQueue.main.async { [weak self] in
            guard let self, NSApp.isActive else { return }
            AppStateSyncController.shared.recoverAfterActivation()
            Task { await self.backendClient.refreshSelectedUsage() }
            self.backendClient.applicationDidBecomeActive()
        }
    }

    func applicationDidResignActive(_ notification: Notification) {
        backendClient.applicationDidResignActive()
    }

    func cancelPendingMainWindowActivationRestoration() {
        mainWindowActivationRestorationGeneration &+= 1
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if CorptieAppEnvironment.isDevelopment {
            // Development must always honor Quit. The one-shot backend job is
            // best-effort stopped and cannot be resurrected by launchd.
            CorptieBackendSupervisor.stopDevelopmentBackendBestEffort()
            return .terminateNow
        }
        // An unbundled executable must never own the production launch agent.
        guard CorptieAppEnvironment.canManageProductionBackend else {
            return .terminateNow
        }
        guard confirmTerminationFromCurrentState() else {
            return .terminateCancel
        }
        do {
            try CorptieBackendSupervisor.stopProductionBackend()
            return .terminateNow
        } catch {
            showBackendShutdownError(error)
            return .terminateCancel
        }
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        openWarRoom()
        return true
    }

    private func presentMainWindowAfterActivation() {
        // Command-Tab does not invoke applicationShouldHandleReopen. Restore a
        // closed main window and explicitly establish normal key/main ordering
        // when the application becomes active. This runs once per activation,
        // not during rendering, tab selection, or ordinary focus changes.
        guard let window = warRoomWindow, window.isVisible else {
            openWarRoom()
            return
        }
        if window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window.makeKeyAndOrderFront(nil)
    }

    private func configureApplicationIcon() {
        guard let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
              let icon = NSImage(contentsOf: iconURL) else {
            return
        }
        NSApp.applicationIconImage = icon
    }

    private func installStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        item.button?.image = NSImage(systemSymbolName: CorptieAppEnvironment.isDevelopment ? "hammer" : "sparkles", accessibilityDescription: CorptieAppEnvironment.appName)
        item.button?.imagePosition = .imageOnly
        item.button?.target = self
        item.button?.action = #selector(handleStatusItemClick)
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])

        refreshStatusMenu()
        statusItem = item
    }

    private func refreshStatusMenu() {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: L10n("Show Corptie"), action: #selector(openWarRoom), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: L10n("Collaboration..."), action: #selector(openCollaboration), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "助手", action: #selector(openAssistant), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: L10n("Workbench"), action: #selector(openWarRoom), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: L10n("Settings..."), action: #selector(openSettings), keyEquivalent: ","))
        let updateItem = NSMenuItem(title: L10n("Check for Updates…"), action: #selector(checkForUpdates), keyEquivalent: "")
        menu.addItem(updateItem)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: L10n("Quit Corptie"), action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        statusMenu = menu
    }

    private func refreshLocalizedChrome() {
        refreshStatusMenu()
        collaborationWindow?.title = "\(CorptieAppEnvironment.appName) \(L10n("Collaboration"))"
        warRoomWindow?.title = "\(CorptieAppEnvironment.appName) \(L10n("Workbench"))"
        assistantWindow?.title = "\(CorptieAppEnvironment.appName) 助手"
    }

    @objc private func handleStatusItemClick() {
        guard NSApp.currentEvent?.type == .rightMouseUp,
              let event = NSApp.currentEvent,
              let button = statusItem?.button,
              let statusMenu else {
            openWarRoom()
            return
        }

        NSMenu.popUpContextMenu(statusMenu, with: event, for: button)
    }

    @objc func openSettings() {
        AppTabRouter.shared.selectTab(.settings)
        openWarRoom()
    }

    @objc private func openCollaboration() {
        NSApp.activate(ignoringOtherApps: true)

        if let collaborationWindow {
            collaborationWindow.makeKeyAndOrderFront(nil)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "\(CorptieAppEnvironment.appName) \(L10n("Collaboration"))"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: CollaborationView())
        window.makeKeyAndOrderFront(nil)
        collaborationWindow = window
    }

    @objc private func openWarRoom() {
        // An explicit Dock reopen/menu request ends launch-only suppression.
        suppressAutomaticWindowPresentation = false

        if let warRoomWindow {
            applyMainWindowLevel(to: warRoomWindow)
            MainWindowForegrounding.present(warRoomWindow) {
                NSApp.activate(ignoringOtherApps: true)
            }
            return
        }

        let visibleFrame = NSScreen.main?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1_440, height: 900)
        let initialContentSize = MainWindowInitialLayout.contentSize(for: visibleFrame)
        let window = MainWindow(
            contentRect: NSRect(origin: .zero, size: initialContentSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "\(CorptieAppEnvironment.appName)"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.titlebarSeparatorStyle = .none
        window.center()
        window.isReleasedWhenClosed = false
        let resizeState = MainWindowResizeState()
        var didApplyFirstRunSize = false
        let hostingView = MainWindowSurfaceContainer(
            rootView: FirstRunSetupRoot(onSetupRequired: { [weak window] in
                guard let window, !didApplyFirstRunSize else { return }
                didApplyFirstRunSize = true
                let screen = window.screen?.visibleFrame ?? visibleFrame
                window.setContentSize(MainWindowInitialLayout.contentSize(for: screen, firstRun: true))
                window.center()
            }) { MainWindowContentView() }
                .background { WindowDragArea() }
                .environmentObject(resizeState),
            resizeState: resizeState
        )
        // This is a user-resizable AppKit-owned window. The SwiftUI root must
        // follow its bounds, not feed its ideal size back into NSWindow. The
        // default sizing options can call updateAnimatedWindowSize during a
        // tab replacement, producing a safe-area/constraint feedback loop.
        hostingView.frame = window.contentView?.bounds ?? NSRect(
            origin: .zero,
            size: window.contentRect(forFrameRect: window.frame).size
        )
        // The floor tracks the visible columns; ConsoleSplitController refreshes
        // it when the Work outline collapses or expands.
        window.contentMinSize = MainWindowMinimumSizePolicy.defaultContentMinSize
        window.preservesContentDuringLiveResize = true
        window.contentView = hostingView
        applyMainWindowLevel(to: window)
        warRoomWindow = window
        MainWindowForegrounding.present(window) {
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    func setMainWindowPinned(_ isPinned: Bool) {
        MainWindowPresentationState.shared.setPinned(isPinned)
        guard let warRoomWindow else { return }
        applyMainWindowLevel(to: warRoomWindow)
        // Reinsert the window at the front of its new level without bypassing
        // the normal activation and key-window rules.
        warRoomWindow.makeKeyAndOrderFront(nil)
    }

    func openSessionInMainWindow(sessionID: String) {
        openWarRoom()
        AppTabRouter.shared.openSession(sessionID, source: .userSelection)
    }

    private func applyMainWindowLevel(to window: NSWindow) {
        window.level = MainWindowLevelPolicy.level(
            isPinned: MainWindowPresentationState.shared.isPinned
        )
    }

    private func openSessionOverview() {
        openWarRoom()
        AppTabRouter.shared.selectTab(.console)
    }

    func openWorktreeManagement(repositoryId: String?, worktreeId: String?, worktreePath: String?, jobId: String? = nil) {
        openWarRoom()
        AppTabRouter.shared.openWorktrees(
            repositoryId: repositoryId,
            worktreeId: worktreeId,
            worktreePath: worktreePath, jobId: jobId
        )
    }

    @objc private func openAssistant() {
        NSApp.activate(ignoringOtherApps: true)

        if let assistantWindow {
            assistantWindow.makeKeyAndOrderFront(nil)
            return
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "\(CorptieAppEnvironment.appName) 助手"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AssistantConversationView())
        window.makeKeyAndOrderFront(nil)
        assistantWindow = window
    }

    @objc private func checkForUpdates() {
        softwareUpdater.checkForUpdates()
    }

    @objc private func quit() {
        let dismissedBlockingUI = ApplicationTerminationUI.dismissBlockingUI(in: NSApp)
        // Ending a sheet clears attachedSheet immediately, but AppKit keeps its
        // modal session alive until the detach animation completes. One run-loop
        // tick is not sufficient; terminating during that interval is rejected.
        DispatchQueue.main.asyncAfter(deadline: .now() + (dismissedBlockingUI ? 0.35 : 0)) {
            NSApp.terminate(nil)
        }
    }

    private func confirmTerminationFromCurrentState() -> Bool {
        let appState = AppStateStore.shared
        if backendClient.isOnline, appState.revision > 0, appState.syncError == nil {
            let unfinished = backendClient.sessions.filter(isUnfinishedSession)
            guard !unfinished.isEmpty else { return true }
            let alert = NSAlert()
            alert.alertStyle = .critical
            alert.messageText = L10n("Tasks are still running")
            let titles = unfinished.prefix(4).map { "• \($0.title)" }.joined(separator: "\n")
            let remaining = unfinished.count > 4
                ? "\n" + L10nFormat("and %d more tasks", unfinished.count - 4)
                : ""
            alert.informativeText = L10nFormat(
                "There are %d unfinished conversations. Quitting will stop the backend and interrupt all of them. Current work may be lost.\n\n%@%@",
                unfinished.count,
                titles,
                remaining
            )
            alert.addButton(withTitle: L10n("Cancel"))
            alert.addButton(withTitle: L10n("Quit and Interrupt Tasks"))
            return alert.runModal() == .alertSecondButtonReturn
        }

        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n("Unable to verify running tasks")
        alert.informativeText = L10n("Corptie could not read the latest synchronized session state. Quitting may interrupt unfinished conversations. Do you still want to stop the frontend and backend?")
        alert.addButton(withTitle: L10n("Cancel"))
        alert.addButton(withTitle: L10n("Quit Anyway"))
        return alert.runModal() == .alertSecondButtonReturn
    }

    private func isUnfinishedSession(_ session: TaskSession) -> Bool {
        switch session.executionTaskStatus {
        case .running:
            return true
        case .blocked:
            let activity = session.activityStatus?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            return activity != "ready" && activity != "idle"
        case .complete, .failed, .cancelled:
            return false
        }
    }

    private func showBackendShutdownError(_ error: Error) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = L10n("Could not stop the backend")
        alert.informativeText = L10nFormat("Corptie was kept open because its backend could not be stopped safely.\n\n%@", error.localizedDescription)
        alert.addButton(withTitle: L10n("OK"))
        alert.runModal()
    }
}
