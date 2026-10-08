import Foundation

public struct UnifiedSearchPage: Decodable, Sendable {
    public let schemaVersion: Int
    public let query: String
    public let indexState: String
    public let items: [UnifiedSearchHit]
    public let nextCursor: String?
}

public struct UnifiedSearchHit: Decodable, Identifiable, Equatable, Sendable {
    public let id: String
    public let kind: String
    public let resourceId: String
    public let title: String
    public let snippet: String
    public let createdAt: String
    public let workId: String?
    public let sessionId: String?
    public let taskId: String?
    public let messageId: String?
    public let workTitle: String?
    public let taskTitle: String?
    public let archived: Bool
}

public struct ClientUnifiedSearchAPI: Sendable {
    private let transport: BackendTransport
    public init(transport: BackendTransport) { self.transport = transport }
    public func search(query: String, scope: String = "all", workID: String? = nil,
                       cursor: String? = nil) async throws -> UnifiedSearchPage {
        var items = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "scope", value: scope)]
        if let workID { items.append(URLQueryItem(name: "workId", value: workID)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        let request = try transport.endpoint.request(path: ["client", "v1", "search"], query: items)
        let (data, _) = try await transport.data(for: request)
        return try JSONDecoder().decode(UnifiedSearchPage.self, from: data)
    }
}
