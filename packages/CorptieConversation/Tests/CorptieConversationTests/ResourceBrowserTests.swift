import Foundation
import Testing
#if os(macOS)
import AppKit
import SwiftUI
#endif
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
    #if os(macOS)
    @Test func markdownDocumentTablesFollowTheReaderWidthWhenItsWindowResizes() throws {
        _ = NSApplication.shared
        let source = "# 文档\n\n| 时间 | 安排 | 备注 |\n| --- | --- | --- |\n| 07:30 | 早餐 | 休息 |\n"
        let chunk = ResourceDocumentChunk(id: 0, text: source)
        let host = NSHostingView(rootView: ScrollView {
            LazyVStack(alignment: .leading) { ResourceDocumentView(chunk: chunk) }.padding(20)
        })
        let window = NSWindow(contentRect: .init(x: 0, y: 0, width: 360, height: 500),
            styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderBack(nil)
        defer { window.close() }
        func tables(_ view: NSView) -> [ClickActivatedTableScrollView] {
            (view as? ClickActivatedTableScrollView).map { [$0] } ?? view.subviews.flatMap(tables)
        }
        var originalTable: ClickActivatedTableScrollView?
        for width: CGFloat in [360, 720, 1120, 480] {
            window.setContentSize(.init(width: width, height: 500))
            host.frame = .init(x: 0, y: 0, width: width, height: 500)
            for _ in 0..<6 {
                host.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.01))
            }
            let table = try #require(tables(host).first)
            print("ARTIFACT_TABLE_WIDTH viewport=\(width) table=\(table.bounds.width) content=\(table.documentView?.frame.width ?? 0)")
            #expect(abs(table.bounds.width - (width - 40)) < 1)
            #expect(abs((table.documentView?.frame.width ?? 0) - table.contentSize.width) < 1)
            if let originalTable { #expect(table === originalTable) }
            else { originalTable = table }
        }
        #expect(chunk.text == source)
    }
    #endif

    @Test func documentPreparesSharedMathOnceAndPreservesSourceForCopy() {
        let source = #"\[夏普比率=\frac{收益}{风险}\]"#
        let chunk = ResourceDocumentChunk(id: 0, text: source)
        #expect(chunk.text == source)
        #expect(chunk.blocks.contains { $0.attributed.flatMap { MessageMarkdown.mathCopyText(from: $0) } == source })
    }
}
