import Foundation
import Testing
import CorptieClientCore
@testable import CorptiePadState

@MainActor @Suite(.serialized)
struct PadTaskCreationTests {
    private func fixture() async throws -> (PadTaskCreationState, PadConnection, UserDefaults, String) {
        CreationProtocol.reset()
        let name = "pad-task-create-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CreationProtocol.self]
        let transport = try BackendTransport(endpoint: BackendEndpoint(URL(string: "https://creation.invalid")!),
            bearerToken: "fixture", configuration: config)
        let connection = PadConnection(transportOverride: transport)
        connection.serverID = "server:a"; connection.address = "https://creation.invalid"
        let state = PadTaskCreationState(workID: "work:a", sourceSessionID: "session:a", connection: connection, defaults: defaults)
        state.draft.title = "Task"
        await state.loadOptions(connection)
        await state.loadOptions(connection)
        #expect(state.canSubmit)
        return (state, connection, defaults, name)
    }

    @Test func completedCreationIsDurableAndDoesNotSubmitTwice() async throws {
        let (state, connection, defaults, name) = try await fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        async let first: Void = state.submit(connection)
        async let second: Void = state.submit(connection)
        _ = await (first, second)
        #expect(CreationProtocol.posts == 1)
        #expect(state.result?.sessionId == "session:new")
        #expect(state.draft.title == "Task")
        let restored = PadTaskCreationState(workID: "work:a", sourceSessionID: "session:other", connection: connection, defaults: defaults)
        #expect(restored.result?.taskId == "task:new")
        await restored.submit(connection)
        #expect(CreationProtocol.posts == 1)
        restored.startAnother()
        #expect(restored.pending == nil && restored.result == nil)
    }

    @Test func uncertainResultSurvivesRestartAndOnlyQueriesOriginalRequest() async throws {
        let (state, connection, defaults, name) = try await fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        CreationProtocol.mode = "unknown"
        await state.submit(connection)
        let requestID = try #require(state.pending?.input.requestId)
        let restored = PadTaskCreationState(workID: "work:a", sourceSessionID: "session:other", connection: connection, defaults: defaults)
        #expect(restored.pending?.sourceSessionID == "session:a")
        #expect(restored.pending?.input.requestId == requestID)
        await restored.submit(connection)
        #expect(CreationProtocol.posts == 1)
        CreationProtocol.mode = "completed"
        await restored.reconcile(connection)
        #expect(restored.result?.taskId == "task:new")
        #expect(CreationProtocol.posts == 1)
        #expect(CreationProtocol.reads == 1)
    }

    @Test func mismatchedReceiptAndRevokedReadsNeverClearPendingOrReplay() async throws {
        let (state, connection, defaults, name) = try await fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        CreationProtocol.mode = "unknown"
        await state.submit(connection)
        let requestID = state.pending?.input.requestId
        CreationProtocol.mode = "mismatch"
        await state.reconcile(connection)
        #expect(state.result == nil)
        #expect(state.pending?.input.requestId == requestID)
        CreationProtocol.mode = "rejected"
        await state.reconcile(connection)
        #expect(state.reconciliationDenied)
        #expect(state.pending?.input.requestId == requestID)
        #expect(CreationProtocol.posts == 1)
    }

    @Test func formValidationAndDraftPersistenceDoNotNeedARequest() async throws {
        let (state, connection, defaults, name) = try await fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        state.draft.title = "invalid title"
        #expect(!state.canSubmit)
        state.draft.title = "修复任务"
        state.draft.model = "not-in-catalog"
        #expect(!state.canSubmit)
        state.draft.model = ""
        state.draft.description = "保留描述"
        state.flush()
        let restored = PadTaskCreationState(workID: "work:a", sourceSessionID: "session:a", connection: connection, defaults: defaults)
        #expect(restored.draft.title == "修复任务")
        #expect(restored.draft.description == "保留描述")
        #expect(CreationProtocol.posts == 0)
    }

    @Test func explicitRejectionKeepsDraftAndDifferentBackendCannotSubmitOrRead() async throws {
        let (state, connection, defaults, name) = try await fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        CreationProtocol.mode = "rejected"
        await state.submit(connection)
        #expect(state.pending == nil)
        #expect(state.draft.title == "Task")
        connection.serverID = "server:b"
        await state.submit(connection)
        await state.reconcile(connection)
        #expect(CreationProtocol.posts == 1 && CreationProtocol.reads == 0)
        let other = PadTaskCreationState(workID: "work:a", sourceSessionID: "session:a", connection: connection, defaults: defaults)
        #expect(other.draft.title.isEmpty)
    }

    @Test func lateCompletionOnOtherBackendDoesNotChangeUIAndCanBeReconciledLater() async throws {
        let (state, connection, defaults, name) = try await fixture()
        defer { defaults.removePersistentDomain(forName: name) }
        CreationProtocol.mode = "delayed"
        let submission = Task { await state.submit(connection) }
        while CreationProtocol.posts == 0 { await Task.yield() }
        connection.serverID = "server:b"
        await submission.value
        #expect(state.result == nil)
        #expect(state.pending != nil)
        connection.serverID = "server:a"
        CreationProtocol.mode = "completed"
        await state.reconcile(connection)
        #expect(state.result?.taskId == "task:new")
        #expect(CreationProtocol.posts == 1)
    }
}

private final class CreationProtocol: URLProtocol, @unchecked Sendable {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var modeValue = "completed"
    nonisolated(unsafe) private static var postCount = 0
    nonisolated(unsafe) private static var readCount = 0
    nonisolated(unsafe) private static var requestID = ""
    static var mode: String { get { lock.withLock { modeValue } } set { lock.withLock { modeValue = newValue } } }
    static var posts: Int { lock.withLock { postCount } }
    static var reads: Int { lock.withLock { readCount } }
    static func reset() { lock.withLock { modeValue = "completed"; postCount = 0; readCount = 0; requestID = "" } }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let path = request.url!.path
        if request.httpMethod == "GET", path.hasSuffix("/tasks") {
            let provider = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first?.value
            respond(200, ["schemaVersion": 1, "sourceSessionId": "session:a", "work": ["id": "work:a", "name": "Work"],
                "agents": [["id": "agent:a", "name": "Agent"]], "providers": [["id": "provider:a", "name": "Provider", "available": true, "supportsModels": true]],
                "defaultProviderId": "provider:a", "providerId": provider as Any? ?? NSNull(), "models": [], "priorities": ["medium"]])
            return
        }
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
        if mode == "rejected" { respond(403, ["code": "DEVICE_PERMISSION_REQUIRED"]); return }
        let reply: @Sendable () -> Void = { [self] in
            let id = mode == "mismatch" ? "other-request" : Self.lock.withLock { Self.requestID }
            respond(200, ["schemaVersion": 1, "requestId": id, "sessionId": "session:a", "kind": "create_task",
                "status": mode == "unknown" ? "unknown" : "completed", "updatedAt": "now",
                "taskResult": ["taskId": "task:new", "sessionId": "session:new", "workId": "work:a"]])
        }
        if mode == "delayed" { DispatchQueue.global().asyncAfter(deadline: .now() + 0.15, execute: reply) }
        else { reply() }
    }
    private func respond(_ status: Int, _ value: [String: Any]) {
        let data = try! JSONSerialization.data(withJSONObject: value)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
