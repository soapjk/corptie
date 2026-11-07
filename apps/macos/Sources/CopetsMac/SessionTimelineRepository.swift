import Combine
import CorptieClientCore
import Foundation

/// Observable state for exactly one provider-neutral Session timeline.
/// A host observes only its own state, so streaming in Session A cannot make
/// the retained view trees for B and C recompute.
@MainActor
final class SessionTimelineState: ObservableObject {
    let sessionID: String
    @Published private(set) var detail: CodexThreadDetail?
    private(set) var timelineRevision: Int
    private(set) var presentationRevision: UInt64 = 0
    private(set) var protectsHistoryWindow = false
    private(set) var tailContentRevision: String

    init(sessionID: String, detail: CodexThreadDetail? = nil, timelineRevision: Int = 0) {
        self.sessionID = sessionID
        self.detail = detail
        self.timelineRevision = max(0, timelineRevision)
        self.tailContentRevision = detail.map { timelineTailContentRevision(for: $0.items) } ?? "none"
    }

    func setProtectsHistoryWindow(_ protects: Bool) {
        guard protectsHistoryWindow != protects else { return }
        protectsHistoryWindow = protects
        if !protects, let detail { apply(detail) }
    }

    func apply(_ detail: CodexThreadDetail, timelineRevision: Int? = nil) {
        // Responses can complete out of order when a stored snapshot races an
        // incremental page. An explicitly older authority must never replace
        // newer resident items while retaining the newer revision number.
        if let timelineRevision {
            if timelineRevision < self.timelineRevision { return }
            // Equal durable revisions may still replace a local optimistic
            // projection. The stored snapshot is authoritative for message
            // delivery state even when no newer item revision is required.
        }
        let detail = ResidentTimelineWindow.compact(detail, protectingHistory: protectsHistoryWindow)
        let nextRevision = max(self.timelineRevision, timelineRevision ?? self.timelineRevision)
        guard self.detail != detail || self.timelineRevision != nextRevision else { return }
        self.timelineRevision = nextRevision
        presentationRevision &+= 1
        tailContentRevision = timelineTailContentRevision(for: detail.items)
        self.detail = detail
    }
}

/// The sole Session-indexed timeline repository on macOS. Transport code
/// publishes provider-neutral `CodexThreadDetail` snapshots here; presentation
/// code never needs to observe the global selected-detail stream.
@MainActor
final class SessionTimelineRepository {
    static let shared = SessionTimelineRepository()

    private var residentStates: ResidentSessionCache<SessionTimelineState>

    init(capacity: Int = 48) {
        residentStates = ResidentSessionCache(capacity: capacity)
    }

    func state(for sessionID: String) -> SessionTimelineState {
        residentStates.value(for: sessionID) {
            SessionTimelineState(sessionID: sessionID)
        }
    }

    func detail(for sessionID: String) -> CodexThreadDetail? {
        residentStates.value(for: sessionID)?.detail
    }

    func timelineRevision(for sessionID: String) -> Int {
        residentStates.peek(sessionID)?.timelineRevision ?? 0
    }

    func publish(_ detail: CodexThreadDetail, for sessionID: String, timelineRevision: Int? = nil) {
        state(for: sessionID).apply(detail, timelineRevision: timelineRevision)
    }

    /// A Workspace transition changes the Provider binding beneath one logical
    /// Session. Re-key the resident projection in place so presentation never
    /// observes an empty Timeline while the authoritative stored snapshot is
    /// being refreshed. Pagination and optimistic rows belong to the logical
    /// Session and therefore survive this Provider identity change.
    @discardableResult
    func rebindProviderIdentity(for session: TaskSession) -> CodexThreadDetail? {
        guard let current = residentStates.peek(session.id)?.detail else { return nil }
        let rebound = SessionTimelineBindingReconciler.rebind(current, to: session)
        publish(rebound, for: session.id)
        return rebound
    }

    func remove(_ sessionID: String) {
        residentStates.remove(sessionID)
    }

    func pin(_ sessionIDs: Set<String>) {
        residentStates.pin(sessionIDs)
    }

    func setPinned(_ pinned: Bool, for sessionID: String) {
        residentStates.setPinned(pinned, for: sessionID)
    }

    func prune(to validSessionIDs: Set<String>) {
        residentStates.prune(to: validSessionIDs)
    }
}

enum SessionTimelineBindingReconciler {
    static func routeIdentity(of session: TaskSession) -> String {
        let external = session.external
        return [
            external?.provider ?? "",
            external?.threadId ?? session.id,
            external?.sessionId ?? "",
            String(external?.routingVersion ?? 0),
            external?.workspace?.id ?? ""
        ].joined(separator: "\u{1f}")
    }

    static func sameRoute(_ left: TaskSession, _ right: TaskSession) -> Bool {
        left.id == right.id && routeIdentity(of: left) == routeIdentity(of: right)
    }

    static func rebind(_ detail: CodexThreadDetail, to session: TaskSession) -> CodexThreadDetail {
        let threadID = session.external?.threadId ?? session.id
        guard detail.id != threadID
                || detail.cwd != session.external?.workspace?.path
                || detail.source != session.external?.source else {
            return detail
        }
        return CodexThreadDetail(
            id: threadID,
            title: detail.title,
            status: detail.status,
            source: session.external?.source ?? detail.source,
            connectionStatus: session.external?.connectionStatus ?? detail.connectionStatus,
            currentModel: session.external?.currentModel ?? detail.currentModel,
            currentReasoningLevel: session.external?.currentReasoningLevel ?? detail.currentReasoningLevel,
            activityStatus: session.activityStatus ?? detail.activityStatus,
            cwd: session.external?.workspace?.path ?? session.external?.cwd ?? detail.cwd,
            createdAt: detail.createdAt,
            updatedAt: max(detail.updatedAt, session.updatedAt),
            canSend: session.actions?.send.available ?? session.capabilities?.canSend ?? detail.canSend,
            sendUnavailableReason: session.actions?.send.reason ?? detail.sendUnavailableReason,
            transitionState: session.transitionState ?? detail.transitionState,
            readiness: session.readiness ?? detail.readiness,
            notReadyReason: session.notReadyReason ?? detail.notReadyReason,
            capabilities: session.capabilities ?? detail.capabilities,
            turnCount: detail.turnCount,
            items: detail.items,
            lastAgentMessageSequence: max(
                detail.lastAgentMessageSequence ?? 0,
                session.lastAgentMessageSequence ?? 0
            ),
            hasMoreHistory: detail.hasMoreHistory,
            historyItemsCount: detail.historyItemsCount,
            actions: session.actions ?? detail.actions
        )
    }
}

/// Bound resident history without splitting an execution turn or losing unsent input.
/// The full current turn is a semantic exception to the ordinary item budget;
/// its expanded steps are independently virtualized by NSTableView.
enum ResidentTimelineWindow {
    static let itemBudget = 400

    static func compact(_ detail: CodexThreadDetail, protectingHistory: Bool, budget: Int = itemBudget) -> CodexThreadDetail {
        guard !protectingHistory, budget > 0, detail.items.count > budget else { return detail }
        var start = detail.items.count - budget
        let boundaryTurn = detail.items[start].turnId
        if !boundaryTurn.isEmpty {
            let turn = boundaryTurn
            while start > 0 && detail.items[start - 1].turnId == turn { start -= 1 }
        }
        let pendingStates: Set<String> = ["queued", "pending", "processing", "sending", "failed"]
        if let pending = detail.items[..<start].firstIndex(where: { item in
            item.userMessageStatus.map(pendingStates.contains) == true
                || (item.type == "approval" && !["completed", "approved", "declined", "cancelled"].contains(item.status ?? ""))
        }) {
            start = min(start, pending)
            let turn = detail.items[start].turnId
            if !turn.isEmpty {
                while start > 0 && detail.items[start - 1].turnId == turn { start -= 1 }
            }
        }
        guard start > 0 else { return detail }
        return CodexThreadDetail(id: detail.id, title: detail.title, status: detail.status,
            source: detail.source, connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel, currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus, cwd: detail.cwd, createdAt: detail.createdAt,
            updatedAt: detail.updatedAt, canSend: detail.canSend, sendUnavailableReason: detail.sendUnavailableReason,
            transitionState: detail.transitionState, readiness: detail.readiness, notReadyReason: detail.notReadyReason,
            capabilities: detail.capabilities, turnCount: detail.turnCount, items: Array(detail.items[start...]),
            lastAgentMessageSequence: detail.lastAgentMessageSequence, hasMoreHistory: true,
            // A dropped item can receive a later historical upsert. Without an
            // authoritative total, adding local drops would invent a count.
            historyItemsCount: nil, actions: detail.actions)
    }
}
