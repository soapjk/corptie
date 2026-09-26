import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

/// Work / Task management commands: one persisted request id, no replay, receipt-driven outcome.
@MainActor @Suite(.serialized)
struct PadEntityCommandTests {
    private func fixture() throws -> (PadEntityCommandState, PadConnection, UserDefaults, String) {
        EntityProtocol.reset()
        let name = "pad-entity-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EntityProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://entity.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.serverID = "server:a"; connection.address = "https://entity.invalid"
        return (PadEntityCommandState(connection: connection, defaults: defaults), connection, defaults, name)
    }

    private func archive(_ state: PadEntityCommandState, _ connection: PadConnection) async -> ClientCommandReceipt? {
        await state.run(connection, target: .task("task:a"), kind: "task_archive", label: "归档 Task") { api, requestID in
            try await api.taskCommand(taskId: "task:a", command: .archive, body: ClientTaskArchive(requestId: requestID, archived: true))
        }
    }

    @Test func completedReceiptClearsPendingAndReportsTheEntityResult() async throws {
        let (state, connection, defaults, name) = try fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        async let first = archive(state, connection)
        async let second = archive(state, connection)
        let receipts = await (first, second)
        #expect(EntityProtocol.posts == 1, "a busy state never dispatches a second command")
        #expect([receipts.0, receipts.1].compactMap { $0 }.count == 1)
        #expect(state.pending == nil && !state.isBusy)
        #expect(state.outcome?.status == "completed")
        #expect(state.outcome?.result?.archived == true)
        #expect(state.notice == "归档 Task已完成。")
        #expect(EntityProtocol.lastPath == "/client/v1/tasks/task:a/archive")
        #expect(PadEntityCommandState(connection: connection, defaults: defaults).pending == nil)
    }

    @Test func preDispatchRejectionReleasesTheStateWithoutARecord() async throws {
        let (state, connection, defaults, name) = try fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        EntityProtocol.mode = "forbidden"
        let receipt = await archive(state, connection)
        #expect(receipt == nil && state.pending == nil && !state.isBusy)
        #expect(state.notice.contains("凭据"))
        #expect(PadEntityCommandState(connection: connection, defaults: defaults).pending == nil)
        EntityProtocol.mode = "completed"
        _ = await archive(state, connection)
        #expect(EntityProtocol.posts == 2, "a definite pre-dispatch rejection allows a fresh request")
    }

    @Test func rejectedReceiptIsFinalAndExplained() async throws {
        let (state, connection, defaults, name) = try fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        EntityProtocol.mode = "busy"
        let receipt = await archive(state, connection)
        #expect(receipt?.status == "rejected")
        #expect(state.pending == nil)
        #expect(state.outcome?.errorCode == "TASK_ARCHIVE_BUSY")
        #expect(state.notice == "请先停止 Task 执行，再归档。")
    }

    @Test func transportFailureKeepsThePendingRequestAndReconcileNeverReposts() async throws {
        let (state, connection, defaults, name) = try fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        EntityProtocol.mode = "drop"
        let receipt = await archive(state, connection)
        #expect(receipt == nil)
        let pending = try #require(state.pending)
        #expect(state.isBusy && state.notice.contains("不会重复执行"))
        #expect(EntityProtocol.posts == 1)

        // A second attempt while unresolved is refused locally.
        _ = await archive(state, connection)
        #expect(EntityProtocol.posts == 1)

        // Restart the app: the record survives and reconciliation only reads the receipt.
        let restored = PadEntityCommandState(connection: connection, defaults: defaults)
        #expect(restored.pending == pending)
        EntityProtocol.mode = "dispatching"
        await restored.reconcile(connection)
        #expect(restored.pending == pending, "dispatching keeps the request open")
        #expect(EntityProtocol.reads == 1 && EntityProtocol.posts == 1)
        #expect(EntityProtocol.lastPath == "/client/v1/commands/\(pending.requestID)")
        EntityProtocol.mode = "completed"
        await restored.reconcile(connection)
        #expect(restored.pending == nil && restored.outcome?.status == "completed")
        #expect(EntityProtocol.posts == 1, "reconciliation never re-sends the command")
    }

    @Test func unknownReceiptIsFinalAndDeniedReconciliationIsFlagged() async throws {
        let (state, connection, defaults, name) = try fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        EntityProtocol.mode = "drop"
        _ = await archive(state, connection)
        #expect(state.pending != nil)
        EntityProtocol.mode = "forbidden"
        await state.reconcile(connection)
        #expect(state.reconciliationDenied && state.pending != nil)
        EntityProtocol.mode = "unknown"
        await state.reconcile(connection)
        #expect(!state.reconciliationDenied)
        #expect(state.pending == nil && state.outcome?.status == "unknown")
        #expect(state.notice.contains("未重复执行"))
        #expect(EntityProtocol.posts == 1)
    }

    @Test func otherConnectionsAreIgnored() async throws {
        let (state, connection, defaults, name) = try fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        let other = PadConnection(transportOverride: try await connection.transport())
        other.serverID = "server:b"; other.address = connection.address
        #expect(!state.matches(other))
        _ = await state.run(other, target: .work("work:a"), kind: "work_delete", label: "删除 Work") { api, requestID in
            try await api.workCommand(workId: "work:a", command: .delete, body: ClientEntityRequest(requestId: requestID))
        }
        #expect(EntityProtocol.posts == 0 && state.pending == nil)
    }
}

private final class EntityProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var modeValue = "completed"
    nonisolated(unsafe) private static var postCount = 0
    nonisolated(unsafe) private static var readCount = 0
    nonisolated(unsafe) private static var requestID = ""
    nonisolated(unsafe) private static var path = ""
    static var mode: String { get { lock.withLock { modeValue } } set { lock.withLock { modeValue = newValue } } }
    static var posts: Int { lock.withLock { postCount } }
    static var reads: Int { lock.withLock { readCount } }
    static var lastPath: String { lock.withLock { path } }
    static func reset() { lock.withLock { modeValue = "completed"; postCount = 0; readCount = 0; requestID = ""; path = "" } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        Self.lock.withLock { Self.path = path }
        if request.httpMethod == "POST" {
            var data = request.httpBody ?? Data()
            if let stream = request.httpBodyStream {
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let count = stream.read(&buffer, maxLength: buffer.count); if count <= 0 { break }; data.append(contentsOf: buffer.prefix(count)) }
            }
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            Self.lock.withLock { Self.postCount += 1; Self.requestID = body?["requestId"] as? String ?? "" }
        } else { Self.lock.withLock { Self.readCount += 1 } }
        let mode = Self.mode
        switch mode {
        case "forbidden": respond(401, ["code": "INVALID_CREDENTIAL"])
        case "drop":
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
        default:
            let id = Self.lock.withLock { Self.requestID }
            let status = mode == "busy" ? "rejected" : mode
            var value: [String: Any] = ["schemaVersion": 1, "requestId": id, "sessionId": "", "kind": "task_archive",
                "status": status, "updatedAt": "now"]
            if mode == "busy" { value["errorCode"] = "TASK_ARCHIVE_BUSY" }
            if mode == "completed" { value["entityResult"] = ["taskId": "task:a", "archived": true] }
            respond(200, value)
        }
    }
    private func respond(_ status: Int, _ value: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: value)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
