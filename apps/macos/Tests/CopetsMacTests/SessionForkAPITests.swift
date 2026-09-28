import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
@MainActor
struct SessionForkAPITests {
    @Test func taskFieldsAreSentInTheConfirmedForkRequest() async throws {
        SessionForkURLProtocol.handler = { request in
            #expect(request.httpMethod == "POST")
            #expect(request.url?.path == "/sessions/source/fork")
            let body = try requestBody(request)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: String])
            #expect(json["requestId"] == "request-123")
            #expect(json["itemId"] == "answer")
            #expect(json["sourceBindingId"] == "binding")
            #expect(json["title"] == "Branch")
            #expect(json["description"] == "Description")
            #expect(json["acceptanceCriteria"] == "Acceptance")
            #expect(json["verificationCriteria"] == "Verification")
            #expect(json["priority"] == "high")
            return (200, #"{"session":{"id":"target","title":"Branch","agent":"Agent","status":"complete","progress":0,"summary":"","suggestedOptions":null,"suggestedPrompt":null,"activityStatus":null,"updatedAt":"2026-09-28T00:00:00Z","accent":"cyan"},"taskId":"task:target"}"#)
        }
        let result = try await SessionForkAPI(
            baseURL: URL(string: "http://127.0.0.1:9999")!,
            urlSession: makeSession()
        ).createSessionFork(
            .init(sessionID: "source", itemID: "answer"), requestID: "request-123",
            sourceBindingID: "binding", title: "Branch", description: "Description",
            acceptanceCriteria: "Acceptance", verificationCriteria: "Verification", priority: "high"
        )
        #expect(result.session.id == "target")
        #expect(result.taskId == "task:target")
    }

    private func makeSession() -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SessionForkURLProtocol.self]
        return URLSession(configuration: configuration)
    }
}

private func requestBody(_ request: URLRequest) throws -> Data {
    if let body = request.httpBody { return body }
    let stream = try #require(request.httpBodyStream)
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while true {
        let count = stream.read(&buffer, maxLength: buffer.count)
        if count < 0 { throw stream.streamError ?? URLError(.cannotDecodeRawData) }
        if count == 0 { return body }
        body.append(contentsOf: buffer.prefix(count))
    }
}

private final class SessionForkURLProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (Int, String))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw URLError(.badServerResponse) }
            let (status, body) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
