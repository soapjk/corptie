import Foundation
import Testing
@testable import CorptieClientCore

@Suite(.serialized)
struct TransportTests {
    @Test func requestPreservesBodyAndSurfacesHTTPFailureWithoutRetry() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let endpoint = try BackendEndpoint(URL(string: "https://unit-test.invalid")!)
        let transport = try BackendTransport(endpoint: endpoint, bearerToken: "test-only", configuration: config)
        for status in [200, 401, 403, 409, 503, 302] {
            StubProtocol.count = 0
            StubProtocol.status = status
            var request = try endpoint.request(path: ["sessions", "s", "messages"])
            request.httpMethod = "POST"
            request.httpBody = Data("message".utf8)
            do {
                let (data, _) = try await transport.data(for: request)
                #expect(status == 200)
                #expect(data == Data("ok".utf8))
            } catch let error as ClientConnectionError {
                #expect(error == .httpStatus(status))
            }
            #expect(StubProtocol.count == 1)
        }
    }

    @Test func unknownAndLocalCapabilitiesNeverEnableRemote() throws {
        for version in [1, 2] {
            let data = Data("{\"schemaVersion\":\(version),\"service\":\"corptie\",\"connection\":{\"mode\":\"local-only\",\"deviceAuthentication\":false,\"remoteAccess\":false}}".utf8)
            #expect(try !JSONDecoder().decode(ClientCapabilities.self, from: data).supportsRemoteConnection)
        }
    }
}

private final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var count = 0
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.count += 1
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
        #expect(request.url?.host == "unit-test.invalid")
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status,
            httpVersion: "HTTP/1.1", headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("ok".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
