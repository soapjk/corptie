import Foundation
import Testing
import CorptieClientCore
@testable import CorptiePadState

@MainActor
@Suite(.serialized)
struct PadReceiptReconciliationTests {
    private func fixture(_ requestID: String) throws -> (PadWorkspace, PadConnection, UserDefaults, String) {
        ReceiptProtocol.reset()
        let name = "corptie-receipt-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ReceiptProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://receipt.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.address = "https://receipt.invalid"
        connection.serverID = "server:a"
        connection.connected = true
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:a"
        workspace.pending = PendingCommand(requestID: requestID, sessionID: "session:a", kind: "conversation_command",
            serverID: connection.serverID, address: connection.address)
        return (workspace, connection, defaults, name)
    }

    @Test func pollsExistingReceiptUntilCompletedWithoutPostingOrTakingGlobalLock() async throws {
        let (workspace, connection, defaults, name) = try fixture("complete_test")
        defer { defaults.removePersistentDomain(forName: name); workspace.refreshWorker?.cancel() }
        workspace.messages = [ClientMessage(id: "history", text: "old")]
        workspace.drafts["session:a"] = "new draft after restart"
        connection.busy = true // unrelated activity must not drop this read
        await workspace.reconcileAutomatically(connection, delays: [.zero, .zero, .zero])
        #expect(ReceiptProtocol.count == 2)
        #expect(workspace.pending == nil)
        #expect(!workspace.automaticReconciliationActive)
        #expect(connection.busy)
        #expect(workspace.visibleMessages.map(\.id) == ["history", "command:result"])
        #expect(workspace.drafts["session:a"] == "new draft after restart")
    }

    @Test func unknownIsBoundedAndKeepsDurableIdentity() async throws {
        let (workspace, connection, defaults, name) = try fixture("unknown_test")
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(try JSONEncoder().encode(workspace.pending!), forKey: "pendingCommand")
        await workspace.reconcileAutomatically(connection, delays: [.zero, .zero, .zero])
        #expect(ReceiptProtocol.count == 3)
        #expect(workspace.pending?.requestID == "unknown_test")
        #expect(defaults.data(forKey: "pendingCommand") != nil)
        #expect(workspace.status.contains("停止自动核对"))
        #expect(!workspace.automaticReconciliationActive)
    }

    @Test(arguments: ["denied_test", "deniedhttp_test"])
    func authorityLossStopsReadsButDoesNotClaimNonDelivery(_ requestID: String) async throws {
        let (workspace, connection, defaults, name) = try fixture(requestID)
        defer { defaults.removePersistentDomain(forName: name) }
        await workspace.reconcileAutomatically(connection, delays: [.zero, .zero, .zero])
        #expect(ReceiptProtocol.count == 1)
        #expect(workspace.pending != nil)
        #expect(workspace.status.contains("权限"))
    }

    @Test func differentBackendAndCancellationDoNotQuery() async throws {
        let (workspace, connection, defaults, name) = try fixture("complete_test")
        defer { defaults.removePersistentDomain(forName: name) }
        connection.serverID = "server:b"
        await workspace.reconcileAutomatically(connection, delays: [.zero])
        #expect(ReceiptProtocol.count == 0)
        connection.serverID = "server:a"
        let worker = Task { await workspace.reconcileAutomatically(connection, delays: [.seconds(10)]) }
        await Task.yield()
        worker.cancel()
        await worker.value
        #expect(ReceiptProtocol.count == 0)
        #expect(workspace.pending != nil)
        #expect(!workspace.automaticReconciliationActive)
    }

    @Test func lateReceiptFromPreviousBackendCannotSettlePending() async throws {
        let (workspace, connection, defaults, name) = try fixture("delayed_test")
        defer { defaults.removePersistentDomain(forName: name) }
        let worker = Task { await workspace.reconcileAutomatically(connection, delays: [.zero]) }
        for _ in 0..<100 where ReceiptProtocol.count == 0 { try await Task.sleep(for: .milliseconds(1)) }
        #expect(ReceiptProtocol.count == 1)
        connection.address = "https://another.invalid"
        await worker.value
        #expect(workspace.pending != nil)
        #expect(workspace.visibleMessages.isEmpty)
        #expect(!workspace.automaticReconciliationActive)
    }
}

private final class ReceiptProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var reads = 0
    static var count: Int { lock.withLock { reads } }
    static func reset() { lock.withLock { reads = 0 } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        #expect(request.httpMethod == "GET")
        #expect(request.url!.path.hasPrefix("/client/v1/commands/"))
        let ordinal = Self.lock.withLock { Self.reads += 1; return Self.reads }
        let requestID = request.url!.lastPathComponent
        let denied = requestID.hasPrefix("denied")
        let status = requestID == "unknown_test" ? "unknown" : ordinal == 1 && requestID != "delayed_test" ? "dispatching" : "completed"
        let json: [String: Any] = denied ? (requestID == "deniedhttp_test" ? ["error": "Forbidden"] : ["code": "DEVICE_PERMISSION_REQUIRED"]) : [
            "schemaVersion": 1, "sessionId": "session:a", "requestId": requestID,
            "kind": "conversation_command", "status": status, "updatedAt": "now",
            "commandResult": ["text": "Goal 已设置", "truncated": false, "messageId": "command:result"]]
        let data = try! JSONSerialization.data(withJSONObject: json)
        let deliver: @Sendable () -> Void = { [self] in
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: denied ? 403 : 200,
                httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        }
        if requestID == "delayed_test" { DispatchQueue.global().asyncAfter(deadline: .now() + 0.1, execute: deliver) }
        else { deliver() }
    }
    override func stopLoading() {}
}
