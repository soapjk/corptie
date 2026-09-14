import Foundation

public enum ClientControlKind: String, CaseIterable, Sendable {
    case automations, repositories, agents, skills
}

/// Summary-only contract. Optional fields belong to the corresponding resource,
/// not to an executor; only Session IDs may be used to address commands.
public struct ClientControlItem: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let description: String?
    public let status: String?
    public let kind: String?
    public let sourceType: String?
    public let logicalSessionId: String?
    public let sessionId: String?
    public let scheduleType: String?
    public let nextRunAt: String?
    public let expiresAt: String?
    public let lastRunStatus: String?
    public let availability: String?
    public let worktreeCount: Int?
    public let updatedAt: String?
}

public struct ClientRepositoryDetail: Decodable, Sendable, Equatable {
    public struct Worktree: Decodable, Sendable, Identifiable, Equatable {
        public let id: String
        public let branchName: String?
        public let isMain: Bool
        public let availability: String
        public let state: String
        public let dirty: Bool?
        public let aheadOfMain: Int?
        public let behindMain: Int?
        public let pendingIntegration: Bool
    }
    public struct Job: Decodable, Sendable, Identifiable, Equatable {
        public let id: String
        public let status: String
    }
    public let schemaVersion: Int
    public let repository: ClientControlItem
    public let worktrees: [Worktree]
    public let latestJob: Job?
}

public struct ClientControlAPI: Sendable {
    private let transport: BackendTransport
    public init(transport: BackendTransport) { self.transport = transport }
    public func list(_ kind: ClientControlKind, cursor: String? = nil) async throws -> ClientInventoryPage<ClientControlItem> {
        let query = [URLQueryItem(name: "limit", value: "50")]
            + (cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
        let request = try transport.endpoint.request(path: ["client", "v1", "control", kind.rawValue], query: query)
        let (data, _) = try await transport.data(for: request)
        let page = try JSONDecoder().decode(ClientInventoryPage<ClientControlItem>.self, from: data)
        guard page.schemaVersion == 1, page.hasMore == (page.nextCursor != nil), page.items.count <= 50 else {
            throw ClientConnectionError.invalidResponse
        }
        return page
    }
    public func repository(_ id: String) async throws -> ClientRepositoryDetail {
        let request = try transport.endpoint.request(path: ["client", "v1", "control", "repositories", id])
        let (data, _) = try await transport.data(for: request)
        let detail = try JSONDecoder().decode(ClientRepositoryDetail.self, from: data)
        guard detail.schemaVersion == 1, detail.repository.id == id else { throw ClientConnectionError.invalidResponse }
        return detail
    }
}
