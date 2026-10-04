import Foundation
import Security
import CorptieClientCore

public struct CloudDeviceIdentity: Codable, Equatable, Sendable {
    public let id: UUID
    public let kind: CloudDevice.Kind
    public let displayName: String
    public let privateKey: Data

    public init(id: UUID = UUID(), kind: CloudDevice.Kind, displayName: String, privateKey: Data) throws {
        guard !displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              displayName.count <= 80, privateKey.count == 32 else { throw CredentialVaultError.invalidIdentity }
        self.id = id
        self.kind = kind
        self.displayName = displayName
        self.privateKey = privateKey
    }
}

public struct CloudCredential: Codable, Equatable, Sendable {
    public let tokens: CloudOAuthTokens
    public let identity: CloudDeviceIdentity

    public init(tokens: CloudOAuthTokens, identity: CloudDeviceIdentity) {
        self.tokens = tokens
        self.identity = identity
    }
}

public enum CloudCredentialStorage: Equatable, Sendable {
    case legacyKeychain
    case dataProtectionKeychain
}

public actor CloudCredentialVault {
    private let service: String
    private let storage: CloudCredentialStorage

    public init(
        service: String = "com.corptie.client.cloud-credentials",
        storage: CloudCredentialStorage = .legacyKeychain
    ) {
        self.service = service
        self.storage = storage
    }

    // Only the installed macOS app uses this path. Never remove the legacy item
    // during migration: it is the recovery copy until the new signed build has
    // proved it can read the credential across restarts and upgrades.
    public func loadMigrating(
        configuration: CloudOAuthConfiguration,
        legacyService: String
    ) async throws -> CloudCredential? {
        if let saved = try load(configuration: configuration) { return saved }
        guard storage == .dataProtectionKeychain else { return nil }
        let legacy = CloudCredentialVault(service: legacyService, storage: .legacyKeychain)
        guard let saved = try await legacy.load(configuration: configuration) else { return nil }
        try save(saved, configuration: configuration)
        guard try load(configuration: configuration) == saved else {
            throw CredentialVaultError.invalidIdentity
        }
        return saved
    }

    public func removeIncludingLegacy(
        configuration: CloudOAuthConfiguration,
        legacyService: String
    ) async throws {
        if storage == .dataProtectionKeychain {
            let legacy = CloudCredentialVault(service: legacyService, storage: .legacyKeychain)
            try await legacy.remove(configuration: configuration)
        }
        try remove(configuration: configuration)
    }

    public func save(_ credential: CloudCredential, configuration: CloudOAuthConfiguration) throws {
        let query = try query(configuration)
        let attributes: [String: Any] = [
            kSecValueData as String: try JSONEncoder().encode(credential),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let inserted = SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw CredentialVaultError.keychain(inserted) }
        } else if status != errSecSuccess {
            throw CredentialVaultError.keychain(status)
        }
    }

    public func load(configuration: CloudOAuthConfiguration) throws -> CloudCredential? {
        var request = try query(configuration)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw status == errSecSuccess ? CredentialVaultError.invalidIdentity : CredentialVaultError.keychain(status)
        }
        let credential = try JSONDecoder().decode(CloudCredential.self, from: data)
        guard credential.identity.privateKey.count == 32 else { throw CredentialVaultError.invalidIdentity }
        return credential
    }

    public func remove(configuration: CloudOAuthConfiguration) throws {
        let status = SecItemDelete(try query(configuration) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialVaultError.keychain(status) }
    }

    nonisolated func query(_ configuration: CloudOAuthConfiguration) throws -> [String: Any] {
        guard let host = configuration.endpoint.baseURL.host?.lowercased() else { throw CredentialVaultError.invalidIdentity }
        let port = configuration.endpoint.baseURL.port ?? (configuration.endpoint.baseURL.scheme == "https" ? 443 : 80)
        let account = "\(configuration.endpoint.baseURL.scheme ?? "")://\(host):\(port)|\(configuration.clientID)"
        var result: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
        if storage == .dataProtectionKeychain {
            result[kSecUseDataProtectionKeychain as String] = true
        }
        return result
    }
}
