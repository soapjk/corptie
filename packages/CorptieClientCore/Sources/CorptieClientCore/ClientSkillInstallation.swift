import Foundation

/// Durable backend receipt, independent of Provider and presentation lifetime.
public struct ClientSkillInstallOperation: Codable, Equatable, Sendable, Identifiable {
    public let operationId: String
    public let requestId: String
    public let status: String
    public let skillId: String?
    public let errorCode: String?
    public let updatedAt: String
    public var id: String { operationId }
    public var isTerminal: Bool { ["succeeded", "failed", "repair_required"].contains(status) }
    public var succeeded: Bool { status == "succeeded" }
}

public struct ClientSkillInstallEnvelope: Decodable, Sendable {
    public let operation: ClientSkillInstallOperation
}
