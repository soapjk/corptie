import Foundation
import Testing
import CorptieClientCore
@testable import CorptiePadState

@Suite(.serialized) @MainActor
struct PadRealtimeTests {
    private func fixture() throws -> (PadConnection, PadWorkspace) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RealtimeProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://fixture.invalid")!), bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.connected = true
        let workspace = PadWorkspace()
        workspace.selection = "session:test"
        RealtimeProtocol.phase = 0
        return (connection, workspace)
    }

    @Test func subscriptionUpdatesTextAndStatusWithoutManualRefreshAndDoesNotNavigate() async throws {
        let (connection, workspace) = try fixture()
        let live = Task { await workspace.runRealtime(connection) }
        defer { live.cancel(); RealtimeProtocol.stream = nil }
        for _ in 0..<40 {
            if workspace.messages.first?.text == "partial" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(workspace.messages.first?.text == "partial")
        #expect(workspace.sessions.first?.executionStatus == "running")
        #expect(workspace.controlRevision > 0)
        RealtimeProtocol.phase = 1
        RealtimeProtocol.stream?.invalidate()
        for _ in 0..<40 {
            if workspace.messages.first?.text == "completed response" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(workspace.messages.first?.text == "completed response")
        #expect(workspace.sessions.first?.executionStatus == "complete")
        #expect(workspace.selection == "session:test")
        #expect(workspace.capabilities?.stop.available == false)
        live.cancel()
        await live.value
        #expect(workspace.refreshWorker == nil)
    }

    @Test func unchangedSnapshotDoesNotInvalidateMessageLayoutAndHistorySurvives() async throws {
        let (connection, workspace) = try fixture()
        workspace.messages = try JSONDecoder().decode([ClientMessage].self, from: Data(#"[{"id":"history","type":"userMessage","text":"old"},{"id":"item:1","type":"agentMessage","text":"partial"}]"#.utf8))
        workspace.before = "older-history"
        try await workspace.refreshRealtime(connection, inventory: false, timeline: true)
        #expect(workspace.messageRevision == 0)
        #expect(workspace.messages.first?.id == "history")
        #expect(workspace.before == "older-history")
        RealtimeProtocol.phase = 1
        try await workspace.refreshRealtime(connection, inventory: false, timeline: true)
        #expect(workspace.messageRevision == 1)
        #expect(workspace.messages.map(\.id) == ["history", "item:1"])
    }

    @Test func interruptedStreamAutomaticallyReconnectsAndRepairsMissedUpdate() async throws {
        let (connection, workspace) = try fixture()
        let live = Task { await workspace.runRealtime(connection) }
        defer { live.cancel(); RealtimeProtocol.stream = nil }
        for _ in 0..<50 {
            if workspace.messages.first?.text == "partial" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(workspace.messages.first?.text == "partial")
        let original = RealtimeProtocol.stream
        original?.finishFromServer()
        RealtimeProtocol.phase = 1 // no invalidation sent: reset must repair this gap
        for _ in 0..<100 {
            if workspace.messages.first?.text == "completed response" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(RealtimeProtocol.stream !== original)
        #expect(workspace.messages.first?.text == "completed response")
        #expect(workspace.selection == "session:test")
        live.cancel(); await live.value
    }
}

private final class RealtimeProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var phase = 0
    nonisolated(unsafe) static var stream: RealtimeProtocol?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        #expect(request.httpMethod == "GET") // this workflow must never replay send/stop
        let streaming = path.hasSuffix("/events")
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": streaming ? "text/event-stream" : "application/json"])!, cacheStoragePolicy: .notAllowed)
        if streaming {
            Self.stream = self
            invalidate(name: "reset")
            return
        }
        let json: String
        if path.hasSuffix("/capabilities") {
            json = "{\"schemaVersion\":1,\"sessionId\":\"session:test\",\"readMessages\":true,\"send\":{\"available\":true},\"stop\":{\"available\":\(Self.phase == 0)}}"
        } else if path.hasSuffix("/messages") {
            json = "{\"schemaVersion\":1,\"sessionId\":\"session:test\",\"hasEarlier\":false,\"items\":[{\"id\":\"item:1\",\"type\":\"agentMessage\",\"text\":\"\(Self.phase == 0 ? "partial" : "completed response")\"}]}"
        } else if path.hasSuffix("/sessions") {
            json = "{\"schemaVersion\":1,\"hasMore\":false,\"items\":[{\"id\":\"session:test\",\"title\":\"Test\",\"executionStatus\":\"\(Self.phase == 0 ? "running" : "complete")\",\"updatedAt\":\"now\"}]}"
        } else { json = #"{"schemaVersion":1,"hasMore":false,"items":[]}"# }
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    func invalidate(name: String = "invalidate") {
        client?.urlProtocol(self, didLoad: Data("event: \(name)\ndata: {\"schemaVersion\":1,\"inventory\":true,\"control\":true,\"sessions\":[],\"allSessions\":true}\n\n".utf8))
    }
    func finishFromServer() { client?.urlProtocolDidFinishLoading(self) }
    override func stopLoading() {}
}
