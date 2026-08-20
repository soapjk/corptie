import Foundation

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

    init(
        id: String,
        title: String,
        agent: String,
        status: TaskStatus,
        summary: String,
        updatedAt: String
    ) {
        self.id = id
        self.title = title
        self.agent = agent
        self.status = status
        self.summary = summary
        self.updatedAt = updatedAt
    }

    init(session: TaskSession) {
        id = session.id
        title = session.title
        agent = session.agent
        status = session.status
        summary = session.summary
        updatedAt = session.updatedAt
    }
}

struct SessionNotificationCounts: Equatable {
    let completed: Int
    let blocked: Int
    let failed: Int

    var total: Int { completed + blocked + failed }
}

struct SessionNotificationEvent: Equatable {
    let id: String
    let kind: SessionNotificationKind
    let session: SessionNotificationSnapshot?
    let counts: SessionNotificationCounts?
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
    private var hasObservedInitialSnapshot = false

    mutating func completedSessionIDs(
        for sessions: [SessionNotificationSnapshot]
    ) -> [String] {
        let currentIDs = Set(sessions.map(\.id))
        previousStatusesBySessionID = previousStatusesBySessionID.filter {
            currentIDs.contains($0.key)
        }

        guard hasObservedInitialSnapshot else {
            previousStatusesBySessionID = Dictionary(
                uniqueKeysWithValues: sessions.map { ($0.id, $0.status) }
            )
            hasObservedInitialSnapshot = true
            return []
        }

        let completedSessionIDs = sessions.compactMap { session -> String? in
            defer { previousStatusesBySessionID[session.id] = session.status }
            guard previousStatusesBySessionID[session.id] == .running,
                  session.status == .complete || session.status == .blocked else {
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
           sessions.allSatisfy({
               $0.status == .complete || $0.status == .blocked || $0.status == .failed
           }) {
            let counts = SessionNotificationCounts(
                completed: sessions.filter { $0.status == .complete }.count,
                blocked: sessions.filter { $0.status == .blocked }.count,
                failed: sessions.filter { $0.status == .failed }.count
            )
            if counts.total > 0 {
                let fingerprint = sessions
                    .filter { $0.status == .complete || $0.status == .blocked || $0.status == .failed }
                    .sorted { $0.id < $1.id }
                    .map { "\($0.id):\($0.status.rawValue):\($0.updatedAt)" }
                    .joined(separator: "|")
                return [SessionNotificationEvent(
                    id: "all-sessions-waiting:\(fingerprint)",
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
