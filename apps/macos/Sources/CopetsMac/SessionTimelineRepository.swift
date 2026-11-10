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
    private(set) var presentationDetail: CodexThreadDetail?
    private var retainedTurnContext: [CodexThreadItem] = []
    private(set) var timelineRevision: Int
    private(set) var presentationRevision: UInt64 = 0
    private(set) var protectsHistoryWindow = false
    private(set) var tailContentRevision: String

    init(sessionID: String, detail: CodexThreadDetail? = nil, timelineRevision: Int = 0) {
        self.sessionID = sessionID
        self.detail = detail
        self.presentationDetail = detail
        self.timelineRevision = max(0, timelineRevision)
        self.tailContentRevision = detail.map { timelineTailContentRevision(for: $0.items) } ?? "none"
    }

    func discardRetainedContext(for itemIDs: [String]) {
        retainedTurnContext.removeAll { itemIDs.contains($0.id) }
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
        let previousContext = retainedTurnContext
        // Auxiliary events can arrive after the active turn. They must not
        // evict the retained prompt before a newer user input replaces it.
        let contextTurn = detail.items.last { $0.type == "userMessage" }?.turnId
            ?? retainedTurnContext.first { $0.type == "userMessage" }?.turnId
            ?? detail.items.last?.turnId
        if !detail.items.isEmpty, let contextTurn {
            let context = [detail.items.last { $0.turnId == contextTurn && $0.type == "userMessage" },
                detail.items.last { $0.turnId == contextTurn && $0.type == "executionPlan" }].compactMap { $0 }
            retainedTurnContext = (context + retainedTurnContext.filter { old in
                old.turnId == contextTurn && !context.contains { $0.type == old.type }
            }).sorted { $0.type == "userMessage" && $1.type != "userMessage" }
        } else { retainedTurnContext = [] }
        let detail = ResidentTimelineWindow.compact(detail, protectingHistory: protectsHistoryWindow)
        let nextRevision = max(self.timelineRevision, timelineRevision ?? self.timelineRevision)
        // Only the ordered item list and the retained turn context feed the
        // display projection. A newer durable revision, or a metadata-only
        // snapshot (updatedAt / status / actions), carries no new renderable
        // content. Bumping the presentation version for those background
        // polls made every open page rebuild its display cache, rebind its
        // AppKit rows and dirty the whole window while the user was idle.
        let contentChanged = (self.detail?.items ?? []) != detail.items
            || retainedTurnContext != previousContext
        guard contentChanged || self.timelineRevision != nextRevision else { return }
        self.timelineRevision = nextRevision
        let ids = Set(detail.items.map(\.id))
        let context = retainedTurnContext.filter { !ids.contains($0.id) }
        presentationDetail = context.isEmpty ? detail
            : ResidentTimelineWindow.replacingItems(in: detail, with: context + detail.items)
        self.detail = detail
        guard contentChanged else { return }
        presentationRevision &+= 1
        tailContentRevision = timelineTailContentRevision(for: detail.items)
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

/// Keep a contiguous, recoverable tail even inside a long execution turn.
/// Unsent input and unresolved approvals remain protected; display-only turn
/// context is retained separately and never changes the history cursor.
enum ResidentTimelineWindow {
    static let itemBudget = 400

    static func compact(_ detail: CodexThreadDetail, protectingHistory: Bool, budget: Int = itemBudget) -> CodexThreadDetail {
        guard !protectingHistory, budget > 0, detail.items.count > budget else { return detail }
        var start = detail.items.count - budget
        // Processing input already belongs to the executing turn. Its prompt
        // is retained as display context, not as a reason to pin every step.
        let pendingStates: Set<String> = ["queued", "pending", "sending", "failed"]
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
        return replacingItems(in: detail, with: Array(detail.items[start...]), clipped: true)
    }

    static func replacingItems(in detail: CodexThreadDetail, with items: [CodexThreadItem], clipped: Bool = false) -> CodexThreadDetail {
        return CodexThreadDetail(id: detail.id, title: detail.title, status: detail.status,
            source: detail.source, connectionStatus: detail.connectionStatus,
            currentModel: detail.currentModel, currentReasoningLevel: detail.currentReasoningLevel,
            activityStatus: detail.activityStatus, cwd: detail.cwd, createdAt: detail.createdAt,
            updatedAt: detail.updatedAt, canSend: detail.canSend, sendUnavailableReason: detail.sendUnavailableReason,
            transitionState: detail.transitionState, readiness: detail.readiness, notReadyReason: detail.notReadyReason,
            capabilities: detail.capabilities, turnCount: detail.turnCount, items: items,
            lastAgentMessageSequence: detail.lastAgentMessageSequence, hasMoreHistory: clipped ? true : detail.hasMoreHistory,
            // A dropped item can receive a later historical upsert. Without an
            // authoritative total, adding local drops would invent a count.
            historyItemsCount: clipped ? nil : detail.historyItemsCount, actions: detail.actions)
    }
}
