import Foundation

/// Presentation policy only: never completes, interrupts or archives a Task.
enum ConsoleAttentionPolicy {
    enum Summary: String { case required, attention, notRequired, unknown }
    struct Input {
        var excluded = false
        var selected = false
        var running = false
        var unread = false
        var explicitAttention = false
        var hasReply = false
        var cancelled = false
        var scheduled = false
        var summary: Summary = .unknown
        var deferred = false
    }

    static func shouldShow(_ input: Input) -> Bool {
        guard !input.excluded else { return false }
        // Pin the user's current context, and never hide active execution.
        if input.selected || input.running { return true }
        if input.deferred { return false }
        if input.unread || input.explicitAttention || input.summary == .required || input.summary == .attention { return true }
        // Unknown is not a positive attention signal. Keep its semantic value,
        // but do not retain an already-read Task merely for having past replies.
        return false
    }

    /// Read receipts and timestamps are intentionally absent: reading or
    /// reconnecting must not invalidate the user's dismissal of an issue.
    struct Receipt: Codable, Equatable {
        let sessionID: String?
        let taskRevision: Int
        let replySequence: Int
        let execution: String?
        let attentionKind: String?
        let attentionSource: String?
        let attentionReason: String?
        let summaryReason: String?
        let summaryAction: String?
    }

    @MainActor
    static func currentSummary(_ task: CorptieTask, session: TaskSession?) -> TaskUserSummary.Content? {
        guard let summary = task.userSummary, summary.isCurrent(for: task),
              let content = summary.content, let session,
              content.basis.sessionID == session.id,
              let revision = session.timelineRevision,
              content.basis.timelineRevision == revision else { return nil }
        return content
    }

    static func retainedDecision(current: String?, historical: String?, retained: String?, sameScope: Bool) -> Summary {
        if current == "not_required" { return .notRequired }
        guard sameScope else { return .unknown }
        let decision = ["required", "attention"].contains(historical ?? "") ? historical : retained
        return decision == "required" ? .required : decision == "attention" ? .attention : .unknown
    }

    @MainActor
    static func attentionDecision(_ task: CorptieTask, session: TaskSession?) -> Summary {
        let content = task.userSummary?.content
        return retainedDecision(current: currentSummary(task, session: session)?.intervention,
            historical: content?.intervention, retained: content?.retainedAttention?.intervention,
            sameScope: content?.basis.taskRevision == task.revision && content?.basis.sessionID == session?.id)
    }

    @MainActor
    static func receipt(_ task: CorptieTask, session: TaskSession?) -> Receipt {
        // Keep the last issue identity while its replacement is generating.
        // Freshness still gates decisions in input(), not dismissal identity.
        let summary = task.userSummary?.content
        return Receipt(sessionID: session?.id ?? task.currentSessionId, taskRevision: task.revision,
            replySequence: session?.lastAgentMessageSequence ?? 0,
            execution: session?.executionTaskStatus.rawValue ?? task.executionStatus,
            attentionKind: session?.attention?.kind,
            attentionSource: session?.attention?.sourceId,
            attentionReason: session?.attention?.reason,
            summaryReason: ["required", "attention"].contains(summary?.intervention ?? "") ? summary?.reason : summary?.retainedAttention?.reason,
            summaryAction: ["required", "attention"].contains(summary?.intervention ?? "") ? summary?.nextAction : summary?.retainedAttention?.nextAction)
    }

    @MainActor
    static func requiresSystemAction(_ session: TaskSession?) -> Bool {
        session?.attention?.kind == "choice" ||
        (session?.executionTaskStatus == .blocked && !(session?.suggestedOptions?.isEmpty ?? true))
    }

    @MainActor
    static func input(_ task: CorptieTask, session: TaskSession?, selected: Bool, deferred: Bool) -> Input {
        return Input(
            excluded: task.archived == true || task.deletionStatus != nil,
            selected: selected,
            running: session?.executionTaskStatus == .running || (session == nil && task.executionStatus == "running"),
            unread: (session?.lastAgentMessageSequence ?? 0) > (session?.lastReadMessageSequence ?? 0),
            explicitAttention: requiresSystemAction(session),
            hasReply: (session?.lastAgentMessageSequence ?? 0) > 0,
            cancelled: session?.executionTaskStatus == .cancelled,
            scheduled: task.hasPendingScheduledWake == true,
            summary: attentionDecision(task, session: session),
            deferred: deferred)
    }
}
