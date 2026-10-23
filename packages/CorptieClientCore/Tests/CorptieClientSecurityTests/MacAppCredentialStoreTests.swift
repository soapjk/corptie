#if os(macOS)
import Foundation
import Testing
import CryptoKit
import CorptieClientCore
@testable import CorptieClientSecurity

struct MacAppCredentialStoreTests {
    @Test func timelineKeyDoesNotHydrateOrCleanOutboxPayloads() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let file = root.appendingPathComponent(UUID().uuidString + ".sealed")
        try Data("preserve-invalid-payload".utf8).write(to: file)
        let expected = SymmetricKey(size: .bits256)
        let outbox = ReliableMessageOutbox(directory: root, key: expected)
        let actual = try await outbox.timelinePersistenceKey()
        #expect(actual.withUnsafeBytes { Data($0) } == expected.withUnsafeBytes { Data($0) })
        #expect(try String(contentsOf: file, encoding: .utf8) == "preserve-invalid-payload")
    }
    private func directory() -> URL { FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString) }
    private func configuration() throws -> CloudOAuthConfiguration {
        try CloudOAuthConfiguration(endpoint: BackendEndpoint(URL(string: "https://example.test")!),
            clientID: "mac", redirectURI: URL(string: "corptie://oauth/callback")!, scopes: ["openid"],
            resource: URL(string: "https://example.test")!)
    }
    private func credential() throws -> CloudCredential {
        let decoder = JSONDecoder(); decoder.dateDecodingStrategy = .iso8601
        let tokens = try decoder.decode(CloudOAuthTokens.self, from: Data(#"{"accessToken":"synthetic","refreshToken":"synthetic-refresh","tokenType":"Bearer","expiresAt":"2030-01-01T00:00:00Z","scope":"openid"}"#.utf8))
        return CloudCredential(tokens: tokens, identity: try .init(kind: .mac, displayName: "test", privateKey: Data(repeating: 7, count: 32)))
    }
    @Test func cloudRoundTripLogoutPreservesCacheAndRejectsLateRefresh() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = MacAppCredentialStore(directory: root, environmentId: "test")
        let configuration = try configuration(), credential = try credential()
        #expect(try await store.state(configuration: configuration).generation == nil)
        let generation = try await store.save(credential, configuration: configuration, expectedGeneration: nil)
        let key = try await store.cacheKey(purpose: "detail-action-recovery", legacyDirectories: [])
        let reopened = MacAppCredentialStore(directory: root, environmentId: "test")
        #expect(try await reopened.state(configuration: configuration).credential == credential)
        try await reopened.remove(configuration: configuration)
        #expect(try await reopened.state(configuration: configuration).credential == nil)
        await #expect(throws: LocalCredentialError.self) {
            try await store.save(credential, configuration: configuration, expectedGeneration: generation)
        }
        let nextKey = try await reopened.cacheKey(purpose: "detail-action-recovery", legacyDirectories: [])
        #expect(key.withUnsafeBytes { Data($0) } == nextKey.withUnsafeBytes { Data($0) })
        let mode = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("app-credentials.v1.json").path)[.posixPermissions] as? Int
        #expect(mode == 0o600)
    }
    @Test func missingKeyNeverOverwritesJournalOnlyInstallation() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let journal = root.appendingPathComponent("journal")
        try FileManager.default.createDirectory(at: journal, withIntermediateDirectories: true)
        let bytes = Data("preserve-ciphertext".utf8)
        try bytes.write(to: journal.appendingPathComponent("scope.pending"))
        let store = MacAppCredentialStore(directory: root.appendingPathComponent("security"), environmentId: "test")
        await #expect(throws: LocalCredentialError.self) {
            try await store.cacheKey(purpose: "detail-action-recovery", legacyDirectories: [journal])
        }
        #expect(try Data(contentsOf: journal.appendingPathComponent("scope.pending")) == bytes)
        let imported = Data(repeating: 9, count: 32)
        try await store.importCacheKey(imported, purposes: ["detail-action-recovery"])
        let key = try await store.cacheKey(purpose: "detail-action-recovery", legacyDirectories: [journal])
        #expect(key.withUnsafeBytes { Data($0) } == imported)
        await #expect(throws: LocalCredentialError.self) {
            try await store.importCacheKey(Data(repeating: 8, count: 32), purposes: ["detail-action-recovery"])
        }
    }
    @Test func corruptAndForeignFilesFailClosed() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = MacAppCredentialStore(directory: root, environmentId: "one")
        _ = try await store.cacheKey(purpose: "detail-action-recovery", legacyDirectories: [])
        let other = MacAppCredentialStore(directory: root, environmentId: "two")
        await #expect(throws: LocalCredentialError.self) { try await other.state(configuration: configuration()) }
        let file = root.appendingPathComponent("app-credentials.v1.json")
        try Data("broken".utf8).write(to: file)
        await #expect(throws: LocalCredentialError.self) { try await store.state(configuration: configuration()) }
        #expect(try String(contentsOf: file, encoding: .utf8) == "broken")
    }
    @Test func symlinkCannotRedirectSecretWrites() async throws {
        let root = directory(); defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let target = root.appendingPathComponent("innocent")
        try Data("unchanged".utf8).write(to: target)
        try FileManager.default.createSymbolicLink(at: root.appendingPathComponent("app-credentials.v1.json"), withDestinationURL: target)
        let store = MacAppCredentialStore(directory: root, environmentId: "test")
        await #expect(throws: LocalCredentialError.self) { try await store.cacheKey(purpose: "detail-action-recovery", legacyDirectories: []) }
        #expect(try String(contentsOf: target, encoding: .utf8) == "unchanged")
    }
}
#endif
