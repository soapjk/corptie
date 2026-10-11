import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailTests {
    actor StreamProbe {
        var calls = 0
        var received = 0
        var closed = 0
        func receive() { received += 1 }
        func close() { closed += 1 }
        func open(request: URLRequest, fixture: Data) -> (BackendByteStream, HTTPURLResponse) {
            calls += 1
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            continuation.onTermination = { @Sendable _ in Task { await self.close() } }
            continuation.yield(Data("event: detail-snapshot\ndata: \(String(decoding: fixture, as: UTF8.self).replacingOccurrences(of: "\n", with: ""))\n\n".utf8))
            // The continuation stays alive through the producer's stream, until cancellation.
            continuations.append(continuation)
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
        }
        var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    }
    func fixture() throws -> Data {
        try Data(contentsOf: #require(Bundle.module.url(forResource: "detail-v1", withExtension: "json", subdirectory: "Fixtures")))
    }
    func altered(_ change: (inout [String: Any]) -> Void) throws -> ClientDetailDocument {
        var json = try #require(JSONSerialization.jsonObject(with: fixture()) as? [String: Any])
        change(&json)
        return try ClientDetailDocument.decode(JSONSerialization.data(withJSONObject: json))
    }
    @Test func sharedFixtureDecodesAndBinds() throws {
        let document = try ClientDetailDocument.decode(fixture())
        #expect(document.sessionId == "logical:sample")
        #expect(document.cards[0].value(for: document.cards[0].nodes[2]) == "Sample Work")
    }
    @Test func rejectsUnknownMajorAndDuplicateOrder() throws {
        #expect(throws: ClientDetailFailure.unsupportedSchema) { try altered { $0["schemaVersion"] = 2 } }
        #expect(throws: ClientDetailFailure.invalidGraph) { try altered { $0["order"] = ["session-info", "session-info"] } }
    }
    @Test func rejectsCyclesAndMissingReferences() throws {
        for children in [["root"], ["missing"]] {
            #expect(throws: ClientDetailFailure.invalidGraph) {
                try altered { json in
                    var cards = json["cards"] as! [[String: Any]]
                    var nodes = cards[0]["nodes"] as! [[String: Any]]
                    nodes[0]["children"] = children; cards[0]["nodes"] = nodes; json["cards"] = cards
                }
            }
        }
    }
    @Test func unknownNodeIsLocalFallbackNotDocumentFailure() throws {
        let document = try altered { json in
            var cards = json["cards"] as! [[String: Any]], nodes = cards[0]["nodes"] as! [[String: Any]]
            nodes[2]["kind"] = "future-widget"; nodes[2]["props"] = ["text": [1, 2, 3], "actionId": 9]
            cards[0]["nodes"] = nodes; json["cards"] = cards
        }
        #expect(document.cards[0].nodes[2].kind == "future-widget")
    }
    @MainActor @Test func conflictingSameRevisionCannotOverwriteValidCache() throws {
        let store = ClientDetailStore(), original = try ClientDetailDocument.decode(fixture())
        try store.apply(.snapshot(original))
        let changed = try altered { json in
            var cards = json["cards"] as! [[String: Any]]
            cards[0]["dataRevision"] = "changed"
            cards[0]["data"] = ["sessionId": "logical:sample", "workName": "Other"]
            json["cards"] = cards
        }
        #expect(throws: ClientDetailFailure.revisionConflict) { try store.apply(.snapshot(changed)) }
        #expect(store.orderedCards[0].card.data["workName"]?.text == "Sample Work")
    }
    @Test func cardVersionStampsMustCoverStructureAndData() throws {
        let original = try ClientDetailDocument.decode(fixture())
        for field in ["data", "title"] {
            let changed = try altered { json in
                json["revision"] = 2
                var cards = json["cards"] as! [[String: Any]]
                cards[0][field] = field == "data" ? ["workName": "Changed"] : ["fallback": "Changed"]
                json["cards"] = cards
            }
            #expect(throws: ClientDetailFailure.revisionConflict) { try original.accepting(changed) }
        }
    }
    @Test func cumulativePatchesCannotGrowPastDocumentLimit() throws {
        let original = try ClientDetailDocument.decode(fixture())
        var large = try #require(JSONSerialization.jsonObject(with: fixture()) as? [String: Any])
        large["revision"] = 2
        var cards = large["cards"] as! [[String: Any]]
        cards[0]["dataRevision"] = "large"
        cards[0]["data"] = ["text": String(repeating: "x", count: ClientDetailProtocol.maxDocumentBytes)]
        large["cards"] = cards
        let decoded = try JSONDecoder().decode(ClientDetailDocument.self, from: JSONSerialization.data(withJSONObject: large))
        let patch = ClientDetailPatch(documentId: original.documentId, sessionId: original.sessionId, generation: original.generation,
            baseRevision: 1, revision: 2, upsertCards: decoded.cards, removeCardIds: [], order: nil)
        #expect(throws: ClientDetailFailure.limit) { try original.applying(patch) }
    }
    @Test func schemaLimitsAndRootedTreeAreCheckedOnBothSides() throws {
        for change in [0, 1, 2] {
            #expect(throws: (any Error).self) {
                try altered { json in
                    if change == 0 { json["revision"] = 9_007_199_254_740_992; return }
                    var cards = json["cards"] as! [[String: Any]], nodes = cards[0]["nodes"] as! [[String: Any]]
                    if change == 1 { nodes.append(["id": "orphan", "kind": "text", "props": [:], "children": []]) }
                    else { nodes[1]["children"] = ["work"] }
                    cards[0]["nodes"] = nodes; json["cards"] = cards
                }
            }
        }
    }
    @Test func frozenActionRequestUsesServerResolvedTargets() throws {
        let url = try #require(Bundle.module.url(forResource: "detail-action-v1", withExtension: "json", subdirectory: "Fixtures"))
        let request = try JSONDecoder().decode(ClientDetailActionRequest.self, from: Data(contentsOf: url))
        try request.validate()
        #expect(request.expectedResourceRevision == "revision:7")
        #expect(request.fields["confirmed"]?.flag == true)
        let schemaURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("apps/backend/src/contracts/detail-v1.schema.json")
        let schema = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: schemaURL)) as? [String: Any])
        let definitions = schema["definitions"] as! [String: [String: Any]]
        let actionProperties = definitions["ActionRequest"]!["properties"] as! [String: Any]
        let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as! [String: Any]
        #expect(Set(encoded.keys).isSubset(of: Set(actionProperties.keys)))
        #expect(definitions["ActionRequest"]?["additionalProperties"] as? Bool == false)
    }
    @MainActor @Test func snapshotsRemoveMembersAndPreserveUnchangedCardState() throws {
        let store = ClientDetailStore(), document = try ClientDetailDocument.decode(fixture())
        try store.apply(.snapshot(document))
        let card = try #require(store.orderedCards.first); card.expandedNodes.insert("root")
        try store.apply(.snapshot(document))
        #expect(store.orderedCards.first === card)
        #expect(card.expandedNodes.contains("root"))
        let removed = try altered { $0["cards"] = []; $0["order"] = []; $0["revision"] = 2 }
        try store.apply(.snapshot(removed)); #expect(store.orderedCards.isEmpty)
    }
    @MainActor @Test func patchesAreAtomicGapAndScopeChecked() throws {
        let store = ClientDetailStore(), document = try ClientDetailDocument.decode(fixture())
        try store.apply(.snapshot(document))
        func patch(base: Int, generation: String = "fixture-generation") -> ClientDetailPatch {
            .init(documentId: document.documentId, sessionId: document.sessionId, generation: generation,
                  baseRevision: base, revision: 2, upsertCards: [], removeCardIds: ["session-info"], order: [])
        }
        #expect(throws: ClientDetailFailure.revisionGap) { try store.apply(.patch(patch(base: 9))) }
        #expect(throws: ClientDetailFailure.wrongScope) { try store.apply(.patch(patch(base: 1, generation: "other"))) }
        #expect(store.orderedCards.count == 1)
        try store.apply(.patch(patch(base: 1))); #expect(store.orderedCards.isEmpty)
        try store.apply(.patch(patch(base: 1))); #expect(store.orderedCards.isEmpty)
    }
    @MainActor @Test func wrongSessionSnapshotDoesNotReplaceCache() throws {
        let store = ClientDetailStore(), document = try ClientDetailDocument.decode(fixture())
        try store.apply(.snapshot(document))
        #expect(throws: ClientDetailFailure.wrongScope) { try store.apply(.snapshot(document), expectedSessionID: "other") }
        #expect(store.orderedCards.count == 1)
    }
    @Test func boundedDocumentRefusesOversizedBody() {
        #expect(throws: ClientDetailFailure.limit) { try ClientDetailDocument.decode(Data(repeating: 32, count: 262145)) }
    }
    @Test func snapshotUsesRelayCompatibleNegotiationAndCorrectFacade() async throws {
        let data = try fixture()
        for (route, expected) in [(ClientDetailAPI.Route.desktop, "/sessions/s/detail"), (.pairedDevice, "/client/v1/sessions/s/detail")] {
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { request in
                #expect(request.url?.path == expected)
                #expect(request.value(forHTTPHeaderField: "Accept") == "application/json; corptie-detail=native-v1")
                return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
            }, bytes: { _ in throw ClientConnectionError.invalidResponse })
            let document = try await ClientDetailAPI(transport: transport, route: route).snapshot(sessionID: "s")
            #expect(document == (try ClientDetailDocument.decode(data)))
        }
    }
    @Test func multipleWindowsShareSubscriptionAndLastCancellationClosesIt() async throws {
        let data = try fixture(), probe = StreamProbe(), pool = ClientDetailSubscriptionPool()
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
            data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in
                if request.value(forHTTPHeaderField: "Accept") == "text/event-stream; corptie-detail=native-v2" {
                    throw ClientServiceFailure(statusCode: 409, code: "DETAIL_CATALOG_UNSUPPORTED")
                }
                #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream; corptie-detail=native-v1")
                return await probe.open(request: request, fixture: data)
            })
        func consumer() -> Task<Void, Never> {
            Task {
                let stream = await pool.subscribe(scope: "user:server:session", sessionID: "s", api: {
                    ClientDetailAPI(transport: transport, route: .desktop)
                })
                do { for try await _ in stream { await probe.receive() } } catch { }
            }
        }
        let first = consumer()
        for _ in 0..<100 { if await probe.received >= 1 { break }; try await Task.sleep(for: .milliseconds(5)) }
        let second = consumer()
        for _ in 0..<100 { if await probe.received >= 2 { break }; try await Task.sleep(for: .milliseconds(5)) }
        #expect(await probe.received == 2)
        #expect(await probe.calls == 1)
        first.cancel(); await first.value
        #expect(await probe.closed == 0)
        second.cancel(); await second.value
        for _ in 0..<100 { if await probe.closed >= 1 { break }; try await Task.sleep(for: .milliseconds(5)) }
        #expect(await probe.closed == 1)
    }
}
