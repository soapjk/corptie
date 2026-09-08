import Foundation

/// Presentation policy only: never completes, interrupts or archives a Task.
enum ConsoleAttentionPolicy {
    enum Summary: String { case required, notRequired, unknown }
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
        if input.unread || input.explicitAttention || input.summary == .required { return true }
        return input.hasReply && input.summary == .unknown && !input.cancelled && !input.scheduled
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
            summaryReason: summary?.intervention == "required" ? summary?.reason : nil,
            summaryAction: summary?.intervention == "required" ? summary?.nextAction : nil)
    }

    @MainActor
    static func input(_ task: CorptieTask, session: TaskSession?, selected: Bool, deferred: Bool) -> Input {
        let summary = currentSummary(task, session: session)
        return Input(
            excluded: task.archived == true || task.deletionStatus != nil,
            selected: selected,
            running: session?.executionTaskStatus == .running || (session == nil && task.executionStatus == "running"),
            unread: (session?.lastAgentMessageSequence ?? 0) > (session?.lastReadMessageSequence ?? 0),
            explicitAttention: session?.attention != nil || session?.executionTaskStatus == .blocked || session?.executionTaskStatus == .failed,
            hasReply: (session?.lastAgentMessageSequence ?? 0) > 0,
            cancelled: session?.executionTaskStatus == .cancelled,
            scheduled: task.hasPendingScheduledWake == true,
            summary: summary?.intervention == "required" ? .required : summary?.intervention == "not_required" ? .notRequired : .unknown,
            deferred: deferred)
    }
}
