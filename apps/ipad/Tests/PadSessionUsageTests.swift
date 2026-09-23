import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

/// The status row's usage is a bounded read: once per applied timeline window,
/// never on a timer, and a host without a usage reader clears it instead of failing.
@MainActor
@Suite(.serialized)
struct PadSessionUsageTests {
    private func fixture() throws -> (PadWorkspace, ClientSessionAPI) {
        UsageProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [UsageProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://usage.invalid")!),
            bearerToken: "fixture", configuration: config)
        let workspace = PadWorkspace(defaults: UserDefaults(suiteName: "corptie-usage-tests-\(UUID().uuidString)")!)
        workspace.selection = "session:a"
        return (workspace, ClientSessionAPI(transport: transport))
    }

    @Test func usageIsReadOncePerTimelineRevision() async throws {
        let (workspace, api) = try fixture()
        let generation = workspace.timelineGeneration
        await workspace.loadUsage(api, sessionID: "session:a", routedID: "session:a", generation: generation)
        #expect(UsageProtocol.count == 1)
        #expect(workspace.usage?.context?.usedTokens == 10)
        #expect(workspace.usage?.account?.rateLimits?.primary?.usedPercent == 25)

        await workspace.loadUsage(api, sessionID: "session:a", routedID: "session:a", generation: generation)
        #expect(UsageProtocol.count == 1, "unchanged timeline must not re-read usage")

        workspace.applyLatestWindow([ClientMessage(id: "m1", text: "hi")], cursor: nil, revision: 2)
        await workspace.loadUsage(api, sessionID: "session:a", routedID: "session:a", generation: generation)
        #expect(UsageProtocol.count == 2)
    }

    @Test func staleSelectionOrGenerationDropsTheSnapshotAndUnsupportedHostsClearIt() async throws {
        let (workspace, api) = try fixture()
        let generation = workspace.timelineGeneration
        workspace.selection = "session:other"
        await workspace.loadUsage(api, sessionID: "session:a", routedID: "session:a", generation: generation)
        #expect(workspace.usage == nil)

        workspace.selection = "session:a"
        workspace.clearSelectionState()
        await workspace.loadUsage(api, sessionID: "session:a", routedID: "session:a", generation: workspace.timelineGeneration)
        #expect(workspace.usage != nil)
        workspace.applyLatestWindow([ClientMessage(id: "m2", text: "x")], cursor: nil, revision: 3)
        UsageProtocol.unsupported = true
        await workspace.loadUsage(api, sessionID: "session:a", routedID: "session:a", generation: workspace.timelineGeneration)
        #expect(workspace.usage == nil)
        let reads = UsageProtocol.count
        await workspace.loadUsage(api, sessionID: "session:a", routedID: "session:a", generation: workspace.timelineGeneration)
        #expect(UsageProtocol.count == reads, "a 409 is remembered for this revision")
        workspace.clearSelectionState()
        #expect(workspace.usage == nil)
    }
}

private final class UsageProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var reads = 0
    nonisolated(unsafe) private static var rejects = false
    static var count: Int { lock.withLock { reads } }
    static var unsupported: Bool {
        get { lock.withLock { rejects } }
        set { lock.withLock { rejects = newValue } }
    }
    static func reset() { lock.withLock { reads = 0; rejects = false } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.httpMethod == "GET")
        #expect(request.url!.path == "/client/v1/sessions/session:a/usage")
        let unsupported = Self.lock.withLock { Self.reads += 1; return Self.rejects }
        let json = unsupported
            ? #"{"code":"CAPABILITY_UNSUPPORTED"}"#
            : #"{"schemaVersion":1,"sessionId":"session:a","context":{"usedTokens":10,"contextWindow":100,"remainingTokens":90,"usedPercent":10},"account":{"available":true,"provider":"codex","model":"gpt-5","rateLimits":{"limitId":"codex","limitName":"Codex","primary":{"usedPercent":25,"windowDurationMins":300,"resetsAt":1700000000}},"rateLimitsByLimitId":null}}"#
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: unsupported ? 409 : 200,
            httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
