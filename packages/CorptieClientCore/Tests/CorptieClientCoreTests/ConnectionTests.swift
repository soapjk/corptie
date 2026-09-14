import Foundation
import Testing
@testable import CorptieClientCore

struct ConnectionTests {
    @Test func unpairedTransportCannotAccessBusinessOrAdminRoutes() throws {
        let endpoint = try BackendEndpoint(URL(string: "https://server.example")!)
        let transport = try BackendTransport(endpoint: endpoint, pairingOnly: true)
        var request = try endpoint.request(path: ["client", "v1", "pairing", "claim"])
        request.httpMethod = "POST"
        #expect(try transport.prepare(request).value(forHTTPHeaderField: "Authorization") == nil)
        for path in [["state", "snapshot"], ["internal", "client-devices"], ["client", "v1", "me"]] {
            #expect(throws: ClientConnectionError.outsideEndpoint) { try transport.prepare(endpoint.request(path: path)) }
        }
    }
    @Test func rejectsUnsafeEndpoints() throws {
        for value in ["http://example.com", "http://192.168.1.2", "https://u:p@example.com",
                      "https://example.com?token=secret", "https://example.com/#secret", "file:///tmp/a",
                      "https://example.com/api", "http://127.0.0.1.evil.example"] {
            #expect(throws: (any Error).self) { try BackendEndpoint(URL(string: value)!) }
        }
        #expect(try BackendEndpoint(URL(string: "http://127.0.0.1:47321")!).isLoopback)
        #expect(try BackendEndpoint(URL(string: "http://[::1]:47321")!).isLoopback)
        #expect(try !BackendEndpoint(URL(string: "https://server.example")!).isLoopback)
    }

    @Test func remoteRequiresCredentialAndBindsOrigin() throws {
        let endpoint = try BackendEndpoint(URL(string: "https://server.example")!)
        #expect(throws: ClientConnectionError.invalidCredential) { try BackendTransport(endpoint: endpoint) }
        #expect(throws: ClientConnectionError.invalidCredential) {
            try BackendTransport(endpoint: endpoint, bearerToken: "bad\r\ntoken")
        }
        let transport = try BackendTransport(endpoint: endpoint, bearerToken: "test-only")
        let request = try transport.prepare(endpoint.request(path: ["state", "snapshot"]))
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-only")
        for value in ["https://other.example/state", "http://server.example/state", "https://server.example:8443/state"] {
            #expect(throws: ClientConnectionError.outsideEndpoint) {
                try transport.prepare(URLRequest(url: URL(string: value)!))
            }
        }
        #expect(throws: ClientConnectionError.invalidEndpoint) { try endpoint.request(path: ["..", "settings"]) }
    }

    @Test func localConnectionDoesNotInheritCredentials() throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:47321")!)
        let transport = try BackendTransport(endpoint: endpoint)
        var input = try endpoint.request(path: ["state", "events"], query: [.init(name: "after", value: "42")])
        input.setValue("secret", forHTTPHeaderField: "Cookie")
        input.setValue("secret", forHTTPHeaderField: "Authorization")
        let request = try transport.prepare(input)
        #expect(request.url?.query == "after=42")
        #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    }

    @Test func sharedParserPreservesHeartbeatUnicodeAndMultiline() {
        var parser = ServerSentEventParser()
        let wire = ": heartbeat\r\n\r\nid: 8\r\nevent: update\r\ndata: 中文\r\ndata: second\r\n\r\n"
        let events = wire.utf8.flatMap { parser.append($0) }
        #expect(events == [.init(id: nil, name: "", data: "", isComment: true),
                          .init(id: "8", name: "update", data: "中文\nsecond")])
    }
}
