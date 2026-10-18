import Foundation
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor @Suite struct ResourceBrowserTests {
    private func api() throws -> ClientResourceAPI {
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:47321")!), data: { request in
            let query = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.queryItems?.first { $0.name == "query" }?.value ?? ""
            if query == "failure" { throw URLError(.notConnectedToInternet) }
            if query == "old" { try? await Task.sleep(for: .milliseconds(100)) }
            let row: [String: Any] = ["id": "artifact:\(query)", "type": "artifact", "title": query, "summary": "", "owner": ["type": "work", "id": "work:one"], "workId": "work:one", "workName": "One", "sourceTitle": "", "updatedAt": "now", "createdAt": "now", "revision": 1, "status": "active", "currentVersion": 1, "capabilities": ["read"]]
            let data = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "items": [row], "hasMore": false])
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, bytes: { _ in throw ClientConnectionError.invalidResponse })
        return ClientResourceAPI(transport: transport, route: .desktop)
    }
    @Test func failurePreservesLastGoodResultsAndReportsFailure() async throws {
        let store = ResourceBrowserStore(), api = try api()
        await store.load(api: api, query: "good", work: "", status: "all", sort: "updated")
        await store.load(api: api, query: "failure", work: "", status: "all", sort: "updated")
        #expect(store.items.first?.title == "good"); #expect(store.error != nil); #expect(!store.loading)
    }
    @Test func lateResponsesCannotReplaceNewSearchOrSurviveScopeReset() async throws {
        let store = ResourceBrowserStore(), api = try api()
        let old = Task { await store.load(api: api, query: "old", work: "", status: "all", sort: "updated") }
        try await Task.sleep(for: .milliseconds(15))
        await store.load(api: api, query: "new", work: "", status: "all", sort: "updated")
        await old.value
        #expect(store.items.first?.title == "new")
        let pending = Task { await store.load(api: api, query: "old", work: "", status: "all", sort: "updated") }
        try await Task.sleep(for: .milliseconds(15)); store.reset(); await pending.value
        #expect(store.items.isEmpty); #expect(store.error == nil); #expect(!store.loading)
    }
    @Test func documentPreparesSharedMathOnceAndPreservesSourceForCopy() {
        let source = #"\[夏普比率=\frac{收益}{风险}\]"#
        let chunk = ResourceDocumentChunk(id: 0, text: source)
        #expect(chunk.text == source)
        #expect(chunk.blocks.contains { $0.attributed.flatMap { MessageMarkdown.mathCopyText(from: $0) } == source })
    }
}
