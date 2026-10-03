import Foundation
import Testing
@testable import CorptieClientCore

@Suite(.serialized)
struct CloudOAuthClientTests {
    private let endpoint = try! BackendEndpoint(URL(string: "https://cloud.example.test")!)

    @Test func sharedServiceConfigurationCentralizesProductionAndAllowsExplicitDevelopmentEndpoint() throws {
        let production = try CorptieCloudService.nativeOAuth(clientID: "corptie-ios")
        #expect(production.endpoint.baseURL == URL(string: "https://corptie.llmay.cn")!)
        #expect(production.resource == URL(string: "https://corptie.llmay.cn/v1")!)
        #expect(production.scopes.contains("connections:write"))

        let development = try CorptieCloudService.nativeOAuth(
            clientID: "corptie-ios", developmentBaseURL: "http://127.0.0.1:4310"
        )
        #expect(development.endpoint.isLoopback)
        #expect(development.resource == URL(string: "http://127.0.0.1:4310/v1")!)
    }

    @Test func authorizationUsesPKCEAndRejectsRedirectOrStateSubstitution() throws {
        let configuration = try config()
        let verifier = String(repeating: "A", count: 43)
        let state = String(repeating: "s", count: 43)
        let authorization = try CloudOAuthAuthorization(configuration: configuration, verifier: verifier, state: state)
        let query = try #require(URLComponents(url: authorization.url, resolvingAgainstBaseURL: false)?.queryItems)
        let values = Dictionary(uniqueKeysWithValues: query.map { ($0.name, $0.value ?? "") })
        #expect(values["client_id"] == "corptie-mobile")
        #expect(values["code_challenge_method"] == "S256")
        #expect(values["code_challenge"] == "DwBzhbb51LfusnSGBa_hqYSgo7-j8BTQnip4TOnlzRo")
        #expect(values["scope"] == "devices:read offline_access openid")
        #expect(values["resource"] == "https://cloud.example.test/v1")

        let callback = URL(string: "corptie://oauth/callback?code=one-time&state=\(state)")!
        #expect(try authorization.code(from: callback, configuration: configuration) == "one-time")
        #expect(throws: CloudOAuthError.stateMismatch) {
            try authorization.code(from: URL(string: "corptie://oauth/callback?code=x&state=wrong")!, configuration: configuration)
        }
        #expect(throws: CloudOAuthError.invalidCallback) {
            try authorization.code(from: URL(string: "corptie://evil/callback?code=x&state=\(state)")!, configuration: configuration)
        }
    }

    @Test func tokenExchangeIsFormEncodedAndRefreshPreservesRotatingToken() async throws {
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [OAuthStubProtocol.self]
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let client = CloudOAuthTokenClient(
            configuration: try config(),
            session: URLSession(configuration: sessionConfiguration),
            now: { now }
        )
        OAuthStubProtocol.response = #"{"access_token":"access-one","refresh_token":"refresh-one","token_type":"Bearer","expires_in":600,"scope":"openid offline_access"}"#
        let exchanged = try await client.exchange(code: "auth-code", verifier: String(repeating: "A", count: 43))
        #expect(exchanged.accessToken == "access-one")
        #expect(exchanged.refreshToken == "refresh-one")
        #expect(exchanged.expiresAt == now.addingTimeInterval(600))
        #expect(OAuthStubProtocol.fields["grant_type"] == "authorization_code")
        #expect(OAuthStubProtocol.fields["code_verifier"] == String(repeating: "A", count: 43))
        #expect(OAuthStubProtocol.authorization == nil)

        OAuthStubProtocol.response = #"{"access_token":"access-two","token_type":"bearer","expires_in":300}"#
        let refreshed = try await client.refresh(exchanged)
        #expect(refreshed.accessToken == "access-two")
        #expect(refreshed.refreshToken == "refresh-one")
        #expect(OAuthStubProtocol.fields["grant_type"] == "refresh_token")
        #expect(OAuthStubProtocol.fields["refresh_token"] == "refresh-one")
    }

    @Test func cloudDeviceDirectoryUsesBearerAndDecodesFractionalDates() async throws {
        let sessionConfiguration = URLSessionConfiguration.ephemeral
        sessionConfiguration.protocolClasses = [DeviceStubProtocol.self]
        let client = try CloudDeviceClient(endpoint: endpoint, accessToken: "cloud-access", configuration: sessionConfiguration)
        DeviceStubProtocol.method = "GET"
        DeviceStubProtocol.response = #"{"devices":[{"id":"11111111-1111-1111-1111-111111111111","kind":"mac","displayName":"Studio","publicKeyAlgorithm":"X25519","publicKey":"key","authEpoch":1,"createdAt":"2026-10-03T00:00:00.000Z","updatedAt":"2026-10-03T00:00:00.000Z","lastSeenAt":"2026-10-03T00:00:00.000Z","revokedAt":null}]}"#
        let devices = try await client.list()
        #expect(devices.first?.displayName == "Studio")
        #expect(DeviceStubProtocol.authorization == "Bearer cloud-access")

        DeviceStubProtocol.method = "POST"
        DeviceStubProtocol.response = #"{"device":{"id":"11111111-1111-1111-1111-111111111111","kind":"mac","displayName":"Studio","publicKeyAlgorithm":"X25519","publicKey":"key","authEpoch":1,"createdAt":"2026-10-03T00:00:00.000Z","updatedAt":"2026-10-03T00:00:00.000Z","lastSeenAt":"2026-10-03T00:00:00.000Z","revokedAt":null}}"#
        let key = Data(repeating: 7, count: 32).base64EncodedString()
        let registered = try await client.register(.init(
            id: UUID(uuidString: "11111111-1111-1111-1111-111111111111")!, kind: .mac, displayName: "Studio", publicKey: key
        ))
        #expect(registered.kind == .mac)
        #expect(DeviceStubProtocol.body?.contains("X25519") == true)

        DeviceStubProtocol.method = "DELETE"
        let explicitlyRevoked = try await client.revoke(registered.id)
        #expect(explicitlyRevoked.id == registered.id)
        #expect(DeviceStubProtocol.path == "/v1/devices/11111111-1111-1111-1111-111111111111")

        let revoked = try await client.revokeCurrent()
        #expect(revoked.id == registered.id)
        #expect(DeviceStubProtocol.path == "/v1/devices/current")
    }

    private func config() throws -> CloudOAuthConfiguration {
        try CloudOAuthConfiguration(
            endpoint: endpoint,
            clientID: "corptie-mobile",
            redirectURI: URL(string: "corptie://oauth/callback")!,
            scopes: ["openid", "offline_access", "devices:read"],
            resource: URL(string: "https://cloud.example.test/v1")!
        )
    }
}

private final class OAuthStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var response = ""
    nonisolated(unsafe) static var fields: [String: String] = [:]
    nonisolated(unsafe) static var authorization: String?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.authorization = request.value(forHTTPHeaderField: "Authorization")
        Self.fields = requestBody(request).flatMap { data in
            URLComponents(string: "?" + String(decoding: data, as: UTF8.self))?.queryItems
        }.map { Dictionary(uniqueKeysWithValues: $0.map { ($0.name, $0.value ?? "") }) } ?? [:]
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.response.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private final class DeviceStubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var method = "GET"
    nonisolated(unsafe) static var response = ""
    nonisolated(unsafe) static var authorization: String?
    nonisolated(unsafe) static var body: String?
    nonisolated(unsafe) static var path: String?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.httpMethod == Self.method)
        Self.authorization = request.value(forHTTPHeaderField: "Authorization")
        Self.body = requestBody(request).map { String(decoding: $0, as: UTF8.self) }
        Self.path = request.url?.path
        let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.response.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

private func requestBody(_ request: URLRequest) -> Data? {
    if let body = request.httpBody { return body }
    guard let stream = request.httpBodyStream else { return nil }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while stream.hasBytesAvailable {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count <= 0 { break }
        body.append(buffer, count: count)
    }
    return body
}
