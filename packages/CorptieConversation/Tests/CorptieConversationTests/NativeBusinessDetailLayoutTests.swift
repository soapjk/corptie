import Foundation
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation
#if os(macOS)
import AppKit

@MainActor struct NativeBusinessDetailLayoutTests {
    @Test func memoryPagingAndTaskNavigationSettleInWidgetDashboard() async throws {
        let repository = ClientDetailBusinessRepository()
        let presentation = ConversationDetailPresentationRepository()
        let reads = PageReadProbe()
        let endpoint = try BackendEndpoint(URL(string: "http://127.0.0.1:47321")!)
        var fixtureAPI: ClientDetailAPI? = ClientDetailAPI(transport: BackendTransport(endpoint: endpoint,
            data: { _ in await reads.record(); throw ClientConnectionError.invalidResponse },
            bytes: { _ in throw ClientConnectionError.invalidResponse }), route: .desktop).nativeBusinessPolicy
        if ProcessInfo.processInfo.environment["CORPTIE_DETAIL_LAYOUT_LIVE_PAGING"] == "1" {
            fixtureAPI = ClientDetailAPI(transport: try BackendTransport(endpoint: BackendEndpoint(URL(string: "http://127.0.0.1:47321")!)), route: .desktop).nativeBusinessPolicy
        }
        let selection = ClientDetailConfiguration.Selection(id: "test", title: "Test", choices: [], canSelect: false)
        let adapters = ConversationDetailAdapters(configuration: .init(provider: selection, model: selection, reasoning: selection),
            selectConfiguration: { _, _ in }, reloadConfiguration: {},
            readTurnSummary: { _ in throw ClientDetailConfigurationFailure.unavailable },
            readTurnTrace: { _, _ in throw ClientDetailConfigurationFailure.unavailable },
            worktreeAPI: { _ in throw ClientDetailConfigurationFailure.unavailable }, onWorktreeJob: { _ in }, resident: .init())
        func rail(_ revision: Int) throws -> some View {
            let scope = ClientDetailBusinessScope(serverID: "fixture", ownerID: "window", principalID: "owner",
                sessionID: "session-\(revision % 2)", taskID: "task-\(revision % 2)", workID: "work")
            let handle = repository.entry(for: scope)
            let document: ClientDetailBusinessDocument
            if let path = ProcessInfo.processInfo.environment["CORPTIE_DETAIL_LAYOUT_FIXTURE"] {
                document = try ClientDetailBusinessDocument.decode(Data(contentsOf: URL(fileURLWithPath: path)))
            } else {
                let cards: [[String: Any]] = ["memoryHits", "memoryResources"].map { kind in
                    ["id": kind, "kind": kind, "version": 1, "revision": "\(revision)", "loadState": "ready", "actions": [
                        ["id": "page", "kind": "read", "operation": "detail.collection.page", "label": ["fallback": "加载更多"],
                         "available": true, "target": ["resourceType": "session", "id": scope.sessionID]]
                     ],
                     "nextCursor": "page-\(revision)", "data": ["hasMore": true, "items": (0..<(revision == 0 ? 1 : 20)).map { index in
                         ["memoryId": "memory-\(index)", "kind": "preference", "content": String(repeating: "开发时应检查全局架构，复用现有模块。", count: index % 3 + 1),
                          "unavailable": false, "snapshotAtRecall": true] as [String: Any]
                     }]]
                }
                document = try ClientDetailBusinessDocument.decode(JSONSerialization.data(withJSONObject: [
                    "protocolVersion": 1, "catalog": "native-business-v1", "documentId": "detail", "sessionId": scope.sessionID,
                    "generation": "generation", "revision": "\(revision)", "cards": cards, "order": cards.map { $0["id"]! }
                ]))
            }
            try handle.store.receive(document)
            let retained = presentation.entry(for: scope)
            return ConversationDetailDashboard {
                ConversationNativeBusinessDetail(store: handle.store, api: fixtureAPI, actions: nil,
                    context: .init(sessionKind: "task", taskID: scope.taskID, workID: scope.workID),
                    adapters: adapters, handle: handle, arrangement: retained.arrangement,
                    refresh: {}, canCommand: { _, _ in false }, perform: { _, _, _ in })
                    .environment(\.detailPresentation, retained)
            }
        }
        let host = NSHostingView(rootView: try rail(0))
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 376, height: 700), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderFront(nil)
        defer { window.contentView = nil; window.close() }
        func scrolls(_ view: NSView) -> [NSScrollView] {
            (view as? NSScrollView).map { [$0] } ?? view.subviews.flatMap(scrolls)
        }
        for revision in 0..<6 {
            host.rootView = try rail(revision)
            window.setContentSize(CGSize(width: revision.isMultiple(of: 2) ? 376 : 320, height: 700))
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(80))
            for scroll in scrolls(host) {
                scroll.contentView.scroll(to: CGPoint(x: 0, y: max(0, (scroll.documentView?.bounds.height ?? 0) - scroll.contentView.bounds.height)))
                scroll.reflectScrolledClipView(scroll.contentView)
            }
            try await Task.sleep(for: .milliseconds(80))
            let frames = scrolls(host).map(\.frame)
            try await Task.sleep(for: .milliseconds(80))
            #expect(scrolls(host).map(\.frame) == frames)
        }
        if ProcessInfo.processInfo.environment["CORPTIE_DETAIL_LAYOUT_LIVE_PAGING"] != "1" {
            host.rootView = try rail(0)
            for scroll in scrolls(host) {
                scroll.contentView.scroll(to: .zero)
                scroll.reflectScrolledClipView(scroll.contentView)
            }
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(120))
            // Offscreen appearance and viewport changes must never launch page
            // tasks. Loading is an explicit action on the stable card surface.
            #expect(await reads.total() == 0)
            let handle = repository.entry(for: .init(serverID: "fixture", ownerID: "window", principalID: "owner",
                sessionID: "session-0", taskID: "task-0", workID: "work"))
            await handle.store.loadMore(cardID: "memoryHits", api: try #require(fixtureAPI), retry: true)
            #expect(await reads.total() == 1)
        }
    }
}

private actor PageReadProbe {
    private var count = 0
    func record() { count += 1 }
    func total() -> Int { count }
}
#endif
