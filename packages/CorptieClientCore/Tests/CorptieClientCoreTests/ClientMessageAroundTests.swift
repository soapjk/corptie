import Foundation
import Testing
@testable import CorptieClientCore

struct ClientMessageAroundTests {
    @Test func aroundUsesOnlyExactEncodedTargetAndKeepsPageIdentity() async throws {
        let target = "message:q ?&=中文"
        let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 2, "sessionId": "s",
            "items": [["id": target, "type": "userMessage", "text": "question"]],
            "hasEarlier": true, "nextBefore": "cursor:older", "revision": 42])
        let url = URL(string: "http://127.0.0.1:1234")!
        let api = ClientSessionAPI(transport: BackendTransport(endpoint: try BackendEndpoint(url), data: { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems
            #expect(query == [URLQueryItem(name: "around", value: target)])
            #expect(request.url?.path == "/client/v1/sessions/s/messages")
            return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, bytes: { _ in throw ClientConnectionError.invalidResponse }))
        let page = try await api.messages(sessionId: "s", around: target)
        #expect(page.items.map(\.id) == [target])
        #expect(page.nextBefore == "cursor:older")
        #expect(page.revision == 42)
    }

    @Test func aroundRejectsMissingDuplicateOrUnboundedWindow() async throws {
        let url = URL(string: "http://127.0.0.1:1234")!
        for ids in [["other"], ["q", "q"], ["q"] + (0..<31).map { "m\($0)" }] {
            let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 2, "sessionId": "s",
                "items": ids.map { ["id": $0, "type": "userMessage", "text": "q"] }, "hasEarlier": false])
            let api = ClientSessionAPI(transport: BackendTransport(endpoint: try BackendEndpoint(url), data: { _ in
                (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse }))
            await #expect(throws: ClientConnectionError.invalidResponse) {
                try await api.messages(sessionId: "s", around: "q")
            }
        }
    }
}
