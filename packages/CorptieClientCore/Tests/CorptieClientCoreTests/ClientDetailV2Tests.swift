import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailV2Tests {
    actor PoolProbe {
        var requests: [ClientInspectorValue] = []
        var closed = 0
        var received = 0
        var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
        func receive() { received += 1 }
        func close() { closed += 1 }
        func open(_ request: URLRequest, snapshot: Data, corruptFirst: Bool) throws -> (BackendByteStream, HTTPURLResponse) {
            let body = try ClientDetailV2JSON.decode(#require(request.httpBody)); requests.append(body)
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            continuation.onTermination = { @Sendable _ in Task { await self.close() } }
            let text = String(decoding: snapshot, as: UTF8.self)
            if requests.count == 1 {
                continuation.yield(Data("event: detail-snapshot\ndata: \(text)\n\n".utf8))
                if corruptFirst {
                    continuation.yield(Data("event: detail-commit\ndata: {\"protocolVersion\":2}\n\n".utf8))
                    continuation.finish()
                } else { continuation.finish(throwing: URLError(.networkConnectionLost)) }
            } else if body["resume"] != .null {
                let value = try ClientDetailV2JSON.decode(snapshot)
                let keys = ["protocolVersion", "documentId", "sessionId", "generation", "revision", "stateHash"]
                let ready = try ClientDetailV2Canonical.encode(.object(Dictionary(uniqueKeysWithValues: keys.map { ($0, value[$0]) })))
                continuation.yield(Data("event: detail-ready\ndata: \(ready)\n\n".utf8))
                continuations.append(continuation)
            } else {
                continuation.yield(Data("event: detail-snapshot\ndata: \(text)\n\n".utf8)); continuations.append(continuation)
            }
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200,
                httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
        }
    }
    @Test func pooledV2ReconnectResumesAndWindowsShareOneProducer() async throws {
        let fixture = try fixture(), snapshot = try JSONEncoder().encode(fixture.snapshot), probe = PoolProbe()
        let pool = ClientDetailSubscriptionPool(retryDelay: { _ in await Task.yield() })
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
            data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in
                try await probe.open(request, snapshot: snapshot, corruptFirst: false)
            })
        func consumer() -> Task<Void, Never> {
            Task {
                do {
                    for try await _ in await pool.subscribe(scope: "account:server:s", sessionID: "s", api: { ClientDetailAPI(transport: transport, route: .desktop) }) {
                        await probe.receive()
                    }
                } catch { }
            }
        }
        let first = consumer()
        for _ in 0..<100 { if await probe.requests.count >= 2 { break }; try await Task.sleep(for: .milliseconds(5)) }
        #expect(await probe.requests.count == 2)
        #expect(await probe.requests[1]["resume"]["revision"].number == Double(fixture.snapshot.revision))
        #expect(await probe.requests[1]["cachedTemplateHashes"].items.count == fixture.snapshot.templates.count)
        let second = consumer()
        for _ in 0..<100 { if await probe.received >= 2 { break }; try await Task.sleep(for: .milliseconds(5)) }
        #expect(await probe.received == 2) // ready does not invalidate UI
        #expect(await probe.requests.count == 2)
        first.cancel(); await first.value
        #expect(await probe.closed == 1)
        second.cancel(); await second.value
        for _ in 0..<100 { if await probe.closed >= 2 { break }; try await Task.sleep(for: .milliseconds(5)) }
        #expect(await probe.closed == 2)
    }
    @Test func corruptCommitRequestsFullBaselineWithoutPublishingBrokenUI() async throws {
        let fixture = try fixture(), snapshot = try JSONEncoder().encode(fixture.snapshot), probe = PoolProbe()
        let pool = ClientDetailSubscriptionPool(retryDelay: { _ in await Task.yield() })
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
            data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in
                try await probe.open(request, snapshot: snapshot, corruptFirst: true)
            })
        let consumer = Task {
            do { for try await event in await pool.subscribe(scope: "repair", sessionID: "s", api: { ClientDetailAPI(transport: transport, route: .desktop) }) {
                if case .snapshot(let document) = event { #expect(document.cards.count == fixture.snapshot.instances.count) }
                await probe.receive()
            } } catch { Issue.record("repair failed: \(error)") }
        }
        for _ in 0..<100 { if await probe.requests.count >= 2 { break }; try await Task.sleep(for: .milliseconds(5)) }
        #expect(await probe.requests.count == 2)
        #expect(await probe.requests[1]["resume"] == .null)
        consumer.cancel(); await consumer.value
    }
    @Test func permissionErrorsNeverFallbackToLegacy() async throws {
        let pool = ClientDetailSubscriptionPool(retryDelay: { _ in await Task.yield() })
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
            data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in
                #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream; corptie-detail=native-v2")
                throw ClientServiceFailure(statusCode: 403, code: "DEVICE_REVOKED")
            })
        do {
            for try await _ in await pool.subscribe(scope: "revoked", sessionID: "s", api: { ClientDetailAPI(transport: transport, route: .desktop) }) {}
            Issue.record("permission error disappeared")
        } catch { #expect(error as? ClientServiceFailure == ClientServiceFailure(statusCode: 403, code: "DEVICE_REVOKED")) }
    }
    @MainActor @Test func v2BridgePreservesExistingCardAndExpansionOnDataChange() throws {
        let fixture = try fixture(), store = ClientDetailStore()
        let before = try fixture.snapshot.renderingDocument()
        try store.apply(.snapshot(before))
        let card = try #require(store.orderedCards.first); card.expandedNodes.insert("root")
        let next = try fixture.snapshot.applying(fixture.commit)
        try store.apply(.snapshot(next.renderingDocument(previous: fixture.snapshot, document: before)))
        #expect(store.orderedCards.first === card)
        #expect(card.expandedNodes.contains("root"))
        #expect(card.card.data["workName"] == .string("更新后的 Work"))
        #expect(before.generation.hasPrefix("v2:"))
    }
    @Test func refreshUsesSameV2VersionNamespaceWithoutSecondSubscription() async throws {
        let fixture = try fixture(), data = try JSONEncoder().encode(fixture.snapshot)
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { request in
            #expect(request.httpMethod == "GET")
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json; corptie-detail=native-v2")
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
        }, bytes: { _ in Issue.record("refresh must not open a second SSE"); throw ClientConnectionError.invalidResponse })
        let document = try await ClientDetailAPI(transport: transport, route: .desktop).renderingSnapshot(sessionID: "s")
        #expect(document == (try fixture.snapshot.renderingDocument()))
    }
    @Test func rawJSONRejectsDuplicateKeysAndUnicodeKeyAliases() throws {
        for source in ["{\"a\":1,\"a\":2}", "{\"a\":1,\"\\u0061\":2}", "{\"é\":1}", "{\"\":1}",
                       "{\"a\":0.5}", "{\"a\":9007199254740992}", "{\"a\":\"\\ud800\"}", "[1,]", "{} trailing"] {
            #expect(throws: (any Error).self) { try ClientDetailV2JSON.decode(Data(source.utf8)) }
        }
        #expect(throws: (any Error).self) { try ClientDetailV2JSON.decode(Data([0xff])) }
        #expect(try ClientDetailV2JSON.decode(Data("{\"text\":\"中文😀\"}".utf8))["text"].text == "中文😀")
    }
    @Test func v2TransportUsesScopedPostAndStreamsSnapshotThenCommit() async throws {
        let fixture = try fixture()
        let snapshot = String(decoding: try JSONEncoder().encode(fixture.snapshot), as: UTF8.self)
        // Codable omits optional nulls; the wire envelope explicitly requires
        // manifestChange, so preserve its null in the fixture's raw commit.
        let url = try #require(Bundle.module.url(forResource: "detail-v2", withExtension: "json", subdirectory: "Fixtures"))
        // Canonical-encoder vectors intentionally contain Unicode object keys;
        // those are not network envelopes. Decode the fixture wrapper normally.
        let raw = try JSONDecoder().decode(ClientInspectorValue.self, from: Data(contentsOf: url))
        let commit = try ClientDetailV2Canonical.encode(raw["commit"])
        for route in [ClientDetailAPI.Route.desktop, .pairedDevice] {
            let expected = route == .desktop ? "/sessions/s/detail/sync" : "/client/v1/sessions/s/detail/sync"
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
                data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in
                    #expect(request.httpMethod == "POST")
                    #expect(request.url?.path == expected)
                    #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream; corptie-detail=native-v2")
                    let body = try ClientDetailV2JSON.decode(#require(request.httpBody))
                    #expect(body["resume"] == .null)
                    let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
                    continuation.yield(Data("event: detail-snapshot\ndata: \(snapshot)\n\nevent: detail-commit\ndata: \(commit)\n\n".utf8))
                    continuation.finish()
                    return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200,
                        httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
                })
            var states: [ClientDetailV2State] = []
            for try await state in ClientDetailV2API(transport: transport, route: route).subscribe(sessionID: "s") { states.append(state) }
            #expect(states.count == 2)
            #expect(states.last?.stateHash == fixture.resultStateHash)
        }
    }
    @Test func rawEnvelopeDoesNotSilentlyDiscardUnknownAuthorityFields() throws {
        let fixture = try fixture()
        let value = try ClientDetailV2JSON.decode(JSONEncoder().encode(fixture.snapshot))
        try ClientDetailV2JSON.validateEnvelope(value, commit: false)
        var fields = value.fields; fields["authority"] = .string("bad")
        #expect(throws: ClientDetailV2Canonical.Failure.shape) {
            try ClientDetailV2JSON.validateEnvelope(.object(fields), commit: false)
        }
    }
    struct Vector: Decodable { let value: ClientInspectorValue; let canonical: String; let hash: String }
    struct Fixture: Decodable {
        let snapshot: ClientDetailV2State
        let commit: ClientDetailV2Commit
        let resultStateHash: String
        let vectors: [Vector]
    }
    func fixture() throws -> Fixture {
        let url = try #require(Bundle.module.url(forResource: "detail-v2", withExtension: "json", subdirectory: "Fixtures"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }
    @Test func nodeAndSwiftCanonicalHashesAgree() throws {
        for vector in try fixture().vectors {
            #expect(try ClientDetailV2Canonical.encode(vector.value) == vector.canonical)
            #expect(try ClientDetailV2Canonical.hash(vector.value) == vector.hash)
        }
        for number in [0.5, Double.infinity, Double.nan, 9_007_199_254_740_992] {
            #expect(throws: ClientDetailV2Canonical.Failure.number) { try ClientDetailV2Canonical.encode(.number(number)) }
        }
    }
    @Test func sharedSnapshotAndDeltaAreAtomicAndIdempotent() throws {
        let fixture = try fixture()
        try fixture.snapshot.validate()
        let next = try fixture.snapshot.applying(fixture.commit)
        #expect(next.stateHash == fixture.resultStateHash)
        #expect(next.instances["session-info"]?.fields["workName"] == .string("更新后的 Work"))
        #expect(try next.applying(fixture.commit) == next)
        #expect(fixture.snapshot.instances["session-info"]?.fields["workName"] == .string("Sample Work"))
    }
    @Test func badHashesAndMissingTemplatesPreserveBaseline() throws {
        let fixture = try fixture()
        var bad = fixture.snapshot
        bad.stateHash = "bad"
        #expect(throws: ClientDetailV2Canonical.Failure.hash) { try bad.validate() }
        bad = fixture.snapshot; bad.templates = [:]
        #expect(throws: ClientDetailV2Canonical.Failure.shape) { try bad.validate() }
        var json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(fixture.commit)) as? [String: Any])
        json["baseRevision"] = 999
        let commit = try JSONDecoder().decode(ClientDetailV2Commit.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(throws: ClientDetailV2Canonical.Failure.base) { try fixture.snapshot.applying(commit) }
        try fixture.snapshot.validate()
    }
}
