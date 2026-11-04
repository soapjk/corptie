import Foundation

/// A bounded, provider-neutral directory page. Cursors address timeline ranges,
/// so a page may be empty while older/newer ranges still exist.
public struct ClientUserMessageNavigationPage: Codable, Equatable, Sendable {
    public struct Item: Codable, Equatable, Identifiable, Sendable {
        public let id: String
        public let createdAt: String
        public let preview: String
        public let replyPreview: String?
        public init(id: String, createdAt: String, preview: String, replyPreview: String? = nil) {
            self.id = id; self.createdAt = createdAt; self.preview = preview; self.replyPreview = replyPreview
        }
    }
    public let schemaVersion: Int
    public let items: [Item]
    public let olderCursor: String?
    public let newerCursor: String?
    public let scannedCount: Int
    public init(schemaVersion: Int = 1, items: [Item], olderCursor: String?, newerCursor: String?, scannedCount: Int) {
        self.schemaVersion = schemaVersion; self.items = items
        self.olderCursor = olderCursor; self.newerCursor = newerCursor; self.scannedCount = scannedCount
    }
    public func validated() throws -> Self {
        guard schemaVersion == 1, items.count <= 128, (0...1024).contains(scannedCount),
              Set(items.map(\.id)).count == items.count,
              items.allSatisfy({ !$0.id.isEmpty && $0.id.utf8.count <= 2048 && $0.preview.count <= 180 && ($0.replyPreview?.count ?? 0) <= 180 }),
              [olderCursor, newerCursor].allSatisfy({ ($0?.utf8.count ?? 0) <= 4096 }) else {
            throw ClientConnectionError.invalidResponse
        }
        return self
    }
}
