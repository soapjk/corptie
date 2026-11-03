import Foundation
import Observation

struct MemoryCenterQuery: Equatable, Sendable {
    var ownerType: String?
    var ownerID: String?
    var text = ""
    var kind = "all"
    var topic = "all"
    var status = "current"
    var includeRevoked = false
    var reviewOnly = false
    var sourceType = "all"
    var trustLevel = "all"

    func parameters(cursor: String? = nil) -> [URLQueryItem] {
        var values = [URLQueryItem(name: "limit", value: "50"),
                      URLQueryItem(name: "includeRevoked", value: includeRevoked && !reviewOnly ? "true" : "false")]
        if let ownerType, let ownerID {
            values += [.init(name: "ownerType", value: ownerType), .init(name: "ownerId", value: ownerID)]
        } else { values.append(.init(name: "global", value: "true")) }
        if !text.isEmpty { values.append(.init(name: "query", value: text)) }
        if kind != "all" { values.append(.init(name: "kind", value: kind)) }
        if topic != "all" { values.append(.init(name: "primaryTopic", value: topic)) }
        let effectiveStatus = reviewOnly ? "candidate" : status
        if effectiveStatus != "all" { values.append(.init(name: "status", value: effectiveStatus)) }
        if reviewOnly { values.append(.init(name: "sourceType", value: "extracted")) }
        else if sourceType != "all" { values.append(.init(name: "sourceType", value: sourceType)) }
        if trustLevel != "all" { values.append(.init(name: "trustLevel", value: trustLevel)) }
        if let cursor { values.append(.init(name: "cursor", value: cursor)) }
        return values
    }
}

/// Display projections are prepared with the response, never on row selection.
struct MemoryCenterRow: Identifiable, Hashable, Sendable {
    let memory: MemoryItem
    let preview: String
    let excerpt: String
    let hasMoreContent: Bool
    let inactive: Bool
    var id: String { memory.id }

    init(_ memory: MemoryItem, now: Date = Date()) {
        self.memory = memory
        preview = String(memory.content.prefix(240)).replacingOccurrences(of: "\n", with: " ")
        excerpt = String(memory.content.prefix(4000))
        hasMoreContent = memory.content.count > 4000
        let expiry = memory.expiresAt.flatMap { value -> Date? in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = formatter.date(from: value) { return date }
            formatter.formatOptions = [.withInternetDateTime]
            return formatter.date(from: value)
        }
        inactive = memory.revokedAt != nil || (expiry.map { $0 <= now } ?? false)
            || ["superseded", "archived", "rolled_back"].contains(memory.promotionStatus ?? "")
    }
    var canReview: Bool {
        memory.sourceType == "extracted" && memory.promotionStatus == "candidate" && memory.revokedAt == nil
    }
    var canMerge: Bool {
        memory.promotionStatus == "active" && memory.trustLevel == "trusted" && !inactive
    }
}

struct MemoryCenterResultPage {
    let rows: [MemoryCenterRow]
    let nextCursor: String?
}

struct MemoryCenterFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Separate from EntityAPIClient's shared browsing cursor. Decoding and text
/// projection run on this actor, outside the UI executor, for every entry point.
actor MemoryCenterReader {
    let baseURL: URL
    let session: URLSession
    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    private func read<T: Decodable>(_ path: String, parameters: [URLQueryItem] = [], as: T.Type, keys: JSONDecoder.KeyDecodingStrategy = .convertFromSnakeCase) async throws -> T {
        var url = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)!
        url.queryItems = parameters.isEmpty ? nil : parameters
        let (data, response) = try await session.data(from: url.url!)
        try Task.checkCancellation()
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw MemoryCenterFailure(message: body?["error"] as? String ?? "Memory request failed (HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)).")
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = keys
        return try decoder.decode(T.self, from: data)
    }

    func page(_ query: MemoryCenterQuery, cursor: String? = nil) async throws -> MemoryCenterResultPage {
        let envelope = try await read("memories", parameters: query.parameters(cursor: cursor), as: MemoryListEnvelope.self)
        let rows = envelope.memories.filter { !query.reviewOnly || ($0.sourceType == "extracted" && $0.promotionStatus == "candidate" && $0.revokedAt == nil) }
        return .init(rows: rows.map { MemoryCenterRow($0) }, nextCursor: envelope.hasMore == true ? envelope.nextCursor : nil)
    }
    func audit(_ id: String) async throws -> [MemoryAuditEntry] {
        try await read("memory-audit", parameters: [.init(name: "memoryId", value: id)], as: MemoryAuditListEnvelope.self).audit
    }
    func recalls(_ id: String) async throws -> [MemoryRecallAudit] {
        try await read("memory-recall-audit", parameters: [.init(name: "memoryId", value: id), .init(name: "limit", value: "50")], as: MemoryRecallListEnvelope.self).recalls
    }
    func jobs() async throws -> [MemoryExtractionJob] {
        try await read("memory-extraction-jobs", as: MemoryExtractionJobsEnvelope.self, keys: .useDefaultKeys).jobs
    }
}

@MainActor @Observable
final class MemoryCenterStore {
    private let reader: MemoryCenterReader
    private var generation = 0
    private(set) var rows: [MemoryCenterRow] = []
    @ObservationIgnored private(set) var rowsByID: [String: MemoryCenterRow] = [:]
    private(set) var nextCursor: String?
    private(set) var isLoading = false
    private(set) var error: String?
    private(set) var loadedQuery: MemoryCenterQuery?
    private(set) var updatedAt: Date?
    static let cacheLimit = 500

    init(reader: MemoryCenterReader = MemoryCenterReader(baseURL: CorptieAppEnvironment.backendBaseURL)) { self.reader = reader }

    func load(_ query: MemoryCenterQuery, more: Bool = false) async {
        if more && (isLoading || loadedQuery != query || nextCursor == nil || rows.count >= Self.cacheLimit) { return }
        generation += 1
        let requestGeneration = generation
        let cursor = more ? nextCursor : nil
        isLoading = true
        error = nil
        defer { if generation == requestGeneration { isLoading = false } }
        do {
            let page = try await reader.page(query, cursor: cursor)
            try Task.checkCancellation()
            guard generation == requestGeneration else { return }
            if more {
                let ids = Set(rows.map(\.id))
                rows.append(contentsOf: page.rows.filter { !ids.contains($0.id) }.prefix(Self.cacheLimit - rows.count))
            } else { rows = page.rows }
            rowsByID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
            nextCursor = page.nextCursor
            loadedQuery = query
            updatedAt = Date()
        } catch is CancellationError {
        } catch {
            guard generation == requestGeneration, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
    }

    func invalidate() {
        generation += 1
        isLoading = false
    }
}
