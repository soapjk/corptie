import AppKit
import Combine
import os
import QuartzCore
import SwiftUI
import UserNotifications

@main
struct CorptieMacApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            SettingsView()
        }
    }
}

@MainActor
enum ApplicationTerminationUI {
    @discardableResult
    static func dismissBlockingUI(in application: NSApplication) -> Bool {
        var dismissedBlockingUI = dismissAttachedSheets(from: application.windows)
        if let modalWindow = application.modalWindow {
            application.abortModal()
            modalWindow.orderOut(nil)
            dismissedBlockingUI = true
        }
        return dismissedBlockingUI
    }

    @discardableResult
    static func dismissAttachedSheets(from windows: [NSWindow]) -> Bool {
        // AppKit rejects terminate() before applicationShouldTerminate whenever
        // any sheet is attached. Treat transient confirmation/edit sheets as
        // cancelled so the normal unfinished-session shutdown guard can run.
        var dismissedSheet = false
        for parentWindow in windows {
            guard let sheet = parentWindow.attachedSheet else { continue }
            parentWindow.endSheet(sheet, returnCode: .cancel)
            sheet.orderOut(nil)
            dismissedSheet = true
        }
        return dismissedSheet
    }
}

enum MainWindowTitlebarZoomPolicy {
    static let topEdgeHeight: CGFloat = 12

    static func shouldToggleZoom(
        clickCount: Int,
        locationY: CGFloat,
        contentHeight: CGFloat
    ) -> Bool {
        guard clickCount == 2, contentHeight > 0 else { return false }
        return locationY >= contentHeight - topEdgeHeight
            && locationY <= contentHeight
    }
}

enum MainWindowLevelPolicy {
    static func level(isPinned: Bool) -> NSWindow.Level {
        isPinned ? .floating : .normal
    }
}

@MainActor
final class MainWindowPresentationState: ObservableObject {
    static let shared = MainWindowPresentationState()

    @Published private(set) var isPinned = false

    func setPinned(_ isPinned: Bool) {
        guard self.isPinned != isPinned else { return }
        self.isPinned = isPinned
    }
}

/// Restores the standard title-bar double-click maximize/restore interaction
/// for the full-size transparent title bar. SwiftUI owns the content under the
/// title bar, so NSWindow's default empty-title-bar handler never sees it.
@MainActor
final class MainWindow: NSWindow {
    override func sendEvent(_ event: NSEvent) {
        if event.type == .leftMouseDown,
           let contentView,
           MainWindowTitlebarZoomPolicy.shouldToggleZoom(
               clickCount: event.clickCount,
               locationY: contentView.convert(event.locationInWindow, from: nil).y,
               contentHeight: contentView.bounds.height
           ),
           !isOverStandardWindowButton(event) {
            zoom(nil)
            return
        }
        super.sendEvent(event)
    }

    private func isOverStandardWindowButton(_ event: NSEvent) -> Bool {
        let buttonTypes: [NSWindow.ButtonType] = [
            .closeButton,
            .miniaturizeButton,
            .zoomButton
        ]
        return buttonTypes.contains { buttonType in
            guard let button = standardWindowButton(buttonType), !button.isHidden else {
                return false
            }
            return button.bounds.contains(
                button.convert(event.locationInWindow, from: nil)
            )
        }
    }
}

struct LiveResizeLayoutStatistics: Equatable {
    fileprivate(set) var sizeChangeEvents = 0
    fileprivate(set) var layoutCommits = 0
    fileprivate(set) var coalescedEvents = 0
    fileprivate(set) var exactLayouts = 0
    fileprivate(set) var maximumLayoutDuration: TimeInterval = 0
}

@MainActor
struct MainWindowChromeSurfaces {
    let leading: NSView
    let center: NSView
    let trailing: NSView
}

enum MainWindowResizeTrace {
    private static let log = OSLog(
        subsystem: "com.corptie.mac",
        category: "MainWindowResizePerformance"
    )

    static func beginSession(_ reason: String) -> OSSignpostID {
        let id = OSSignpostID(log: log)
        os_signpost(.begin, log: log, name: "ResizeSession", signpostID: id, "%{public}@", reason)
        return id
    }

    static func endSession(_ id: OSSignpostID) {
        os_signpost(.end, log: log, name: "ResizeSession", signpostID: id)
    }

    static func sizeChanged(width: CGFloat, height: CGFloat) {
        os_signpost(
            .event,
            log: log,
            name: "ResizeSizeChanged",
            "%{public}.0fx%{public}.0f",
            Double(width),
            Double(height)
        )
    }

    static func measure<T>(_ name: StaticString, operation: () throws -> T) rethrows -> T {
        os_signpost(.begin, log: log, name: name)
        defer { os_signpost(.end, log: log, name: name) }
        return try operation()
    }
}

@MainActor
final class MainWindowResizeState: ObservableObject {
    @Published fileprivate(set) var isLiveResize = false
}

/// AppKit-owned main-window surface hierarchy. The three title-bar surfaces keep
/// fixed intrinsic sizes and move with native window geometry, independently of
/// the coalesced SwiftUI content surface. A display-link consumes only the latest
/// pending content size; completion always restores exact geometry. The content
/// surface is never scaled: fixed-width columns therefore cannot stretch past
/// their target and snap backward at the next real layout commit.
@MainActor
final class MainWindowSurfaceContainer<Content: View>: NSView {
    private enum ResizeReason: Hashable {
        case liveResize
        case fullScreenTransition
    }

    static var liveLayoutInterval: TimeInterval { 1.0 / 30.0 }
    static var animatedLayoutInterval: TimeInterval { 1.0 / 60.0 }
    static var stabilityDelay: TimeInterval { 0.12 }

    private let backgroundView = NSView()
    private let contentContainer = NSView()
    private let hostingView: NSHostingView<Content>
    private let chromeSurfaces: MainWindowChromeSurfaces?
    private let resizeState: MainWindowResizeState
    private var resizeReasons = Set<ResizeReason>()
    private var windowNotificationTokens: [NSObjectProtocol] = []
    private var resizeDisplayLink: CADisplayLink?
    private var hasPendingLayoutCommit = false
    private var exactLayoutTimer: Timer?
    private var lastLayoutTime: TimeInterval = -.infinity
    private var lastSizeChangeTime: TimeInterval = -.infinity
    private var lastObservedSize = NSSize.zero
    private var resizeTraceID: OSSignpostID?
    private(set) var layoutStatistics = LiveResizeLayoutStatistics()
    var renderedContentSize: NSSize { hostingView.frame.size }
    var presentedContentFrame: NSRect {
        contentContainer.layer?.frame ?? contentContainer.frame
    }
    var contentUsesIdentityTransform: Bool {
        contentContainer.layer?.affineTransform() == .identity
    }

    init(
        rootView: Content,
        resizeState: MainWindowResizeState,
        chromeSurfaces: MainWindowChromeSurfaces? = nil
    ) {
        hostingView = NSHostingView(rootView: rootView)
        self.resizeState = resizeState
        self.chromeSurfaces = chromeSurfaces
        super.init(frame: .zero)

        wantsLayer = true
        layer?.masksToBounds = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor

        backgroundView.wantsLayer = true
        backgroundView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        backgroundView.autoresizingMask = []
        addSubview(backgroundView)

        contentContainer.wantsLayer = true
        contentContainer.layer?.masksToBounds = true
        contentContainer.autoresizingMask = []
        addSubview(contentContainer)

        hostingView.sizingOptions = []
        hostingView.autoresizingMask = []
        hostingView.layerContentsRedrawPolicy = .duringViewResize
        contentContainer.addSubview(hostingView)

        if let chromeSurfaces {
            for surface in [chromeSurfaces.leading, chromeSurfaces.center, chromeSurfaces.trailing] {
                surface.translatesAutoresizingMaskIntoConstraints = false
                surface.setContentHuggingPriority(.required, for: .horizontal)
                surface.setContentHuggingPriority(.required, for: .vertical)
                addSubview(surface)
            }
            NSLayoutConstraint.activate([
                chromeSurfaces.leading.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 76),
                chromeSurfaces.leading.topAnchor.constraint(
                    equalTo: safeAreaLayoutGuide.topAnchor,
                    constant: -28
                ),
                chromeSurfaces.leading.widthAnchor.constraint(equalToConstant: 88),
                chromeSurfaces.leading.heightAnchor.constraint(equalToConstant: 22),

                chromeSurfaces.center.centerXAnchor.constraint(equalTo: centerXAnchor),
                chromeSurfaces.center.topAnchor.constraint(
                    equalTo: safeAreaLayoutGuide.topAnchor,
                    constant: -12
                ),
                chromeSurfaces.center.widthAnchor.constraint(
                    equalToConstant: CGFloat(AppTab.allCases.count) * 42
                ),
                chromeSurfaces.center.heightAnchor.constraint(equalToConstant: 30),

                chromeSurfaces.trailing.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
                chromeSurfaces.trailing.topAnchor.constraint(
                    equalTo: safeAreaLayoutGuide.topAnchor,
                    constant: -24
                ),
                chromeSurfaces.trailing.widthAnchor.constraint(equalToConstant: 220),
                chromeSurfaces.trailing.heightAnchor.constraint(equalToConstant: 22)
            ])
        }
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        removeWindowObservers()
        guard let window else { return }
        installDisplayLink()

        let center = NotificationCenter.default
        windowNotificationTokens = [
            center.addObserver(
                forName: NSWindow.willEnterFullScreenNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.beginResize(for: .fullScreenTransition)
                }
            },
            center.addObserver(
                forName: NSWindow.didEnterFullScreenNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.endResize(for: .fullScreenTransition)
                }
            },
            center.addObserver(
                forName: NSWindow.willExitFullScreenNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.beginResize(for: .fullScreenTransition)
                }
            },
            center.addObserver(
                forName: NSWindow.didExitFullScreenNotification,
                object: window,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.endResize(for: .fullScreenTransition)
                }
            }
        ]
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        backgroundView.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    override func viewWillStartLiveResize() {
        super.viewWillStartLiveResize()
        beginResize(for: .liveResize)
    }

    override func viewDidEndLiveResize() {
        super.viewDidEndLiveResize()
        endResize(for: .liveResize)
    }

    override func layout() {
        super.layout()
        backgroundView.frame = bounds
        guard bounds.size != lastObservedSize else { return }
        lastObservedSize = bounds.size
        lastSizeChangeTime = ProcessInfo.processInfo.systemUptime
        layoutStatistics.sizeChangeEvents += 1
        MainWindowResizeTrace.sizeChanged(width: bounds.width, height: bounds.height)

        if hostingView.frame.size == .zero {
            applyExactLayout()
            return
        }

        // Native live/full-screen transitions have a definitive end callback.
        // Running the stability fallback during those transitions can mistake a
        // delayed main-thread event for completion and force an expensive exact
        // layout while the pointer is still moving.
        if resizeReasons.isEmpty {
            scheduleExactLayoutAfterStability()
        }
        scheduleLayoutIfNeeded()
    }

    private func beginResize(for reason: ResizeReason) {
        let wasResizing = !resizeReasons.isEmpty
        resizeReasons.insert(reason)
        guard !wasResizing else { return }
        exactLayoutTimer?.invalidate()
        exactLayoutTimer = nil
        resizeState.isLiveResize = true
        lastLayoutTime = ProcessInfo.processInfo.systemUptime
        resizeTraceID = MainWindowResizeTrace.beginSession(
            reason == .liveResize ? "liveResize" : "fullScreenTransition"
        )
    }

    private func endResize(for reason: ResizeReason) {
        resizeReasons.remove(reason)
        guard resizeReasons.isEmpty else { return }
        resizeState.isLiveResize = false
        invalidateLayoutTimers()
        applyExactLayout()
        if let resizeTraceID {
            MainWindowResizeTrace.endSession(resizeTraceID)
            self.resizeTraceID = nil
        }
    }

    private func scheduleLayoutIfNeeded() {
        guard !hasPendingLayoutCommit else {
            layoutStatistics.coalescedEvents += 1
            return
        }
        hasPendingLayoutCommit = true
        resizeDisplayLink?.isPaused = false
    }

    private func installDisplayLink() {
        resizeDisplayLink?.invalidate()
        let link = displayLink(
            target: self,
            selector: #selector(handleDisplayLink(_:))
        )
        link.isPaused = true
        link.add(to: .main, forMode: .common)
        resizeDisplayLink = link
    }

    @objc private func handleDisplayLink(_ displayLink: CADisplayLink) {
        guard hasPendingLayoutCommit else {
            displayLink.isPaused = true
            return
        }
        let interval = resizeReasons.isEmpty
            ? Self.animatedLayoutInterval
            : Self.liveLayoutInterval
        let now = ProcessInfo.processInfo.systemUptime
        guard now - lastLayoutTime >= interval else { return }
        hasPendingLayoutCommit = false
        applyLayoutCommit()
        if !hasPendingLayoutCommit {
            displayLink.isPaused = true
        }
    }

    private func scheduleExactLayoutAfterStability() {
        guard exactLayoutTimer == nil else { return }
        scheduleStabilityTimer(after: Self.stabilityDelay)
    }

    private func scheduleStabilityTimer(after delay: TimeInterval) {
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.exactLayoutTimer = nil
                let elapsed = ProcessInfo.processInfo.systemUptime - self.lastSizeChangeTime
                guard elapsed >= Self.stabilityDelay else {
                    self.scheduleStabilityTimer(after: Self.stabilityDelay - elapsed)
                    return
                }
                self.hasPendingLayoutCommit = false
                self.resizeDisplayLink?.isPaused = true
                self.applyExactLayout()
            }
        }
        exactLayoutTimer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func applyLayoutCommit() {
        let startedAt = ProcessInfo.processInfo.systemUptime
        MainWindowResizeTrace.measure("ResizeLayoutCommit") {
            // Assign only the newest size. AppKit and Core Animation perform the
            // resulting child layout/draw in their normal transaction instead of
            // synchronously blocking this resize callback. Intermediate sizes
            // coalesced by the frame coordinator are intentionally discarded.
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            contentContainer.frame = bounds
            hostingView.frame = contentContainer.bounds
            CATransaction.commit()
        }
        let finishedAt = ProcessInfo.processInfo.systemUptime
        lastLayoutTime = finishedAt
        layoutStatistics.layoutCommits += 1
        layoutStatistics.maximumLayoutDuration = max(
            layoutStatistics.maximumLayoutDuration,
            finishedAt - startedAt
        )
    }

    private func applyExactLayout() {
        let startedAt = ProcessInfo.processInfo.systemUptime
        MainWindowResizeTrace.measure("ResizeExactLayout") {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            contentContainer.frame = bounds
            hostingView.frame = contentContainer.bounds
            CATransaction.commit()
            hostingView.needsLayout = true
            hostingView.layoutSubtreeIfNeeded()
            // Drawing remains transaction-driven. The synchronous layout makes
            // geometry and hit-testing exact without waiting for rasterization.
            hostingView.needsDisplay = true
        }
        let finishedAt = ProcessInfo.processInfo.systemUptime
        lastLayoutTime = finishedAt
        layoutStatistics.exactLayouts += 1
        layoutStatistics.maximumLayoutDuration = max(
            layoutStatistics.maximumLayoutDuration,
            finishedAt - startedAt
        )
    }

    private func invalidateLayoutTimers() {
        hasPendingLayoutCommit = false
        resizeDisplayLink?.isPaused = true
        exactLayoutTimer?.invalidate()
        exactLayoutTimer = nil
    }

    private func removeWindowObservers() {
        invalidateLayoutTimers()
        resizeDisplayLink?.invalidate()
        resizeDisplayLink = nil
        let center = NotificationCenter.default
        windowNotificationTokens.forEach(center.removeObserver)
        windowNotificationTokens.removeAll()
    }
}

typealias LiveResizeHostingView<Content: View> = MainWindowSurfaceContainer<Content>

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    static weak var shared: AppDelegate?

    private let backendClient = BackendClient.shared
    private let appLanguage = AppLanguageController.shared
    private var panelController: FloatingPanelController?
    private var agentOrbManager: AgentOrbManager?
    private var completionSoundManager: SessionCompletionSoundManager?
    private var resetNotificationManager: CodexResetSystemNotificationManager?
    private var statusItem: NSStatusItem?
    private var statusMenu: NSMenu?
    private var settingsWindow: NSWindow?
    private var collaborationWindow: NSWindow?
    private var warRoomWindow: NSWindow?
    private var assistantWindow: NSWindow?
    private var cancellables = Set<AnyCancellable>()

    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.shared = self

        // The main window is a first-class macOS app window. A regular
        // activation policy keeps Corptie in the Dock and Command-Tab switcher;
        // the status item and auxiliary floating panels remain available.
        NSApp.setActivationPolicy(.regular)
        configureApplicationIcon()

        showWelcomePromptIfNeeded()
        CorptieBackendSupervisor.ensureProductionBackendStarted()

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

        let controller = FloatingPanelController(client: backendClient)
        panelController = controller
        // 控制台是主界面：启动默认打开控制台；液态玻璃悬浮窗是辅助界面，默认不打开
        openWarRoom()

        // Agent 浮球：订阅 sessions + agents 变化驱动 sync（通知聚合 + 生命周期）
        let agentOrbManager = AgentOrbManager(
            client: backendClient,
            showMain: { [weak self] in self?.openWarRoom() },
            openSession: { [weak self] sessionID in self?.openSessionInPanel(sessionId: sessionID) }
        )
        self.agentOrbManager = agentOrbManager
        backendClient.sessionsDidChange
            .receive(on: DispatchQueue.main)
            .sink { [weak self] sessions in
                MainActor.assumeIsolated {
                    self?.agentOrbManager?.sync(agents: EntityAPIClient.shared.agents, sessions: sessions)
                }
            }
            .store(in: &cancellables)
        AppStateStore.shared.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.agentOrbManager?.sync(
                        agents: AppStateStore.shared.agents,
                        sessions: self?.backendClient.sessions ?? []
                    )
                }
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .showAgentOrb)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] notification in
                guard let agentID = notification.userInfo?["agentId"] as? String,
                      let agent = AppStateStore.shared.agents.first(where: { $0.agentId == agentID })
                        ?? EntityAPIClient.shared.agents.first(where: { $0.agentId == agentID }) else {
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
                let isVisibleInPanel = self.panelController?.isVisible == true && isSelected
                let isVisibleInSessionOverview = NSApp.isActive
                    && self.warRoomWindow?.isVisible == true
                    && AppTabRouter.shared.selectedTab == .sessions
                    && isSelected
                return isVisibleInPanel || isVisibleInSessionOverview
            },
            isOverviewVisible: { [weak self] in
                NSApp.isActive
                    && self?.warRoomWindow?.isVisible == true
                    && AppTabRouter.shared.selectedTab == .sessions
            }
        )
        completionSoundManager = soundManager
        soundManager.start()
        let resetNotificationManager = CodexResetSystemNotificationManager(client: backendClient)
        self.resetNotificationManager = resetNotificationManager
        resetNotificationManager.start()
        installStatusItem()

        // 控制台 WorkItem 详情「打开对话」→ 在主悬浮窗打开该 session 对话
        NotificationCenter.default.publisher(for: .openSessionConversation)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] notification in
                guard let sessionId = notification.userInfo?["sessionId"] as? String else { return }
                self?.openSessionInPanel(sessionId: sessionId)
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

        SessionDSHWebViewStore.shared.preload()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Two synchronous phases ensure every native timeline samples its
        // final semantic anchor before presentation stores encode the rollback
        // copy. SQLite writes are already committed continuously in WAL mode.
        NotificationCenter.default.post(name: .captureSessionTimelinePositions, object: nil)
        NotificationCenter.default.post(name: .persistSessionTimelinePositions, object: nil)
        CorptieAppEnvironment.userDefaults.synchronize()
        agentOrbManager?.closeAll()
        completionSoundManager?.stop()
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
        completionHandler()
        Task { @MainActor in
            if let sessionID {
                NotificationCenter.default.post(
                    name: .openSessionConversation,
                    object: nil,
                    userInfo: ["sessionId": sessionID]
                )
            }
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        presentMainWindowAfterActivation()
        // Reconcile list state on foregrounding and replace any stream that was
        // silently stalled while the app was inactive.
        AppStateSyncController.shared.recoverAfterActivation()
        Task {
            await backendClient.refreshSelectedUsage()
        }
        backendClient.applicationDidBecomeActive()
    }

    func applicationDidResignActive(_ notification: Notification) {
        backendClient.applicationDidResignActive()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // A development executable must never own the production launch agent.
        // This bundle-level check remains effective even if its environment is
        // missing or sanitized when the process is terminated externally.
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

    private func showWelcomePromptIfNeeded() {
        let key = "corptie.hasAcknowledgedWelcomeSetup"

        guard !CorptieAppEnvironment.userDefaults.bool(forKey: key) else {
            return
        }

        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = L10n("Welcome to Corptie")
        alert.informativeText = L10n("""
        Corptie keeps your agent tasks visible in a floating panel while you work on other things.

        Your session data is stored in ~/Library/Application Support/Corptie/ and stays on this machine.

        If you ever need to run tasks in a workspace on an external drive, you may need to grant Corptie Full Disk Access in System Settings.
        """)
        alert.addButton(withTitle: L10n("Get Started"))
        CorptieAppEnvironment.userDefaults.set(true, forKey: key)
        CorptieAppEnvironment.userDefaults.synchronize()
        alert.runModal()
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
        menu.addItem(NSMenuItem(title: L10n("Show Corptie"), action: #selector(showPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: L10n("Collaboration..."), action: #selector(openCollaboration), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "助手", action: #selector(openAssistant), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "控制台", action: #selector(openWarRoom), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: L10n("Settings..."), action: #selector(openSettings), keyEquivalent: ","))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: L10n("Quit Corptie"), action: #selector(quit), keyEquivalent: "q"))
        menu.items.forEach { $0.target = self }
        statusMenu = menu
    }

    private func refreshLocalizedChrome() {
        refreshStatusMenu()
        settingsWindow?.title = "\(CorptieAppEnvironment.appName) \(L10n("Settings"))"
        collaborationWindow?.title = "\(CorptieAppEnvironment.appName) \(L10n("Collaboration"))"
        warRoomWindow?.title = "\(CorptieAppEnvironment.appName) 控制台"
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

    @objc private func showPanel() {
        NSApp.activate(ignoringOtherApps: true)
        panelController?.show()
    }

    // 在悬浮窗打开某个 session 的对话（选中 + 显示悬浮窗）
    private func openSessionInPanel(sessionId: String) {
        Task { @MainActor in
            let cached = backendClient.sessions.first(where: { $0.id == sessionId })
            let resolved: TaskSession?
            if let cached { resolved = cached }
            else { resolved = await AppStateSyncController.shared.hydrateSession(sessionId) }
            guard let session = resolved else {
                backendClient.reportNavigationError(sessionId: sessionId)
                return
            }
            backendClient.select(session: session)
            NSApp.activate(ignoringOtherApps: true)
            panelController?.show()
        }
    }

    @objc func openSettings() {
        NSApp.activate(ignoringOtherApps: true)

        if let settingsWindow {
            settingsWindow.makeKeyAndOrderFront(nil)
            settingsWindow.orderFrontRegardless()
            return
        }

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: SettingsWindowLayout.contentSize),
            styleMask: [.titled, .closable, .miniaturizable],
            backing: .buffered,
            defer: false
        )
        window.title = "\(CorptieAppEnvironment.appName) \(L10n("Settings"))"
        window.center()
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: SettingsView(
            onClose: {
                window.close()
            }
        ))
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        settingsWindow = window
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
        NSApp.activate(ignoringOtherApps: true)
        // 控制台前置时，收起辅助的液态玻璃悬浮窗
        panelController?.hide()

        if let warRoomWindow {
            if warRoomWindow.isMiniaturized {
                warRoomWindow.deminiaturize(nil)
            }
            applyMainWindowLevel(to: warRoomWindow)
            warRoomWindow.makeKeyAndOrderFront(nil)
            return
        }

        let window = MainWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 760),
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
        let leadingChrome = NSHostingView(rootView: MainWindowFixedChromeView())
        let centerChrome = NSHostingView(rootView: MainWindowTabBarSurfaceView())
        let trailingChrome = NSHostingView(rootView: MainWindowTaskSurfaceView())
        leadingChrome.sizingOptions = []
        centerChrome.sizingOptions = []
        trailingChrome.sizingOptions = []
        for surface in [leadingChrome, centerChrome, trailingChrome] {
            surface.layerContentsRedrawPolicy = .onSetNeedsDisplay
        }
        let hostingView = MainWindowSurfaceContainer(
            rootView: MainWindowContentView().environmentObject(resizeState),
            resizeState: resizeState,
            chromeSurfaces: MainWindowChromeSurfaces(
                leading: leadingChrome,
                center: centerChrome,
                trailing: trailingChrome
            )
        )
        // This is a user-resizable AppKit-owned window. The SwiftUI root must
        // follow its bounds, not feed its ideal size back into NSWindow. The
        // default sizing options can call updateAnimatedWindowSize during a
        // tab replacement, producing a safe-area/constraint feedback loop.
        hostingView.frame = window.contentView?.bounds ?? NSRect(
            origin: .zero,
            size: window.contentRect(forFrameRect: window.frame).size
        )
        window.contentMinSize = NSSize(width: 980, height: 620)
        window.preservesContentDuringLiveResize = true
        window.contentView = hostingView
        applyMainWindowLevel(to: window)
        window.makeKeyAndOrderFront(nil)
        warRoomWindow = window
    }

    func setMainWindowPinned(_ isPinned: Bool) {
        MainWindowPresentationState.shared.setPinned(isPinned)
        guard let warRoomWindow else { return }
        applyMainWindowLevel(to: warRoomWindow)
        // Reinsert the window at the front of its new level without bypassing
        // the normal activation and key-window rules.
        warRoomWindow.makeKeyAndOrderFront(nil)
    }

    private func applyMainWindowLevel(to window: NSWindow) {
        window.level = MainWindowLevelPolicy.level(
            isPinned: MainWindowPresentationState.shared.isPinned
        )
    }

    private func openSessionOverview() {
        openWarRoom()
        AppTabRouter.shared.selectTab(.sessions)
    }

    func openWorktreeManagement(repositoryId: String?, worktreeId: String?, worktreePath: String?) {
        openWarRoom()
        AppTabRouter.shared.openWorktrees(
            repositoryId: repositoryId,
            worktreeId: worktreeId,
            worktreePath: worktreePath
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
        switch session.status {
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

@MainActor
enum CorptieBackendSupervisor {
    private static let label = "com.corptie.backend"

    static func ensureProductionBackendStarted() {
        guard CorptieAppEnvironment.canManageProductionBackend else {
            return
        }
        guard let bundledPlist = Bundle.main.url(forResource: label, withExtension: "plist") else {
            return
        }

        do {
            let fileManager = FileManager.default
            let launchAgentsDir = fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("LaunchAgents", isDirectory: true)
            let backendLogDir = fileManager.homeDirectoryForCurrentUser
                .appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Logs", isDirectory: true)
                .appendingPathComponent("Corptie", isDirectory: true)
            let installedPlist = launchAgentsDir.appendingPathComponent("\(label).plist")

            try fileManager.createDirectory(at: launchAgentsDir, withIntermediateDirectories: true)
            // launchd opens StandardOutPath/StandardErrorPath before executing
            // the bundled launcher, so the parent directory must already exist.
            try fileManager.createDirectory(at: backendLogDir, withIntermediateDirectories: true)
            if !fileManager.contentsEqual(atPath: bundledPlist.path, andPath: installedPlist.path) {
                _ = try? runLaunchctl(["bootout", "gui/\(getuid())", installedPlist.path])
                if fileManager.fileExists(atPath: installedPlist.path) {
                    try fileManager.removeItem(at: installedPlist)
                }
                try fileManager.copyItem(at: bundledPlist, to: installedPlist)
            }

            if !isLaunchAgentLoaded() {
                try runLaunchctl(["bootstrap", "gui/\(getuid())", installedPlist.path])
            }
        } catch {
            NSLog("Corptie backend startup failed: \(error.localizedDescription)")
        }
    }

    static func stopProductionBackend() throws {
        guard CorptieAppEnvironment.canManageProductionBackend, isLaunchAgentLoaded() else {
            return
        }
        try runLaunchctl(["bootout", "gui/\(getuid())/\(label)"])
    }

    private static func isLaunchAgentLoaded() -> Bool {
        (try? runLaunchctl(["print", "gui/\(getuid())/\(label)"])) != nil
    }

    @discardableResult
    private static func runLaunchctl(_ arguments: [String]) throws -> String {
        let process = Process()
        let output = Pipe()
        let errorOutput = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = errorOutput
        try process.run()
        process.waitUntilExit()

        let stdout = String(data: output.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderr = String(data: errorOutput.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw BackendSupervisorError.launchctlFailed(arguments.joined(separator: " "), stderr.isEmpty ? stdout : stderr)
        }
        return stdout
    }

    enum BackendSupervisorError: LocalizedError {
        case launchctlFailed(String, String)

        var errorDescription: String? {
            switch self {
            case let .launchctlFailed(command, output):
                return "launchctl \(command) failed: \(output)"
            }
        }
    }
}

enum CorptiePermissionManager {
    @MainActor
    static func openFullDiskAccessSettings() {
        let candidateURLs: [URL] = [
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!,
            URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy")!,
            URL(fileURLWithPath: "/System/Library/PreferencePanes/Security.prefPane")
        ]

        for url in candidateURLs {
            if NSWorkspace.shared.open(url) {
                break
            }
        }
    }
}

enum SettingsWindowLayout {
    // Keep enough room for six equal tab targets, including the longest
    // supported localized labels, without truncation or an overflow control.
    static let contentSize = NSSize(width: 860, height: 680)
}

enum SettingsTab: Hashable, CaseIterable {
    case general
    case notifications
    case memory
    case proxy
    case gateway
    case archivedSessions

    var titleKey: String {
        switch self {
        case .general: "General"
        case .notifications: "Notifications"
        case .memory: "Memory Inspector"
        case .proxy: "Proxy"
        case .gateway: "Gateway"
        case .archivedSessions: "Archived Sessions"
        }
    }

    var systemImage: String {
        switch self {
        case .general: "gearshape"
        case .notifications: "bell"
        case .memory: "brain.head.profile"
        case .proxy: "network"
        case .gateway: "message.badge.filled.fill"
        case .archivedSessions: "archivebox"
        }
    }
}

struct SettingsView: View {
    @ObservedObject private var backendClient = BackendClient.shared
    @ObservedObject private var appLanguage = AppLanguageController.shared
    var onClose: () -> Void = {}
    @State private var selectedTab = SettingsTab.general
    @State private var archivedSessionPendingDeletion: TaskSession?
    @State private var dataDir = ""
    @State private var logDir = ""
    @State private var choiceParser = ChoiceParserSettings.defaults
    @State private var savedChoiceParser = ChoiceParserSettings.defaults
    @State private var codexBackend = CodexBackendSettings.defaults
    @State private var savedCodexBackend = CodexBackendSettings.defaults
    @State private var codeDiff = CodeDiffSettings.defaults
    @State private var savedCodeDiff = CodeDiffSettings.defaults
    @State private var agentProxy = AgentProxySettings.defaults
    @State private var savedAgentProxy = AgentProxySettings.defaults
    @State private var gateway = GatewaySettings.defaults
    @State private var savedGateway = GatewaySettings.defaults
    @State private var choiceParserStatus: ChoiceParserStatus = .idle
    @State private var feishuAddMode = "credentials"
    @State private var newFeishuAppId = ""
    @State private var newFeishuAppSecret = ""
    @State private var newFeishuProfile = ""
    @State private var feishuPairingCodes: [String: FeishuPairingCodeResponse] = [:]

    var body: some View {
        VStack(spacing: 12) {
            settingsTabBar

            selectedSettingsTab

            Divider()

            HStack {
                Spacer()
                if selectedTab == .archivedSessions || selectedTab == .notifications || selectedTab == .memory {
                    Button(L10n("Close")) {
                        onClose()
                    }
                    .keyboardShortcut(.defaultAction)
                } else {
                    Button(L10n("Save")) {
                        Task {
                            await saveAllSettings()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(
                        backendClient.isUpdatingSettings
                        || dataDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || logDir.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }
            }
        }
        .padding(20)
        .frame(
            width: SettingsWindowLayout.contentSize.width,
            height: SettingsWindowLayout.contentSize.height
        )
        .task {
            await backendClient.loadSettings()
            await backendClient.loadFeishuBots()
            await backendClient.loadFeishuProfiles()
            selectDefaultFeishuProfileIfNeeded()
            await backendClient.loadModels(for: "codex-pty")
            if dataDir.isEmpty {
                dataDir = backendClient.settings?.dataDir ?? defaultDataDirectory
            }
            logDir = backendClient.settings?.logDir ?? defaultLogDirectory
            choiceParser = backendClient.settings?.choiceParser ?? .defaults
            savedChoiceParser = choiceParser
            codexBackend = backendClient.settings?.codexBackend ?? .defaults
            savedCodexBackend = codexBackend
            codeDiff = backendClient.settings?.codeDiff ?? .defaults
            savedCodeDiff = codeDiff
            agentProxy = backendClient.settings?.agentProxy ?? .defaults
            savedAgentProxy = agentProxy
            gateway = backendClient.settings?.gateway ?? .defaults
            savedGateway = gateway
        }
        .onChange(of: backendClient.settings) { _, settings in
            if let settings {
                dataDir = settings.dataDir
                logDir = settings.logDir ?? defaultLogDirectory
                choiceParser = settings.choiceParser ?? .defaults
                savedChoiceParser = choiceParser
                codexBackend = settings.codexBackend ?? .defaults
                savedCodexBackend = codexBackend
                codeDiff = settings.codeDiff ?? .defaults
                savedCodeDiff = codeDiff
                agentProxy = settings.agentProxy ?? .defaults
                savedAgentProxy = agentProxy
                gateway = settings.gateway ?? .defaults
                savedGateway = gateway
                choiceParserStatus = .idle
            }
        }
        .onChange(of: selectedTab) { _, tab in
            guard tab == .archivedSessions else { return }
            Task { await backendClient.refreshArchivedSessions() }
        }
        .confirmationDialog(
            L10n("Delete this archived session permanently?"),
            isPresented: Binding(
                get: { archivedSessionPendingDeletion != nil },
                set: { if !$0 { archivedSessionPendingDeletion = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button(L10n("Delete"), role: .destructive) {
                guard let session = archivedSessionPendingDeletion else { return }
                archivedSessionPendingDeletion = nil
                backendClient.delete(session: session)
            }
            Button(L10n("Cancel"), role: .cancel) {
                archivedSessionPendingDeletion = nil
            }
        } message: {
            Text(L10n("This action cannot be undone."))
        }
        .environment(\.locale, appLanguage.locale)
    }

    private var settingsTabBar: some View {
        HStack(spacing: 8) {
            ForEach(SettingsTab.allCases, id: \.self) { tab in
                Button {
                    selectedTab = tab
                } label: {
                    VStack(spacing: 4) {
                        Image(systemName: tab.systemImage)
                            .font(.system(size: 18))
                        Text(L10n(tab.titleKey))
                            .font(.caption)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .contentShape(Rectangle())
                    .background {
                        if selectedTab == tab {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.accentColor.opacity(0.12))
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("settings.tab.\(tab)")
                .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
            }
        }
    }

    @ViewBuilder
    private var selectedSettingsTab: some View {
        switch selectedTab {
        case .general:
            generalSettingsTab
        case .notifications:
            NotificationSettingsView()
        case .memory:
            MemoryManagementView(scope: .global)
        case .proxy:
            proxySettingsTab
        case .gateway:
            feishuSettingsTab
        case .archivedSessions:
            archivedSessionsTab
        }
    }

    private var generalSettingsTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("Storage"))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10nFormat(
                        "%@ environment on port %lld.",
                        L10n(CorptieAppEnvironment.displayName),
                        CorptieAppEnvironment.backendPort
                    ))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                if backendClient.isUpdatingSettings {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Data Directory"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                HStack(spacing: 8) {
                    TextField(L10n("Choose a data directory"), text: $dataDir)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))

                    Button {
                        chooseDataDirectory()
                    } label: {
                        Image(systemName: "folder")
                    }
                    .help(L10n("Choose data directory"))
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Log Directory"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                HStack(spacing: 8) {
                    TextField(L10n("Choose a log directory"), text: $logDir)
                        .textFieldStyle(.roundedBorder)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))

                    Button {
                        chooseLogDirectory()
                    } label: {
                        Image(systemName: "folder")
                    }
                    .help(L10n("Choose log directory"))
                }
                Text(L10n("Backend logs rotate automatically at 20 MB and keep five backups."))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
            }

            if let settings = backendClient.settings {
                VStack(alignment: .leading, spacing: 5) {
                    Text(L10n("Database"))
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Text(settings.dbPath)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .textSelection(.enabled)
                        .lineLimit(2)
                }
                if let configPath = settings.configPath {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(L10n("Config"))
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Text(configPath)
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .foregroundStyle(CorptiePalette.secondaryText)
                            .textSelection(.enabled)
                            .lineLimit(2)
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Language"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                Picker(L10n(""), selection: $appLanguage.selection) {
                    ForEach(AppLanguage.allCases) { language in
                        Text(L10n(language.localizationKey)).tag(language)
                    }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .frame(maxWidth: 220, alignment: .leading)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Session Management"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(L10n("Archived Sessions"))
                            .font(.system(size: 12, weight: .semibold))
                        Text(L10n("View or restore sessions removed from the main screen."))
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                    }
                    Spacer()
                    Button(L10n("View…"), systemImage: "archivebox") {
                        selectedTab = .archivedSessions
                    }
                }
            }

            VStack(alignment: .leading, spacing: 8) {
                Text(L10n("Codex Backend"))
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(CorptiePalette.secondaryText)
                Picker(L10n(""), selection: $codexBackend.mode) {
                    Text(L10n("App Server")).tag("app-server")
                    Text(L10n("PTY Legacy")).tag("pty")
                }
                .pickerStyle(.segmented)
                .help(L10n("Choose how new Codex sessions are created. App Server uses Codex JSON-RPC; PTY Legacy drives the terminal UI."))
                Text(codexBackend.mode == "app-server" ? L10n("New Codex sessions use the official Codex app-server protocol.") : L10n("New Codex sessions use the legacy terminal adapter."))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(CorptiePalette.secondaryText)
            }

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L10n("Code Diff Tool"))
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Text(L10n("Used when you review files changed by a Codex reply."))
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                Picker(L10n(""), selection: $codeDiff.tool) {
                    Text(L10n("Automatic")).tag("automatic")
                    Text(L10n("Git Difftool")).tag("git-difftool")
                    Text(L10n("FileMerge")).tag("filemerge")
                    Text(L10n("Visual Studio Code")).tag("vscode")
                    Text(L10n("Kaleidoscope")).tag("kaleidoscope")
                    Text(L10n("Beyond Compare")).tag("beyond-compare")
                    Text(L10n("Sublime Merge")).tag("sublime-merge")
                }
                .labelsHidden()
                .frame(width: 180)
            }

            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Toggle(L10n("Use LLM-enhanced interactions"), isOn: llmInteractionEnabled)
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(CorptiePalette.secondaryText)
                    Spacer()
                }
                .help(L10n("Enable model-assisted parsing for terminal choice prompts"))

                if choiceParser.provider != "disabled" {
                    Picker(L10n(""), selection: $choiceParser.provider) {
                        Text(L10n("Local Agent")).tag("local-agent")
                        Text(L10n("OpenAI-compatible")).tag("openai")
                    }
                    .pickerStyle(.segmented)
                    .help(L10n("Choose how Corptie parses terminal choice prompts"))

                    if choiceParser.provider == "openai" {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField(L10n("Base URL, e.g. https://api.openai.com/v1"), text: $choiceParser.openaiBaseURL)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            TextField(L10n("OpenAI API key"), text: $choiceParser.openaiApiKey)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            TextField(L10n("Parser model"), text: $choiceParser.openaiModel)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField(L10n("Agent command"), text: $choiceParser.localCommand)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            TextField(L10n("Fixed arguments"), text: $choiceParser.localArgs)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            ParserModelPicker(
                                title: "Model",
                                selection: $choiceParser.localModel,
                                defaultModel: "",
                                allowAutomatic: true
                            )
                        }
                    }

                    HStack {
                        Text(L10n("Timeout"))
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Stepper("\(choiceParser.timeoutMs / 1000)s", value: $choiceParser.timeoutMs, in: 1000...60000, step: 1000)
                            .font(.system(size: 11, weight: .medium))
                    }
                }

                HStack(spacing: 8) {
                    Button(L10n("Test")) {
                        Task {
                            await testChoiceParser()
                        }
                    }
                    .disabled(choiceParser.provider == "disabled" || backendClient.isTestingChoiceParser || backendClient.isUpdatingSettings)

                    Button(L10n("Confirm")) {
                        Task {
                            await confirmChoiceParser()
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!isChoiceParserDirty || backendClient.isTestingChoiceParser || backendClient.isUpdatingSettings)

                    if isChoiceParserDirty {
                        Button(L10n("Cancel")) {
                            choiceParser = savedChoiceParser
                            choiceParserStatus = .idle
                        }
                    }

                    if backendClient.isTestingChoiceParser {
                        ProgressView()
                            .controlSize(.small)
                    }

                    Text(choiceParserStatus.message)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(choiceParserStatus.color)
                }
                .onChange(of: choiceParser) { _, _ in
                    choiceParserStatus = .idle
                }
            }

            if let error = backendClient.lastError {
                Text(error)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
                }
                .padding(.trailing, 8)
            }

        }
    }

    private var archivedSessionsTab: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("Archived Sessions"))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10n("Archived sessions are hidden from the main screen until you restore them."))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }

                Spacer()

                if backendClient.isLoadingArchivedSessions {
                    ProgressView()
                        .controlSize(.small)
                }

                Button(L10n("Refresh"), systemImage: "arrow.clockwise") {
                    Task { await backendClient.refreshArchivedSessions() }
                }
                .disabled(backendClient.isLoadingArchivedSessions)
            }

            if backendClient.archivedSessions.isEmpty {
                ContentUnavailableView(
                    L10n("No archived sessions"),
                    systemImage: "archivebox",
                    description: Text(L10n("Sessions you archive will appear here and can be restored at any time."))
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(backendClient.archivedSessions) { session in
                    HStack(spacing: 12) {
                        Image(systemName: "archivebox.fill")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(session.accent.color)
                            .frame(width: 28)

                        VStack(alignment: .leading, spacing: 3) {
                            Text(session.title)
                                .font(.system(size: 13, weight: .semibold))
                                .lineLimit(1)
                            HStack(spacing: 7) {
                                Text(session.agent)
                                Text("·")
                                Text(session.status.label)
                                if !session.summary.isEmpty {
                                    Text("·")
                                    Text(session.summary)
                                        .lineLimit(1)
                                }
                            }
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        }

                        Spacer(minLength: 8)

                        Button(L10n("Restore"), systemImage: "tray.and.arrow.up") {
                            backendClient.setArchived(false, session: session)
                        }
                        .buttonStyle(.borderless)

                        Button(L10n("Delete"), systemImage: "trash", role: .destructive) {
                            archivedSessionPendingDeletion = session
                        }
                        .buttonStyle(.borderless)
                    }
                    .padding(.vertical, 5)
                }
                .listStyle(.inset)
            }
        }
        .padding(.top, 8)
    }

    private var proxySettingsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("Agent Proxy"))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10n("Proxy settings are applied per agent when Corptie launches agent processes."))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                if backendClient.isUpdatingSettings {
                    ProgressView()
                        .controlSize(.small)
                }
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ProxyProfileEditor(
                        title: L10n("Codex CLI"),
                        subtitle: L10n("Used by new Codex PTY sessions and resumed Codex sessions."),
                        profile: $agentProxy.codex
                    )

                    ProxyProfileEditor(
                        title: L10n("Choice Parser"),
                        subtitle: L10n("Used by the Local Agent choice parser test and parsing process."),
                        profile: $agentProxy.choiceParser
                    )

                    ProxyProfileEditor(
                        title: L10n("Generic PTY Agent"),
                        subtitle: L10n("Used by custom PTY agents launched from the advanced task form."),
                        profile: $agentProxy.pty
                    )
                }
                .padding(.vertical, 2)
            }

            if let error = backendClient.lastError {
                Text(error)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

        }
    }

    private var feishuSettingsTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L10n("Feishu Gateway"))
                        .font(.system(size: 18, weight: .semibold, design: .rounded))
                    Text(L10n("Connect trusted Feishu users to sessions on this Mac."))
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                if backendClient.isUpdatingFeishu {
                    ProgressView()
                        .controlSize(.small)
                }
                Button {
                    Task { await backendClient.loadFeishuBots() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help(L10n("Refresh Feishu bots"))
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(L10n("Trusted Workspaces"))
                                    .font(.system(size: 13, weight: .bold))
                                Text(L10n("These folders appear first when a Feishu user creates a session. Paths used by existing sessions are included automatically."))
                                    .font(.system(size: 10, weight: .medium))
                                    .foregroundStyle(CorptiePalette.secondaryText)
                            }
                            Spacer()
                            Button(L10n("Add Folder…")) {
                                addTrustedWorkspace()
                            }
                            .controlSize(.small)
                        }

                        if gateway.trustedWorkspaces.isEmpty {
                            Text(L10n("No pinned workspaces. Existing and recent session folders remain available in Feishu."))
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        } else {
                            ForEach(gateway.trustedWorkspaces, id: \.self) { path in
                                HStack(spacing: 8) {
                                    Image(systemName: "folder.fill")
                                        .foregroundStyle(.blue)
                                    Text(path)
                                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                        .help(path)
                                    Spacer()
                                    Button {
                                        gateway.trustedWorkspaces.removeAll { $0 == path }
                                    } label: {
                                        Image(systemName: "minus.circle")
                                    }
                                    .buttonStyle(.plain)
                                    .help(L10n("Remove trusted workspace"))
                                }
                            }
                        }
                    }
                    .padding(12)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))

                    if backendClient.feishuBots.isEmpty {
                        ContentUnavailableView(
                            L10n("No Feishu Bots"),
                            systemImage: "message.badge",
                            description: Text(L10n("Add a lark-cli profile below. A bot stays stopped until you explicitly enable it."))
                        )
                        .frame(maxWidth: .infinity, minHeight: 150)
                    } else {
                        ForEach(backendClient.feishuBots) { bot in
                            feishuBotCard(bot)
                        }
                    }

                    Divider()

                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(L10n("Add Bot"))
                                .font(.system(size: 13, weight: .bold))
                            Spacer()
                            Link(L10n("Create or configure in Feishu Open Platform"), destination: URL(string: "https://open.feishu.cn/app")!)
                                .font(.system(size: 10, weight: .semibold))
                        }
                        Text(L10n("Feishu requires the enterprise app and bot capability to be created and published in its developer console first. Corptie connects that existing app to local sessions."))
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(CorptiePalette.secondaryText)
                        Picker(L10n(""), selection: $feishuAddMode) {
                            Text(L10n("App Credentials")).tag("credentials")
                            Text(L10n("Existing CLI Profile")).tag("profile")
                        }
                        .pickerStyle(.segmented)
                        if feishuAddMode == "credentials" {
                            TextField(L10n("Feishu App ID"), text: $newFeishuAppId)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                            SecureField(L10n("Feishu App Secret"), text: $newFeishuAppSecret)
                                .textFieldStyle(.roundedBorder)
                                .font(.system(size: 12, weight: .medium, design: .monospaced))
                        } else if availableFeishuProfiles.isEmpty {
                            Text(L10n("No unused lark-cli Profiles are available. Add a Profile in lark-cli or remove its existing Gateway bot first."))
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(CorptiePalette.secondaryText)
                        } else {
                            Picker(L10n("lark-cli Profile"), selection: $newFeishuProfile) {
                                ForEach(availableFeishuProfiles) { profile in
                                    Text(profile.active ? "\(profile.name) (Active)" : profile.name)
                                        .tag(profile.name)
                                }
                            }
                            .pickerStyle(.menu)
                        }
                        HStack {
                            Text(feishuAddMode == "credentials"
                                ? L10n("The App Secret is passed directly to lark-cli encrypted storage and is never saved in the Corptie database.")
                                : L10n("The existing Profile and its credentials remain owned by lark-cli and are never removed by Corptie."))
                                .font(.system(size: 10, weight: .medium))
                                .foregroundStyle(CorptiePalette.secondaryText)
                            Spacer()
                            Button(L10n("Add Bot")) {
                                Task {
                                    let added = if feishuAddMode == "credentials" {
                                        await backendClient.addFeishuBot(appId: newFeishuAppId, appSecret: newFeishuAppSecret)
                                    } else {
                                        await backendClient.addFeishuBot(profile: newFeishuProfile)
                                    }
                                    if added {
                                        newFeishuAppId = ""
                                        newFeishuAppSecret = ""
                                        await backendClient.loadFeishuProfiles()
                                        selectDefaultFeishuProfileIfNeeded()
                                    }
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(!canAddFeishuBot || backendClient.isUpdatingFeishu)
                        }
                    }
                    .padding(12)
                    .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .padding(.trailing, 8)
            }

            if let error = backendClient.lastError {
                Text(error)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        }
    }

    @ViewBuilder
    private func feishuBotCard(_ bot: FeishuBot) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if let avatar = bot.remoteAvatarURL.flatMap(URL.init(string:)) {
                    AsyncImage(url: avatar) { image in
                        image
                            .resizable()
                            .scaledToFill()
                    } placeholder: {
                        DefaultInitialAvatarView(
                            seed: bot.remoteName ?? bot.name,
                            initials: DefaultAvatarInitials.make(from: bot.remoteName ?? bot.name),
                            size: 30
                        )
                    }
                    .frame(width: 30, height: 30)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                } else {
                    DefaultInitialAvatarView(
                        seed: bot.remoteName ?? bot.name,
                        initials: DefaultAvatarInitials.make(from: bot.remoteName ?? bot.name),
                        size: 30
                    )
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(bot.remoteName ?? L10n("Loading Feishu bot identity…"))
                        .font(.system(size: 13, weight: .bold))
                    if let remoteName = bot.remoteName {
                        Text(L10nFormat("Search in Feishu: %@", remoteName))
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.blue)
                    }
                    Text(L10nFormat("App ID: %@ · Profile: %@", bot.appId ?? L10n("Unknown"), bot.profile))
                        .font(.system(size: 10, weight: .medium, design: .monospaced))
                        .foregroundStyle(CorptiePalette.secondaryText)
                        .textSelection(.enabled)
                }
                Spacer()
                Text(feishuConnectionLabel(bot))
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(bot.connectionStatus == "connected" ? .green : CorptiePalette.secondaryText)
                Toggle(L10n(""), isOn: Binding(
                    get: { bot.enabled },
                    set: { enabled in
                        Task { await backendClient.setFeishuBotEnabled(bot, enabled: enabled) }
                    }
                ))
                .labelsHidden()
                .toggleStyle(.switch)
                .controlSize(.small)
            }

            if let error = bot.lastError, !error.isEmpty {
                Text(error)
                    .font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.red)
            }

            HStack(spacing: 14) {
                Label(bot.bindings.isEmpty ? L10n("Not paired") : L10n("Paired"), systemImage: bot.bindings.isEmpty ? "person.crop.circle.badge.questionmark" : "person.crop.circle.badge.checkmark")
                if let assignment = bot.assignment {
                    Label(assignment.sessionId, systemImage: "link")
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Label(L10n("No session selected"), systemImage: "link.badge.plus")
                }
            }
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(CorptiePalette.secondaryText)

            if let pairing = feishuPairingCodes[bot.id] {
                HStack(spacing: 8) {
                    Text(L10n("Pairing code"))
                        .font(.system(size: 11, weight: .semibold))
                    Text(pairing.code)
                        .font(.system(size: 18, weight: .bold, design: .monospaced))
                        .textSelection(.enabled)
                    Text(L10nFormat("expires %@", pairing.expiresAt))
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                .padding(.vertical, 4)
            }

            HStack(spacing: 8) {
                Button(L10n("Generate Pairing Code")) {
                    Task {
                        if case .success(let pairing) = await backendClient.createFeishuPairingCode(for: bot) {
                            feishuPairingCodes[bot.id] = pairing
                        }
                    }
                }
                .disabled(!bot.enabled)
                if let binding = bot.bindings.first {
                    Button(L10n("Unpair")) {
                        Task { await backendClient.revokeFeishuBinding(binding) }
                    }
                }
                if bot.assignment != nil {
                    Button(L10n("Release Session")) {
                        Task { await backendClient.releaseFeishuSession(for: bot) }
                    }
                }
                Spacer()
                Button(L10n("Delete"), role: .destructive) {
                    Task {
                        if await backendClient.deleteFeishuBot(bot) {
                            feishuPairingCodes.removeValue(forKey: bot.id)
                            selectDefaultFeishuProfileIfNeeded()
                        }
                    }
                }
            }
            .controlSize(.small)
            .disabled(backendClient.isUpdatingFeishu)
        }
        .padding(12)
        .background(.quaternary.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func feishuConnectionLabel(_ bot: FeishuBot) -> String {
        switch bot.connectionStatus {
        case "connected": L10n("Connected")
        case "connecting": L10n("Connecting")
        case "error": L10n("Error")
        default: L10n("Stopped")
        }
    }

    private var availableFeishuProfiles: [FeishuProfile] {
        let usedProfiles = Set(backendClient.feishuBots.map(\.profile))
        return backendClient.feishuProfiles.filter { !usedProfiles.contains($0.name) }
    }

    private var canAddFeishuBot: Bool {
        if feishuAddMode == "profile" {
            return availableFeishuProfiles.contains { $0.name == newFeishuProfile }
        }
        return !newFeishuAppId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !newFeishuAppSecret.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func selectDefaultFeishuProfileIfNeeded() {
        guard !availableFeishuProfiles.contains(where: { $0.name == newFeishuProfile }) else {
            return
        }
        newFeishuProfile = availableFeishuProfiles.first(where: { $0.active })?.name
            ?? availableFeishuProfiles.first?.name
            ?? ""
    }

    private var llmInteractionEnabled: Binding<Bool> {
        Binding(
            get: { choiceParser.provider != "disabled" },
            set: { enabled in
                choiceParser.provider = enabled ? (savedChoiceParser.provider == "openai" ? "openai" : "local-agent") : "disabled"
                choiceParserStatus = .idle
            }
        )
    }

    private var isChoiceParserDirty: Bool {
        choiceParser != savedChoiceParser
    }

    private func addTrustedWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.canCreateDirectories = false
        panel.prompt = L10n("Add Workspace")
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            let path = url.standardizedFileURL.path
            if !gateway.trustedWorkspaces.contains(path) {
                gateway.trustedWorkspaces.append(path)
            }
        }
    }

    private func saveAllSettings() async {
        if await backendClient.updateSettings(
            dataDir: dataDir,
            logDir: logDir,
            choiceParser: choiceParser,
            codexBackend: codexBackend,
            codeDiff: codeDiff,
            agentProxy: agentProxy,
            gateway: gateway
        ) {
            savedChoiceParser = choiceParser
            savedCodexBackend = codexBackend
            savedCodeDiff = codeDiff
            savedAgentProxy = agentProxy
            savedGateway = gateway
            choiceParserStatus = .saved
            onClose()
        }
    }

    private func confirmChoiceParser() async {
        choiceParserStatus = .idle
        if await backendClient.updateSettings(dataDir: dataDir, logDir: logDir, choiceParser: choiceParser, codexBackend: codexBackend, codeDiff: codeDiff, agentProxy: agentProxy, gateway: gateway) {
            savedChoiceParser = choiceParser
            savedCodexBackend = codexBackend
            savedCodeDiff = codeDiff
            savedAgentProxy = agentProxy
            savedGateway = gateway
            choiceParserStatus = .saved
        } else {
            choiceParserStatus = .failed(backendClient.lastError ?? L10n("Save failed"))
        }
    }

    private func testChoiceParser() async {
        choiceParserStatus = .idle
        guard choiceParser.provider != "disabled" else {
            return
        }
        switch await backendClient.testChoiceParser(choiceParser, agentProxy: agentProxy) {
        case .success(let message):
            choiceParserStatus = .passed(message)
        case .failure(let error):
            choiceParserStatus = .failed(error.localizedDescription)
        }
    }

    private func chooseDataDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: dataDir.isEmpty ? defaultDataDirectory : dataDir)

        if panel.runModal() == .OK, let url = panel.url {
            dataDir = url.path
        }
    }

    private func chooseLogDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: logDir.isEmpty ? defaultLogDirectory : logDir)

        if panel.runModal() == .OK, let url = panel.url {
            logDir = url.path
        }
    }

    private var defaultDataDirectory: String {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        return support?.appendingPathComponent(CorptieAppEnvironment.appSupportFolderName, isDirectory: true).path ?? NSHomeDirectory()
    }

    private var defaultLogDirectory: String {
        let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask).first?
            .appendingPathComponent("Logs", isDirectory: true)
        return logs?.appendingPathComponent(CorptieAppEnvironment.appSupportFolderName, isDirectory: true).path ?? NSHomeDirectory()
    }
}

private struct ProxyProfileEditor: View {
    let title: String
    let subtitle: String
    @Binding var profile: AgentProxyProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(CorptiePalette.primaryText)
                    Text(subtitle)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(CorptiePalette.secondaryText)
                }
                Spacer()
                Toggle(L10n(""), isOn: $profile.enabled)
                    .labelsHidden()
            }

            if profile.enabled {
                VStack(alignment: .leading, spacing: 8) {
                    proxyField("HTTP_PROXY", text: $profile.httpProxy, placeholder: "http://127.0.0.1:7890")
                    proxyField("HTTPS_PROXY", text: $profile.httpsProxy, placeholder: "http://127.0.0.1:7890")
                    proxyField("ALL_PROXY", text: $profile.allProxy, placeholder: "socks5h://127.0.0.1:7890")
                    proxyField("NO_PROXY", text: $profile.noProxy, placeholder: AgentProxyProfile.defaults.noProxy)
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.white.opacity(0.07))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
        )
    }

    private func proxyField(_ label: String, text: Binding<String>, placeholder: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .foregroundStyle(CorptiePalette.secondaryText)
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
        }
    }
}

private enum ChoiceParserStatus: Equatable {
    case idle
    case passed(String)
    case saved
    case failed(String)

    @MainActor var message: String {
        switch self {
        case .idle:
            ""
        case .passed(let text):
            text
        case .saved:
            L10n("Saved")
        case .failed(let text):
            text
        }
    }

    var color: Color {
        switch self {
        case .idle:
            CorptiePalette.secondaryText
        case .passed, .saved:
            CorptiePalette.connected
        case .failed:
            .red
        }
    }
}

private struct ParserModelPicker: View {
    @ObservedObject private var backendClient = BackendClient.shared
    let title: String
    @Binding var selection: String
    let defaultModel: String
    let allowAutomatic: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(CorptiePalette.secondaryText)

            if backendClient.codexModels.isEmpty {
                TextField(defaultModel.isEmpty ? L10n("Automatic") : defaultModel, text: $selection)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, weight: .medium, design: .monospaced))
            } else {
                Picker(L10n(""), selection: normalizedSelection) {
                    if allowAutomatic {
                        Text(L10n("Auto")).tag("")
                    }
                    ForEach(sortedModels) { model in
                        Text(model.name).tag(model.id)
                    }
                    if shouldShowCustom {
                        Text(L10nFormat("Custom: %@", selection)).tag(selection)
                    }
                }
                .labelsHidden()
                .pickerStyle(.menu)
                .help(L10n("Choose parser model"))
            }
        }
    }

    private var sortedModels: [CodexModel] {
        backendClient.codexModels.sorted { lhs, rhs in
            score(lhs) < score(rhs)
        }
    }

    private var shouldShowCustom: Bool {
        !selection.isEmpty && !backendClient.codexModels.contains { $0.id == selection }
    }

    private var normalizedSelection: Binding<String> {
        Binding(
            get: {
                if selection.isEmpty {
                    return allowAutomatic ? "" : defaultModel
                }
                return selection
            },
            set: { selection = $0 }
        )
    }

    private func score(_ model: CodexModel) -> Int {
        let id = model.id.lowercased()
        let name = model.name.lowercased()
        if id.contains("mini") || name.contains("mini") { return 0 }
        if id.contains("spark") || name.contains("spark") { return 1 }
        if id.contains("fast") || name.contains("fast") { return 2 }
        return 10
    }
}
