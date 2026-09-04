import AppKit
import SwiftUI

// Sessions 与控制台共用的栏位几何，确保 sidebar 与详情卡片宽度稳定。
enum TwoPaneLayoutMetrics {
    static let sidebarWidth: CGFloat = 300
    static let sidebarMaximumWidth: CGFloat = 520
    static let detailCardWidth: CGFloat = 300
    static let contentPadding: CGFloat = 16
    static let cardCornerRadius: CGFloat = 12
}

enum MainWindowLayoutMetrics {
    static let titlebarHeight: CGFloat = 32
    static let tabItemWidth: CGFloat = 42
    static let tabBarHeight: CGFloat = 26
    static let taskSurfaceWidth: CGFloat = 220
    static let titlebarTrailingInset: CGFloat = 12

    static var tabBarWidth: CGFloat {
        CGFloat(AppTab.allCases.count) * tabItemWidth
    }
}

enum MainWindowPageLayoutMetrics {
    static let outerPadding: CGFloat = 6
    static let columnSpacing: CGFloat = 6
    static let cardCornerRadius: CGFloat = 10
    static let cardShadowRadius: CGFloat = 5

    static var halfColumnSpacing: CGFloat { columnSpacing / 2 }
}

private struct MainWindowPageCardModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .clipShape(
                RoundedRectangle(
                    cornerRadius: MainWindowPageLayoutMetrics.cardCornerRadius,
                    style: .continuous
                )
            )
            .background(
                .regularMaterial,
                in: RoundedRectangle(
                    cornerRadius: MainWindowPageLayoutMetrics.cardCornerRadius,
                    style: .continuous
                )
            )
            .overlay {
                RoundedRectangle(
                    cornerRadius: MainWindowPageLayoutMetrics.cardCornerRadius,
                    style: .continuous
                )
                .stroke(Color(nsColor: .separatorColor).opacity(0.42), lineWidth: 1)
            }
            .shadow(
                color: Color.black.opacity(0.045),
                radius: MainWindowPageLayoutMetrics.cardShadowRadius,
                x: 0,
                y: 1
            )
    }
}

extension View {
    func mainWindowPageCard() -> some View {
        modifier(MainWindowPageCardModifier())
    }
}

// 顶层 Tab 枚举。会话已经并入统一控制台，不再保留独立 Sessions 入口。
enum AppTab: String, CaseIterable, Identifiable {
    case console
    case automations
    case worktrees
    case agents

    var id: String { rawValue }

    // Tab 在栏中的顺序，用于判断页面切换的滑动方向（前进/后退）。
    var index: Int {
        switch self {
        case .console: 0
        case .automations: 1
        case .worktrees: 2
        case .agents: 3
        }
    }

    @MainActor var title: String {
        switch self {
        case .console: L10n("Workbench")
        case .automations: L10n("Automations")
        case .worktrees: L10n("Worktrees")
        case .agents: L10n("Agents")
        }
    }

    var systemImage: String {
        switch self {
        case .console: "circle.hexagongrid.fill"
        case .automations: "bolt.badge.clock"
        case .worktrees: "arrow.triangle.branch"
        case .agents: "person.2"
        }
    }
}

enum MainTabSlideDirection: Equatable {
    case forward
    case backward

    var unitOffset: CGFloat {
        switch self {
        case .forward: 1
        case .backward: -1
        }
    }
}

struct MainTabTransition: Equatable {
    let from: AppTab
    let to: AppTab
    let direction: MainTabSlideDirection
}

/// Retains every visited tab's attached hosting view and SwiftUI state. During a
/// switch, only the old and new hosts are unhidden. Both keep an exact, stationary
/// frame equal to `bounds`; Core Animation translates their backing layers instead
/// of changing SwiftUI layout geometry on every animation frame. Cached inactive
/// hosts stay hidden and keep their previous frame, so resize cannot re-propose all
/// six heavyweight page layouts.
@MainActor
final class MainTabPageContainer: NSView {
    static let defaultAnimationDuration: TimeInterval = 0.22

    private let pageProvider: (AppTab) -> NSView
    private let animationDuration: TimeInterval
    private var pages: [AppTab: NSView] = [:]
    private var transitionGeneration: UInt = 0
    private(set) var selectedTab: AppTab?
    private(set) var transition: MainTabTransition?
    private(set) var pendingTab: AppTab?
    private(set) var activePageLayoutCount = 0

    init(
        animationDuration: TimeInterval = MainTabPageContainer.defaultAnimationDuration,
        pageProvider: @escaping (AppTab) -> NSView
    ) {
        self.animationDuration = animationDuration
        self.pageProvider = pageProvider
        super.init(frame: .zero)
        wantsLayer = true
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        layer?.masksToBounds = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    }

    override func layout() {
        super.layout()
        for tab in participatingTabs {
            guard let page = pages[tab], page.frame != bounds else { continue }
            page.frame = bounds
            activePageLayoutCount += 1
        }
    }

    func select(_ tab: AppTab, animated: Bool = true) {
        if transition != nil {
            if animated {
                // Keep the in-flight pair continuous and coalesce rapid clicks
                // to the latest destination. Interrupting a composited slide by
                // snapping either layer to its model value causes a visible jump.
                pendingTab = tab == selectedTab ? nil : tab
            } else {
                pendingTab = nil
                finishTransition(generation: transitionGeneration, startsPendingTransition: false)
                select(tab, animated: false)
            }
            return
        }
        guard selectedTab != tab else {
            needsLayout = true
            return
        }

        guard let previousTab = selectedTab else {
            let page = page(for: tab)
            selectedTab = tab
            attach(page, for: tab)
            resetLayer(of: page)
            updateVisibilityAndAccessibility()
            return
        }

        let oldPage = page(for: previousTab)
        let newPage = page(for: tab)
        let direction: MainTabSlideDirection = tab.index > previousTab.index ? .forward : .backward
        let nextTransition = MainTabTransition(from: previousTab, to: tab, direction: direction)

        selectedTab = tab
        transition = nextTransition
        transitionGeneration &+= 1
        let generation = transitionGeneration

        attach(oldPage, for: previousTab)
        attach(newPage, for: tab)
        addSubview(newPage, positioned: .above, relativeTo: oldPage)
        updateVisibilityAndAccessibility()

        guard animated, animationDuration > 0, bounds.width > 0 else {
            finishTransition(generation: generation)
            return
        }
        animate(nextTransition, oldPage: oldPage, newPage: newPage, generation: generation)
    }

    var cachedPageCount: Int { pages.count }
    var attachedPageCount: Int { subviews.count }
    var attachedTabs: [AppTab] {
        pages.compactMap { tab, page in page.superview === self ? tab : nil }
            .sorted { $0.index < $1.index }
    }
    var visibleTabs: [AppTab] {
        pages.compactMap { tab, page in
            page.superview === self && !page.isHidden ? tab : nil
        }
        .sorted { $0.index < $1.index }
    }

    func cachedPage(for tab: AppTab) -> NSView? {
        pages[tab]
    }

    /// Deterministic completion hook used by reduced-motion updates and tests.
    func finishActiveTransition() {
        guard transition != nil else { return }
        finishTransition(generation: transitionGeneration)
    }

    private func page(for tab: AppTab) -> NSView {
        if let page = pages[tab] { return page }
        let created = pageProvider(tab)
        created.autoresizingMask = []
        created.wantsLayer = true
        pages[tab] = created
        return created
    }

    private func attach(_ page: NSView, for tab: AppTab) {
        if page.superview !== self {
            addSubview(page)
        }
        if page.frame != bounds {
            page.frame = bounds
            activePageLayoutCount += 1
        }
        page.isHidden = false
    }

    private func animate(
        _ transition: MainTabTransition,
        oldPage: NSView,
        newPage: NSView,
        generation: UInt
    ) {
        let travel = max(1, bounds.width) * transition.direction.unitOffset
        resetLayer(of: oldPage)
        resetLayer(of: newPage)

        CATransaction.begin()
        CATransaction.setDisableActions(true)
        CATransaction.setCompletionBlock { [weak self] in
            Task { @MainActor [weak self] in
                self?.finishTransition(generation: generation)
            }
        }
        addCompositeAnimation(
            to: oldPage,
            fromX: 0,
            toX: -travel,
            fromOpacity: 1,
            toOpacity: 0.92
        )
        addCompositeAnimation(
            to: newPage,
            fromX: travel,
            toX: 0,
            fromOpacity: 0.92,
            toOpacity: 1
        )
        CATransaction.commit()
    }

    private func addCompositeAnimation(
        to page: NSView,
        fromX: CGFloat,
        toX: CGFloat,
        fromOpacity: Float,
        toOpacity: Float
    ) {
        guard let layer = page.layer else { return }
        layer.setValue(toX, forKeyPath: "transform.translation.x")
        layer.opacity = toOpacity

        let translation = CABasicAnimation(keyPath: "transform.translation.x")
        translation.fromValue = fromX
        translation.toValue = toX
        translation.duration = animationDuration
        translation.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 0.9, 0.24, 1)

        let opacity = CABasicAnimation(keyPath: "opacity")
        opacity.fromValue = fromOpacity
        opacity.toValue = toOpacity
        opacity.duration = animationDuration
        opacity.timingFunction = translation.timingFunction

        layer.add(translation, forKey: "main-tab-translation")
        layer.add(opacity, forKey: "main-tab-opacity")
    }

    private func finishTransition(
        generation: UInt,
        startsPendingTransition: Bool = true
    ) {
        guard generation == transitionGeneration, transition != nil else { return }
        let nextTab = startsPendingTransition ? pendingTab : nil
        pendingTab = nil
        for page in pages.values {
            page.layer?.removeAllAnimations()
            resetLayer(of: page)
        }
        transition = nil
        updateVisibilityAndAccessibility()
        if let nextTab, nextTab != selectedTab {
            select(nextTab, animated: true)
        }
    }

    private func updateVisibilityAndAccessibility() {
        for (tab, page) in pages {
            let participates = participatingTabs.contains(tab)
            page.isHidden = !participates
            // The destination owns interaction and accessibility immediately;
            // the outgoing page is visual transition material only.
            page.setAccessibilityHidden(tab != selectedTab)
        }
    }

    private var participatingTabs: Set<AppTab> {
        if let transition {
            return [transition.from, transition.to]
        }
        if let selectedTab {
            return [selectedTab]
        }
        return []
    }

    private func resetLayer(of page: NSView) {
        guard let layer = page.layer else { return }
        layer.setValue(CGFloat.zero, forKeyPath: "transform.translation.x")
        layer.opacity = 1
    }
}

private struct MainTabPageHost: NSViewRepresentable {
    let selection: AppTab
    let router: AppTabRouter
    let resizeState: MainWindowResizeState
    @Environment(\.accessibilityReduceMotion) private var accessibilityReduceMotion

    func makeNSView(context: Context) -> MainTabPageContainer {
        let container = MainTabPageContainer { tab in
            let root: AnyView
            switch tab {
            case .console:
                root = AnyView(UnifiedConsoleView())
            case .automations:
                root = AnyView(AutomationsView())
            case .worktrees:
                root = AnyView(WorktreeManagementView())
            case .agents:
                root = AnyView(AgentManagementView())
            }
            let hostingView = NSHostingView(
                rootView: root
                    .environmentObject(router)
                    .environmentObject(resizeState)
                    .environmentObject(router.sidebarState(for: tab))
            )
            hostingView.sizingOptions = []
            hostingView.layerContentsRedrawPolicy = .duringViewResize
            return hostingView
        }
        container.select(selection, animated: false)
        return container
    }

    func updateNSView(_ container: MainTabPageContainer, context: Context) {
        container.select(selection, animated: !accessibilityReduceMotion && !resizeState.isLiveResize)
    }
}

// MARK: - 胶囊式 Tab 栏
// 固定尺寸的纯图标 Tab；选中项使用内嵌的小胶囊和反色前景。

struct UnderlineTabBar: View {
    @Binding var selection: AppTab

    private let selectionAnimation = Animation.timingCurve(
        0.22,
        0.9,
        0.24,
        1.0,
        duration: 0.15
    )

    var body: some View {
        HStack(spacing: 0) {
            ForEach(AppTab.allCases) { tab in
                UnderlineTabButton(
                    tab: tab,
                    isSelected: selection == tab
                ) {
                    select(tab)
                }
                .frame(width: MainWindowLayoutMetrics.tabItemWidth)
            }
        }
        .frame(height: MainWindowLayoutMetrics.tabBarHeight)
        .contentShape(Rectangle())
        .background {
            Capsule()
                .fill(Color.primary.opacity(0.035))
        }
        .overlay {
            Capsule()
                .stroke(Color(nsColor: .separatorColor).opacity(0.18), lineWidth: 0.5)
        }
        .shadow(
            color: Color.black.opacity(0.025),
            radius: 3,
            x: 0,
            y: 1
        )
    }

    private func select(_ tab: AppTab) {
        withAnimation(selectionAnimation) {
            selection = tab
        }
    }
}

private struct UnderlineTabButton: View {
    let tab: AppTab
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: tab.systemImage)
                .font(.system(
                    size: 13,
                    weight: isSelected ? .semibold : .regular
                ))
                .frame(height: 16)
                .foregroundStyle(
                    isSelected
                        ? Color(nsColor: .windowBackgroundColor)
                        : Color.secondary
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background {
                    Capsule()
                        .fill(isSelected ? Color.primary : Color.clear)
                        .padding(.horizontal, 3)
                        .padding(.vertical, 2)
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(tab.title)
        .accessibilityLabel(tab.title)
        .accessibilityIdentifier("main-tab.\(tab.rawValue)")
        .accessibilityValue(isSelected ? "selected" : "not-selected")
        .animation(.easeInOut(duration: 0.15), value: isSelected)
    }
}

// MARK: - 主窗口独立渲染表面

/// The heavyweight page surface starts at AppKit's native title-bar safe area;
/// no second spacer row is reserved below the compact title-bar controls.
struct MainWindowContentView: View {
    @StateObject private var router = AppTabRouter.shared
    @StateObject private var selectionState = AppTabRouter.shared.selectionState
    @EnvironmentObject private var resizeState: MainWindowResizeState

    var body: some View {
        MainTabPageHost(
            selection: selectionState.selectedTab,
            router: router,
            resizeState: resizeState
        )
        .clipped()
        .environmentObject(router)
        .transaction { transaction in
            if resizeState.isLiveResize {
                transaction.animation = nil
                transaction.disablesAnimations = true
            }
        }
    }
}

/// A separately composited, constant-size title-bar surface. Keeping these
/// edge-anchored controls outside the coalesced main content prevents their
/// glyphs and frames from stretching and snapping at root layout commits.
struct MainWindowFixedChromeView: View {
    var body: some View {
        MainWindowChromeControls(
            openSettings: { AppDelegate.shared?.openSettings() }
        )
    }
}

/// The center tab bar keeps its original fixed 42-point item geometry. AppKit
/// moves this surface to the current window center without resizing the host.
struct MainWindowTabBarSurfaceView: View {
    @StateObject private var router = AppTabRouter.shared
    @StateObject private var selectionState = AppTabRouter.shared.selectionState

    var body: some View {
        UnderlineTabBar(selection: Binding(
            get: { selectionState.selectedTab },
            set: { router.selectTab($0) }
        ))
    }
}

/// The trailing status surface owns the same leaf renderer previously attached
/// as a root overlay. Its publications cannot invalidate content or tab layout.
struct MainWindowTaskSurfaceView: View {
    var body: some View {
        MainWindowBackgroundTaskOverlay()
            .frame(width: MainWindowLayoutMetrics.taskSurfaceWidth, alignment: .trailing)
    }
}

/// Keeps fixed window actions isolated from the resident tab page hierarchy.
private struct MainWindowChromeControls: View {
    @ObservedObject private var windowState = MainWindowPresentationState.shared
    let openSettings: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Button {
                AppDelegate.shared?.setMainWindowPinned(!windowState.isPinned)
            } label: {
                chromeIcon(
                    systemName: windowState.isPinned ? "pin.fill" : "pin",
                    isActive: windowState.isPinned
                )
            }
            .buttonStyle(.plain)
            .help(L10n(windowState.isPinned ? "Disable Always on Top" : "Enable Always on Top"))
            .accessibilityLabel(L10n("Always on Top"))
            .accessibilityValue(L10n(windowState.isPinned ? "On" : "Off"))
            .accessibilityIdentifier("main-window.pin")

            Button(action: openSettings) {
                chromeIcon(systemName: "gearshape", isActive: false)
            }
            .buttonStyle(.plain)
            .help(L10n("设置"))
            .accessibilityIdentifier("main-window.settings")
        }
    }

    private func chromeIcon(systemName: String, isActive: Bool) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 13, weight: isActive ? .semibold : .medium))
            .foregroundStyle(isActive ? Color.accentColor : Color.secondary)
            .frame(width: 24, height: 22)
            .background {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(isActive ? Color.accentColor.opacity(0.16) : Color.clear)
            }
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(
                        isActive ? Color.accentColor.opacity(0.45) : Color.clear,
                        lineWidth: 1
                    )
            }
            .contentShape(Rectangle())
    }
}

/// A persistent AppKit control for the cross-host sidebar binding.
///
/// The title-bar chrome and each tab page live in separate hosting trees. An
/// `NSButton` keeps the toggle's native view identity and hit target intact while
/// a `NavigationSplitView` removes or restores its sidebar in the page tree.
/// Rebinding the same control on tab changes preserves the per-tab state model.
struct MainWindowSidebarToggleButton: NSViewRepresentable {
    let sidebarState: TabSidebarState

    func makeNSView(context: Context) -> MainWindowSidebarNSButton {
        MainWindowSidebarNSButton(sidebarState: sidebarState)
    }

    func updateNSView(_ button: MainWindowSidebarNSButton, context: Context) {
        button.bind(to: sidebarState)
    }
}

@MainActor
enum MainWindowSidebarButtonAppearance {
    private static let symbolConfiguration = NSImage.SymbolConfiguration(
        pointSize: 13,
        weight: .medium
    )

    static func image(isVisible: Bool) -> NSImage? {
        if isVisible {
            return NSImage(systemSymbolName: "sidebar.left", accessibilityDescription: nil)?
                .withSymbolConfiguration(symbolConfiguration)
        }
        return collapsedImage
    }

    /// SF Symbols does not provide a `sidebar.left.slash` variant. Compose it
    /// once so the closed state retains the familiar sidebar silhouette while
    /// remaining a cheap image swap during tab changes and repeated toggles.
    private static let collapsedImage: NSImage? = {
        guard let sidebar = NSImage(
            systemSymbolName: "sidebar.left",
            accessibilityDescription: nil
        )?.withSymbolConfiguration(symbolConfiguration),
        let slash = NSImage(
            systemSymbolName: "line.diagonal",
            accessibilityDescription: nil
        )?.withSymbolConfiguration(
            NSImage.SymbolConfiguration(pointSize: 11, weight: .medium)
        ) else {
            return nil
        }

        let image = NSImage(size: sidebar.size, flipped: false) { bounds in
            sidebar.draw(in: bounds)
            slash.draw(in: bounds.insetBy(dx: 1, dy: 0))
            return true
        }
        image.isTemplate = true
        return image
    }()
}

@MainActor
final class MainWindowSidebarNSButton: NSButton {
    private var sidebarState: TabSidebarState

    init(sidebarState: TabSidebarState) {
        self.sidebarState = sidebarState
        super.init(frame: NSRect(x: 0, y: 0, width: 24, height: 22))
        target = self
        action = #selector(toggleSidebar)
        isBordered = false
        imagePosition = .imageOnly
        focusRingType = .none
        setAccessibilityIdentifier("main-window.sidebar")
        setAccessibilityLabel(L10n("Sidebar"))
        refreshAppearance()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func bind(to sidebarState: TabSidebarState) {
        self.sidebarState = sidebarState
        refreshAppearance()
    }

    @objc private func toggleSidebar() {
        sidebarState.toggle()
        // Keep the control truthful in the same event turn. SwiftUI will also
        // call updateNSView after the observable state publication.
        refreshAppearance()
    }

    private func refreshAppearance() {
        let isVisible = sidebarState.isVisible
        image = MainWindowSidebarButtonAppearance.image(isVisible: isVisible)
        contentTintColor = .secondaryLabelColor
        toolTip = L10n(isVisible ? "Hide Sidebar" : "Show Sidebar")
        setAccessibilityValue(L10n(isVisible ? "Expanded" : "Collapsed"))
    }
}

/// The main-window notification renderer is intentionally a leaf view.
///
/// Keeping these observable dependencies out of `MainTabView` prevents task and
/// connection publications from invalidating the tab container. Its parent uses
/// an overlay, so this view's changing intrinsic content size is also excluded
/// from the tab header's layout calculation.
private struct MainWindowBackgroundTaskOverlay: View {
    @StateObject private var backendClient = BackendClient.shared
    @StateObject private var entityClient = EntityAPIClient.shared
    @StateObject private var backgroundTasks = BackgroundTaskCenter.shared

    var body: some View {
        Group {
            if !backendClient.isOnline,
               entityClient.worksLoadError != nil,
               !backgroundTasks.records.contains(where: {
                   $0.id == BackgroundTaskCenter.backendConnectionTaskID
                       && $0.state != .succeeded
               }) {
                Label(L10n("Connecting to the server…"), systemImage: "network")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .allowsHitTesting(false)
            } else {
                BackgroundTaskStatusBar(center: backgroundTasks)
            }
        }
    }
}

// 跨 Tab 导航路由器：让「控制台 → 打开对话」能切到 Sessions Tab 并选中对应会话。
// 同时持有侧栏可见性状态，供各 NavigationSplitView 页面共享（自定义左上角开关按钮控制）。
@MainActor
final class AppTabRouter: ObservableObject {
    static let shared = AppTabRouter()

    let selectionState = AppTabSelectionState()
    var selectedTab: AppTab { selectionState.selectedTab }
    // 待选中的 session id：Sessions Tab 出现后消费它并清空。
    @Published var pendingSessionId: String?
    @Published private(set) var pendingTaskId: String?
    @Published var pendingAutomationId: String?
    @Published private(set) var pendingWorktreeTarget: WorktreeNavigationTarget?
    @Published var navigationError: String?

    // Each resident page owns a distinct observable state. Updating one tab's
    // sidebar therefore does not publish into the other five page subtrees.
    private let sidebarStates: [AppTab: TabSidebarState] = Dictionary(
        uniqueKeysWithValues: AppTab.allCases.map { ($0, TabSidebarState(tab: $0)) }
    )

    func sidebarState(for tab: AppTab) -> TabSidebarState {
        // AppTab.allCases is the source used to build the dictionary, so a
        // missing value is a programming error rather than recoverable input.
        guard let state = sidebarStates[tab] else {
            preconditionFailure("Missing sidebar state for \(tab.rawValue)")
        }
        return state
    }

    func selectTab(_ tab: AppTab) {
        guard tab != selectedTab else { return }
        sidebarState(for: selectedTab).setSelected(false)
        sidebarState(for: tab).setSelected(true)
        PerfStopwatch.event("Tab切换", value: 1)
        selectionState.selectedTab = tab
    }

    func openSession(_ sessionId: String) {
        navigationError = nil
        pendingTaskId = nil
        pendingSessionId = sessionId
        selectTab(.console)
    }

    func openTaskSession(taskId: String, sessionId: String) {
        navigationError = nil
        pendingTaskId = taskId
        pendingSessionId = sessionId
        selectTab(.console)
    }

    func consumeSessionNavigation(_ requestedSessionId: String) {
        guard pendingSessionId == requestedSessionId else { return }
        pendingSessionId = nil
        pendingTaskId = nil
    }

    func openAutomation(_ automationId: String) {
        navigationError = nil
        pendingAutomationId = automationId
        selectTab(.automations)
    }

    func consumeAutomation(_ automationId: String) {
        if pendingAutomationId == automationId { pendingAutomationId = nil }
    }

    func openWorktrees(repositoryId: String?, worktreeId: String?, worktreePath: String?) {
        pendingWorktreeTarget = WorktreeNavigationTarget(
            repositoryId: repositoryId,
            worktreeId: worktreeId,
            worktreePath: worktreePath
        )
        sidebarState(for: .worktrees).visibility = .all
        selectTab(.worktrees)
    }

    func consumeWorktreeTarget(_ target: WorktreeNavigationTarget) {
        if pendingWorktreeTarget == target { pendingWorktreeTarget = nil }
    }

    func failSessionNavigation(_ sessionId: String) {
        navigationError = L10nFormat("Session %@ could not be loaded.", sessionId)
        pendingSessionId = nil
        pendingTaskId = nil
    }
}

@MainActor
final class AppTabSelectionState: ObservableObject {
    @Published fileprivate(set) var selectedTab: AppTab = .console
}

@MainActor
final class TabSidebarState: ObservableObject {
    let tab: AppTab
    @Published var visibility: NavigationSplitViewVisibility
    @Published private(set) var isSelected: Bool

    init(tab: AppTab, visibility: NavigationSplitViewVisibility = .all) {
        self.tab = tab
        self.visibility = visibility
        isSelected = tab == .console
    }

    var isVisible: Bool { visibility != .detailOnly }

    func toggle() {
        visibility = isVisible ? .detailOnly : .all
    }

    fileprivate func setSelected(_ selected: Bool) {
        guard isSelected != selected else { return }
        isSelected = selected
    }
}

struct WorktreeNavigationTarget: Equatable {
    let repositoryId: String?
    let worktreeId: String?
    let worktreePath: String?

    func matchingWorktree(in worktrees: [ManagedWorktree]) -> ManagedWorktree? {
        if let worktreeId,
           let exact = worktrees.first(where: { $0.worktreeId == worktreeId }) {
            return exact
        }
        guard let worktreePath else { return nil }
        let normalized = URL(fileURLWithPath: worktreePath).standardizedFileURL.path
        return worktrees.first {
            URL(fileURLWithPath: $0.path).standardizedFileURL.path == normalized
        }
    }
}
