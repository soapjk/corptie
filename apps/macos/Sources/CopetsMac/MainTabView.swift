import SwiftUI

// Sessions 与控制台共用的栏位几何，确保 sidebar 与详情卡片宽度稳定。
enum TwoPaneLayoutMetrics {
    static let sidebarWidth: CGFloat = 300
    static let sidebarMaximumWidth: CGFloat = 520
    static let detailCardWidth: CGFloat = 300
    static let contentPadding: CGFloat = 16
    static let cardCornerRadius: CGFloat = 12
}

/// Keeps every main-tab subtree alive while placing only the selected page.
///
/// Placing multiple resident NavigationSplitViews offscreen can leave the
/// selected page without a visible layout after the tab collection changes.
/// The inactive subtrees retain their state, but only the selected subtree
/// participates in the current window layout.
struct MainTabPageLayout: Layout {
    let selectedIndex: Int

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        CGSize(
            width: max(0, proposal.width ?? 0),
            height: max(0, proposal.height ?? 0)
        )
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        guard subviews.indices.contains(selectedIndex) else { return }
        subviews[selectedIndex].place(
            at: CGPoint(x: bounds.minX, y: bounds.minY),
            anchor: .topLeading,
            proposal: ProposedViewSize(width: bounds.width, height: bounds.height)
        )
    }
}

// 顶层 Tab 枚举：控制台 / Sessions / Agents（设置已移至右上角齿轮入口的独立页面）。
enum AppTab: String, CaseIterable, Identifiable {
    case console
    case sessions
    case automations
    case worktrees
    case sessionDSH
    case agents

    var id: String { rawValue }

    // Tab 在栏中的顺序，用于判断页面切换的滑动方向（前进/后退）。
    var index: Int {
        switch self {
        case .console: 0
        case .sessions: 1
        case .automations: 2
        case .worktrees: 3
        case .sessionDSH: 4
        case .agents: 5
        }
    }

    @MainActor var title: String {
        switch self {
        case .console: L10n("Console")
        case .sessions: L10n("Sessions")
        case .automations: L10n("Automations")
        case .worktrees: L10n("Worktrees")
        case .sessionDSH: L10n("Session DSH")
        case .agents: L10n("Agents")
        }
    }

    var systemImage: String {
        switch self {
        case .console: "square.grid.2x2"
        case .sessions: "bubble.left.and.bubble.right"
        case .automations: "bolt.badge.clock"
        case .worktrees: "arrow.triangle.branch"
        case .sessionDSH: "globe"
        case .agents: "person.2"
        }
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
                .frame(width: 42)
            }
        }
        .frame(height: 30)
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
        .animation(.easeInOut(duration: 0.15), value: isSelected)
    }
}

// MARK: - 主窗口顶层容器

// 主窗口顶层容器：顶部中间 Tab 切换器（控制台 / Sessions / Agents / 设置）+ 对应内容。
struct MainTabView: View {
    @StateObject private var router = AppTabRouter.shared

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                HStack(spacing: 8) {
                    // Sidebar 开关与设置入口共同位于 macOS 窗口按钮右侧。
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            router.toggleSidebar()
                        }
                    } label: {
                        Image(systemName: "sidebar.left")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 22, height: 22)
                    }
                    .buttonStyle(.plain)
                    .help(L10n(router.isSidebarVisible ? "Hide Sidebar" : "Show Sidebar"))

                    Button {
                        openSettings()
                    } label: {
                        Image(systemName: "gearshape")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(.secondary)
                            .frame(width: 22, height: 22)
                    }
                    .buttonStyle(.plain)
                    .help(L10n("设置"))
                }
                .frame(width: 220, alignment: .leading)
                .offset(x: 64, y: -32)
                .frame(maxWidth: .infinity, alignment: .leading)

                UnderlineTabBar(selection: Binding(
                    get: { router.selectedTab },
                    set: { router.selectTab($0) }
                ))
                .offset(y: -12)
            }
            .padding(.horizontal, 12)

            MainTabPageLayout(selectedIndex: router.selectedTab.index) {
                ForEach(AppTab.allCases) { tab in
                    content(for: tab)
                        .allowsHitTesting(tab == router.selectedTab)
                        .accessibilityHidden(tab != router.selectedTab)
                }
            }
            .clipped()
        }
        .environmentObject(router)
        // The notification owns its subscriptions in a separate overlay subtree.
        // Overlay sizing never participates in the tab header's ZStack layout, so
        // task insertion, mutation, removal, and intrinsic-width changes cannot
        // move or resize the tab controls.
        .overlay(alignment: .topTrailing) {
            MainWindowBackgroundTaskOverlay()
                .frame(width: 220, alignment: .trailing)
                .padding(.top, 8)
                .padding(.trailing, 12)
                .offset(y: -32)
        }
    }

    @ViewBuilder
    private func content(for tab: AppTab) -> some View {
        switch tab {
        case .console:
            WarRoomView()
        case .sessions:
            SessionsView()
        case .automations:
            AutomationsView()
        case .worktrees:
            WorktreeManagementView()
        case .sessionDSH:
            SessionDSHView()
        case .agents:
            AgentManagementView()
        }
    }

    private func openSettings() {
        AppDelegate.shared?.openSettings()
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
               entityClient.objectivesLoadError != nil,
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

    @Published private(set) var selectedTab: AppTab = .console
    // 必须先于 selectedTab 更新，确保 SwiftUI 创建 transition 时读到本次切换的方向。
    @Published private(set) var slideForward = true
    // 待选中的 session id：Sessions Tab 出现后消费它并清空。
    @Published var pendingSessionId: String?
    @Published private(set) var pendingWorktreeTarget: WorktreeNavigationTarget?
    @Published var navigationError: String?

    // .all displays the leading navigation columns. Worktree management uses
    // all three native split columns; the other tabs use sidebar + detail.
    @Published var sidebarVisibility: NavigationSplitViewVisibility = .all

    var isSidebarVisible: Bool { sidebarVisibility != .detailOnly }

    func toggleSidebar() {
        sidebarVisibility = isSidebarVisible ? .detailOnly : .all
    }

    func selectTab(_ tab: AppTab) {
        guard tab != selectedTab else { return }
        slideForward = tab.index > selectedTab.index
        PerfStopwatch.event("Tab切换", value: 1)
        selectedTab = tab
    }

    func openSession(_ sessionId: String) {
        navigationError = nil
        pendingSessionId = sessionId
        selectTab(.sessions)
    }

    func openWorktrees(repositoryId: String?, worktreeId: String?, worktreePath: String?) {
        pendingWorktreeTarget = WorktreeNavigationTarget(
            repositoryId: repositoryId,
            worktreeId: worktreeId,
            worktreePath: worktreePath
        )
        sidebarVisibility = .all
        selectTab(.worktrees)
    }

    func consumeWorktreeTarget(_ target: WorktreeNavigationTarget) {
        if pendingWorktreeTarget == target { pendingWorktreeTarget = nil }
    }

    func failSessionNavigation(_ sessionId: String) {
        navigationError = L10nFormat("Session %@ could not be loaded.", sessionId)
        pendingSessionId = nil
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
