import Foundation
import Security
import Testing
import CorptieClientCore
@testable import CorptieClientSecurity

struct CredentialVaultTests {
    @Test func cloudCredentialStorageTargetsSeparateMacKeychains() throws {
        let configuration = try CorptieCloudService.nativeOAuth(clientID: "corptie-macos")
        let legacy = CloudCredentialVault(service: "com.corptie.tests.cloud", storage: .legacyKeychain)
        let protected = CloudCredentialVault(service: "com.corptie.tests.cloud", storage: .dataProtectionKeychain)
        let legacyQuery = try legacy.query(configuration)
        let protectedQuery = try protected.query(configuration)

        #expect(legacyQuery[kSecUseDataProtectionKeychain as String] == nil)
        #expect(protectedQuery[kSecUseDataProtectionKeychain as String] as? Bool == true)
        #expect(legacyQuery[kSecAttrService as String] as? String == "com.corptie.tests.cloud")
        let legacyAccount = legacyQuery[kSecAttrAccount as String] as? String
        let protectedAccount = protectedQuery[kSecAttrAccount as String] as? String
        #expect(protectedAccount == legacyAccount)
        #expect(protectedQuery[kSecAttrSynchronizable as String] as? Bool == false)
    }

    @Test func mismatchedServerCannotWriteCredentials() async throws {
        let credentials = try JSONDecoder().decode(DeviceCredentials.self, from: Data(#"{"serverId":"other","deviceId":"d","accessToken":"test","refreshToken":"test","accessExpiresAt":1,"refreshExpiresAt":2}"#.utf8))
        let vault = DeviceCredentialVault(service: "com.corptie.tests.unused")
        do {
            try await vault.save(credentials, endpoint: BackendEndpoint(URL(string: "https://example.test")!), expectedServerId: "expected")
            Issue.record("Mismatched server identity was accepted")
        } catch CredentialVaultError.invalidIdentity {} // Rejected before any Keychain operation.
    }

    @Test func identitySeparatesServersAndNormalizesDefaultHTTPSPort() throws {
        let a = try BackendEndpoint(URL(string: "https://example.test")!)
        let b = try BackendEndpoint(URL(string: "https://EXAMPLE.test:443/")!)
        let c = try BackendEndpoint(URL(string: "https://example.test:8443")!)
        #expect(try DeviceCredentialVault.account(endpoint: a, serverId: "a") == DeviceCredentialVault.account(endpoint: b, serverId: "a"))
        #expect(try DeviceCredentialVault.account(endpoint: a, serverId: "a") != DeviceCredentialVault.account(endpoint: a, serverId: "b"))
        #expect(try DeviceCredentialVault.account(endpoint: a, serverId: "a") != DeviceCredentialVault.account(endpoint: c, serverId: "a"))
        #expect(throws: (any Error).self) { try DeviceCredentialVault.account(endpoint: a, serverId: "") }
    }
}
