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

public actor CloudCredentialVault {
    private let service: String

    public init(service: String = "com.corptie.client.cloud-credentials") { self.service = service }

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

    private func query(_ configuration: CloudOAuthConfiguration) throws -> [String: Any] {
        guard let host = configuration.endpoint.baseURL.host?.lowercased() else { throw CredentialVaultError.invalidIdentity }
        let port = configuration.endpoint.baseURL.port ?? (configuration.endpoint.baseURL.scheme == "https" ? 443 : 80)
        let account = "\(configuration.endpoint.baseURL.scheme ?? "")://\(host):\(port)|\(configuration.clientID)"
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }
}
