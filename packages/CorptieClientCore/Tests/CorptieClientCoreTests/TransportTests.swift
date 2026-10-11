import Foundation
import Testing
@testable import CorptieClientCore

@Suite(.serialized)
struct TransportTests {
    @Test func composerPayloadsDoNotExportLocalFilePathsAndLegacyCapabilitiesRemainCompatible() throws {
        let image = ClientDraftImage(fileName: "photo.png", data: Data([1, 2, 3]))
        let payload = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(image)) as? [String: String])
        #expect(payload == ["fileName": "photo.png", "dataBase64": "AQID"])
        let caps = try JSONDecoder().decode(ClientSessionCapabilities.self, from: Data(#"{"schemaVersion":1,"sessionId":"s","readMessages":true,"send":{"available":true},"stop":{"available":false}}"#.utf8))
        #expect(caps.composer == nil)
        #expect(caps.sendImages == nil)
        #expect(caps.scheduleMessage == nil)
        let model = try JSONDecoder().decode(ClientComposerConfiguration.self, from: Data(#"{"schemaVersion":1,"sessionId":"s","currentModel":"neutral","currentReasoningLevel":"high","models":[{"id":"neutral","name":"Model","reasoningLevels":["high"]}],"switchModel":{"available":true},"switchReasoning":{"available":true}}"#.utf8))
        #expect(model.models.first?.reasoningLevels == ["high"])
    }
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

    @Test func structuredServiceFailurePreservesTheServerErrorCode() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let endpoint = try BackendEndpoint(URL(string: "https://unit-test.invalid")!)
        let transport = try BackendTransport(endpoint: endpoint, bearerToken: "test-only", configuration: config)
        StubProtocol.status = 404
        StubProtocol.body = #"{"code":"ROUTE_NOT_AVAILABLE"}"#
        defer { StubProtocol.body = "ok" }
        do {
            var request = try endpoint.request(path: ["client", "v1", "missing"])
            request.httpMethod = "POST"
            _ = try await transport.data(for: request)
            Issue.record("Expected a structured service failure")
        } catch let error as ClientServiceFailure {
            #expect(error == ClientServiceFailure(statusCode: 404, code: "ROUTE_NOT_AVAILABLE"))
        }
    }

    @Test(arguments: [false, true])
    func streamingReceiptLookupPreservesStructured404ThroughNativeAndRelayPaths(relay: Bool) async throws {
        let endpoint = try BackendEndpoint(URL(string: "https://unit-test.invalid")!)
        let body = Data(#"{"code":"COMMAND_NOT_FOUND","error":"COMMAND_NOT_FOUND","retryable":false}"#.utf8)
        let transport: BackendTransport
        if relay {
            transport = BackendTransport(endpoint: endpoint,
                data: { _ in throw URLError(.cancelled) },
                bytes: { request in
                    let stream = AsyncThrowingStream<UInt8, Error> { continuation in
                        for byte in body { continuation.yield(byte) }
                        continuation.finish()
                    }
                    return (BackendByteStream(stream), HTTPURLResponse(url: request.url!, statusCode: 404,
                        httpVersion: nil, headerFields: nil)!)
                })
        } else {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [StubProtocol.self]
            StubProtocol.status = 404
            StubProtocol.body = String(decoding: body, as: UTF8.self)
            transport = try BackendTransport(endpoint: endpoint, bearerToken: "test-only", configuration: config)
        }
        defer { StubProtocol.body = "ok" }
        var request = try endpoint.request(path: ["client", "v1", "commands", "request_123"])
        request.httpMethod = "POST" // Shared URLProtocol fixture expects POST.
        do {
            _ = try await transport.bytes(for: request)
            Issue.record("Expected the backend's receipt-not-found code")
        } catch let failure as ClientServiceFailure {
            #expect(failure == ClientServiceFailure(statusCode: 404, code: "COMMAND_NOT_FOUND"))
        }
    }

    @Test func streamingErrorBodyIsBounded() async throws {
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1")!)
        let transport = BackendTransport(endpoint: endpoint,
            data: { _ in throw URLError(.cancelled) }, bytes: { request in
                let stream = AsyncThrowingStream<UInt8, Error> { continuation in
                    for _ in 0...64 * 1024 { continuation.yield(32) }
                    continuation.finish()
                }
                return (BackendByteStream(stream), HTTPURLResponse(url: request.url!, statusCode: 404,
                    httpVersion: nil, headerFields: nil)!)
            })
        await #expect(throws: ClientConnectionError.httpStatus(404)) {
            _ = try await transport.bytes(for: endpoint.request(path: ["missing"]))
        }
    }
}

private final class StubProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var status = 200
    nonisolated(unsafe) static var count = 0
    nonisolated(unsafe) static var body = "ok"
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
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
