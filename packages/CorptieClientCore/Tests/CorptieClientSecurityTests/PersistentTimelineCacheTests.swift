import Foundation
import CryptoKit
import Testing
import CorptieClientCore
@testable import CorptieClientSecurity

struct PersistentTimelineCacheTests {
    @Test func restartRestoresMessagesAndRevisionTogetherWithEncryptedScopeIsolation() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let cache = PersistentTimelineCache(directory: directory, keyProvider: { key })
        let message = try JSONDecoder().decode(ClientMessage.self, from: Data(#"{"id":"one","type":"agentMessage","text":"PRIVATE-MESSAGE","images":[],"toolExecution":{"schemaVersion":1,"toolId":"one","name":"tool","status":"completed","result":"PRIVATE-RESULT"}}"#.utf8))
        await cache.save(PersistedClientTimeline(sessionID: "session", revision: 7, messages: [message], before: "one"), scope: "server|device")
        try await cache.flush()
        let recreated = PersistentTimelineCache(directory: directory, keyProvider: { key })
        let records = try await recreated.load(scope: "server|device")
        #expect(records.count == 1)
        #expect(records.first?.revision == 7)
        #expect(records.first?.messages == [message])
        #expect(records.first?.before == "one")
        #expect(try await recreated.load(scope: "server|other-device").isEmpty)
        #expect(try await recreated.load(scope: "other-server|device").isEmpty)
        for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
            let data = try Data(contentsOf: file)
            #expect(data.range(of: Data("PRIVATE-MESSAGE".utf8)) == nil)
            #expect(data.range(of: Data("PRIVATE-RESULT".utf8)) == nil)
        }
    }

    @Test func boundedCacheNeverPersistsCursorWithoutItsBaseline() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let cache = PersistentTimelineCache(directory: directory, keyProvider: { key })
        for index in 0..<50 {
            await cache.save(PersistedClientTimeline(sessionID: "session:\(index)", revision: index, messages: [], before: nil), scope: "scope")
        }
        try await cache.flush()
        #expect(try await cache.load(scope: "scope").count == 48)
        let large = ClientMessage(id: "large", text: String(repeating: "x", count: 2 * 1024 * 1024))
        await cache.save(PersistedClientTimeline(sessionID: "large", revision: 99, messages: [large], before: nil), scope: "scope")
        try await cache.flush()
        #expect(try await cache.load(scope: "scope").contains(where: { $0.sessionID == "large" }) == false)
        let wrongKey = SymmetricKey(size: .bits256)
        let wrong = PersistentTimelineCache(directory: directory, keyProvider: { wrongKey })
        #expect(try await wrong.load(scope: "scope").isEmpty)
        #expect(try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).count == 48)
    }
}
