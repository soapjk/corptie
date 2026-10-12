import Foundation
import CryptoKit
import Testing
import CorptieClientCore
@testable import CorptieClientSecurity

struct ClientDetailActionJournalTests {
    @Test func encryptedRecoveryIdentitySurvivesRestartAndIsolatesAccounts() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let key = SymmetricKey(size: .bits256)
        let scope = ClientDetailActionScope(serverID: "server", principalID: "account-A", sessionID: "session-A",
            accountID: "account-A", credentialBindingID: "device-binding-1", catalog: "native-v2-components-1", capabilityDigest: "digest-1")
        let record = ClientDetailPendingAction(scope: scope, requestID: UUID().uuidString,
            documentID: "doc", cardID: "card", actionID: "action", operation: "schedule.cancel")
        let journal = ClientDetailActionFileJournal(directory: directory, key: key)
        try await journal.save(record)
        let restored = ClientDetailActionFileJournal(directory: directory, key: key)
        #expect(try await restored.pending(scope: scope) == [record])
        #expect(try await restored.pending(scope: scope) == [record])
        let other = ClientDetailActionScope(serverID: "server", principalID: "account-B", sessionID: "session-A",
            accountID: "account-B", credentialBindingID: "device-binding-1", catalog: "native-v2-components-1", capabilityDigest: "digest-1")
        #expect(try await restored.pending(scope: other).isEmpty)
        let rebound = ClientDetailActionScope(serverID: "server", principalID: "account-A", sessionID: "session-A",
            accountID: "account-A", credentialBindingID: "device-binding-2", catalog: "native-v2-components-1", capabilityDigest: "digest-1")
        #expect(try await restored.pending(scope: rebound).isEmpty)
        let changedCatalog = ClientDetailActionScope(serverID: "server", principalID: "account-A", sessionID: "session-A",
            accountID: "account-A", credentialBindingID: "device-binding-1", catalog: "native-v1", capabilityDigest: "digest-2")
        #expect(try await restored.pending(scope: changedCatalog).isEmpty)
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
        #expect(files.count == 1)
        let directoryAttributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        let fileAttributes = try FileManager.default.attributesOfItem(atPath: files[0].path)
        #expect((directoryAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        #expect((fileAttributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        #if os(iOS)
        #expect(fileAttributes[.protectionKey] as? FileProtectionType == .complete)
        #endif
        #expect(!String(decoding: try Data(contentsOf: files[0]), as: UTF8.self).contains("account-A"))
        // Exercise replacement of an existing encrypted file, not just creation.
        let second = ClientDetailPendingAction(scope: scope, requestID: UUID().uuidString,
            documentID: "doc", cardID: "card-2", actionID: "action-2", operation: "schedule.cancel")
        try await restored.save(second)
        #expect(try await journal.pending(scope: scope) == [record, second])
        try await restored.remove(scope: scope, requestID: record.requestID)
        #expect(try await journal.pending(scope: scope) == [second])
        try await restored.remove(scope: scope, requestID: second.requestID)
        #expect(try await journal.pending(scope: scope).isEmpty)
    }
    @Test func existingDirectoryIsRestrictedAndWrongKeyCannotRecover() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o755])
        let scope = ClientDetailActionScope(serverID: "server", principalID: "user", sessionID: "session",
            accountID: "account", credentialBindingID: "binding", catalog: "native-v1", capabilityDigest: "digest")
        let record = ClientDetailPendingAction(scope: scope, requestID: UUID().uuidString,
            documentID: "doc", cardID: "card", actionID: "action", operation: "schedule.cancel")
        let journal = ClientDetailActionFileJournal(directory: directory, key: SymmetricKey(size: .bits256))
        try await journal.save(record)
        let attributes = try FileManager.default.attributesOfItem(atPath: directory.path)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
        let wrongKey = ClientDetailActionFileJournal(directory: directory, key: SymmetricKey(size: .bits256))
        await #expect(throws: (any Error).self) { _ = try await wrongKey.pending(scope: scope) }
        #expect(try await journal.pending(scope: scope) == [record])
    }
}
