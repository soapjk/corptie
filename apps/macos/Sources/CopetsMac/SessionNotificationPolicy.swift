import Foundation

func sessionNeedsUserAttention(
    status: TaskStatus,
    lastAgentMessageSequence: Int,
    lastReadMessageSequence: Int
) -> Bool {
    status == .complete && lastAgentMessageSequence > lastReadMessageSequence
}

enum SessionNotificationKind: String, Equatable {
    case completed
    case blocked
    case failed
    case allSessionsWaiting
}

struct SessionNotificationConfiguration: Equatable {
    var notifyOnComplete: Bool
    var notifyOnBlocked: Bool
    var notifyOnFailed: Bool
    var notifyWhenAllSessionsWaiting: Bool
}

struct SessionNotificationSnapshot: Equatable {
    let id: String
    let title: String
    let agent: String
    let status: TaskStatus
    let summary: String
    let updatedAt: String
    let lastAgentMessageSequence: Int
    let lastReadMessageSequence: Int

    init(
        id: String,
        title: String,
        agent: String,
        status: TaskStatus,
        summary: String,
        updatedAt: String,
        lastAgentMessageSequence: Int = 0,
        lastReadMessageSequence: Int = 0
    ) {
        self.id = id
        self.title = title
        self.agent = agent
        self.status = status
        self.summary = summary
        self.updatedAt = updatedAt
        self.lastAgentMessageSequence = lastAgentMessageSequence
        self.lastReadMessageSequence = lastReadMessageSequence
    }

    init(session: TaskSession) {
        id = session.id
        title = session.title
        agent = session.agent
        status = session.status
        summary = session.summary
        updatedAt = session.updatedAt
        lastAgentMessageSequence = session.lastAgentMessageSequence ?? 0
        lastReadMessageSequence = session.lastReadMessageSequence ?? 0
    }

    var needsUserAttention: Bool {
        sessionNeedsUserAttention(
            status: status,
            lastAgentMessageSequence: lastAgentMessageSequence,
            lastReadMessageSequence: lastReadMessageSequence
        )
    }
}

enum SessionNotificationScope {
    static func activeSnapshots(
        from sessions: [TaskSession],
        workItems: [WorkItem] = []
    ) -> [SessionNotificationSnapshot] {
        sessions
            .filter { isSessionInActiveBusinessScope($0, workItems: workItems) }
            .map(SessionNotificationSnapshot.init(session:))
    }
}

func isSessionInActiveBusinessScope(_ session: TaskSession, workItems: [WorkItem]) -> Bool {
    guard session.archived != true else { return false }
    guard session.resolvedSessionKind == .worker,
          let workItemID = session.workItemId,
          let workItem = workItems.first(where: { $0.id == workItemID }) else {
        return true
    }
    return WorkItemColumn.column(for: workItem.status) != .done
}

struct SessionNotificationCounts: Equatable {
    let completed: Int
    let blocked: Int
    let failed: Int
    let pendingUserAttention: Int

    var total: Int { completed + blocked + failed }
}

struct SessionNotificationEvent: Equatable {
    let id: String
    let kind: SessionNotificationKind
    let session: SessionNotificationSnapshot?
    let counts: SessionNotificationCounts?
}

enum SessionNotificationEventIdentity {
    /// Notification Center identifiers travel over an XPC boundary. Keep the
    /// identifier bounded even when an account has thousands of Sessions.
    static func allSessionsWaiting(for sessions: [SessionNotificationSnapshot]) -> String {
        let fingerprint = sessions
            .sorted { $0.id < $1.id }
            .map { "\($0.id):\($0.status.rawValue):\($0.updatedAt)" }
            .joined(separator: "|")
        return "all-sessions-waiting:v2:\(stableDigest(fingerprint))"
    }

    private static func stableDigest(_ value: String) -> String {
        var hash: UInt64 = 14_695_981_039_346_656_037
        for byte in value.utf8 {
            hash ^= UInt64(byte)
            hash &*= 1_099_511_628_211
        }
        return String(format: "%016llx", hash)
    }
}

enum SessionNotificationDestination: Equatable {
    case session(String)
    case overview
}

enum SessionNotificationNavigation {
    static func destination(for userInfo: [AnyHashable: Any]) -> SessionNotificationDestination {
        if let sessionID = userInfo["sessionId"] as? String, !sessionID.isEmpty {
            return .session(sessionID)
        }
        return .overview
    }
}

struct SessionCompletionSoundTransitionTracker {
    private var previousStatusesBySessionID: [String: TaskStatus] = [:]
    private var runStartingAgentMessageSequencesBySessionID: [String: Int] = [:]
    private var hasObservedInitialSnapshot = false

    mutating func completedSessionIDs(
        for sessions: [SessionNotificationSnapshot]
    ) -> [String] {
        let currentIDs = Set(sessions.map(\.id))
        previousStatusesBySessionID = previousStatusesBySessionID.filter {
            currentIDs.contains($0.key)
        }
        runStartingAgentMessageSequencesBySessionID = runStartingAgentMessageSequencesBySessionID.filter {
            currentIDs.contains($0.key)
        }

        guard hasObservedInitialSnapshot else {
            previousStatusesBySessionID = Dictionary(
                uniqueKeysWithValues: sessions.map { ($0.id, $0.status) }
            )
            runStartingAgentMessageSequencesBySessionID = Dictionary(
                uniqueKeysWithValues: sessions.map { ($0.id, $0.lastAgentMessageSequence) }
            )
            hasObservedInitialSnapshot = true
            return []
        }

        let completedSessionIDs = sessions.compactMap { session -> String? in
            let previousStatus = previousStatusesBySessionID[session.id]
            if session.status == .running, previousStatus != .running {
                runStartingAgentMessageSequencesBySessionID[session.id] = session.lastAgentMessageSequence
            }
            defer {
                previousStatusesBySessionID[session.id] = session.status
                if session.status != .running {
                    runStartingAgentMessageSequencesBySessionID[session.id] = session.lastAgentMessageSequence
                }
            }
            guard previousStatus == .running,
                  session.status == .complete || session.status == .blocked,
                  session.lastAgentMessageSequence
                    > (runStartingAgentMessageSequencesBySessionID[session.id] ?? 0) else {
                return nil
            }
            return session.id
        }
        return completedSessionIDs
    }
}

struct SessionNotificationReducer {
    private var previousStatusesBySessionID: [String: TaskStatus] = [:]
    private var previousHadRunningSession: Bool?

    mutating func events(
        for sessions: [SessionNotificationSnapshot],
        configuration: SessionNotificationConfiguration
    ) -> [SessionNotificationEvent] {
        let hasRunningSession = sessions.contains { $0.status == .running }

        guard let previousHadRunningSession else {
            previousStatusesBySessionID = Dictionary(
                uniqueKeysWithValues: sessions.map { ($0.id, $0.status) }
            )
            self.previousHadRunningSession = hasRunningSession
            return []
        }

        let terminalTransitions = sessions.filter {
            previousStatusesBySessionID[$0.id] == .running
                && ($0.status == .complete || $0.status == .blocked || $0.status == .failed)
        }

        let currentIDs = Set(sessions.map(\.id))
        previousStatusesBySessionID = previousStatusesBySessionID.filter { currentIDs.contains($0.key) }
        for session in sessions {
            previousStatusesBySessionID[session.id] = session.status
        }
        self.previousHadRunningSession = hasRunningSession

        if configuration.notifyWhenAllSessionsWaiting,
           previousHadRunningSession,
           !hasRunningSession,
           !terminalTransitions.isEmpty,
           sessions.allSatisfy({ $0.status != .running }) {
            // The authoritative terminal status can arrive one state revision
            // before the agent/read message cursors. A freshly finished Session
            // therefore needs attention even when both projected cursors are
            // temporarily equal (often 0). Union IDs so a transition whose
            // unread cursor already advanced is still counted exactly once.
            let pendingUserAttentionIDs = Set(
                sessions.filter(\.needsUserAttention).map(\.id)
            ).union(terminalTransitions.map(\.id))
            let counts = SessionNotificationCounts(
                completed: sessions.filter { $0.status == .complete }.count,
                blocked: sessions.filter { $0.status == .blocked }.count,
                failed: sessions.filter { $0.status == .failed }.count,
                pendingUserAttention: pendingUserAttentionIDs.count
            )
            if counts.total > 0 {
                return [SessionNotificationEvent(
                    id: SessionNotificationEventIdentity.allSessionsWaiting(for: sessions),
                    kind: .allSessionsWaiting,
                    session: nil,
                    counts: counts
                )]
            }
        }

        return terminalTransitions.compactMap { session in
            let kind: SessionNotificationKind
            let isEnabled: Bool
            switch session.status {
            case .complete:
                kind = .completed
                isEnabled = configuration.notifyOnComplete
            case .blocked:
                kind = .blocked
                isEnabled = configuration.notifyOnBlocked
            case .failed:
                kind = .failed
                isEnabled = configuration.notifyOnFailed
            case .running, .cancelled:
                return nil
            }
            guard isEnabled else { return nil }
            return SessionNotificationEvent(
                id: "session:\(session.id):\(session.status.rawValue):\(session.updatedAt)",
                kind: kind,
                session: session,
                counts: nil
            )
        }
    }
}
