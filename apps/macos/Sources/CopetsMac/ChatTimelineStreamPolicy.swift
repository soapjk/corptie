import Foundation

enum ChatDetailStreamHealth: Equatable, Sendable {
    case inactive
    case connecting(sessionId: String)
    case healthy(sessionId: String)
    case fallback(sessionId: String)

    func isHealthy(for sessionId: String) -> Bool {
        self == .healthy(sessionId: sessionId)
    }
}

enum ChatDetailRefreshPolicy {
    static func shouldPoll(
        sessionId: String?,
        isViewingHistory: Bool,
        sseHealthEnabled: Bool,
        streamHealth: ChatDetailStreamHealth
    ) -> Bool {
        guard let sessionId, !isViewingHistory else { return false }
        return !sseHealthEnabled || !streamHealth.isHealthy(for: sessionId)
    }

    static func reconnectDelaySeconds(afterFailure failureCount: Int) -> Int {
        guard failureCount > 0 else { return 0 }
        return min(30, 1 << min(failureCount, 5))
    }
}
