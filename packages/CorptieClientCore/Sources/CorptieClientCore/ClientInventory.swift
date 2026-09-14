import Foundation

public struct ClientInventoryPage<Item: Decodable & Sendable>: Decodable, Sendable {
    public let schemaVersion: Int
    public let items: [Item]
    public let hasMore: Bool
    public let nextCursor: String?
}
public struct ClientWork: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let name: String
    public let status: String
    public let updatedAt: String
}
public struct ClientTask: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let workId: String
    public let lifecycleState: String
    public let executionStatus: String
    public let currentSessionId: String?
    public let updatedAt: String
}
public struct ClientSession: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let title: String
    public let workId: String?
    public let taskId: String?
    public let sessionKind: String?
    public let executionStatus: String
    public let updatedAt: String
}
public struct ClientInventory: Sendable {
    private let transport: BackendTransport
    public init(transport: BackendTransport) { self.transport = transport }
    public func works(cursor: String? = nil) async throws -> ClientInventoryPage<ClientWork> { try await page("works", cursor: cursor) }
    public func tasks(cursor: String? = nil) async throws -> ClientInventoryPage<ClientTask> { try await page("tasks", cursor: cursor) }
    public func sessions(cursor: String? = nil) async throws -> ClientInventoryPage<ClientSession> { try await page("sessions", cursor: cursor) }
    private func page<Item>(_ kind: String, cursor: String?) async throws -> ClientInventoryPage<Item> {
        let query = [URLQueryItem(name: "limit", value: "50")] + (cursor.map { [URLQueryItem(name: "cursor", value: $0)] } ?? [])
        let request = try transport.endpoint.request(path: ["client", "v1", kind], query: query)
        let (data, _) = try await transport.data(for: request)
        let result = try JSONDecoder().decode(ClientInventoryPage<Item>.self, from: data)
        guard result.schemaVersion == 1 else { throw ClientConnectionError.invalidResponse }
        return result
    }
}
