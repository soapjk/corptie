import Combine
import Observation
import CorptieConversation
import AppKit
import SwiftUI

/// Pointer feedback stays in this small wrapper, outside list projections and
/// row content. It changes only paint: no animation, layout or data work.
private struct ConsoleHoverFeedback: ViewModifier {
    var enabled = true
    var isSelected = false
    var horizontalInset: CGFloat = 0
    @Environment(\.isEnabled) private var isEnabled
    @State private var isHovering = false

    func body(content: Content) -> some View {
        content
            .background {
                if enabled {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(Color.primary.opacity(isSelected ? 0.055 : isEnabled && isHovering ? 0.065 : 0))
                        .padding(.horizontal, horizontalInset)
                        .allowsHitTesting(false)
                }
            }
            .onHover { if enabled { isHovering = $0 } }
            .onDisappear { isHovering = false }
    }
}

extension View {
    func consoleHoverFeedback(enabled: Bool = true, isSelected: Bool = false,
                              horizontalInset: CGFloat = 0) -> some View {
        modifier(ConsoleHoverFeedback(enabled: enabled, isSelected: isSelected, horizontalInset: horizontalInset))
    }
}

/// Establish the complete row bounds before painting either interaction state.
/// Padding belongs inside that surface so text and indicators cannot overhang it.
struct ConsoleOutlineRowSurface: ViewModifier {
    let isSelected: Bool

    func body(content: Content) -> some View {
        content
            // Native List supplies hierarchy indentation. Leave 8pt of content
            // padding inside each edge of the surface's 8pt outer inset.
            .padding(.leading, 16)
            .padding(.trailing, 16)
            .frame(maxWidth: .infinity, minHeight: 30,
                   maxHeight: 30, alignment: .leading)
            .consoleHoverFeedback(isSelected: isSelected, horizontalInset: 8)
    }
}

extension View {
    func consoleOutlineRowSurface(isSelected: Bool) -> some View {
        modifier(ConsoleOutlineRowSurface(isSelected: isSelected))
    }
}

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
            .consoleHoverFeedback()
            .focused($isFocused)
            .opacity(isHovering || isFocused ? 1 : 0)
            .accessibilityLabel(accessibilityLabel)
            .help(accessibilityLabel)
        }
        .onHover { isHovering = $0 }
    }
}

/// Collapsed groups summarize the same activity shown by their child rows.
struct ConsoleGroupStatusIndicators: View {
    let isExpanded: Bool
    let isProcessing: Bool
    let hasUnread: Bool
    var isActive = true

    var body: some View {
        if !isExpanded {
            HStack(spacing: 4) {
                if isProcessing {
                    TaskActivityIndicator(activity: .processing, label: L10n("Processing"), isActive: isActive)
                }
                if hasUnread {
                    UnreadSessionDot(label: L10n("Unread Session"))
                }
            }
        }
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.controlActiveState) private var controlActiveState

    @State private var isHovering = false
    @FocusState private var isCreateTaskFocused: Bool
    @FocusState private var isChatFocused: Bool

    var body: some View {
        let _ = SessionSwitchTrace.shared.recordWorkHeader(workID: work.id, inputs: .init(
            title: work.name, avatarPath: work.avatarPath, expanded: isExpanded,
            selected: isSelected, working: isWorking, unread: hasUnread,
            chatSelected: isChatSelected, chatRunning: isChatRunning,
            unreadChat: hasUnreadChat, active: isActive))
        WorkOutlineHeaderRow(toggleExpanded: toggleExpanded) {
            Button(action: toggleExpanded) {
                HStack(spacing: 7) {
                    WorkOutlineFolderIcon(isExpanded: isExpanded)
                        .stroke(.secondary, style: StrokeStyle(lineWidth: 1.2, lineCap: .round, lineJoin: .round))
                        .frame(width: 18, height: 14)
                    Text(work.name)
                        .font(WorkbenchTypography.font(for: .navigation))
                        .foregroundStyle(.primary)
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
            Button(action: openChat) {
                Image(systemName: "bubble.left")
                    .font(.system(size: 12))
                    .foregroundStyle(isChatSelected ? Color.primary : Color.secondary)
                    .frame(width: 24, height: 24)
                    .background(isChatSelected ? Color.primary.opacity(0.06) : .clear,
                                in: RoundedRectangle(cornerRadius: 5))
            }
            .buttonStyle(.plain)
            .consoleHoverFeedback()
            .focused($isChatFocused)
            .opacity(isHovering || isChatFocused || isChatSelected || hasUnreadChat ? 1 : 0)
            .help(L10n("Open Work Chat"))
            .accessibilityLabel(L10nFormat("%@ · %@", work.name, L10n("Open Work Chat")))
            .accessibilityValue(hasUnreadChat ? L10n("Unread Session") : "")

        } actions: {
            ConsoleGroupStatusIndicators(isExpanded: isExpanded, isProcessing: isWorking,
                hasUnread: hasUnread, isActive: isActive)

            Button(action: createTask) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .consoleHoverFeedback()
            .focused($isCreateTaskFocused)
            .opacity(isHovering || isCreateTaskFocused ? 1 : 0)
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

/// The front flap opens without changing the header's icon or row geometry.
struct WorkOutlineFolderIcon: Shape {
    let isExpanded: Bool
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: 1, y: 12.5))
        path.addLine(to: CGPoint(x: 1, y: 2.5))
        path.addQuadCurve(to: CGPoint(x: 2, y: 1.5), control: CGPoint(x: 1, y: 1.5))
        path.addLine(to: CGPoint(x: 6, y: 1.5))
        path.addLine(to: CGPoint(x: 8, y: 3.5))
        path.addLine(to: CGPoint(x: 15, y: 3.5))
        path.addQuadCurve(to: CGPoint(x: 16, y: 4.5), control: CGPoint(x: 16, y: 3.5))
        if isExpanded {
            path.addLine(to: CGPoint(x: 16, y: 6.5))
            path.move(to: CGPoint(x: 1, y: 12.5))
            path.addLine(to: CGPoint(x: 4, y: 6.5))
            path.addLine(to: CGPoint(x: 17, y: 6.5))
            path.addLine(to: CGPoint(x: 14, y: 12.5))
        } else {
            path.addLine(to: CGPoint(x: 16, y: 11.5))
            path.addQuadCurve(to: CGPoint(x: 15, y: 12.5), control: CGPoint(x: 16, y: 12.5))
        }
        path.addLine(to: CGPoint(x: 1, y: 12.5))
        return path.applying(CGAffineTransform(a: rect.width / 18, b: 0, c: 0,
            d: rect.height / 14, tx: rect.minX, ty: rect.minY))
    }
}
