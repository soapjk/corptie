import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

private final class MemoryCenterURLProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
        let values = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        if components.path == "/memory-extraction-jobs" {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"jobs":[{"session_id":"session:a","reason":"turn","state":"queued","attempts":2,"retry_at":"2026-11-02T12:00:00Z","last_error":"BUDGET"}]}"#.utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        if request.url?.host == "memory-stress.test" {
            let page = Int(values["cursor"] ?? "0") ?? 0
            let records: [[String: Any]] = (0..<50).map { index in
                ["id": "stress-\(page * 50 + index)", "ownerType": "global", "ownerId": "user:local", "kind": "fact",
                 "sourceType": "user", "promotionStatus": "active", "trustLevel": "trusted",
                 "content": String(repeating: "合成记忆正文与很长的无空格关键词。", count: index == 49 ? 2000 : 10), "createdAt": "2026-11-02T00:00:00Z"]
            }
            let payload: [String: Any] = ["memories": records, "hasMore": true, "nextCursor": String(page + 1)]
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: payload))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let query = values["query"] ?? ""
        if query == "failure" {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data("{}".utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        let cursor = values["cursor"]
        let id = cursor == nil ? query + "first" : "second"
        let record: [String: Any] = ["id": id, "ownerType": "work", "ownerId": values["ownerId"] ?? "work:a",
            "kind": "fact", "sourceType": "user", "content": "Prepared summary \(id)", "createdAt": "2026-11-02T00:00:00Z"]
        let records = cursor == nil ? [record] : [
            ["id": query + "first", "ownerType": "work", "ownerId": "work:a", "kind": "fact", "sourceType": "user", "content": "Duplicate", "createdAt": "2026-11-02T00:00:00Z"], record]
        let envelope: [String: Any] = ["memories": records, "hasMore": cursor == nil, "nextCursor": cursor == nil ? "next" : NSNull()]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: envelope))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor
struct MemoryCenterTests {
    private func reader() -> MemoryCenterReader {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryCenterURLProtocol.self]
        return MemoryCenterReader(baseURL: URL(string: "http://memory.test")!, session: URLSession(configuration: configuration))
    }

    @Test func searchAndReviewUseServerFiltersAndPreserveCursor() {
        var query = MemoryCenterQuery(ownerType: "work", ownerID: "work:one")
        query.text = "关键词 & swift"
        query.kind = "fact"
        query.topic = "programming"
        query.reviewOnly = true
        query.includeRevoked = true
        query.sourceType = "user"
        query.trustLevel = "untrusted"
        let values = Dictionary(uniqueKeysWithValues: query.parameters(cursor: "page:two").map { ($0.name, $0.value) })
        #expect(values["query"] == "关键词 & swift")
        #expect(values["ownerId"] == "work:one")
        #expect(values["global"] == nil)
        #expect(values["sourceType"] == "extracted")
        #expect(values["status"] == "candidate")
        #expect(values["trustLevel"] == "untrusted")
        #expect(values["includeRevoked"] == "false")
        #expect(values["cursor"] == "page:two")
    }

    @Test func ownerWindowsHaveIndependentPagingAndDuplicateRowsAreDiscarded() async {
        let first = MemoryCenterStore(reader: reader())
        let second = MemoryCenterStore(reader: reader())
        let a = MemoryCenterQuery(ownerType: "work", ownerID: "work:a")
        var b = MemoryCenterQuery(ownerType: "task", ownerID: "task:b")
        b.text = "other"
        await first.load(a)
        await second.load(b)
        await first.load(a, more: true)
        #expect(first.rows.map(\.id) == ["first", "second"])
        #expect(second.rows.map(\.id) == ["otherfirst"])
        #expect(second.nextCursor == "next")
        #expect(first.nextCursor == nil)
    }

    @Test func failedSearchPreservesDataAndDoesNotRelabelItsQuery() async {
        let store = MemoryCenterStore(reader: reader())
        let original = MemoryCenterQuery()
        await store.load(original)
        var failed = original
        failed.text = "failure"
        await store.load(failed)
        #expect(store.rows.map(\.id) == ["first"])
        #expect(store.loadedQuery == original)
        #expect(store.error != nil)
        #expect(!store.isLoading)
        await store.load(failed, more: true)
        #expect(store.rows.count == 1)
        await store.load(original)
        #expect(store.error == nil)
    }

    @Test func cancelledResponseNeverPublishes() async {
        let store = MemoryCenterStore(reader: reader())
        let task = Task { await store.load(MemoryCenterQuery()) }
        task.cancel()
        await task.value
        #expect(store.rows.isEmpty)
        #expect(store.loadedQuery == nil)
        #expect(!store.isLoading)
    }

    @Test func extractionQueueDecodesItsSnakeCaseContract() async throws {
        let jobs = try await reader().jobs()
        #expect(jobs.count == 1)
        #expect(jobs[0].sessionId == "session:a")
        #expect(jobs[0].retryAt == "2026-11-02T12:00:00Z")
        #expect(jobs[0].lastError == "BUDGET")
    }

    @Test func compactAndWideModesUseContentWidth() {
        #expect(!MemoryCenterLayout.showsSidebar(999))
        #expect(MemoryCenterLayout.showsSidebar(1000))
        #expect(!MemoryCenterLayout.showsDetailBesideList(480))
        #expect(!MemoryCenterLayout.showsDetailBesideList(719))
        #expect(MemoryCenterLayout.showsDetailBesideList(720))
    }

    @Test func longListKeepsPagingBoundedAndDrawsAtAllWidths() async throws {
        _ = NSApplication.shared
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryCenterURLProtocol.self]
        let store = MemoryCenterStore(reader: MemoryCenterReader(baseURL: URL(string: "http://memory-stress.test")!, session: URLSession(configuration: configuration)))
        let query = MemoryCenterQuery()
        let began = ContinuousClock.now
        await store.load(query)
        for _ in 0..<9 { await store.load(query, more: true) }
        #expect(store.rows.count == 500)
        let cursor = store.nextCursor
        await store.load(query, more: true)
        #expect(store.rows.count == 500)
        #expect(store.nextCursor == cursor)
        print("MEMORY_PROJECTION_500=\(began.duration(to: .now)) (transport and decoding included)")
        let host = NSHostingView(rootView: MemoryCenterView(store: store))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 700), styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        for width: CGFloat in [480, 720, 960, 1200] {
            let start = ContinuousClock.now
            window.setContentSize(NSSize(width: width, height: 700))
            window.layoutIfNeeded()
            host.layoutSubtreeIfNeeded()
            window.displayIfNeeded()
            #expect(host.fittingSize.width <= width + 1)
            print("MEMORY_NATIVE_LAYOUT_AND_DRAW width=\(width) duration=\(start.duration(to: .now)); does not measure WindowServer presentation")
        }
    }

    @Test func nativeWorkspaceFitsNarrowAndWideWindows() async {
        let store = MemoryCenterStore(reader: reader())
        await store.load(MemoryCenterQuery())
        let host = NSHostingView(rootView: MemoryCenterView(store: store))
        for width: CGFloat in [480, 720, 960, 1200] {
            host.frame = NSRect(x: 0, y: 0, width: width, height: 700)
            host.layoutSubtreeIfNeeded()
            #expect(host.fittingSize.width <= width + 1)
            #expect(host.bounds.width == width)
        }
    }

    @Test func projectionsBoundLongContentAndEnforceReviewAndMergeEligibility() throws {
        func memory(_ extra: [String: Any]) throws -> MemoryItem {
            var object: [String: Any] = ["id": "memory:a", "kind": "fact", "ownerType": "work", "ownerId": "work:a",
                "sourceType": "extracted", "promotionStatus": "candidate", "content": String(repeating: "长正文\n", count: 10000), "createdAt": "2026-11-02T00:00:00Z"]
            object.merge(extra) { _, new in new }
            return try JSONDecoder().decode(MemoryItem.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let candidate = MemoryCenterRow(try memory([:]))
        #expect(candidate.preview.count <= 240)
        #expect(!candidate.preview.contains("\n"))
        #expect(candidate.canReview)
        #expect(!candidate.canMerge)
        let user = MemoryCenterRow(try memory(["sourceType": "user", "trustLevel": "untrusted"]))
        #expect(!user.canReview)
        let expired = MemoryCenterRow(try memory(["promotionStatus": "active", "trustLevel": "trusted", "expiresAt": "2000-01-01T00:00:00Z"]))
        #expect(expired.inactive)
        #expect(!expired.canMerge)
        let fractionalExpiry = MemoryCenterRow(try memory(["promotionStatus": "active", "trustLevel": "trusted", "expiresAt": "2000-01-01T00:00:00.123Z"]))
        #expect(fractionalExpiry.inactive)
    }
}
