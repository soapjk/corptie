import Foundation

public struct ClientInventoryPage<Item: Decodable & Sendable>: Decodable, Sendable {
    public let schemaVersion: Int
    public let items: [Item]
    public let hasMore: Bool
    public let nextCursor: String?
}
public struct ClientWork: Decodable, Sendable, Identifiable, Equatable {
    public let description: String?
    public let id: String
    public let name: String
    public let status: String
    /// Host advertises availability only; bytes come from `ClientInventory.workAvatar`.
    public let hasAvatar: Bool
    public let updatedAt: String

    enum CodingKeys: String, CodingKey { case id, name, status, hasAvatar, updatedAt, description }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        name = try container.decode(String.self, forKey: .name)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        status = try container.decode(String.self, forKey: .status)
        hasAvatar = try container.decodeIfPresent(Bool.self, forKey: .hasAvatar) ?? false
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}
public struct ClientTask: Decodable, Sendable, Identifiable, Equatable {
    public let description: String?
    public let acceptanceCriteria: String?
    public let verificationCriteria: String?
    public let id: String
    public let title: String
    public let workId: String
    public let lifecycleState: String
    public let executionStatus: String
    public let currentSessionId: String?
    /// Mirrors the macOS outline `ConsoleScheduledWakeIcon` signal.
    public let hasPendingScheduledWake: Bool
    /// `deleting` / `delete_failed`; nil when the Task is not being deleted.
    public let deletionStatus: String?
    /// The macOS outline hides archived Tasks; older hosts omit the flag.
    public let archived: Bool
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, workId, lifecycleState, executionStatus, currentSessionId, hasPendingScheduledWake, deletionStatus, archived, updatedAt, description, acceptanceCriteria, verificationCriteria
    }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        description = try container.decodeIfPresent(String.self, forKey: .description)
        acceptanceCriteria = try container.decodeIfPresent(String.self, forKey: .acceptanceCriteria)
        verificationCriteria = try container.decodeIfPresent(String.self, forKey: .verificationCriteria)
        workId = try container.decode(String.self, forKey: .workId)
        lifecycleState = try container.decode(String.self, forKey: .lifecycleState)
        executionStatus = try container.decode(String.self, forKey: .executionStatus)
        currentSessionId = try container.decodeIfPresent(String.self, forKey: .currentSessionId)
        hasPendingScheduledWake = try container.decodeIfPresent(Bool.self, forKey: .hasPendingScheduledWake) ?? false
        deletionStatus = try container.decodeIfPresent(String.self, forKey: .deletionStatus)
        archived = try container.decodeIfPresent(Bool.self, forKey: .archived) ?? false
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }
}
public struct ClientSession: Decodable, Sendable, Identifiable, Equatable {
    public let summary: String?
    public let id: String
    public let title: String
    public let workId: String?
    public let taskId: String?
    public let sessionKind: String?
    public let executionStatus: String
    public let activityStatus: String?
    /// Read-receipt cursors; identical inputs to the desktop unread rule (`SessionReadAttention`).
    public let lastAgentMessageSequence: Int
    public let lastReadMessageSequence: Int
    public let updatedAt: String

    enum CodingKeys: String, CodingKey {
        case id, title, workId, taskId, sessionKind, executionStatus, activityStatus, summary
        case lastAgentMessageSequence, lastReadMessageSequence, updatedAt
    }
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        workId = try container.decodeIfPresent(String.self, forKey: .workId)
        taskId = try container.decodeIfPresent(String.self, forKey: .taskId)
        sessionKind = try container.decodeIfPresent(String.self, forKey: .sessionKind)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
        executionStatus = try container.decode(String.self, forKey: .executionStatus)
        activityStatus = try container.decodeIfPresent(String.self, forKey: .activityStatus)
        lastAgentMessageSequence = try container.decodeIfPresent(Int.self, forKey: .lastAgentMessageSequence) ?? 0
        lastReadMessageSequence = try container.decodeIfPresent(Int.self, forKey: .lastReadMessageSequence) ?? 0
        updatedAt = try container.decode(String.self, forKey: .updatedAt)
    }

    /// True when the agent finished and produced messages the user has not opened yet.
    public var needsUserAttention: Bool {
        SessionReadAttention.needsUserAttention(executionStatus: executionStatus,
            lastAgentMessageSequence: lastAgentMessageSequence, lastReadMessageSequence: lastReadMessageSequence)
    }
}

/// Unread policy shared with macOS `sessionNeedsUserAttention` / `SessionReadAcknowledgementPolicy`.
public enum SessionReadAttention {
    public static func needsUserAttention(executionStatus: String, lastAgentMessageSequence: Int, lastReadMessageSequence: Int) -> Bool {
        SessionExecutionState(executionStatus: executionStatus) == .complete && lastAgentMessageSequence > lastReadMessageSequence
    }
    /// Sequence to acknowledge when the session is opened; nil when nothing new to submit.
    public static func sequenceForOpenedSession(lastAgentMessageSequence: Int, lastReadMessageSequence: Int,
                                                alreadySubmittedSequence: Int?) -> Int? {
        guard lastAgentMessageSequence > lastReadMessageSequence,
              lastAgentMessageSequence > (alreadySubmittedSequence ?? 0) else { return nil }
        return lastAgentMessageSequence
    }
}

public struct ClientReadReceipt: Decodable, Sendable, Equatable {
    public let schemaVersion: Int
    public let sessionId: String
    public let lastAgentMessageSequence: Int
    public let lastReadMessageSequence: Int
}
public struct ClientInventory: Sendable {
    private let transport: BackendTransport
    public init(transport: BackendTransport) { self.transport = transport }
    public func works(cursor: String? = nil) async throws -> ClientInventoryPage<ClientWork> { try await page("works", cursor: cursor) }
    public func tasks(cursor: String? = nil) async throws -> ClientInventoryPage<ClientTask> { try await page("tasks", cursor: cursor) }
    public func sessions(cursor: String? = nil) async throws -> ClientInventoryPage<ClientSession> { try await page("sessions", cursor: cursor) }
    /// Raw managed avatar bytes for an active Work (`nil` when the host has none). Callers decode off-main.
    public func workAvatar(id: String) async throws -> (data: Data, contentType: String?)? {
        let request = try transport.endpoint.request(path: ["client", "v1", "works", id, "avatar"])
        do {
            let (data, response) = try await transport.data(for: request)
            return (data, response.value(forHTTPHeaderField: "Content-Type"))
        } catch let failure as ClientServiceFailure where failure.statusCode == 404 {
            return nil
        }
    }
    private func page<Item>(_ kind: String, cursor: String?) async throws -> ClientInventoryPage<Item> {
        let query = [URLQueryItem(name: "limit", value: "50")] + (cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
        let request = try transport.endpoint.request(path: ["client", "v1", kind], query: query)
        let (data, _) = try await transport.data(for: request)
        let result = try JSONDecoder().decode(ClientInventoryPage<Item>.self, from: data)
        guard result.schemaVersion == 1 else { throw ClientConnectionError.invalidResponse }
        return result
    }
}
