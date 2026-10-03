import Combine
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
        Set(tasks.lazy.compactMap { task in
            CorptieTaskBoundSessionActivity.resolve(task: task, sessions: sessions) == .processing
                ? task.workId
                : nil
        })
    }
}

/// Local disclosure preference for the grouped console outline.
@MainActor
final class ConsoleOutlineExpansionPreferences: ObservableObject {
    @Published private(set) var expandedWorkIDs: Set<String>
    @Published private(set) var isAssistantCollapsed: Bool
    private let store: WorkOutlineExpansionStore

    init(defaults: UserDefaults = CorptieAppEnvironment.userDefaults) {
        store = WorkOutlineExpansionStore(defaults: defaults)
        expandedWorkIDs = store.load()
        isAssistantCollapsed = !store.loadChat()
    }

    func setWorkExpanded(_ isExpanded: Bool, workID: String) {
        guard expandedWorkIDs.contains(workID) != isExpanded else { return }
        if isExpanded {
            expandedWorkIDs.insert(workID)
        } else {
            expandedWorkIDs.remove(workID)
        }
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
        guard expandedWorkIDs.remove(workID) != nil else { return }
        store.save(expandedWorkIDs)
    }
}

typealias ConsoleWorkTitle = CorptieConversation.ConsoleWorkTitle

/// Shared by list rows and experimental Task cards; body lives in CorptieConversation.
struct ConsoleScheduledWakeIcon: View {
    var isActive = true

    var body: some View {
        ScheduledWakeIcon(isActive: isActive, label: L10n("存在等待执行的计划任务"))
            .help(L10n("存在等待执行的计划任务"))
    }
}

struct ConsoleWorkOutlineDisclosureStyle: DisclosureGroupStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 0) {
                Button {
                    withAnimation(ConsoleWorkOutlineMetrics.disclosureAnimation) {
                        configuration.isExpanded.toggle()
                    }
                } label: {
                    Image(systemName: configuration.isExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 18, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(L10n(
                    configuration.isExpanded ? "Collapse group" : "Expand group"
                ))

                configuration.label
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            if configuration.isExpanded {
                configuration.content
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
        .animation(
            ConsoleWorkOutlineMetrics.disclosureAnimation,
            value: configuration.isExpanded
        )
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

    @State private var isHovering = false
    @FocusState private var isCreateTaskFocused: Bool

    var body: some View {
        HStack(spacing: 0) {
            Button(action: toggleExpanded) {
                HStack(spacing: 7) {
                    ObjectiveAvatarView(
                        objectiveID: work.id,
                        name: work.name,
                        avatarPath: work.avatarPath,
                        size: 22
                    )
                    ConsoleWorkTitle(title: work.name, isWorking: isWorking)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                        .lineLimit(1)
                }
                .padding(.vertical, 3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(work.name)
            .accessibilityValue(accessibilityValue)
            .help(isExpanded ? L10n("Collapse Work") : L10n("Expand Work"))

            WorkDiscussionButton(isSelected: isChatSelected, isRunning: isChatRunning,
                hasUnread: hasUnreadChat, title: L10n("讨论"),
                accessibilityTitle: L10n("Open Work Chat"),
                accessibilityState: hasUnreadChat ? L10n("Unread Session") : "",
                action: openChat)
                .padding(.leading, 6)

            Spacer(minLength: 4)

            if hasUnread && !isExpanded {
                Circle()
                    .fill(Color.red)
                    .frame(width: 8, height: 8)
                    .accessibilityLabel(L10n("Unread Session"))
            }

            Button(action: createTask) {
                Image(systemName: "plus")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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
