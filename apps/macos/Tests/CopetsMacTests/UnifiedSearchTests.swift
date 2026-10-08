import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMac

@MainActor
struct UnifiedSearchTests {
    private static func page(_ query: String, cursor: String? = nil, id: String = "hit") throws -> UnifiedSearchPage {
        let object: [String: Any] = ["schemaVersion": 1, "query": query, "indexState": "ready",
            "items": [["id": id, "kind": "message", "resourceId": id, "title": "Chat", "snippet": query,
                       "createdAt": "2026-10-01T00:00:00Z", "sessionId": "session", "messageId": id, "archived": true]],
            "nextCursor": cursor as Any? ?? NSNull()]
        return try JSONDecoder().decode(UnifiedSearchPage.self, from: JSONSerialization.data(withJSONObject: object))
    }

    @Test func newQueryWinsEvenWhenTheOldRequestFinishesLater() async throws {
        let model = UnifiedSearchModel { request, _ in
            if request.query == "old" { try await Task.sleep(for: .milliseconds(500)) }
            return try Self.page(request.query, id: request.query)
        }
        let old = Task { await model.search(UnifiedSearchRequest(query: "old", scope: "all", workID: nil)) }
        try await Task.sleep(for: .milliseconds(350))
        await model.search(UnifiedSearchRequest(query: "new", scope: "messages", workID: nil))
        await old.value
        #expect(model.items.map(\.id) == ["new"])
        #expect(!model.isLoading)
    }

    @Test func pagesDeduplicateMessagesAndPreserveTheOriginalQuery() async throws {
        let model = UnifiedSearchModel { request, cursor in
            try Self.page(request.query, cursor: cursor == nil ? "next" : nil)
        }
        await model.search(UnifiedSearchRequest(query: "中文", scope: "messages", workID: "work"))
        await model.loadMore()
        #expect(model.items.count == 1)
        #expect(model.cursor == nil)
        #expect(model.items.first?.archived == true)
    }

    @Test func cancellationDoesNotBecomeAVisibleSearchFailure() async throws {
        let model = UnifiedSearchModel { request, _ in try Self.page(request.query) }
        let operation = Task { await model.search(UnifiedSearchRequest(query: "cancel", scope: "all", workID: nil)) }
        operation.cancel()
        await operation.value
        #expect(model.items.isEmpty)
        #expect(model.error == nil)
    }
}
