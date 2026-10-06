import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@MainActor struct PadStopCapabilityTests {
    private func session(_ id: String, status: String) throws -> ClientSession {
        let data = try JSONSerialization.data(withJSONObject: ["id": id, "title": id,
            "executionStatus": status, "updatedAt": "now"])
        return try JSONDecoder().decode(ClientSession.self, from: data)
    }

    private func fixture(_ probe: StopCapabilityProbe) throws -> (PadConnection, PadWorkspace) {
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { request in try await probe.handle(request) }, bytes: { _ in throw URLError(.cancelled) })
        let connection = PadConnection(transportOverride: transport)
        connection.connected = true
        let workspace = PadWorkspace()
        workspace.selection = "selected"
        workspace.sessions = [try session("selected", status: "running")]
        workspace.sessionsByID = ["selected": workspace.sessions[0]]
        return (connection, workspace)
    }

    @Test func cachedTimelineDoesNotSkipCapabilityOnlyRefresh() async throws {
        let probe = StopCapabilityProbe()
        let (connection, workspace) = try fixture(probe)
        workspace.messages = [ClientMessage(id: "cached", text: "cached")]
        workspace.lastTimelineRevision = 8
        #expect(workspace.selectedTimelineReady)
        #expect(workspace.selectedSessionIsRunning)
        #expect(!workspace.stopControlEnabled(connection))
        #expect(workspace.stopControlReason(connection) == nil)
        await workspace.refreshSelectedCapabilities(connection)
        #expect(workspace.stopControlEnabled(connection))
        #expect(workspace.messages.first?.id == "cached")
        #expect(await probe.paths.count == 1)
        #expect(await probe.paths.first?.hasSuffix("/capabilities") == true)
        await workspace.refreshSelectedCapabilities(connection)
        #expect(await probe.paths.count == 1)
    }

    @Test func repeatedRefreshesCoalesceAndReconnectRevalidates() async throws {
        let probe = StopCapabilityProbe(delay: true)
        let (connection, workspace) = try fixture(probe)
        async let first: Void = workspace.refreshSelectedCapabilities(connection)
        async let second: Void = workspace.refreshSelectedCapabilities(connection)
        _ = await (first, second)
        #expect(await probe.paths.count == 1)
        connection.recoveryRevision += 1
        #expect(!workspace.stopControlEnabled(connection))
        await workspace.refreshSelectedCapabilities(connection)
        #expect(await probe.paths.count == 2)
        #expect(workspace.stopControlEnabled(connection))
    }

    @Test func verificationInFlightIsSilentAndStillDisablesStop() async throws {
        let probe = StopCapabilityProbe(delay: true)
        let (connection, workspace) = try fixture(probe)
        let refresh = Task { await workspace.refreshSelectedCapabilities(connection) }
        while await probe.paths.isEmpty { await Task.yield() }
        #expect(workspace.refreshingCapabilities)
        #expect(workspace.stopControlReason(connection) == nil)
        #expect(!workspace.stopControlEnabled(connection))
        await refresh.value
        #expect(workspace.stopControlEnabled(connection))
        #expect(workspace.stopControlReason(connection) == nil)
    }

    @Test func oldSelectionResponseCannotOverwriteNewSession() async throws {
        let probe = StopCapabilityProbe(delay: true)
        let (connection, workspace) = try fixture(probe)
        let old = Task { await workspace.refreshSelectedCapabilities(connection) }
        while await probe.paths.isEmpty { await Task.yield() }
        workspace.selection = "new"
        workspace.sessions = [try session("new", status: "running")]
        workspace.sessionsByID = ["new": workspace.sessions[0]]
        await workspace.refreshSelectedCapabilities(connection)
        await old.value
        #expect(workspace.capabilities?.sessionId == "new")
        #expect(workspace.stopControlEnabled(connection))
        #expect(!workspace.refreshingCapabilities)
    }

    @Test func denialAndFailureRemainVisibleButCannotExecute() async throws {
        for failure in [false, true] {
            let probe = StopCapabilityProbe(denied: true, failure: failure)
            let (connection, workspace) = try fixture(probe)
            await workspace.refreshSelectedCapabilities(connection)
            #expect(workspace.selectedSessionIsRunning)
            #expect(!workspace.stopControlEnabled(connection))
            #expect(workspace.stopControlReason(connection) == (failure
                ? "停止能力确认失败，请重新连接后重试" : "not_supported"))
            #expect(!workspace.refreshingCapabilities)
            await workspace.command(connection, stop: true)
            #expect(await probe.paths.count == 1)
        }
    }

    @Test func taskFallbackNeverEnablesStopForAnotherSession() throws {
        let workspace = PadWorkspace()
        workspace.selection = "history"
        let data = Data(#"{"id":"task","title":"task","workId":"work","lifecycleState":"active","executionStatus":"running","currentSessionId":"current","updatedAt":"now"}"#.utf8)
        workspace.tasks = [try JSONDecoder().decode(ClientTask.self, from: data)]
        #expect(!workspace.selectedSessionIsRunning)
        workspace.selection = "current"
        #expect(workspace.selectedSessionIsRunning)
        workspace.sessions = [try session("current", status: "completed")]
        workspace.sessionsByID = ["current": workspace.sessions[0]]
        #expect(!workspace.selectedSessionIsRunning)
    }

    @Test func genericBusyDoesNotBlockStopButSubmissionDoes() async throws {
        let probe = StopCapabilityProbe()
        let (connection, workspace) = try fixture(probe)
        await workspace.refreshSelectedCapabilities(connection)
        connection.busy = true
        #expect(workspace.stopControlEnabled(connection))
        var executed = false
        await connection.perform(independent: true) { executed = true }
        #expect(executed)
        #expect(connection.busy)
        workspace.stopSubmissionInFlight = true
        #expect(!workspace.stopControlEnabled(connection))
        #expect(workspace.stopControlReason(connection) == "正在提交停止请求")
    }

    @Test func enteringRunningStateRequiresFreshCapabilitiesWithoutReloadingMessages() async throws {
        let probe = StopCapabilityProbe()
        let (connection, workspace) = try fixture(probe)
        workspace.sessionsByID["selected"] = try session("selected", status: "idle")
        await workspace.refreshSelectedCapabilities(connection)
        #expect(!workspace.selectedSessionIsRunning)
        workspace.sessionsByID["selected"] = try session("selected", status: "running")
        #expect(workspace.selectedSessionIsRunning)
        #expect(!workspace.stopControlEnabled(connection))
        await workspace.refreshSelectedCapabilities(connection)
        #expect(workspace.stopControlEnabled(connection))
        #expect(await probe.paths.count == 2)
        #expect(await probe.paths.allSatisfy { $0.hasSuffix("/capabilities") })
    }
}

private actor StopCapabilityProbe {
    var paths: [String] = []
    let delay: Bool
    let denied: Bool
    let failure: Bool
    init(delay: Bool = false, denied: Bool = false, failure: Bool = false) {
        self.delay = delay; self.denied = denied; self.failure = failure
    }
    func handle(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url!.path
        paths.append(path)
        if delay { try await Task.sleep(for: .milliseconds(50)) }
        if failure { throw URLError(.timedOut) }
        let id = request.url!.pathComponents.dropLast().last!
        let body = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1,
            "sessionId": id, "readMessages": true, "send": ["available": true],
            "stop": ["available": !denied, "reason": "not_supported"]])
        return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}
