import Foundation
import Testing
import CorptieClientCore
@testable import CorptiePadState

@Suite(.serialized) @MainActor
struct PadControlTests {
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
        #expect(store.errors[.agents]?.contains("权限") == true)
    }

    @Test func changingSessionClearsOldTimelineButReselectingDoesNot() {
        let workspace = PadWorkspace()
        workspace.selection = "one"
        workspace.before = "history-anchor"
        workspace.drafts["one"] = "draft"
        workspace.selection = "one"
        #expect(workspace.before == "history-anchor")
        workspace.selection = "two"
        #expect(workspace.before == nil)
        #expect(workspace.drafts["one"] == "draft")
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
