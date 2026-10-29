import Foundation
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit

@MainActor struct MemoryHitAutomaticPagingTests {
    @Test func scrollingLoadsSuccessivePagesOnceAndStopsAtEnd() async throws {
        let fixture = HitPageFixture()
        let harness = try HitPagingHarness(fixture: fixture)
        defer { harness.close() }
        await harness.settle()
        #expect(await fixture.cursors.isEmpty)
        #expect(harness.loadMoreButtons.isEmpty)
        for expected in 1...2 {
            try harness.scrollToBottom()
            for _ in 0..<6 { harness.host.layoutSubtreeIfNeeded() }
            await harness.settle()
            let cursors = await fixture.cursors
            #expect(cursors == (1...expected).map(String.init), "requested cursors: \(cursors)")
            #expect(harness.rowCount == 20 * (expected + 1))
            // Remaining at the previous boundary must not drain another page.
            await harness.settle()
            #expect(await fixture.cursors.count == expected)
        }
        try harness.scrollToBottom()
        await harness.settle()
        #expect(await fixture.cursors == ["1", "2"])
        #expect(await fixture.maximumInFlight == 1)
        #expect(harness.handle.store.orderedCards.first?.card.nextCursor == nil)
    }

    @Test func failedPageRetainsRowsAndWaitsForRetry() async throws {
        let fixture = HitPageFixture(failFirst: true)
        let harness = try HitPagingHarness(fixture: fixture)
        defer { harness.close() }
        await harness.settle()
        try harness.scrollToBottom()
        await harness.settle()
        let visibleCursors = await fixture.cursors
        #expect(visibleCursors == ["1"], "requested cursors: \(visibleCursors)")
        #expect(harness.rowCount == 20)
        #expect(harness.handle.store.orderedCards.first?.pageError != nil)
        for _ in 0..<3 { try harness.scrollToBottom(); await harness.settle() }
        #expect(await fixture.cursors == ["1"])
        await harness.handle.store.loadMore(cardID: "memoryHits", api: harness.api, retry: true)
        await harness.settle()
        #expect(await fixture.cursors == ["1", "1"])
        #expect(harness.rowCount == 40)
        #expect(harness.handle.store.orderedCards.first?.pageError == nil)
    }

    @Test func hiddenPresentationDoesNotPageAndCancellationCanResume() async throws {
        let fixture = HitPageFixture()
        let harness = try HitPagingHarness(fixture: fixture)
        defer { harness.close() }
        await harness.settle()
        harness.activity.deactivate()
        try harness.scrollToBottom()
        await harness.settle()
        #expect(await fixture.cursors.isEmpty)
        harness.activity.activate()
        await harness.waitForRows(40)
        let resumedCursors = await fixture.cursors
        #expect(resumedCursors == ["1"], "requested after resume: \(resumedCursors)")

        // A cancelled viewport read is not a page failure, and must not poison
        // the deduplication fence for the same cursor on the next visit.
        harness.activity.deactivate()
        let read = Task { await harness.handle.store.loadMore(cardID: "memoryHits", api: harness.api) }
        try await Task.sleep(for: .milliseconds(20))
        read.cancel()
        await read.value
        #expect(harness.rowCount == 40)
        #expect(harness.handle.store.orderedCards.first?.pageError == nil)
        await harness.handle.store.loadMore(cardID: "memoryHits", api: harness.api)
        #expect(harness.rowCount == 60)
        #expect(await fixture.cursors == ["1", "2", "2"])
    }

    @Test func boundedWindowDoesNotDrainPagesWhileStationary() async throws {
        let fixture = HitPageFixture(lastPage: 9)
        let harness = try HitPagingHarness(fixture: fixture)
        defer { harness.close() }
        for _ in 0..<4 { await harness.handle.store.loadMore(cardID: "memoryHits", api: harness.api) }
        await harness.settle()
        try harness.scrollToBottom()
        await harness.settle()
        #expect(harness.rowCount == 100)
        #expect(harness.handle.store.orderedCards.first?.windowClipped == true)
        let count = await fixture.cursors.count
        #expect(count == 5)
        await harness.settle()
        #expect(await fixture.cursors.count == count)
        try harness.scrollToTop()
        await harness.settle()
        try harness.scrollToBottom()
        await harness.settle()
        #expect(await fixture.cursors.count == 6)
        #expect(harness.rowCount == 100)
    }
}

private actor HitPageFixture {
    private(set) var cursors: [String] = []
    private(set) var maximumInFlight = 0
    private var inFlight = 0
    private var failFirst: Bool
    private let lastPage: Int
    init(failFirst: Bool = false, lastPage: Int = 2) { self.failFirst = failFirst; self.lastPage = lastPage }
    func read(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let object = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
        let fields = object?["fields"] as? [String: Any]
        let cursor = fields?["cursor"] as? String ?? "invalid"
        cursors.append(cursor)
        inFlight += 1; maximumInFlight = max(maximumInFlight, inFlight)
        defer { inFlight -= 1 }
        try await Task.sleep(for: .milliseconds(80))
        if failFirst { failFirst = false; throw ClientConnectionError.invalidResponse }
        let page = Int(cursor) ?? 0
        let data = try Self.document(start: page * 100, count: 20, next: page < lastPage ? String(page + 1) : nil)
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
    nonisolated static func document(start: Int = 0, count: Int = 20, next: String? = "1") throws -> Data {
        var card: [String: Any] = ["id": "memoryHits", "kind": "memoryHits", "version": 1,
            "revision": "fixed", "loadState": "ready", "actions": [
                ["id": "page", "kind": "read", "operation": "detail.collection.page", "label": ["fallback": "加载更多"],
                 "available": true, "target": ["resourceType": "session", "id": "hits"]]],
            "data": ["hasMore": next != nil, "items": (start..<(start + count)).map { i in
                ["memoryId": "memory-\(i)", "kind": "preference", "content": "记忆 \(i)：检查全局架构，复用现有组件。",
                 "unavailable": false, "snapshotAtRecall": true] as [String: Any]
            }]]
        if let next { card["nextCursor"] = next }
        return try JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "catalog": "native-business-v1",
            "documentId": "detail", "sessionId": "hits", "generation": "generation", "revision": "fixed",
            "cards": [card], "order": ["memoryHits"]])
    }
}

@MainActor private final class HitPagingHarness {
    let repository = ClientDetailBusinessRepository()
    let activity = ConversationDetailPresentationActivity(isActive: true)
    let handle: ClientDetailBusinessHandle
    let api: ClientDetailAPI
    let host: NSHostingView<AnyView>
    let window: NSWindow
    init(fixture: HitPageFixture) throws {
        let scope = ClientDetailBusinessScope(serverID: "fixture", ownerID: "window", principalID: "user",
            sessionID: "hits", taskID: nil, workID: nil)
        handle = repository.entry(for: scope)
        try handle.store.receive(.decode(HitPageFixture.document()))
        api = ClientDetailAPI(transport: BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:49989")!),
            data: { try await fixture.read($0) }, bytes: { _ in throw ClientConnectionError.invalidResponse }), route: .desktop).nativeBusinessPolicy
        let choice = ClientDetailConfiguration.Selection(id: "fixture", title: "Fixture", choices: [], canSelect: false)
        let adapters = ConversationDetailAdapters(configuration: .init(provider: choice, model: choice, reasoning: choice),
            selectConfiguration: { _, _ in }, reloadConfiguration: {}, readTurnSummary: { _ in throw CancellationError() },
            readTurnTrace: { _, _ in throw CancellationError() }, worktreeAPI: { _ in throw CancellationError() }, onWorktreeJob: { _ in }, resident: .init())
        let view = ConversationNativeBusinessDetail(store: handle.store, api: api, actions: nil,
            context: .init(sessionKind: "assistantChat", taskID: nil, workID: nil), adapters: adapters, handle: handle,
            arrangement: .init(defaults: .standard), refresh: {}, activity: activity,
            canCommand: { _, _ in false }, perform: { _, _, _ in })
        host = NSHostingView(rootView: AnyView(ConversationDetailDashboard { view }))
        window = NSWindow(contentRect: CGRect(x: 100, y: 100, width: 324, height: 600),
            styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.contentView = host; window.orderFront(nil)
        host.layoutSubtreeIfNeeded()
    }
    func close() { activity.deactivate(); window.contentView = nil; window.close(); repository.invalidateAll() }
    func settle() async { try? await Task.sleep(for: .milliseconds(250)); host.layoutSubtreeIfNeeded() }
    func waitForRows(_ count: Int) async {
        for _ in 0..<20 {
            if rowCount == count { break }
            try? await Task.sleep(for: .milliseconds(30)); host.layoutSubtreeIfNeeded()
        }
    }
    var rowCount: Int {
        guard let card = handle.store.orderedCards.first, case .hits(let list) = card.card.payload else { return 0 }
        return list.items.count
    }
    private func descendants<T: NSView>(_ view: NSView, as type: T.Type) -> [T] {
        ((view as? T).map { [$0] } ?? []) + view.subviews.flatMap { descendants($0, as: type) }
    }
    var loadMoreButtons: [NSButton] { descendants(host, as: NSButton.self).filter { $0.title == "加载更多" } }
    private func innerScroll() throws -> NSScrollView {
        try #require(descendants(host, as: NSScrollView.self).first { $0.bounds.height < host.bounds.height - 40 && $0.documentView != nil })
    }
    func scrollToBottom() throws {
        let scroll = try innerScroll()
        scroll.contentView.scroll(to: CGPoint(x: 0, y: max(0, (scroll.documentView?.bounds.height ?? 0) - scroll.contentView.bounds.height)))
        scroll.reflectScrolledClipView(scroll.contentView)
    }
    func scrollToTop() throws {
        let scroll = try innerScroll()
        scroll.contentView.scroll(to: .zero); scroll.reflectScrolledClipView(scroll.contentView)
    }
}
#endif
