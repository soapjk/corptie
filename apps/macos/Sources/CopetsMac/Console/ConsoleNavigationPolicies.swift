import Combine
import Observation
import CorptieConversation
import AppKit
import SwiftUI

enum ConsoleNavigationCardWidthPolicy {
    static let minimumTaskColumnWidth = 220.0
    static let defaultTaskColumnWidth = 300.0
    static let maximumTaskColumnWidth = 520.0

    static func clamped(_ width: Double) -> Double {
        min(max(width, minimumTaskColumnWidth), maximumTaskColumnWidth)
    }

    static func resizedWidth(from startWidth: Double, translation: Double) -> Double {
        clamped(startWidth + translation)
    }
}

enum ConsoleNavigationMode: String, CaseIterable {
    case workOutline
    case taskCards

    static func resolved(_ rawValue: String) -> Self {
        Self(rawValue: rawValue) ?? .workOutline
    }

    @MainActor
    var accessibilityValue: String {
        switch self {
        case .workOutline: L10n("Expanded Work list")
        case .taskCards: "卡片 · 实验"
        }
    }
}

typealias ConsoleWorkOutlineMetrics = CorptieConversation.ConsoleWorkOutlineMetrics

typealias ConsoleWorkFlowingGradientPolicy = CorptieConversation.ConsoleWorkFlowingGradientPolicy

enum ConsoleWorkActivityPolicy {
    static func processingWorkIDs(
        tasks: [CorptieTask],
        sessions: [TaskSession]
    ) -> Set<String> {
        let lookup = TaskSessionLookup(sessions: sessions)
        return Set(tasks.lazy.compactMap { task in
            lookup.activity(for: task) == .processing
                ? task.workId
                : nil
        })
    }
}

/// Local disclosure preference for the grouped console outline.
@MainActor @Observable
final class ConsoleOutlineExpansionPreferences {
    // The saved collection is storage, not a shared UI invalidation source.
    @ObservationIgnored private(set) var expandedWorkIDs: Set<String>
    @ObservationIgnored private var workStates: [String: WorkState] = [:]
    @MainActor @Observable fileprivate final class WorkState {
        var isExpanded: Bool
        init(isExpanded: Bool) { self.isExpanded = isExpanded }
    }
    private(set) var isAssistantCollapsed: Bool
    private let store: WorkOutlineExpansionStore

    init(defaults: UserDefaults = CorptieAppEnvironment.userDefaults) {
        store = WorkOutlineExpansionStore(defaults: defaults)
        expandedWorkIDs = store.load()
        isAssistantCollapsed = !store.loadChat()
    }

    func isWorkExpanded(_ workID: String) -> Bool {
        if let state = workStates[workID] { return state.isExpanded }
        let state = WorkState(isExpanded: expandedWorkIDs.contains(workID))
        workStates[workID] = state
        return state.isExpanded
    }

    func setWorkExpanded(_ isExpanded: Bool, workID: String) {
        guard expandedWorkIDs.contains(workID) != isExpanded else { return }
        if isExpanded {
            expandedWorkIDs.insert(workID)
        } else {
            expandedWorkIDs.remove(workID)
        }
        workStates[workID]?.isExpanded = isExpanded
        store.save(expandedWorkIDs)
    }

    func toggleWork(workID: String) {
        setWorkExpanded(!expandedWorkIDs.contains(workID), workID: workID)
    }

    func setAssistantExpanded(_ isExpanded: Bool) {
        let isCollapsed = !isExpanded
        guard isAssistantCollapsed != isCollapsed else { return }
        isAssistantCollapsed = isCollapsed
        store.saveChat(isExpanded)
    }

    func toggleAssistant() {
        setAssistantExpanded(isAssistantCollapsed)
    }

    func removeWork(_ workID: String) {
        workStates.removeValue(forKey: workID)?.isExpanded = false
        guard expandedWorkIDs.remove(workID) != nil else { return }
        store.save(expandedWorkIDs)
    }
}

typealias ConsoleWorkTitle = CorptieConversation.ConsoleWorkTitle

/// Read the Chat expansion in its own observation scope, not the Console root.
struct ConsoleAssistantExpansionScope<Content: View>: View {
    let preferences: ConsoleOutlineExpansionPreferences
    let forceExpanded: Bool
    let content: (Bool) -> Content

    init(preferences: ConsoleOutlineExpansionPreferences, forceExpanded: Bool,
         @ViewBuilder content: @escaping (Bool) -> Content) {
        self.preferences = preferences; self.forceExpanded = forceExpanded; self.content = content
    }

    var body: some View { content(forceExpanded || !preferences.isAssistantCollapsed) }
}

/// Shared by list rows and experimental Task cards; body lives in CorptieConversation.
struct ConsoleScheduledWakeIcon: View {
    var isActive = true

    var body: some View {
        ScheduledWakeIcon(isActive: isActive, label: L10n("存在等待执行的计划任务"))
            .help(L10n("存在等待执行的计划任务"))
    }
}

enum ConsoleWorkOutlineRowMetrics {
    static let height: CGFloat = 24
    static let spacing: CGFloat = 2

    static func contentHeight(count: Int) -> CGFloat {
        guard count > 0 else { return 0 }
        return CGFloat(count) * height + CGFloat(count - 1) * spacing
    }
}

/// The outline rows are single-line controls. Supply their exact extent without
/// measuring every row, while the lazy stack mounts only the viewport's rows.
struct ConsoleWorkOutlineRows<Content: View>: View {
    let rowCount: Int
    @ViewBuilder var content: Content

    var body: some View {
        LazyVStack(alignment: .leading, spacing: ConsoleWorkOutlineRowMetrics.spacing) {
            content
        }
        .frame(height: ConsoleWorkOutlineRowMetrics.contentHeight(count: rowCount), alignment: .top)
    }
}

/// Measure the full child stack once for a width, then reveal its height.
/// Children remain in normal layout until the reveal animation completes.
private struct ConsoleDisclosureRevealLayout: Layout {
    nonisolated var fraction: CGFloat
    nonisolated var animatableData: CGFloat {
        get { fraction }
        set { fraction = newValue }
    }
    struct Cache {
        // SwiftUI alternates unconstrained and constrained width proposals in
        // one layout pass. Retain a bounded set instead of evicting each other.
        var measurements: [(width: CGFloat?, size: CGSize)] = []
    }
    func makeCache(subviews: Subviews) -> Cache { Cache() }
    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        cache.measurements.removeAll(keepingCapacity: true)
    }
    private func fullSize(width: CGFloat?, subviews: Subviews, cache: inout Cache) -> CGSize {
        if let measured = cache.measurements.first(where: { $0.width == width }) { return measured.size }
        let size = subviews.first?.sizeThatFits(.init(width: width, height: nil)) ?? .zero
        if cache.measurements.count == 8 { cache.measurements.removeFirst() }
        cache.measurements.append((width, size))
        return size
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let size = fullSize(width: proposal.width, subviews: subviews, cache: &cache)
        return .init(width: size.width, height: size.height * min(1, max(0, fraction)))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        // Keep rows at their natural size and position; only the enclosing
        // layout height changes, as in the mobile Work card.
        let size = fullSize(width: bounds.width, subviews: subviews, cache: &cache)
        subviews.first?.place(at: bounds.origin, anchor: .topLeading,
            proposal: .init(width: bounds.width, height: size.height))
    }

}

/// Keep the reveal container alive across both directions. Removal transitions
/// let LazyVStack reclaim the row before the departing children finish drawing.
private struct ConsoleWorkDisclosureBody<Label: View, Content: View>: View {
    @Binding var isExpanded: Bool
    let label: Label
    let content: Content
    let reduceMotion: Bool
    let onCollapseCompleted: (() -> Void)?
    @State private var collapseNotified = false
    @State private var contentMounted: Bool
    @State private var fraction: CGFloat
    @State private var animationGeneration = 0

    init(isExpanded: Binding<Bool>, label: Label, content: Content, reduceMotion: Bool,
         onCollapseCompleted: (() -> Void)?) {
        _isExpanded = isExpanded
        self.label = label
        self.content = content
        self.reduceMotion = reduceMotion
        self.onCollapseCompleted = onCollapseCompleted
        _contentMounted = State(initialValue: isExpanded.wrappedValue)
        _fraction = State(initialValue: isExpanded.wrappedValue ? 1 : 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 0) {
                Button { isExpanded.toggle() } label: {
                    Image(systemName: "chevron.right")
                        .rotationEffect(.degrees(90 * min(1, max(0, fraction))))
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(SessionSelectionPressStyle())
                .accessibilityLabel(L10n(isExpanded ? "Collapse group" : "Expand group"))
                label.frame(maxWidth: .infinity, alignment: .leading)
            }

            ConsoleDisclosureRevealLayout(fraction: fraction) {
                if contentMounted {
                    // Reuse the layout at a constant fraction for full-size
                    // measurement. Its cache survives reveal interpolation,
                    // while SwiftUI invalidates it when the content changes.
                    ConsoleDisclosureRevealLayout(fraction: 1) { content }
                        .transition(.identity)
                }
            }
            .clipped()
            .contentShape(Rectangle())
            .padding(.top, 2 * min(1, max(0, fraction)))
            .allowsHitTesting(isExpanded)
            .accessibilityHidden(!isExpanded)
        }
        .clipped()
        .onAppear { reveal(isExpanded, animated: false) }
        .onDisappear {
            animationGeneration &+= 1
            finishCollapse(generation: animationGeneration)
        }
        .onChange(of: isExpanded) { _, expanded in reveal(expanded, animated: !reduceMotion) }
        .onChange(of: reduceMotion) { _, reduced in
            if reduced { reveal(isExpanded, animated: false) }
        }
    }

    private func reveal(_ expanded: Bool, animated: Bool) {
        animationGeneration &+= 1
        let generation = animationGeneration
        var immediate = Transaction(animation: nil)
        immediate.disablesAnimations = true
        withTransaction(immediate) {
            if expanded {
                contentMounted = true
                collapseNotified = false
            }
            if !animated { fraction = expanded ? 1 : 0 }
        }
        guard animated else {
            finishCollapse(generation: generation)
            return
        }
        withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation, completionCriteria: .removed) {
            fraction = expanded ? 1 : 0
        } completion: {
            finishCollapse(generation: generation)
        }
    }

    private func finishCollapse(generation: Int) {
        guard generation == animationGeneration, !isExpanded, !collapseNotified else { return }
        var immediate = Transaction(animation: nil)
        immediate.disablesAnimations = true
        withTransaction(immediate) {
            contentMounted = false
            collapseNotified = true
            onCollapseCompleted?()
        }
    }

}

struct ConsoleWorkOutlineDisclosureStyle: DisclosureGroupStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var reduceMotionOverride: Bool? = nil
    var onCollapseCompleted: (() -> Void)? = nil

    func makeBody(configuration: Configuration) -> some View {
        ConsoleWorkDisclosureBody(isExpanded: configuration.$isExpanded,
                                  label: configuration.label, content: configuration.content,
                                  reduceMotion: reduceMotionOverride ?? reduceMotion,
                                  onCollapseCompleted: onCollapseCompleted)
    }
}

private typealias ConsoleWorkOutlineGroupCardModifier = WorkGroupCardSurface

extension View {
    func consoleWorkOutlineGroupCard() -> some View {
        modifier(ConsoleWorkOutlineGroupCardModifier())
    }
}

struct HoverRevealHeaderAction<Header: View>: View {
    let accessibilityLabel: String
    let header: Header
    let action: () -> Void

    @State private var isHovering = false
    @FocusState private var isFocused: Bool

    init(
        accessibilityLabel: String,
        action: @escaping () -> Void,
        @ViewBuilder header: () -> Header
    ) {
        self.accessibilityLabel = accessibilityLabel
        self.action = action
        self.header = header()
    }

    var body: some View {
        HStack(spacing: 0) {
            header
            Button(action: action) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focused($isFocused)
            .opacity(isHovering || isFocused ? 1 : 0)
            .accessibilityLabel(accessibilityLabel)
            .help(accessibilityLabel)
        }
        .onHover { isHovering = $0 }
    }
}

struct ConsoleWorkOutlineHeader: View {
    let work: Work
    let isExpanded: Bool
    let isSelected: Bool
    let isWorking: Bool
    let hasUnread: Bool
    let isChatSelected: Bool
    let isChatRunning: Bool
    let hasUnreadChat: Bool
    let toggleExpanded: () -> Void
    let openChat: () -> Void
    let createTask: () -> Void
    // Equal display values may retain actions only within the same Console
    // lifetime. Actions in that scope must resolve current state when invoked.
    var actionOwner: AnyObject = NSObject()
    var isActive = true
    @Environment(\.controlActiveState) private var controlActiveState

    @State private var isHovering = false
    @FocusState private var isCreateTaskFocused: Bool

    var body: some View {
        let _ = SessionSwitchTrace.shared.recordWorkHeader(workID: work.id, inputs: .init(
            title: work.name, avatarPath: work.avatarPath, expanded: isExpanded,
            selected: isSelected, working: isWorking, unread: hasUnread,
            chatSelected: isChatSelected, chatRunning: isChatRunning,
            unreadChat: hasUnreadChat, active: isActive))
        WorkOutlineHeaderRow(toggleExpanded: toggleExpanded) {
            Button(action: toggleExpanded) {
                HStack(spacing: 7) {
                    ObjectiveAvatarView(
                        objectiveID: work.id,
                        name: work.name,
                        avatarPath: work.avatarPath,
                        size: 22
                    )
                    ConsoleWorkTitle(title: work.name, isWorking: isWorking,
                        isActive: isActive && controlActiveState != .inactive)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(SessionSelectionPressStyle())
            .accessibilityLabel(work.name)
            .accessibilityValue(accessibilityValue)
            .help(isExpanded ? L10n("Collapse Work") : L10n("Expand Work"))
        } discussion: {
            WorkDiscussionButton(isSelected: isChatSelected, isRunning: isChatRunning,
                hasUnread: hasUnreadChat, title: L10n("讨论"),
                accessibilityTitle: L10n("Open Work Chat"),
                accessibilityState: hasUnreadChat ? L10n("Unread Session") : "",
                action: openChat)
                .padding(.leading, 6)

        } actions: {
            if hasUnread && !isExpanded {
                UnreadSessionDot(label: L10n("Unread Session"))
                    .padding(.trailing, 4)
            }

            Button(action: createTask) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focused($isCreateTaskFocused)
            .opacity(isHovering || isCreateTaskFocused ? 1 : 0.45)
            .accessibilityLabel(L10nFormat("Create Task in %@", work.name))
            .help(L10nFormat("Create Task in %@", work.name))
        }
        .onHover { isHovering = $0 }
    }

    private var accessibilityValue: String {
        let expandedValue = isExpanded ? L10n("Expanded group") : L10n("Collapsed group")
        return isWorking ? "\(expandedValue), \(L10n("Processing"))" : expandedValue
    }
}

extension ConsoleWorkOutlineHeader: Equatable {
    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        guard lhs.actionOwner === rhs.actionOwner else { return false }
        return lhs.work == rhs.work
            && lhs.isExpanded == rhs.isExpanded
            && lhs.isSelected == rhs.isSelected
            && lhs.isWorking == rhs.isWorking
            && lhs.hasUnread == rhs.hasUnread
            && lhs.isChatSelected == rhs.isChatSelected
            && lhs.isChatRunning == rhs.isChatRunning
            && lhs.hasUnreadChat == rhs.hasUnreadChat
            && lhs.isActive == rhs.isActive
    }
}

enum ConsoleTaskSelectionPolicy {
    static func isValidSelection(
        task: CorptieTask,
        selectedWorkID: String?
    ) -> Bool {
        task.workId == selectedWorkID
            && task.lifecycleState != "done"
            && task.archived != true
            && task.deletionStatus != "deleting"
    }

    static func session(
        for task: CorptieTask,
        in sessions: [TaskSession]
    ) -> TaskSession? {
        if let currentSessionID = task.currentSessionId,
           let current = sessions.first(where: {
               $0.id == currentSessionID
                   && $0.taskId == task.id
                   && $0.archived != true
           }) {
            return current
        }
        return sessions.first { $0.taskId == task.id && $0.archived != true }
    }
}

enum ConsoleTaskOpenDecision: Equatable {
    case selectSession(id: String)
    case showWithoutSession

    static func resolve(task: CorptieTask, session: TaskSession?) -> Self {
        if let session { return .selectSession(id: session.id) }
        return .showWithoutSession
    }
}

enum ConsoleSelectionRefreshPolicy {
    static func permitsAutomaticDefaultSelection(
        selectedTaskID: String?,
        selectedSessionID: String?,
        explicitlyCleared: Bool = false
    ) -> Bool {
        !explicitlyCleared && selectedTaskID == nil && selectedSessionID == nil
    }
}

// 统一控制台：Work/Assistant 导航、Task 列、消息列和详情列。
//   左 sidebar  — 会话列表（CompactSessionRow，固定窄列，窗口级连续侧栏）
//   中 content  — 对话（复用旧版 DetailView，吃满剩余宽度，纸面卡片质感）
//   详情信息   — 右侧竖列常驻 side panel（固定宽度，无收起按钮，模仿 Rudder IssueDetail 的 rail）
//
// Rudder 设计契约要点（IssueDetail.tsx + index.css）：
//   - 详情页是 CSS Grid 三区域布局，右侧「Properties rail」固定 280px，sticky 常驻，
//     没有收起/折叠按钮——只有 <48rem 移动端才 display:none（靠顶部 SlidersHorizontal 打开 Sheet）。
//   - 字段区标题用 11px uppercase + tracking 的小字「Properties」标签，下面竖向排列字段。
//   - 窄列固定像素宽度，主工作区吃掉剩余空间。
