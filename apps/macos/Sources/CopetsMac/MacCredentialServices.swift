import Foundation
import Security
import CorptieClientSecurity

@MainActor
enum MacCredentialServices {
    static let store = MacAppCredentialStore(directory: CorptieAppEnvironment.credentialDirectory,
                                            environmentId: CorptieAppEnvironment.credentialEnvironmentID)
    static var legacyRecoveryDirectories: [URL] {
        // Development must never inspect or import production recovery data.
        let root = CorptieAppEnvironment.credentialDirectory.deletingLastPathComponent()
        return ["DetailActionRecovery", "MessageOutbox", "TimelineCache"].map {
            root.appendingPathComponent($0, isDirectory: true)
        }
    }
    /// Invoked only by the explicit migration button. No constructor/startup I/O.
    static func importLegacyCacheKey() async throws {
        guard CorptieAppEnvironment.canManageProductionBackend else { throw LocalCredentialError.unavailable }
        let data = try await Task.detached {
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: "com.corptie.client.message-outbox",
                kSecAttrAccount as String: "encryption-v1", kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne]
            var result: CFTypeRef?
            guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
                  let data = result as? Data, data.count == 32 else { throw LocalCredentialError.migrationRequired }
            return data
        }.value
        try await store.importCacheKey(data, purposes: ["detail-action-recovery", "message-outbox", "timeline-cache"])
    }
}
