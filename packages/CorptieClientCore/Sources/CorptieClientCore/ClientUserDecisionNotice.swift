import Foundation

/// A host-authored notification; approval remains an explicit conversation action.
public struct ClientUserDecisionNotice: Decodable, Equatable, Sendable {
    public let id: String
    public let sessionId: String
    public let title: String
    public let body: String
    public let occurredAt: String
    public var notification: OperationNotificationEvent? {
        guard let date = ClientAutomationNotificationBatch.date(occurredAt) else { return nil }
        return OperationNotificationEvent(id: id, category: .worktree, outcome: .attention,
            name: title, summary: body, sessionID: sessionId, occurredAt: date)
    }
}
