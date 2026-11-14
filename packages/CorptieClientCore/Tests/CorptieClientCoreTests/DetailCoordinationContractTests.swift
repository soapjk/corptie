import Foundation
import Testing
@testable import CorptieClientCore

struct DetailCoordinationContractTests {
    static func document(parent: String? = "task:parent", target: String = "task:current") throws -> Data {
        let task: [String: Any] = ["taskId": "task:current", "parentTaskId": parent as Any? ?? NSNull(),
            "title": "Child", "status": "in_progress", "description": "", "acceptanceCriteria": "", "verificationCriteria": "",
            "resourceRevision": "1", "coordinationEnabled": false,
            "summary": ["state": "pending", "focus": "", "progress": "", "intervention": "none", "reason": "", "nextAction": "", "current": false]]
        let action: [String: Any] = ["id": "task-coordination-setting", "kind": "command", "operation": "task.coordination.update",
            "label": ["fallback": "协调模式"], "available": true, "target": ["resourceType": "task", "id": target], "expectedResourceRevision": "1"]
        return try JSONSerialization.data(withJSONObject: ["protocolVersion": 1, "catalog": "native-business-v1",
            "documentId": "detail:logical:current", "sessionId": "logical:current", "generation": "test", "revision": "1",
            "cards": [["id": "task-information", "kind": "taskInfo", "version": 1, "revision": "1", "loadState": "ready", "data": task, "actions": [action]]],
            "order": ["task-information"]])
    }
    @Test @MainActor func removedSessionInformationNeverReturnsFromSnapshotsOrOrdering() throws {
        var fields = try #require(JSONSerialization.jsonObject(with: Self.document()) as? [String: Any])
        var cards = try #require(fields["cards"] as? [[String: Any]])
        cards.insert(["id": "session-information", "kind": "sessionInfo", "version": 1,
            "revision": "1", "loadState": "ready", "actions": [],
            "data": ["sessionId": "logical:current", "workName": "Work"]], at: 0)
        fields["order"] = cards.map { $0["id"]! }
        let store = ClientDetailBusinessStore()
        for loadState in ["ready", "error"] {
            cards[0]["loadState"] = loadState
            fields["cards"] = cards
            let document = try ClientDetailBusinessDocument.decode(JSONSerialization.data(withJSONObject: fields))
            try store.receive(document)
            for kind in ["assistantChat", "workChat", "worker"] {
                let context = ClientDetailContext(sessionKind: kind, taskID: "task:current", workID: "work:current")
                #expect(!ClientDetailCardPolicy.isVisible(document.cards[0], context: context))
                #expect(!ClientDetailCardPolicy.orderedCards(in: store, context: context).contains { $0.card.kind == "sessionInfo" })
            }
            let taskContext = ClientDetailContext(sessionKind: "worker", taskID: "task:current", workID: "work:current")
            #expect(ClientDetailCardPolicy.orderedCards(in: store, context: taskContext).map(\.id) == ["task-information"])
            // Keep the transport contract intact; only the presentation directory changes.
            #expect(store.orderedCards.count == 2)
        }
    }

    @Test func hierarchyDoesNotInvalidateBoundCoordinationAction() throws {
        for parent in [nil, "task:root", "task:child"] as [String?] {
            let data = try Self.document(parent: parent)
            let document = try ClientDetailBusinessDocument.decode(data)
            #expect(document.cards.count == 1)
            #expect(document.cards[0].actions.first?.target?.id == "task:current")
            #expect(throws: ClientDetailFailure.invalidGraph) {
                try ClientDetailBusinessDocument.decode(Self.document(parent: parent, target: "task:other"))
            }
        }
    }
    @Test func bothRoutesDecodeTheSameSnapshotAndStream() async throws {
        let data = try Self.document()
        let url = URL(string: "http://127.0.0.1:1234")!
        for route in [ClientDetailAPI.Route.desktop, .pairedDevice] {
            let transport = BackendTransport(endpoint: try BackendEndpoint(url), data: { request in
                #expect(request.value(forHTTPHeaderField: "Accept")?.contains("native-business-v1") == true)
                return (data, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }, bytes: { _ in
                let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
                continuation.yield(Data("event: detail-snapshot\ndata: \(String(decoding: data, as: UTF8.self))\n\n".utf8))
                continuation.finish()
                return (BackendByteStream(chunks: stream), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
            })
            let api = ClientDetailAPI(transport: transport, route: route)
            let snapshot = try await api.businessSnapshot(sessionID: "logical:current")
            var received = 0
            for try await document in api.businessSubscribe(sessionID: "logical:current") {
                #expect(document == snapshot); received += 1
            }
            #expect(received == 1)
        }
    }
    @Test @MainActor func terminalFailureResumesOneFeedAndReleaseCancelsIt() async throws {
        let probe = DetailRecoveryProbe(valid: try Self.document(), invalid: try Self.document(target: "task:other"))
        let url = URL(string: "http://127.0.0.1:1234")!
        let transport = BackendTransport(endpoint: try BackendEndpoint(url), data: { _ in throw CancellationError() }, bytes: { _ in
            let stream = await probe.open()
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
        })
        let api = ClientDetailAPI(transport: transport, route: .desktop)
        let repository = ClientDetailBusinessRepository()
        let scope = ClientDetailBusinessScope(serverID: "test", ownerID: "owner", principalID: "user", sessionID: "logical:current", taskID: "task:current", workID: nil)
        let handle = repository.entry(for: scope)
        let first = repository.acquire(handle, api: { api })
        let second = repository.acquire(handle, api: { api })
        for _ in 0..<100 where handle.store.error == nil { try await Task.sleep(for: .milliseconds(10)) }
        #expect(handle.store.error?.contains("校验失败") == true)
        #expect(await probe.opens == 1)
        // Let the terminal producer finish before the explicit user retry.
        try await Task.sleep(for: .milliseconds(20))
        repository.resumeIfNeeded(handle, api: { api })
        repository.resumeIfNeeded(handle, api: { api })
        for _ in 0..<100 where !handle.store.isCurrent { try await Task.sleep(for: .milliseconds(10)) }
        #expect(handle.store.isCurrent)
        #expect(handle.store.error == nil)
        #expect(await probe.opens == 2)
        repository.release(first, from: handle)
        repository.release(second, from: handle)
        for _ in 0..<100 {
            if await probe.terminations >= 2 { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(await probe.terminations == 2)
        repository.invalidateAll()
    }
}

private actor DetailRecoveryProbe {
    let valid: Data, invalid: Data
    var opens = 0, terminations = 0
    init(valid: Data, invalid: Data) { self.valid = valid; self.invalid = invalid }
    func open() -> AsyncThrowingStream<Data, Error> {
        opens += 1
        let data = opens == 1 ? invalid : valid
        let pair = AsyncThrowingStream<Data, Error>.makeStream()
        pair.continuation.onTermination = { _ in Task { await self.terminated() } }
        pair.continuation.yield(Data("event: detail-snapshot\ndata: \(String(decoding: data, as: UTF8.self))\n\n".utf8))
        return pair.stream
    }
    func terminated() { terminations += 1 }
}
