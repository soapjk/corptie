import Foundation
import Testing
import CorptieClientCore
import CorptieClientSecurity
@testable import CorptieMobileState

@Suite(.serialized) @MainActor
struct PadCloudAccountRecoveryTests {
    private func saved() throws -> CloudCredential {
        CloudCredential(tokens: try JSONDecoder().decode(CloudOAuthTokens.self, from: Data(
            #"{"accessToken":"test-access","refreshToken":"test-refresh","tokenType":"Bearer","expiresAt":-10000000000,"scope":"openid"}"#.utf8)),
            identity: try CloudDeviceIdentity(kind: .mobile, displayName: "Test", privateKey: Data(repeating: 7, count: 32)))
    }

    @Test func gatewayFailureRetainsAccountAndIdentityWithoutSavingOrDeleting() async throws {
        let credential = try saved()
        var writes = 0
        let connection = PadConnection(cloudAuthDependencies: .init(load: { _ in credential },
            save: { _, _ in writes += 1 }, refresh: { _, _ in throw ClientConnectionError.httpStatus(502) }))
        await connection.restoreCloudConnection()
        #expect(connection.cloudSignedIn)
        #expect(connection.cloudAccountState == .temporarilyUnavailable)
        #expect(connection.cloudCurrentDeviceID == credential.identity.id)
        #expect(connection.cloudAccountNeedsRecovery)
        #expect(writes == 0)
    }

    @Test func keychainFailureIsNotSignedOutAndMissingIsDistinct() async {
        let unavailable = PadConnection(cloudAuthDependencies: .init(load: { _ in throw CredentialVaultError.keychain(-25308) },
            save: { _, _ in }, refresh: { tokens, _ in tokens }))
        await unavailable.restoreCloudConnection()
        #expect(unavailable.cloudAccountState == .storageUnavailable)
        #expect(unavailable.cloudAccountNeedsRecovery)
        let absent = PadConnection(cloudAuthDependencies: .init(load: { _ in nil }, save: { _, _ in }, refresh: { tokens, _ in tokens }))
        await absent.restoreCloudConnection()
        #expect(absent.cloudAccountState == .signedOut)
        #expect(!absent.cloudAccountNeedsRecovery)
    }

    @Test func onlyDefinitiveRefreshDenialRequestsLogin() async throws {
        let credential = try saved()
        for failure in [ClientConnectionError.httpStatus(400), .httpStatus(502), .httpStatus(401), .httpStatus(403)] {
            let connection = PadConnection(cloudAuthDependencies: .init(load: { _ in credential }, save: { _, _ in },
                refresh: { _, _ in throw failure }))
            await connection.restoreCloudConnection()
            let denied = failure == .httpStatus(401) || failure == .httpStatus(403)
            #expect(connection.cloudAccountState == (denied ? .reauthenticationRequired : .temporarilyUnavailable))
            #expect(connection.cloudCurrentDeviceID == credential.identity.id)
        }
        let rejected = PadConnection(cloudAuthDependencies: .init(load: { _ in credential }, save: { _, _ in },
            refresh: { _, _ in throw CloudOAuthRefreshError.invalidGrant }))
        await rejected.restoreCloudConnection()
        #expect(rejected.cloudAccountState == .reauthenticationRequired)
        #expect(!rejected.cloudAccountNeedsRecovery)
    }

    @Test func concurrentRefreshUsesOneRequestAndOneSave() async throws {
        let credential = try saved()
        var refreshes = 0, saves = 0
        let connection = PadConnection(cloudAuthDependencies: .init(load: { _ in credential },
            save: { _, _ in saves += 1 }, refresh: { _, _ in
                refreshes += 1
                try await Task.sleep(for: .milliseconds(30))
                return try JSONDecoder().decode(CloudOAuthTokens.self, from: Data(
                    #"{"accessToken":"new-access","refreshToken":"new-refresh","tokenType":"Bearer","expiresAt":10000000000,"scope":"openid"}"#.utf8))
            }))
        let config = try CorptieCloudService.nativeOAuth(clientID: "corptie-ios")
        async let a = connection.validCloudCredential(config)
        async let b = connection.validCloudCredential(config)
        let (first, second) = try await (a, b)
        #expect(first == second)
        #expect(first.identity == credential.identity)
        #expect(refreshes == 1)
        #expect(saves == 1)
        #expect(try await connection.validCloudCredential(config) == first)
        #expect(refreshes == 1)
    }

    @Test func loginProbeIsBoundedCredentialFreeAndDoesNotAuthorizeOn502() async throws {
        let settings = URLSessionConfiguration.ephemeral
        settings.protocolClasses = [LoginProbeProtocol.self]
        let session = URLSession(configuration: settings)
        defer { session.invalidateAndCancel() }
        let connection = PadConnection()
        LoginProbeProtocol.status = 502
        await #expect(throws: ClientConnectionError.httpStatus(502)) { try await connection.prepareCloudSignIn(session: session) }
        #expect(!connection.cloudSignInPreparing)
        #expect(LoginProbeProtocol.request?.url?.path == "/healthz")
        #expect(LoginProbeProtocol.request?.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(LoginProbeProtocol.request?.httpBody == nil)
        #expect(LoginProbeProtocol.request?.timeoutInterval == 5)
        LoginProbeProtocol.status = 200
        let url = try await connection.prepareCloudSignIn(session: session)
        #expect(url.path == "/api/auth/oauth2/authorize")
        #expect(!connection.cloudSignInPreparing)
        connection.cancelCloudSignIn()
    }

    @Test func rotatedTokenSurvivesTransientKeychainSaveFailureWithoutAnotherRefresh() async throws {
        let credential = try saved()
        var refreshes = 0, saves = 0
        let updated = try JSONDecoder().decode(CloudOAuthTokens.self, from: Data(
            #"{"accessToken":"new-access","refreshToken":"rotated-refresh","tokenType":"Bearer","expiresAt":10000000000,"scope":"openid"}"#.utf8))
        let connection = PadConnection(cloudAuthDependencies: .init(load: { _ in credential },
            save: { _, _ in
                saves += 1
                if saves == 1 { throw CredentialVaultError.keychain(-25308) }
            }, refresh: { _, _ in refreshes += 1; return updated }))
        let config = try CorptieCloudService.nativeOAuth(clientID: "corptie-ios")
        do { _ = try await connection.validCloudCredential(config); Issue.record("First persistence must fail") }
        catch { #expect(error is CredentialVaultError) }
        let recovered = try await connection.validCloudCredential(config)
        #expect(recovered.tokens == updated)
        #expect(recovered.identity == credential.identity)
        #expect(refreshes == 1)
        #expect(saves == 2)
    }
}

private final class LoginProbeProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var request: URLRequest?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.request = request
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: Self.status,
            httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() { }
}
