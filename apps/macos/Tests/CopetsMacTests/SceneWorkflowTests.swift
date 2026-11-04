import Foundation
import AppKit
import SwiftUI
import Testing
@testable import CorptieMac

@Suite(.serialized)
@MainActor
struct SceneWorkflowTests {
    private func scene(_ id: String = "scene:one", kind: String = "fitness-planner", revision: Int = 3) -> SceneInstance {
        SceneInstance(instanceId: id, templateId: kind, templateVersion: 1, name: "Scene", timezone: "Asia/Shanghai",
                      status: "active", instanceRevision: revision, resourceVersion: 1, createdAt: "", updatedAt: "")
    }
    private func record(_ i: Int, owner: String = "scene:one", type: String = "Measurement") -> SceneRecord {
        SceneRecord(instanceId: owner, recordId: "r:\(i)", recordType: type,
                    data: type == "List" ? ["title": .string("Existing"), "archived": .bool(false)]
                      : ["metric": .string("Weight"), "value": .number(Double(i)), "unit": .string("kg")],
                    recordVersion: 1, archivedAt: nil, createdAt: "2026-11-02T00:00:00Z", updatedAt: "")
    }
    private func page(_ records: [SceneRecord], scene: SceneInstance, next: Int? = nil) throws -> Data {
        try JSONEncoder().encode(SceneViewResponse(scene: scene, view: .init(viewId: "measurements", title: "Records", kind: "list", recordTypes: []), records: records, nextOffset: next))
    }
    private func client() -> (SceneAPIClient, URLSession) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SceneWorkflowProtocol.self]
        let session = URLSession(configuration: config)
        return (SceneAPIClient(baseURL: URL(string: "http://127.0.0.1:49992")!, session: session), session)
    }

    @Test func decimalValidationMatchesBoundsLocaleAndUTF16() {
        #expect(SceneInput.number("68,4", locale: Locale(identifier: "de_DE")) == 68.4)
        #expect(SceneInput.number("1.234", locale: Locale(identifier: "de_DE")) == nil)
        #expect(SceneInput.number("1,234", locale: Locale(identifier: "en_US")) == nil)
        #expect(SceneInput.number("0", locale: .current) == 0)
        for value in ["NaN", "Infinity", "1000001", "1e3", "4.2x", "--3", "1.2.3"] {
            #expect(SceneInput.number(value, locale: Locale(identifier: "en_US")) == nil)
        }
        #expect(SceneInput.number("-1000000", locale: .current) == -1_000_000)
        #expect(SceneInput.validText(String(repeating: "😀", count: 120), maximum: 240))
        #expect(!SceneInput.validText(String(repeating: "😀", count: 121), maximum: 240))
        #expect(!SceneInput.validText(" \n ", maximum: 240))
        #expect(SceneKind(templateID: "future", version: 1) == .unsupported)
        #expect(SceneKind(templateID: "daily-checklist", version: 2) == .unsupported)
    }

    @Test func draftsAreIsolatedAndNeverSilentlyEvicted() throws {
        let store = SceneDraftStore()
        for i in 0..<10 { try #require(store.draft(for: "s:\(i)")).title = "unsaved \(i)" }
        #expect(store.draft(for: "eleventh") == nil)
        #expect(store.draft(for: "s:0")?.title == "unsaved 0")
        store.draft(for: "s:0")?.title = ""
        #expect(store.draft(for: "eleventh") != nil)
        let saved = SceneEntryDraft()
        saved.title = "Weight"; saved.unit = "lb"
        saved.markMeasurementSaved(metric: "Weight", unit: "lb")
        #expect(saved.isEmpty, "Saved metric preferences must not consume the unsaved draft budget")
        saved.clear(); #expect(saved.isEmpty)
    }

    @Test func boundedPaginationCanReachEveryRecordAndGoBack() async throws {
        let scene = scene()
        let pages = try Dictionary(uniqueKeysWithValues: stride(from: 0, to: 1000, by: 100).map { offset in
            (offset, try page((offset..<(offset + 100)).map { record($0) }, scene: scene, next: offset < 900 ? offset + 100 : nil))
        })
        SceneWorkflowProtocol.state.reset { request in
            let offset = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "offset" }?.value.flatMap(Int.init) ?? 0
            return (200, pages[offset]!, 0)
        }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        await client.loadScene(scene)
        var seen = Set(client.records.map(\.id))
        for _ in 0..<9 {
            await client.loadMore(scene)
            #expect(client.records.count <= 500)
            seen.formUnion(client.records.map(\.id))
        }
        #expect(seen.count == 1000)
        #expect(client.nextOffset == nil)
        #expect(client.hasPreviousGroup)
        await client.loadPrevious(scene)
        #expect(client.groupOffset == 0)
        #expect(client.records.first?.id == "r:0")
    }

    @Test func revisionChangeRejectsFollowingPageWithoutMixingData() async throws {
        let first = try page([record(0)], scene: scene(), next: 100)
        let second = try page([record(100)], scene: scene(revision: 4))
        SceneWorkflowProtocol.state.reset { request in
            (200, request.url!.query!.contains("offset=0") ? first : second, 0)
        }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        await client.loadScene(scene()); await client.loadMore(scene())
        #expect(client.records.map(\.id) == ["r:0"])
        #expect(client.pageError != nil)
        #expect(client.nextOffset == nil)
    }

    @Test func checklistFindsListBeyondFirstPageAndDoesNotCreateAnother() async throws {
        let scene = scene(kind: "daily-checklist")
        let first = try page([record(0, type: "Item")], scene: scene, next: 100)
        let second = try page([record(1, type: "List")], scene: scene)
        let receipt = try JSONEncoder().encode(SceneMutationReceipt(mutationId: "m:1", instanceId: scene.id, instanceRevision: 4, summary: "created"))
        SceneWorkflowProtocol.state.reset { request in
            if request.httpMethod == "POST" { return (200, receipt, 0) }
            return (200, request.url!.query!.contains("offset=0") ? first : second, 0)
        }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        await client.loadScene(scene)
        #expect(await client.addChecklistItem(title: "Read", to: scene) == .committed)
        let posts = SceneWorkflowProtocol.state.requests.filter { $0.httpMethod == "POST" }
        #expect(posts.count == 1)
        let body = try #require(posts.first?.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let payload = try #require(json["payload"] as? [String: Any])
        let data = try #require(payload["data"] as? [String: Any])
        #expect(data["listId"] as? String == "r:1")
    }

    @Test func multipleChecklistsDisableEntryAndNeverChooseArbitrarily() async throws {
        let scene = scene(kind: "daily-checklist")
        let data = try page([record(1, type: "List"), record(2, type: "List")], scene: scene)
        SceneWorkflowProtocol.state.reset { _ in (200, data, 0) }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        await client.loadScene(scene)
        #expect(client.listIssue != nil)
        #expect(await client.addChecklistItem(title: "No", to: scene) == .rejected)
        #expect(SceneWorkflowProtocol.state.requests.count == 1)
    }

    @Test func committedWriteWithFailedRefreshDoesNotBecomeRetryableWrite() async throws {
        let data = try page([record(1)], scene: scene())
        let receipt = try JSONEncoder().encode(SceneMutationReceipt(mutationId: "m:1", instanceId: "scene:one", instanceRevision: 4, summary: "created"))
        SceneWorkflowProtocol.state.reset { request in request.httpMethod == "POST" ? (200, receipt, 0) : (200, data, 0) }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        await client.loadScene(scene())
        SceneWorkflowProtocol.state.setHandler { request in request.httpMethod == "POST" ? (200, receipt, 0) : (503, Data(#"{"error":"Unavailable"}"#.utf8), 0) }
        #expect(await client.addMeasurement(metric: "Weight", value: 10, unit: "kg", to: scene()) == .committed)
        #expect(client.operation(for: "scene:one").message?.isEmpty == false)
        #expect(client.records.count == 1)
        #expect(client.errorMessage != nil)
    }

    @Test func uncertainOrMalformedCommitBlocksBlindResubmission() async throws {
        for status in [200, 503] {
            SceneWorkflowProtocol.state.reset { _ in (status, Data("not json".utf8), 0) }
            let (client, session) = client(); defer { session.invalidateAndCancel() }
            #expect(await client.addMeasurement(metric: "Weight", value: 1, unit: "kg", to: scene()) == .uncertain)
            #expect(client.operation(for: "scene:one").needsVerification)
            #expect(await client.addMeasurement(metric: "Weight", value: 1, unit: "kg", to: scene()) == .rejected)
            #expect(SceneWorkflowProtocol.state.requests.count == 1)
        }
    }

    @Test func creationRetainsTemplateVersionAndReportsAmbiguousResponse() async throws {
        SceneWorkflowProtocol.state.reset { _ in (200, Data("{}".utf8), 0) }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        do {
            _ = try await client.createScene(CreateSceneDraft(templateId: "daily-checklist", name: "  New  ", templateVersion: 2))
            Issue.record("Expected ambiguous response")
        } catch {
            #expect((error as? SceneRequestError)?.uncertain == true)
        }
        let body = try #require(SceneWorkflowProtocol.state.requests.first?.httpBody)
        let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        #expect(json["templateVersion"] as? Int == 2)
        #expect(json["name"] as? String == "New")
    }

    @Test func writeFinishingAfterSelectionChangeDoesNotReplaceNewScene() async throws {
        let a = scene("scene:a"), b = scene("scene:b")
        let first = try page([record(1, owner: a.id)], scene: a)
        let second = try page([record(2, owner: b.id)], scene: b)
        let receipt = try JSONEncoder().encode(SceneMutationReceipt(mutationId: "m:a", instanceId: a.id, instanceRevision: 4, summary: "created"))
        SceneWorkflowProtocol.state.reset { request in
            if request.httpMethod == "POST" { return (200, receipt, 0.1) }
            return (200, request.url!.path.contains("scene:a") ? first : second, 0)
        }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        await client.loadScene(a)
        let write = Task { await client.addMeasurement(metric: "Weight", value: 1, unit: "kg", to: a) }
        try await Task.sleep(for: .milliseconds(10))
        await client.loadScene(b)
        #expect(await write.value == .committed)
        #expect(client.records.map(\.instanceId) == [b.id])
        #expect(client.operation(for: b.id).message == nil)
        #expect(client.operation(for: a.id).message != nil)
    }

    @Test func detailHostRendersBoundedLongListsAtNarrowAndWideWidths() async throws {
        _ = NSApplication.shared
        let scene = scene()
        let pages = try Dictionary(uniqueKeysWithValues: stride(from: 0, to: 500, by: 100).map { offset in
            (offset, try page((offset..<(offset+100)).map { record($0) }, scene: scene, next: offset < 400 ? offset+100 : nil))
        })
        SceneWorkflowProtocol.state.reset { request in
            let offset = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "offset" }?.value.flatMap(Int.init) ?? 0
            return (200, pages[offset]!, 0)
        }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        await client.loadScene(scene)
        for _ in 0..<4 { await client.loadMore(scene) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 620), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let draft = SceneEntryDraft()
        draft.title = "Retained metric"; draft.value = "68.4"
        let host = NSHostingView(rootView: ScenePageColumns(showsNavigation: true) {
            Text("Scenes")
        } detail: { _ in
            SceneDetailView(scene: scene, client: client, draft: draft, operation: client.operation(for: scene.id))
        })
        let requestCount = SceneWorkflowProtocol.state.requests.count
        window.contentView = host
        defer { window.contentView = nil; window.close() }
        for width: CGFloat in [760, 420, 320] {
            let started = CFAbsoluteTimeGetCurrent()
            window.setContentSize(NSSize(width: width, height: 620))
            window.layoutIfNeeded(); host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
            host.layoutSubtreeIfNeeded()
            #expect(host.bounds.width <= width + 1)
            #expect(client.rows.count == 500)
            print("[SceneHost] width=\(width) records=500 layout_callback_ms=\((CFAbsoluteTimeGetCurrent()-started)*1000) (includes 50ms settling; not screen presentation)")
            if let directory = ProcessInfo.processInfo.environment["CORPTIE_SCENE_SNAPSHOT_DIR"] {
                let root = URL(fileURLWithPath: directory).standardizedFileURL
                #expect(root.path.hasPrefix("/Volumes/T9/.corptie/tmp/"))
                guard root.path.hasPrefix("/Volumes/T9/.corptie/tmp/"), let bitmap = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { continue }
                host.cacheDisplay(in: host.bounds, to: bitmap)
                if let png = bitmap.representation(using: .png, properties: [:]) {
                    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                    try png.write(to: root.appendingPathComponent("scene-host-\(Int(width)).png"))
                }
            }
            func descendants(_ view: NSView) -> [NSView] { [view] + view.subviews.flatMap(descendants) }
            let scroll = try #require(descendants(host).compactMap { $0 as? NSScrollView }.first {
                ($0.documentView?.frame.height ?? 0) > $0.contentView.bounds.height + 10
            })
            let document = try #require(scroll.documentView)
            let maximum = max(0, document.frame.height - scroll.contentView.bounds.height)
            scroll.contentView.scroll(to: NSPoint(x: 0, y: maximum))
            scroll.reflectScrolledClipView(scroll.contentView)
            try await Task.sleep(for: .milliseconds(30)); host.layoutSubtreeIfNeeded()
            #expect(scroll.contentView.bounds.minY > 0, "The record list must remain scrollable inside full-height columns")
            scroll.contentView.scroll(to: .zero)
            scroll.reflectScrolledClipView(scroll.contentView)
            #expect(draft.title == "Retained metric" && draft.value == "68.4")
            #expect(SceneWorkflowProtocol.state.requests.count == requestCount, "Resize and scrolling must not reload scene data")
            print("[SceneScroll] width=\(width) rows=500 scrolled=true draftRetained=true extraRequests=0 (programmatic NSClipView; not a physical scroll)")
        }
    }

    @Test func oldResponseCannotReplaceNewSelection() async throws {
        let a = scene("scene:a"), b = scene("scene:b")
        let first = try page([record(1, owner: a.id)], scene: a)
        let second = try page([record(2, owner: b.id)], scene: b)
        SceneWorkflowProtocol.state.reset { request in
            request.url!.path.contains("scene:a") ? (200, first, 0.1) : (200, second, 0)
        }
        let (client, session) = client(); defer { session.invalidateAndCancel() }
        let old = Task { await client.loadScene(a) }
        try await Task.sleep(for: .milliseconds(10))
        await client.loadScene(b); await old.value
        #expect(client.recordsOwnerSceneID == b.id)
        #expect(client.records.map(\.instanceId) == [b.id])
    }
}

private final class SceneWorkflowProtocol: URLProtocol, @unchecked Sendable {
    final class State: @unchecked Sendable {
        private let lock = NSLock()
        private var handler: @Sendable (URLRequest) -> (Int, Data, Double) = { _ in (500, Data(), 0) }
        private var captured: [URLRequest] = []
        var requests: [URLRequest] { lock.withLock { captured } }
        func reset(_ action: @escaping @Sendable (URLRequest) -> (Int, Data, Double)) {
            lock.withLock { captured = []; handler = action }
        }
        func setHandler(_ action: @escaping @Sendable (URLRequest) -> (Int, Data, Double)) { lock.withLock { handler = action } }
        func response(_ request: URLRequest) -> (Int, Data, Double) {
            lock.withLock { captured.append(request); return handler(request) }
        }
    }
    static let state = State()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        // URLSession may move streamed request bodies out of httpBody.
        var captured = request
        if captured.httpBody == nil, let stream = captured.httpBodyStream {
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let count = stream.read(&buffer, maxLength: buffer.count)
                if count <= 0 { break }; data.append(buffer, count: count)
            }
            captured.httpBody = data
        }
        let (status, data, delay) = Self.state.response(captured)
        let send: @Sendable () -> Void = { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data); client?.urlProtocolDidFinishLoading(self)
        }
        if delay > 0 { DispatchQueue.global().asyncAfter(deadline: .now() + delay, execute: send) } else { send() }
    }
    override func stopLoading() {}
}
