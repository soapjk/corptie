import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

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

    private func pushFixture() throws -> (PadConnection, PadWorkspace) {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [PushRealtimeProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://push-fixture.invalid")!), bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.connected = true
        let workspace = PadWorkspace()
        workspace.selection = "session:test"
        PushRealtimeProtocol.requests = []
        return (connection, workspace)
    }

    @Test func v2PushPopulatesWorkspaceWithoutFallbackReads() async throws {
        let (connection, workspace) = try pushFixture()
        let live = Task { await workspace.runRealtime(connection) }
        defer { live.cancel(); PushRealtimeProtocol.stream = nil }

        for _ in 0..<40 {
            if workspace.messages.first?.text == "pushed response", !workspace.sessions.isEmpty { break }
            try await Task.sleep(for: .milliseconds(50))
        }

        #expect(workspace.messages.first?.text == "pushed response")
        #expect(workspace.sessions.first?.executionStatus == "running")
        #expect(workspace.realtimeConnected)
        #expect(workspace.lastRealtimePulseAt != nil)
        #expect(workspace.realtimeStateRevision == 7)
        #expect(workspace.hasReceivedRealtimeState)
        #expect(workspace.lastTimelineRevision == 3)
        #expect(workspace.before == "item:1")
        #expect(workspace.directControlSnapshot != nil)
        #expect(PushRealtimeProtocol.requests.count == 1)
        #expect(PushRealtimeProtocol.requests.first?.hasPrefix("/client/v2/events") == true)
        #expect(PushRealtimeProtocol.requests.first?.contains("sessionId=") == false)

        live.cancel()
        await live.value
    }

    @Test func readyWithoutStateUsesOneBootstrapInventoryFallback() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReadyOnlyRealtimeProtocol.self]
        let transport = try BackendTransport(
            endpoint: BackendEndpoint(URL(string: "https://ready-only.invalid")!),
            bearerToken: "fixture",
            configuration: config
        )
        let connection = PadConnection(transportOverride: transport)
        connection.connected = true
        let workspace = PadWorkspace(initialStateRecoveryDelay: .milliseconds(10))
        ReadyOnlyRealtimeProtocol.requests = []
        let live = Task { await workspace.runRealtime(connection) }
        defer { live.cancel(); ReadyOnlyRealtimeProtocol.stream = nil }

        for _ in 0..<40 {
            if workspace.sessions.first?.id == "session:recovered" { break }
            try await Task.sleep(for: .milliseconds(25))
        }

        #expect(workspace.sessions.first?.id == "session:recovered")
        #expect(!workspace.hasReceivedRealtimeState)
        #expect(ReadyOnlyRealtimeProtocol.requests.filter { $0.hasSuffix("/works") }.count == 1)
        #expect(ReadyOnlyRealtimeProtocol.requests.filter { $0.hasSuffix("/tasks") }.count == 1)
        #expect(ReadyOnlyRealtimeProtocol.requests.filter { $0.hasSuffix("/sessions") }.count == 1)

        live.cancel()
        await live.value
        #expect(!workspace.realtimeConnected)
        #expect(workspace.realtimePausedAt != nil)
    }

    @Test func v2PushCursorLoadsAndPrependsEarlierHistory() async throws {
        let (connection, workspace) = try pushFixture()
        let live = Task { await workspace.runRealtime(connection) }
        defer { live.cancel(); PushRealtimeProtocol.stream = nil }

        for _ in 0..<40 {
            if workspace.before == "item:1" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        await workspace.loadEarlierMessagesIfNeeded(connection)

        #expect(workspace.messages.map(\.id) == ["item:0", "item:1"])
        #expect(workspace.before == nil)
        #expect(PushRealtimeProtocol.requests.contains {
            $0.contains("/client/v1/sessions/session:test/messages")
                && $0.contains("before=item:1")
        })

        live.cancel()
        await live.value
    }

    @Test func v2PushCachesUnselectedConversationBeforeItIsOpened() async throws {
        let (connection, workspace) = try pushFixture()
        let live = Task { await workspace.runRealtime(connection) }
        defer { live.cancel(); PushRealtimeProtocol.stream = nil }

        for _ in 0..<40 {
            if workspace.messages.first?.text == "pushed response" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        let visibleRevision = workspace.messageRevision
        PushRealtimeProtocol.stream?.sendBackgroundSnapshot()
        PushRealtimeProtocol.stream?.sendBackgroundDelta()
        try await Task.sleep(for: .milliseconds(100))

        #expect(workspace.messageRevision == visibleRevision)
        #expect(workspace.messages.last?.text == "pushed response")
        workspace.selection = "session:background"
        #expect(workspace.messages.last?.text == "completed background response")
        #expect(workspace.lastTimelineRevision == 10)
        #expect(PushRealtimeProtocol.requests.count == 1)

        live.cancel()
        await live.value
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

    @Test func cachedCapabilitiesWithoutTimelineStillBootstrapsMessages() async throws {
        let (connection, workspace) = try fixture()
        workspace.capabilities = try JSONDecoder().decode(ClientSessionCapabilities.self, from: Data(
            #"{"schemaVersion":1,"sessionId":"session:test","readMessages":true,"send":{"available":true},"stop":{"available":false}}"#.utf8))
        #expect(!workspace.selectedTimelineReady)
        await workspace.waitForRealtimeTimelineOrFallback(connection, graceAttempts: 0)
        #expect(workspace.messages.first?.text == "partial")
        #expect(workspace.selectedTimelineReady)
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

    @Test func polymorphicSessionIDMatchesRealtimeNotification() async throws {
        let (connection, workspace) = try fixture()
        workspace.selection = "codex:test-session-uuid"
        let live = Task { await workspace.runRealtime(connection) }
        defer { live.cancel(); RealtimeProtocol.stream = nil }

        for _ in 0..<50 {
            if workspace.messages.first?.text == "partial" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(workspace.messages.first?.text == "partial")

        // Server sends unprefixed session UUID or alternate alias
        RealtimeProtocol.phase = 1
        RealtimeProtocol.stream?.invalidateSession(sessionID: "test-session-uuid")

        for _ in 0..<50 {
            if workspace.messages.first?.text == "completed response" { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        #expect(workspace.messages.first?.text == "completed response")
        live.cancel(); await live.value
    }
}

private final class PushRealtimeProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var requests: [String] = []
    nonisolated(unsafe) static var stream: PushRealtimeProtocol?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        let recorded = path + request.url.map { $0.query.map { "?" + $0 } ?? "" }!
        Self.requests.append(recorded)
        #expect(request.httpMethod == "GET")
        if path.hasSuffix("/messages") {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(#"{"schemaVersion":1,"sessionId":"session:test","items":[{"id":"item:0","type":"userMessage","text":"earlier question"}],"hasEarlier":false,"nextBefore":null,"revision":3}"#.utf8))
            client?.urlProtocolDidFinishLoading(self)
            return
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        Self.stream = self
        send("stream-ready", #"{"schemaVersion":2,"pushPayloads":true,"eventRecovery":"snapshot"}"#)
        send("state-snapshot", #"{"schemaVersion":2,"revision":7,"works":[],"tasks":[],"sessions":[{"id":"session:test","title":"Test","executionStatus":"running","updatedAt":"now"}]}"#)
        send("control-snapshot", #"{"schemaVersion":2,"automations":[],"repositories":[],"agents":[],"skills":[]}"#)
        send("timeline-snapshot", #"{"schemaVersion":2,"kind":"snapshot","sessionId":"session:test","revision":3,"messages":{"schemaVersion":1,"sessionId":"session:test","items":[{"id":"item:1","type":"agentMessage","text":"pushed response"}],"hasEarlier":true,"nextBefore":"item:1","revision":3},"capabilities":{"schemaVersion":1,"sessionId":"session:test","readMessages":true,"send":{"available":true},"stop":{"available":true}},"usage":null,"composer":null}"#)
    }
    private func send(_ event: String, _ json: String) {
        client?.urlProtocol(self, didLoad: Data("event: \(event)\ndata: \(json)\n\n".utf8))
    }
    func sendBackgroundSnapshot() {
        send("timeline-snapshot", #"{"schemaVersion":2,"kind":"snapshot","sessionId":"session:background","revision":9,"messages":{"schemaVersion":1,"sessionId":"session:background","items":[{"id":"item:background","type":"agentMessage","text":"background response"}],"hasEarlier":false,"nextBefore":null,"revision":9},"capabilities":{"schemaVersion":1,"sessionId":"session:background","readMessages":true,"send":{"available":true},"stop":{"available":false}},"usage":null,"composer":null}"#)
    }
    func sendBackgroundDelta() {
        send("timeline-delta", #"{"schemaVersion":2,"kind":"delta","sessionId":"session:background","snapshotRequired":false,"baseRevision":9,"revision":10,"currentRevision":10,"hasMore":false,"changes":[{"revision":10,"itemId":"item:background","operation":"upsert","item":{"id":"item:background","type":"agentMessage","text":"completed background response"}}]}"#)
    }
    override func stopLoading() {}
}

private final class ReadyOnlyRealtimeProtocol: URLProtocol, @unchecked Sendable {
    nonisolated(unsafe) static var requests: [String] = []
    nonisolated(unsafe) static var stream: ReadyOnlyRealtimeProtocol?
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.requests.append(path)
        if path.hasSuffix("/events") {
            client?.urlProtocol(self, didReceive: HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/event-stream"]
            )!, cacheStoragePolicy: .notAllowed)
            Self.stream = self
            client?.urlProtocol(self, didLoad: Data(
                "event: stream-ready\ndata: {\"schemaVersion\":2,\"pushPayloads\":true,\"eventRecovery\":\"server-snapshot\"}\n\n".utf8
            ))
            return
        }
        let item: String
        if path.hasSuffix("/sessions") {
            item = #"{"schemaVersion":1,"items":[{"id":"session:recovered","title":"Recovered","executionStatus":"complete","updatedAt":"now"}],"hasMore":false,"nextCursor":null}"#
        } else {
            item = #"{"schemaVersion":1,"items":[],"hasMore":false,"nextCursor":null}"#
        }
        client?.urlProtocol(self, didReceive: HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(item.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
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
    func invalidateSession(sessionID: String) {
        client?.urlProtocol(self, didLoad: Data("event: invalidate\ndata: {\"schemaVersion\":1,\"inventory\":false,\"control\":false,\"sessions\":[\"\(sessionID)\"],\"allSessions\":false}\n\n".utf8))
    }
    func finishFromServer() { client?.urlProtocolDidFinishLoading(self) }
    override func stopLoading() {}
}
