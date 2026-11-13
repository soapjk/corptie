import Combine
import CorptieConversation
import CorptieClientCore
import AppKit
import SwiftUI

struct WorkRailUnreadSummary: Equatable {
    let hasUnreadAssistantSessions: Bool
    let workIDs: Set<String>

    init(hasUnreadAssistantSessions: Bool, workIDs: Set<String>) {
        self.hasUnreadAssistantSessions = hasUnreadAssistantSessions
        self.workIDs = workIDs
    }

    init(sessions: [TaskSession]) {
        var hasUnreadAssistantSessions = false
        var workIDs = Set<String>()

        for session in sessions where isSessionUnread(session)
            && session.hasValidProductClassification
            && session.archived != true {
            if session.resolvedSessionKind == .assistantChat {
                hasUnreadAssistantSessions = true
            } else if let workID = session.workId, !workID.isEmpty {
                workIDs.insert(workID)
            }
        }

        self.hasUnreadAssistantSessions = hasUnreadAssistantSessions
        self.workIDs = workIDs
    }
}

struct FloatingCreationButtonGlassModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content
                .glassEffect(.regular.interactive(), in: .circle)
        } else {
            content
                .background(.ultraThinMaterial, in: Circle())
                .overlay {
                    Circle()
                        .stroke(Color(nsColor: .separatorColor).opacity(0.38), lineWidth: 1)
                }
                .shadow(color: Color.black.opacity(0.12), radius: 7, x: 0, y: 3)
        }
    }
}

enum SessionReadAcknowledgementPolicy {
    static func sequenceForOpenedSession(
        _ session: TaskSession,
        alreadySubmittedSequence: Int?
    ) -> Int? {
        guard let sequence = session.lastAgentMessageSequence,
              sequence > (session.lastReadMessageSequence ?? 0),
              sequence > (alreadySubmittedSequence ?? 0) else { return nil }
        return sequence
    }
}

struct SessionSidebarFunctionBarGlassModifier: ViewModifier {
    @ViewBuilder
    func body(content: Content) -> some View {
        if #available(macOS 26.0, *) {
            content
                .glassEffect(.clear.interactive(), in: .capsule)
        } else {
            content
                .background(.ultraThinMaterial, in: Capsule())
        }
    }
}

/// Chat Session rows intentionally share the same visual metrics as Task rows
/// so switching between the two groups does not change navigation density. It
/// observes the stable row model directly so content-only patches stay local.
struct ConsoleSessionRow<MenuContent: View>: View {
    var projectName: String? = nil
    var showsHoverFeedback = true
    var isActive = true
    @ObservedObject var row: SessionRowModel
    @EnvironmentObject private var backendClient: BackendClient
    @State private var isRenaming = false
    let selectionRequested: (TaskSession) -> Void
    @ViewBuilder var menuContent: (TaskSession, Binding<Bool>) -> MenuContent

    var body: some View {
        let session = row.session
        Button {
            selectionRequested(session)
        } label: {
            HStack(spacing: 9) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.listTitle)
                        .font(WorkbenchTypography.font(for: .navigation))
                        .lineLimit(1)
                    if let projectName {
                        Text(projectName)
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if (session.mailboxPendingCount ?? 0) > 0 {
                    Image(systemName: "envelope.badge").font(.caption2).foregroundStyle(.secondary)
                        .accessibilityLabel("信箱有待处理消息")
                }
                if [.running, .blocked, .failed].contains(session.executionTaskStatus) {
                    TaskActivityIndicator(activity: .resolve(hasBinding: true,
                        sessionExecutionStatus: session.executionTaskStatus.rawValue, taskExecutionStatus: nil),
                        isActive: isActive)
                }
                if isSessionUnread(session) {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel(L10n("Unread Session"))
                        .help(L10n("Unread Session"))
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(SessionSelectionPressStyle())
        .consoleHoverFeedback(enabled: showsHoverFeedback)
        .contextMenu {
            menuContent(session, $isRenaming)
        }
        .sheet(isPresented: $isRenaming) {
            RenameSessionSheet(session: session) { isRenaming = false }
                .environmentObject(backendClient)
                .presentationBackground(.clear)
        }
    }
}

struct ConsoleWorkChatRowContent: View {
    var isActive = true
    var showsHoverFeedback = true
    @ObservedObject var row: SessionRowModel
    let isSelected: Bool
    let onSelect: () -> Void

    var body: some View {
        let session = row.session
        Button(action: onSelect) {
            HStack(spacing: 9) {
                HStack(spacing: 7) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 13))
                        .frame(width: 18)
                        .foregroundStyle(.secondary)
                    Text(L10n("Work Chat"))
                        .font(WorkbenchTypography.font(for: .navigation))
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if [.running, .blocked, .failed].contains(session.executionTaskStatus) {
                    TaskActivityIndicator(activity: .resolve(hasBinding: true,
                        sessionExecutionStatus: session.executionTaskStatus.rawValue, taskExecutionStatus: nil),
                        isActive: isActive)
                }
                if isSessionUnread(session) {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel(L10n("Unread Session"))
                        .help(L10n("Unread Session"))
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .accessibilityLabel(L10n("Open Work Chat"))
        .accessibilityIdentifier("console.work-chat." + (session.workId ?? session.id))
        .buttonStyle(SessionSelectionPressStyle())
        .consoleHoverFeedback(enabled: showsHoverFeedback)
        .listRowBackground(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(isSelected ? Color.primary.opacity(0.055) : Color.clear)
                .padding(.horizontal, 8)
        )
    }
}

struct ConsoleTaskRowContent: View {
    var showsHoverFeedback = true
    let task: CorptieTask
    let sessionActivity: TaskSessionActivity
    var session: TaskSession? = nil
    let isSelected: Bool
    let isUnread: Bool
    var isActive = true
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 9) {
                HStack(spacing: 4) {
                    Text(task.title)
                        .font(WorkbenchTypography.font(for: .navigation))
                        .lineLimit(1)
                }
                if task.hasPendingScheduledWake == true {
                    ConsoleScheduledWakeIcon()
                }
                Spacer(minLength: 0)
                if [.processing, .waitingForInput, .paused, .failed].contains(sessionActivity) {
                    TaskActivityIndicator(activity: sessionActivity, lifecycleState: task.lifecycleState,
                        label: L10nFormat("Session: %@", sessionActivity.label), isActive: isActive)
                }
                if task.deletionStatus == "deleting" {
                    ProgressView()
                        .controlSize(.mini)
                        .accessibilityLabel(L10n("后台处理中"))
                }
                if isUnread {
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 8, height: 8)
                        .accessibilityLabel(L10n("Unread Session"))
                        .help(L10n("Unread Session"))
                }
            }
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(SessionSelectionPressStyle())
        .consoleHoverFeedback(enabled: showsHoverFeedback)
        .disabled(task.deletionStatus == "deleting")
        .help([task.title, sessionActivity.label, session?.external?.provider].compactMap { $0 }.joined(separator: " · "))
        .listRowBackground(
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(isSelected ? Color.primary.opacity(0.055) : Color.clear)
                .padding(.horizontal, 8)
        )
    }
}

func sessionMatchingPendingSelection(_ pendingSessionId: String?, in sessions: [TaskSession]) -> TaskSession? {
    guard let pendingSessionId = normalizedSessionRouteIdentifier(pendingSessionId) else { return nil }
    // Preserve the canonical Session id as the highest-priority match. Logical
    // and Provider ids are accepted only as route aliases so a CorptieTask created
    // before/after a workspace or Provider transition still opens the same
    // product Session instead of failing hydration or selecting another row.
    if let exact = sessions.first(where: { $0.id == pendingSessionId }) {
        return exact
    }
    return sessions.first { session in
        [
            session.external?.logicalSessionId,
            session.external?.threadId,
            session.external?.sessionId
        ]
        .compactMap(normalizedSessionRouteIdentifier)
        .contains(pendingSessionId)
    }
}

private func normalizedSessionRouteIdentifier(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !value.isEmpty else { return nil }
    return value
}

struct SessionGroup: Identifiable {
    let key: String
    let title: String
    let rows: [SessionRowModel]
    let showsHeader: Bool
    let rowSubtitles: [String: String]

    var id: String { key }

    init(
        key: String,
        title: String,
        rows: [SessionRowModel],
        showsHeader: Bool = true,
        rowSubtitles: [String: String] = [:]
    ) {
        self.key = key
        self.title = title
        self.rows = rows
        self.showsHeader = showsHeader
        self.rowSubtitles = rowSubtitles
    }
}

struct SessionCountBadge: View {
    let count: Int
    let fill: Color
    let diameter: CGFloat

    var body: some View {
        Text("\(count)")
            .font(.system(size: diameter <= 15 ? 8 : 9, weight: .bold, design: .rounded))
            .foregroundStyle(.white)
            .minimumScaleFactor(0.65)
            .lineLimit(1)
            .frame(width: diameter, height: diameter)
            .background(fill, in: Circle())
            .accessibilityLabel(L10nFormat("%@ Sessions", "\(count)"))
    }
}

func isSessionUnread(_ session: TaskSession) -> Bool {
    sessionNeedsUserAttention(
        status: session.executionTaskStatus,
        lastAgentMessageSequence: session.lastAgentMessageSequence ?? 0,
        lastReadMessageSequence: session.lastReadMessageSequence ?? 0
    )
}

func countUnreadSessions(
    in sessions: [TaskSession],
    category: SessionCategory
) -> Int {
    unreadSessionCounts(in: sessions)[category, default: 0]
}

func unreadSessionCounts(in sessions: [TaskSession]) -> [SessionCategory: Int] {
    var counts: [SessionCategory: Int] = [:]
    for session in sessions where isSessionUnread(session)
        && session.hasValidProductClassification
        && session.archived != true {
        let category = SessionCategory(session: session)
        counts[category, default: 0] += 1
    }
    return counts
}
