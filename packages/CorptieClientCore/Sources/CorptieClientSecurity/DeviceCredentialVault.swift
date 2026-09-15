import Foundation
import Security
import CorptieClientCore

public enum CredentialVaultError: Error { case invalidIdentity, keychain(OSStatus) }

/// Separate platform-security target keeps transport and DTOs independent of Keychain.
public actor DeviceCredentialVault {
    private let service: String
    public init(service: String = "com.corptie.client.device-credentials") { self.service = service }

    static func account(endpoint: BackendEndpoint, serverId: String) throws -> String {
        guard !serverId.isEmpty, serverId.count <= 256, endpoint.baseURL.scheme == "https" else {
            throw CredentialVaultError.invalidIdentity
        }
        var components = URLComponents(url: endpoint.baseURL, resolvingAgainstBaseURL: false)!
        components.path = ""
        components.host = components.host?.lowercased()
        if components.port == 443 { components.port = nil }
        return String(data: try JSONEncoder().encode([components.string!, serverId]), encoding: .utf8)!
    }

    private func query(endpoint: BackendEndpoint, serverId: String) throws -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: try Self.account(endpoint: endpoint, serverId: serverId),
         kSecAttrSynchronizable as String: false]
    }

    public func save(_ credentials: DeviceCredentials, endpoint: BackendEndpoint, expectedServerId: String) throws {
        guard credentials.serverId == expectedServerId else { throw CredentialVaultError.invalidIdentity }
        let query = try query(endpoint: endpoint, serverId: expectedServerId)
        let attributes: [String: Any] = [kSecValueData as String: try JSONEncoder().encode(credentials),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let added = SecItemAdd(query.merging(attributes, uniquingKeysWith: { _, new in new }) as CFDictionary, nil)
            guard added == errSecSuccess else { throw CredentialVaultError.keychain(added) }
        } else if status != errSecSuccess { throw CredentialVaultError.keychain(status) }
    }

    public func load(endpoint: BackendEndpoint, serverId: String) throws -> DeviceCredentials? {
        var query = try query(endpoint: endpoint, serverId: serverId)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw CredentialVaultError.keychain(status) }
        guard let data = result as? Data else { throw CredentialVaultError.invalidIdentity }
        let credentials = try JSONDecoder().decode(DeviceCredentials.self, from: data)
        guard credentials.serverId == serverId else { throw CredentialVaultError.invalidIdentity }
        return credentials
    }

    public func remove(endpoint: BackendEndpoint, serverId: String) throws {
        let status = SecItemDelete(try query(endpoint: endpoint, serverId: serverId) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw CredentialVaultError.keychain(status) }
    }

    /// The UI must keep the expected server identity from its trusted pairing information.
    public func exchangeAndStore(claim: DevicePairingClaim, endpoint: BackendEndpoint, expectedServerId: String, certificate: String? = nil) async throws -> DeviceCredentials {
        var credentials = try await DevicePairingClient(endpoint: endpoint, certificate: certificate).exchange(claim)
        credentials.certificate = certificate
        try save(credentials, endpoint: endpoint, expectedServerId: expectedServerId)
        return credentials
    }
}
