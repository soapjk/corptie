import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailV2NegotiationTests {
    // Wire-only mock with no templates, valid for an explicitly empty rich
    // capability set; legacy templates are no longer valid rich responses.
    private func emptyStateData() throws -> Data {
        var state = try ClientDetailV2Tests().fixture().snapshot
        let hash = try ClientDetailV2Canonical.hash(.object(["cards": .object([:]), "order": .array([])]))
        state.manifest = .init(revision: 1, hash: hash, cards: [:], order: [])
        state.instances = [:]; state.templates = [:]
        state.stateHash = try ClientDetailV2Canonical.hash(.object(["manifestHash": .string(hash), "instances": .array([])]))
        return try JSONEncoder().encode(state)
    }
    @Test func negotiationIsCanonicalAndDefaultsRemainLegacy() throws {
        let config = try ClientDetailV2Negotiation.components(clientCapabilities: ["detail.markdown", "detail.chart"])
        #expect(config.clientCapabilities == ["detail.chart", "detail.markdown"])
        #expect(config.capabilityDigest == "sha256:6c854ba480d86ba739c2074461b63392be9efa4d6815b238ed3042c549ad75d2")
        #expect(config.scoped("account:server:s") != ClientDetailV2Negotiation.legacy.scoped("account:server:s"))
        #expect(config.scoped("account:server:s") != (try ClientDetailV2Negotiation.components(clientCapabilities: [])).scoped("account:server:s"))
        for tokens in [["detail.unknown"], ["detail.chart", "detail.chart"], ["detail.chart,detail.form"], Array(repeating: "detail.chart", count: 33)] {
            #expect(throws: ClientDetailV2Canonical.Failure.shape) { try ClientDetailV2Negotiation.components(clientCapabilities: tokens) }
        }
    }
    @Test func explicitRichGetAndPostUseOneCapabilitySetAndResetForeignResume() async throws {
        let fixture = try ClientDetailV2Tests().fixture()
        let emptyData = try emptyStateData()
        let config = try ClientDetailV2Negotiation.components(clientCapabilities: ["detail.chart", "detail.markdown"])
        for route in [ClientDetailAPI.Route.desktop, .pairedDevice] {
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { request in
                #expect(request.value(forHTTPHeaderField: "Accept") == "application/json; corptie-detail=native-v2-components-1")
                #expect(request.value(forHTTPHeaderField: "X-Corptie-Detail-Capabilities") == "detail.chart,detail.markdown")
                // Empty wire-only mock, not real rich fixture acceptance.
                return (emptyData, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
            }, bytes: { request in
                #expect(request.value(forHTTPHeaderField: "Accept") == "text/event-stream; corptie-detail=native-v2")
                let body = try ClientDetailV2JSON.decode(#require(request.httpBody))
                #expect(body["catalog"].text == "native-v2-components-1")
                #expect(body["clientCapabilities"].items == [.string("detail.chart"), .string("detail.markdown")])
                #expect(body["resume"] == .null)
                #expect(body["cachedTemplateHashes"].items.isEmpty)
                let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(); continuation.finish()
                return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200,
                    httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
            })
            let api = ClientDetailV2API(transport: transport, route: route, negotiation: config)
            _ = try await api.snapshot(sessionID: "s")
            for try await _ in api.subscribe(sessionID: "s", resume: fixture.snapshot, resumeNegotiation: .legacy) {}
        }
    }
    @Test func defaultLegacyPostDoesNotExtendFrozenRequest() async throws {
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in
            let body = try ClientDetailV2JSON.decode(#require(request.httpBody))
            #expect(body["catalog"].text == "native-v2")
            #expect(body.fields["clientCapabilities"] == nil)
            #expect(request.value(forHTTPHeaderField: "X-Corptie-Detail-Capabilities") == nil)
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(); continuation.finish()
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"])!)
        })
        for try await _ in ClientDetailV2API(transport: transport, route: .desktop).subscribe(sessionID: "s") {}
    }
    @Test func emptyRichCapabilitiesRemainExplicitAndChangedCapabilitiesResetResume() async throws {
        let fixture = try ClientDetailV2Tests().fixture()
        let emptyData = try emptyStateData()
        let config = try ClientDetailV2Negotiation.components(clientCapabilities: [])
        let previous = try ClientDetailV2Negotiation.components(clientCapabilities: ["detail.chart"])
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { request in
            #expect(request.value(forHTTPHeaderField: "X-Corptie-Detail-Capabilities") == "")
            return (emptyData, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
        }, bytes: { request in
            let body = try ClientDetailV2JSON.decode(#require(request.httpBody))
            #expect(body.fields["clientCapabilities"] == .array([]))
            #expect(body["resume"] == .null)
            #expect(body["cachedTemplateHashes"].items.isEmpty)
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(); continuation.finish()
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"])!)
        })
        let client = ClientDetailV2API(transport: transport, route: .desktop, negotiation: config)
        _ = try await client.snapshot(sessionID: "s")
        for try await _ in client.subscribe(sessionID: "s", resume: fixture.snapshot, resumeNegotiation: previous) {}
    }
    actor Rebinding {
        var attempts = 0
        func next(transport: BackendTransport) throws -> ClientDetailAPI {
            attempts += 1
            return ClientDetailAPI(transport: transport, route: .desktop,
                negotiation: attempts == 1 ? .legacy : try .components(clientCapabilities: ["detail.chart"]))
        }
    }
    @Test func reconnectCannotSilentlyChangeTheEntryCatalogOrCapabilities() async throws {
        let fixture = try ClientDetailV2Tests().fixture(), probe = ClientDetailV2Tests.PoolProbe(), rebinding = Rebinding()
        let data = try JSONEncoder().encode(fixture.snapshot)
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
            data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in
                try await probe.open(request, snapshot: data, corruptFirst: false)
            })
        let pool = ClientDetailSubscriptionPool(retryDelay: { _ in await Task.yield() })
        let stream = await pool.subscribe(scope: "account:server:s", sessionID: "s", api: { try await rebinding.next(transport: transport) })
        do {
            for try await _ in stream {}
            Issue.record("profile change must terminate the old entry")
        } catch {
            guard case ClientDetailFailure.wrongScope = error else { Issue.record("unexpected error: \(error)"); return }
        }
        #expect(await probe.requests.count == 1)
        #expect(await rebinding.attempts == 2)
    }
    actor Probe {
        var bodies: [ClientInspectorValue] = []
        var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
        func open(_ request: URLRequest) throws -> (BackendByteStream, HTTPURLResponse) {
            bodies.append(try ClientDetailV2JSON.decode(#require(request.httpBody)))
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream(); continuations.append(continuation)
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"])!)
        }
    }
    @Test func poolPartitionsSameAccountSessionByCatalogAndCapabilityDigest() async throws {
        let pool = ClientDetailSubscriptionPool(), probe = Probe()
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!),
            data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { request in try await probe.open(request) })
        let configs: [ClientDetailV2Negotiation] = [.legacy, try .components(clientCapabilities: []), try .components(clientCapabilities: ["detail.chart"])]
        var tasks: [Task<Void, Never>] = []
        for config in configs + [configs[2]] {
            let stream = await pool.subscribe(scope: "account:server:s", sessionID: "s", negotiation: config,
                api: { ClientDetailAPI(transport: transport, route: .desktop, negotiation: config) })
            tasks.append(Task { do { for try await _ in stream {} } catch {} })
        }
        for _ in 0..<100 { if await probe.bodies.count == 3 { break }; try await Task.sleep(for: .milliseconds(5)) }
        #expect(await probe.bodies.count == 3)
        #expect(await probe.bodies.allSatisfy { $0["resume"] == .null && $0["cachedTemplateHashes"].items.isEmpty })
        for task in tasks { task.cancel() }
        for task in tasks { await task.value }
    }
}
