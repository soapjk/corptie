import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@Suite(.serialized) @MainActor
struct PadControlTests {
    @Test func statusBarBackdropUsesSafeAreaAndOnlyAShortFade() {
        #expect(PadStatusBarBackdropLayout.height(topInset: 24) == 40)
        #expect(PadStatusBarBackdropLayout.height(topInset: 0) == 0)
        #expect(PadStatusBarBackdropLayout.height(topInset: -1) == 0)
        #expect(PadStatusBarBackdropLayout.solidStop(topInset: 24) == 0.6)
        #expect(PadStatusBarBackdropLayout.solidStop(topInset: 0) == 0)
    }

    @Test func statusBarBackdropHasOneIPadOnlyOwnerWithoutScrollTracking() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("Sources/PadAppShell.swift")
        let source = try String(contentsOf: url, encoding: .utf8)
        #expect(source.components(separatedBy: "PadUnifiedStatusBarBackdrop()").count == 2)
        #expect(source.contains("if usesNavigationRail, tab == .workspace"))
        #expect(source.contains("content.scrollEdgeEffectHidden(true, for: .top)"))
        let backdrop = source.components(separatedBy: "private struct PadUnifiedStatusBarBackdrop: View")[1]
            .components(separatedBy: "private struct PadUnifiedTopScrollEdges")[0]
        #expect(backdrop.contains(".mask {"))
        #expect(backdrop.contains(".allowsHitTesting(false)"))
        #expect(!backdrop.contains("@State"))
        #expect(!backdrop.contains("onScroll"))
        #expect(!backdrop.contains(".shadow("))
    }
    @Test func worktreeErrorsPreserveStageAndServerCode() {
        let rejected = PadWorktreeFailure.describe(
            ClientServiceFailure(statusCode: 400, code: "BRANCH_OPERATION_INVALID"),
            stage: "生成集成计划", mutation: true)
        #expect(rejected.contains("生成集成计划"))
        #expect(rejected.contains("BRANCH_OPERATION_INVALID"))
        #expect(rejected.contains("HTTP 400"))
        #expect(!rejected.contains("同步失败"))
        let unknown = PadWorktreeFailure.describe(URLError(.timedOut), stage: "确认计划", mutation: true)
        #expect(unknown.contains("不要重复提交"))
        let read = PadWorktreeFailure.describe(URLError(.timedOut), stage: "读取仓库状态")
        #expect(!read.contains("执行结果未确认"))
    }
    @Test func mentionMenuStaysAboveComposerWithinAvailableViewport() {
        let full = PadMentionMenuPlacement(moduleTop: 600, moduleWidth: 500, preferredHeight: 326)
        #expect(full.width == 360 && full.height == 326)
        #expect(full.offsetY + full.height == -8)
        let keyboard = PadMentionMenuPlacement(moduleTop: 180, moduleWidth: 280, preferredHeight: 326)
        #expect(keyboard.width == 280 && keyboard.height == 164)
        #expect(180 + keyboard.offsetY == 8)
        #expect(keyboard.offsetY + keyboard.height == -8)
        let unavailable = PadMentionMenuPlacement(moduleTop: 10, moduleWidth: 280, preferredHeight: 326)
        #expect(unavailable.height == 0)
    }
    @Test func workActivitySortTracksAllSessionsAndFallsBackOnlyWithoutSessions() throws {
        let workspace = PadWorkspace()
        workspace.works = try JSONDecoder().decode([ClientWork].self, from: Data("""
        [{"id":"a","name":"A","status":"active","updatedAt":"2026-09-30"},
         {"id":"b","name":"B","status":"active","updatedAt":"2026-09-01"},
         {"id":"c","name":"C","status":"active","updatedAt":"2026-09-03"}]
        """.utf8))
        func sessions(_ latest: String, progressUpdate: String = "2026-10-01") throws -> [ClientSession] {
            try JSONDecoder().decode([ClientSession].self, from: Data("""
            [{"id":"a1","title":"A","workId":"a","taskId":"task:a","executionStatus":"complete","lastMessageAt":"2026-09-02","updatedAt":"\(progressUpdate)"},
             {"id":"b1","title":"B","workId":"b","taskId":"task:b","executionStatus":"complete","lastMessageAt":"2026-09-01","updatedAt":"2026-09-01"},
             {"id":"b2","title":"Discussion","workId":"b","sessionKind":"workChat","executionStatus":"complete","lastMessageAt":"\(latest)","updatedAt":"2026-10-01"},
             {"id":"chat","title":"Chat","executionStatus":"complete","updatedAt":"2026-10-01"}]
            """.utf8))
        }
        workspace.sessions = try sessions("2026-09-04")
        workspace.rebuildGroups()
        #expect(workspace.latestSessionActivityByWork == ["a": "2026-09-02", "b": "2026-09-04"])
        #expect(workspace.latestSessionActivityByTask == ["task:a": "2026-09-02", "task:b": "2026-09-01"])
        #expect(PadOutlineSort.updated.works(workspace.works,
            latestSessionActivity: workspace.latestSessionActivityByWork).map(\.id) == ["b", "c", "a"])
        workspace.sessions = try sessions("2026-09-04", progressUpdate: "2026-10-08")
        workspace.rebuildGroups()
        #expect(workspace.latestSessionActivityByWork == ["a": "2026-09-02", "b": "2026-09-04"])
        workspace.sessions = try sessions("2026-09-01")
        workspace.rebuildGroups()
        #expect(PadOutlineSort.updated.works(workspace.works,
            latestSessionActivity: workspace.latestSessionActivityByWork).map(\.id) == ["c", "a", "b"])
        workspace.sessions = []
        workspace.rebuildGroups()
        #expect(workspace.latestSessionActivityByWork.isEmpty)
    }
    @Test func outlineSortPreservesDefaultAndUsesStableTies() throws {
        let works = try JSONDecoder().decode([ClientWork].self, from: Data("""
        [{"id":"b","name":"B","status":"active","updatedAt":"2026-01-02"},
         {"id":"a","name":"A","status":"active","updatedAt":"2026-01-02"},
         {"id":"c","name":"C","status":"active","updatedAt":"2026-01-03"}]
        """.utf8))
        #expect(PadOutlineSort.standard.works(works).map(\.id) == ["b", "a", "c"])
        #expect(PadOutlineSort.updated.works(works).map(\.id) == ["c", "a", "b"])
        #expect(PadOutlineSort.name.works(works).map(\.id) == ["a", "b", "c"])
        let tasks = try JSONDecoder().decode([ClientTask].self, from: Data("""
        [{"id":"b","title":"B","workId":"w","lifecycleState":"todo","executionStatus":"idle","updatedAt":"2026-01-01"},
         {"id":"a","title":"A","workId":"w","lifecycleState":"todo","executionStatus":"idle","updatedAt":"2026-01-02"},
         {"id":"c","title":"C","workId":"w","lifecycleState":"todo","executionStatus":"idle","updatedAt":"2026-01-03","archived":true}]
        """.utf8))
        #expect(PadOutlineSort.standard.tasks(tasks).map(\.id) == ["b", "a"])
        #expect(PadOutlineSort.updated.tasks(tasks).map(\.id) == ["a", "b"])
        #expect(PadOutlineSort.updated.tasks(tasks, latestSessionActivity: ["b": "2026-02-01"]).map(\.id) == ["b", "a"])
        #expect(PadOutlineSort.name.tasks(tasks).map(\.id) == ["a", "b"])
        #expect(PadOutlineSort.standard.tasks(tasks, showingArchived: true).map(\.id) == ["c"])
    }
    private func fixture() throws -> (PadConnection, PadControlStore) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ControlProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://control.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.connected = true
        ControlProtocol.fail = false; ControlProtocol.calls = []; ControlProtocol.phase = 0
        return (connection, PadControlStore())
    }

    @Test func fourTabsExcludeSettingsAndMapSkillsUnderAgents() {
        #expect(PadTab.allCases.count == 4)
        #expect(PadTab.agents.resources == [.agents, .skills])
        #expect(PadTab.worktrees.resources == [.repositories])
    }

    @Test func hiddenPagesDoNotFetchAndInvalidationPreservesSelection() async throws {
        let (connection, store) = try fixture()
        defer { store.pause() }
        store.routes[.agents] = PadControlSelection(kind: .agents, id: "agent:1")
        store.activate(.agents, connection: connection)
        try await Task.sleep(for: .milliseconds(600))
        #expect(ControlProtocol.calls.isEmpty)
        // Legacy hosts send invalidations; only that compatibility path reads.
        store.invalidate(connection)
        for _ in 0..<40 {
            if store.items[.skills] != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(store.items[.agents]?.first?.name == "Before")
        #expect(!ControlProtocol.calls.contains { $0.contains("repositories") || $0.contains("automations") })
        ControlProtocol.phase = 1
        store.invalidate(connection)
        for _ in 0..<40 {
            if store.items[.agents]?.first?.name == "After" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(store.items[.agents]?.first?.name == "After")
        #expect(store.routes[.agents]?.id == "agent:1")
        #expect(store.visibleTab == .agents)
        store.pause()
        let calls = ControlProtocol.calls.count
        store.invalidate(connection)
        try await Task.sleep(for: .milliseconds(600))
        #expect(ControlProtocol.calls.count == calls)
    }

    @Test func refreshAppliesDeletionsAndDenialIsNotEmptySuccess() async throws {
        let (connection, store) = try fixture()
        await store.refresh(.agents, connection: connection)
        #expect(store.items[.agents]?.count == 1)
        ControlProtocol.phase = 2
        await store.refresh(.agents, connection: connection)
        #expect(store.items[.agents]?.isEmpty == true)
        ControlProtocol.fail = true
        await store.refresh(.agents, connection: connection)
        #expect(store.errors[.agents]?.contains("拒绝") == true)
    }

    @Test func changingSessionClearsOldTimelineButReselectingDoesNot() {
        let workspace = PadWorkspace()
        workspace.selection = "one"
        workspace.before = "history-anchor"
        workspace.messages = [ClientMessage(id: "m1", text: "hello")]
        workspace.drafts["one"] = "draft"
        workspace.selection = "one"
        #expect(workspace.before == "history-anchor")
        #expect(workspace.messages.map(\.id) == ["m1"])
        workspace.selection = "two"
        #expect(workspace.before == nil)
        #expect(workspace.messages.isEmpty)
        #expect(workspace.drafts["one"] == "draft")
        workspace.selection = "one"
        #expect(workspace.before == "history-anchor")
        #expect(workspace.messages.map(\.id) == ["m1"])
        #expect(!workspace.isLoadingDetail)
    }
}

private final class ControlProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var phase = 0
    nonisolated(unsafe) static var fail = false
    nonisolated(unsafe) static var calls: [String] = []
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.calls.append(path)
        #expect(request.httpMethod == "GET")
        let status = Self.fail ? 403 : 200
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        let rows = Self.phase == 2 ? "[]" : "[{\"id\":\"agent:1\",\"name\":\"\(Self.phase == 0 ? "Before" : "After")\"}]"
        let json = "{\"schemaVersion\":1,\"items\":\(rows),\"hasMore\":false}"
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
