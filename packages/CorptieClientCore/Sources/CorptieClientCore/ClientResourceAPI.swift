import Foundation

public struct ClientResourceSummary: Decodable, Sendable, Identifiable, Equatable {
    public struct Owner: Decodable, Sendable, Equatable { public let type: String; public let id: String? }
    public let id: String
    public let type: String
    public let title: String
    public let summary: String
    public let owner: Owner
    public let workId: String?
    public let workName: String
    public let sourceSessionId: String?
    public let sourceTitle: String
    public let updatedAt: String
    public let createdAt: String
    public let revision: Int
    public let status: String
    public let currentVersion: Int
    public let approvedVersion: Int?
    public let previewHash: String?
    public let previewState: String?
    public let capabilities: [String]
}

public struct ClientResourcePage: Decodable, Sendable {
    public let schemaVersion: Int
    public let items: [ClientResourceSummary]
    public let hasMore: Bool
    public let nextCursor: String?
    public let invalidItemCount: Int
    public let capabilities: [String]
    private struct Item: Decodable {
        let value: ClientResourceSummary?
        init(from decoder: Decoder) throws {
            let candidate = try? ClientResourceSummary(from: decoder)
            value = candidate.flatMap { $0.type == "artifact" && ["session", "work", "task"].contains($0.owner.type)
                && !($0.owner.id?.isEmpty ?? true) && $0.revision > 0 ? $0 : nil }
        }
    }
    private enum CodingKeys: CodingKey { case schemaVersion, items, hasMore, nextCursor, capabilities }
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try values.decode(Int.self, forKey: .schemaVersion)
        let rows = try values.decode([Item].self, forKey: .items)
        items = rows.compactMap(\.value); invalidItemCount = rows.count - items.count
        hasMore = try values.decode(Bool.self, forKey: .hasMore)
        nextCursor = try values.decodeIfPresent(String.self, forKey: .nextCursor)
        capabilities = try values.decodeIfPresent([String].self, forKey: .capabilities) ?? []
        guard schemaVersion == 1, rows.count <= 100, hasMore == (nextCursor != nil) else { throw ClientConnectionError.invalidResponse }
    }
}

public struct ClientResourceDetail: Decodable, Sendable {
    public struct Target: Decodable, Sendable, Identifiable {
        public let id: String; public let title: String; public let taskId: String?
    }
    public struct Version: Decodable, Sendable, Identifiable {
        public var id: Int { version }
        public let version: Int
        public let contentHash: String
        public let byteLength: Int
        public let mimeType: String
        public let approvalStatus: String
        public let createdAt: String
    }
    public struct Reference: Decodable, Sendable, Identifiable {
        public let id: String; public let taskId: String?; public let sessionId: String?
        public let version: Int; public let hash: String; public let policy: String
    }
    public let schemaVersion: Int
    public let resource: ClientResourceSummary
    public let versions: [Version]
    public let references: [Reference]
    public let targets: [Target]
    public let versionsTruncated: Bool
    public let referencesTruncated: Bool
}

public struct ClientResourceExport: Decodable, Sendable {
    public let schemaVersion: Int; public let fileName: String; public let mimeType: String; public let dataBase64: String
}

public struct ClientResourceRead: Decodable, Sendable {
    public struct Range: Decodable, Sendable { public let offset: Int; public let nextOffset: Int? }
    public let artifactId: String; public let version: Int; public let contentHash: String
    public let mimeType: String; public let content: String?; public let encoding: String?
    public let range: Range; public let complete: Bool
}

public struct ClientResourceFocus: Hashable, Sendable {
    public let id: String
    public let version: Int?
    public let hash: String?
    public let workId: String?
    public init(id: String, version: Int? = nil, hash: String? = nil, workId: String? = nil) {
        self.id = id; self.version = version; self.hash = hash; self.workId = workId
    }
}

public struct ClientResourceAPI: Sendable {
    public struct Work: Decodable, Sendable, Identifiable { public let id: String; public let name: String }
    public enum Route: Sendable { case desktop, pairedDevice }
    private let transport: BackendTransport
    private let prefix: [String]
    public init(transport: BackendTransport, route: Route) {
        self.transport = transport; prefix = route == .desktop ? ["resources"] : ["client", "v1", "resources"]
    }
    public func list(query: String = "", workId: String? = nil, status: String = "all", sort: String = "updated", cursor: String? = nil) async throws -> ClientResourcePage {
        var parameters = [URLQueryItem(name: "query", value: query), .init(name: "status", value: status), .init(name: "sort", value: sort), .init(name: "limit", value: "50")]
        if let workId { parameters.append(.init(name: "workId", value: workId)) }
        if let cursor { parameters.append(.init(name: "cursor", value: cursor)) }
        return try await get([], query: parameters)
    }
    public func detail(_ id: String, version: Int? = nil) async throws -> ClientResourceDetail {
        try await get([id], query: version.map { [.init(name: "version", value: String($0))] } ?? [])
    }
    public func works(cursor: String? = nil) async throws -> ClientInventoryPage<Work> {
        let page: ClientInventoryPage<Work> = try await get(["works"], query: cursor.map { [.init(name: "cursor", value: $0)] } ?? [])
        guard page.schemaVersion == 1, page.items.count <= 100, page.hasMore == (page.nextCursor != nil) else { throw ClientConnectionError.invalidResponse }
        return page
    }
    public func create(workId: String, title: String, summary: String, content: String, requestId: String,
                       importedBytes: Data? = nil, mimeType: String = "text/markdown") async throws -> ClientResourceDetail {
        var input: [String: ClientInspectorValue] = ["workId": .string(workId), "title": .string(title), "summary": .string(summary), "requestId": .string(requestId), "mimeType": .string(mimeType)]
        if let importedBytes { input["dataBase64"] = .string(importedBytes.base64EncodedString()) }
        else { input["content"] = .string(content) }
        let data = try await post([], input: input)
        return try JSONDecoder().decode(ClientResourceDetail.self, from: data)
    }
    public func export(_ resource: ClientResourceSummary, version: Int, hash: String) async throws -> ClientResourceExport {
        let data = try await post([resource.id, "commands"], input: ["action": .string("export"), "expectedRevision": .number(Double(resource.revision)), "version": .number(Double(version)), "hash": .string(hash), "confirmed": .bool(true)])
        guard data.count <= 24 * 1024 * 1024 else { throw ClientConnectionError.invalidResponse }
        return try JSONDecoder().decode(ClientResourceExport.self, from: data)
    }
    public func read(_ id: String, version: Int, hash: String, offset: Int, readId: String) async throws -> ClientResourceRead {
        try await get([id, "read"], query: [.init(name: "version", value: String(version)), .init(name: "hash", value: hash), .init(name: "offset", value: String(offset)), .init(name: "readId", value: readId)])
    }
    public func command(_ resource: ClientResourceSummary, action: String, fields: [String: ClientInspectorValue] = [:]) async throws {
        var input = fields; input["action"] = .string(action); input["expectedRevision"] = .number(Double(resource.revision))
        _ = try await post([resource.id, "commands"], input: input)
    }
    private func post(_ suffix: [String], input: [String: ClientInspectorValue]) async throws -> Data {
        var request = try transport.endpoint.request(path: prefix + suffix)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(input)
        let (data, _) = try await transport.data(for: request)
        return data
    }
    private func get<T: Decodable & Sendable>(_ suffix: [String], query: [URLQueryItem] = []) async throws -> T {
        let request = try transport.endpoint.request(path: prefix + suffix, query: query)
        let (data, _) = try await transport.data(for: request)
        guard data.count <= 524288 else { throw ClientConnectionError.invalidResponse }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
