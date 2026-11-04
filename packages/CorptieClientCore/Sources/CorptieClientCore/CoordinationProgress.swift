import Foundation

/// Provider-neutral presentation facts. A completed model turn is never acceptance.
public struct ClientCoordinationProgress: Codable, Equatable, Sendable {
    public let version: Int
    public let batchId: String
    public let parentSessionId: String
    public let revision: Int
    public let updatedAt: String
    public let counts: [String: Int]
    public let total: Int
    public let items: [ClientCoordinationProgressItem]
    public let hasMore: Bool
    public let focus: String
    public let decision: String
}

public struct ClientCoordinationProgressItem: Codable, Equatable, Identifiable, Sendable {
    public var id: String { assignmentId }
    public let assignmentId: String
    public let taskId: String?
    public let sessionId: String?
    public let title: String
    public let state: String
    public let summary: String
    public let reason: String
    public let reportMessageId: String?
    public let updatedAt: String
}

public struct ClientCoordinationProgressPage: Decodable, Sendable {
    public let items: [ClientCoordinationProgressItem]
    public let nextOffset: Int?
}

public struct ClientCoordinationProgressReport: Decodable, Sendable {
    public let text: String
    public let nextOffset: Int?
}

extension ClientCoordinationProgress {
    /// Mirrors the shared card's bounded three-row layout; no history measurement.
    public var previewHeight: Double {
        76 + Double(items.count) * 66 + (focus.isEmpty ? 0 : 40)
            + (decision.isEmpty ? 0 : 40) + (hasMore ? 28 : 0)
    }
}
