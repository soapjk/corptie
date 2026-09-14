import Foundation
import Testing
@testable import CorptieClientCore

struct SessionAPITests {
    @Test func typedCommandsAndHistoryUseVersionedRoutes() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://unit-test.invalid")!),
            bearerToken: "test-only", configuration: config)
        let api = ClientSessionAPI(transport: transport)
        #expect(try await api.send(sessionId: "session:test", requestId: "request_123", text: "Hello").status == "accepted")
        #expect(try await api.stop(sessionId: "session:test", requestId: "stop_12345").status == "stop_requested")
        #expect(try await api.receipt(requestId: "request_123").requestId == "request_123")
        #expect(try await api.messages(sessionId: "session:test", before: "item:1").items.isEmpty)
        #expect(try await api.capabilities(sessionId: "session:test").send.available)
    }
}

private final class SessionProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
        let path = request.url!.path
        let json: String
        if path.hasSuffix("capabilities") {
            json = #"{"schemaVersion":1,"sessionId":"session:test","readMessages":true,"send":{"available":true},"stop":{"available":false}}"#
        } else if path.hasSuffix("messages") && request.httpMethod == "GET" {
            #expect(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.contains(URLQueryItem(name: "before", value: "item:1")) == true)
            json = #"{"schemaVersion":1,"sessionId":"session:test","items":[],"hasEarlier":false}"#
        } else {
            let stopping = path.hasSuffix("stop")
            #expect(path.hasPrefix("/client/v1/"))
            #expect(request.httpMethod == (path.contains("/commands/") ? "GET" : "POST"))
            json = "{\"schemaVersion\":1,\"sessionId\":\"session:test\",\"requestId\":\"request_123\",\"kind\":\"\(stopping ? "stop" : "send")\",\"status\":\"\(stopping ? "stop_requested" : "accepted")\",\"updatedAt\":\"2026-09-13T00:00:00Z\"}"
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
