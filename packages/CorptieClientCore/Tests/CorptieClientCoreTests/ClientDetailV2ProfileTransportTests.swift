import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailV2ProfileTransportTests {
    @Test func actualCapabilitiesAndMixedTemplatesAreRejectedThroughTheAPI() async throws {
        let data = try fixture(), full = ClientDetailV2Catalog.componentKinds.sorted()
        let reduced = try ClientDetailV2Negotiation.components(clientCapabilities: Array(full.dropLast()))
        let complete = try ClientDetailV2Negotiation.components(clientCapabilities: full)
        let state = try JSONDecoder().decode(ClientDetailV2State.self, from: data)
        let document = try state.renderingDocument(catalogProfile: complete.catalog, clientCapabilities: full)
        #expect(throws: (any Error).self) {
            try state.renderingDocument(previous: state, document: document, catalogProfile: reduced.catalog, clientCapabilities: reduced.clientCapabilities)
        }
        var mixed = state
        let legacy = try ClientDetailV2Tests().fixture().snapshot.templates
        mixed.templates.merge(legacy) { _, new in new }
        let mixedData = try JSONEncoder().encode(mixed)
        for route in [ClientDetailAPI.Route.desktop, .pairedDevice] {
            for (config, responseData) in [(reduced, data), (complete, mixedData)] {
                let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { _ in
                    (responseData, HTTPURLResponse(url: URL(string: "http://127.0.0.1:1234")!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
                }, bytes: { _ in
                    Issue.record("invalid rich resume must be rejected before opening a stream")
                    throw ClientConnectionError.invalidResponse
                })
                let client = ClientDetailAPI(transport: transport, route: route, negotiation: config)
                do {
                    _ = try await client.renderingSnapshot(sessionID: state.sessionId)
                    Issue.record("unsupported rich response was accepted")
                } catch {
                    guard case ClientDetailV2Canonical.Failure.shape = error else { Issue.record("unexpected error: \(error)"); continue }
                }
                do {
                    for try await _ in client.v2.subscribe(sessionID: state.sessionId, resume: config == reduced ? state : mixed, resumeNegotiation: config) {}
                    Issue.record("invalid rich resume was accepted")
                } catch {
                    guard case ClientDetailV2Canonical.Failure.shape = error else { Issue.record("unexpected resume error: \(error)"); continue }
                }
            }
        }
    }
    @Test func realCollectionDeltaTravelsThroughTheRichAPIAtomically() async throws {
        let fixture = try ClientDetailV2JSON.decode(Data(contentsOf: #require(Bundle.module.url(forResource: "detail-v2-components-sync", withExtension: "json", subdirectory: "Fixtures"))))
        let initial = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(fixture["snapshot"]))
        let expected = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(fixture["expectedState"]))
        let events = try ["snapshot", "commit"].map { key in
            let data = try JSONEncoder().encode(fixture[key])
            return Data("event: detail-\(key)\ndata: \(String(decoding: data, as: UTF8.self))\n\n".utf8)
        }
        let config = try ClientDetailV2Negotiation.components(clientCapabilities: Array(ClientDetailV2Catalog.componentKinds))
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { _ in
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            for event in events { continuation.yield(event) }
            continuation.finish()
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: URL(string: "http://127.0.0.1:1234")!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
        })
        var received: [ClientDetailV2State] = []
        for try await state in ClientDetailV2API(transport: transport, route: .desktop, negotiation: config).subscribe(sessionID: initial.sessionId) { received.append(state) }
        #expect(received == [initial, expected])
        #expect(received.last?.instances["b"] == initial.instances["b"])
        #expect(received.last?.instances["a"]?.collections["resources"]?["revision"].number == 2)
    }
    private func fixture() throws -> Data {
        try Data(contentsOf: #require(Bundle.module.url(forResource: "detail-v2-components-state", withExtension: "json", subdirectory: "Fixtures")))
    }
    @Test func realBusinessFormsAndPaginationCrossBothProfileAPIsWithoutContractRelaxation() async throws {
        let data = try Data(contentsOf: #require(Bundle.module.url(forResource: "detail-v2-business-interactive", withExtension: "json", subdirectory: "Fixtures")))
        let fixture = try ClientDetailV2JSON.decode(data)
        let initial = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(fixture["snapshot"]))
        let expected = try JSONDecoder().decode(ClientDetailV2State.self, from: JSONEncoder().encode(fixture["expectedState"]))
        let config = try ClientDetailV2Negotiation.components(clientCapabilities: fixture["clientCapabilities"].items.compactMap(\.text))
        let events = try ["snapshot", "commit"].map { key in
            let payload = try JSONEncoder().encode(fixture[key])
            return Data("event: detail-\(key)\ndata: \(String(decoding: payload, as: UTF8.self))\n\n".utf8)
        }
        for route in [ClientDetailAPI.Route.desktop, .pairedDevice] {
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { _ in throw ClientConnectionError.invalidResponse }, bytes: { _ in
                let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
                for event in events { continuation.yield(event) }; continuation.finish()
                return (BackendByteStream(chunks: stream), HTTPURLResponse(url: URL(string: "http://127.0.0.1:1234")!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
            })
            var received: [ClientDetailV2State] = []
            for try await state in ClientDetailV2API(transport: transport, route: route, negotiation: config).subscribe(sessionID: initial.sessionId) { received.append(state) }
            #expect(received == [initial, expected])
            let document = try expected.renderingDocument(catalogProfile: config.catalog, clientCapabilities: config.clientCapabilities)
            let editor = try #require(document.cards.first { $0.id == "memory-editor-interactive" })
            #expect(editor.actions.first { $0.id == "save" }?.expectedResourceRevision == "revision-2")
            let nativeTask = try #require(document.cards.first { $0.id == "task-information" })
            #expect(nativeTask.actions.first { $0.id == "edit" }?.operation == "editor.open")
            #expect(nativeTask.actions.first { $0.id == "edit" }?.target?.resourceType == "task")
            #expect(nativeTask.actions.first { $0.id == "edit" }?.expectedResourceRevision == "1")
            #expect(initial.instances["business-references"]?.collections["resources"]?["nextCursor"].text == "opaque-lease-interactive")
            #expect(expected.instances["business-references"]?.collections["resources"]?["nextCursor"] == .null)
        }
    }
    @Test func fixedRichStateRequiresExplicitProfileAndRetainsLocalPresentation() throws {
        let data = try fixture()
        try ClientDetailV2JSON.validateEnvelope(ClientDetailV2JSON.decode(data), commit: false)
        let state = try JSONDecoder().decode(ClientDetailV2State.self, from: data)
        #expect(throws: (any Error).self) { try state.validate() }
        #expect(throws: (any Error).self) { try state.validate(catalogProfile: "native-v2-components-2") }
        #expect(throws: (any Error).self) { try state.renderingDocument(catalogProfile: "native-v2") }
        let capabilities = ClientDetailV2Catalog.componentKinds.sorted()
        #expect(throws: (any Error).self) { try state.validate(catalogProfile: ClientDetailV2Catalog.profile) }
        try state.validate(catalogProfile: ClientDetailV2Catalog.profile, clientCapabilities: capabilities)
        let rendered = try state.renderingDocument(catalogProfile: ClientDetailV2Catalog.profile, clientCapabilities: capabilities)
        #expect(rendered.cards.first?.v2Presentation != nil)
        #expect(ClientDetailV2Catalog.componentKinds == ClientDetailV2Negotiation.registeredCapabilities)
        let wire = try ClientDetailV2JSON.decode(JSONEncoder().encode(rendered.cards[0]))
        #expect(wire.fields["v2Presentation"] == nil)
    }
    @Test func richGetAndPoolSnapshotUseTheRetainedProfile() async throws {
        let data = try fixture()
        let state = try JSONDecoder().decode(ClientDetailV2State.self, from: data)
        let commit = ClientDetailV2Commit(protocolVersion: 2, documentId: state.documentId, sessionId: state.sessionId,
            generation: state.generation, baseRevision: state.revision, revision: state.revision,
            baseStateHash: state.stateHash, resultStateHash: state.stateHash, templates: [:],
            manifestChange: nil, instanceChanges: [], removeInstanceIds: [])
        var commitFields = try ClientDetailV2JSON.decode(JSONEncoder().encode(commit)).fields
        // The wire requires explicit null; Codable omits optional nil.
        commitFields["manifestChange"] = .null
        let commitData = try JSONEncoder().encode(ClientInspectorValue.object(commitFields))
        let config = try ClientDetailV2Negotiation.components(clientCapabilities: Array(ClientDetailV2Catalog.componentKinds))
        for route in [ClientDetailAPI.Route.desktop, .pairedDevice] {
            let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { request in
                #expect(request.value(forHTTPHeaderField: "Accept") == "application/json; corptie-detail=\(config.catalog)")
                return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: [:])!)
            }, bytes: { request in
                let body = try ClientDetailV2JSON.decode(#require(request.httpBody))
                if body["resume"] != .null {
                    #expect(body["resume"]["generation"].text == state.generation)
                    #expect(body["cachedTemplateHashes"].items.count == state.templates.count)
                }
                let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
                continuation.yield(Data("event: detail-snapshot\ndata: \(String(decoding: data, as: UTF8.self).split(separator: "\n").joined())\n\n".utf8))
                continuation.yield(Data("event: detail-commit\ndata: \(String(decoding: commitData, as: UTF8.self))\n\n".utf8))
                continuation.finish()
                return (BackendByteStream(chunks: stream), HTTPURLResponse(url: URL(string: "http://127.0.0.1:1234")!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!)
            })
            let client = ClientDetailAPI(transport: transport, route: route, negotiation: config)
            #expect(try await client.renderingSnapshot(sessionID: "logical:sample").cards.first?.v2Presentation != nil)
            var events = 0
            for try await next in client.v2.subscribe(sessionID: "logical:sample", resume: state, resumeNegotiation: config) {
                #expect(next == state)
                events += 1
            }
            #expect(events == 2)
            let pool = ClientDetailSubscriptionPool()
            let stream = await pool.subscribe(scope: "server:account:principal:device:logical:sample", sessionID: "logical:sample", negotiation: config, api: { client })
            for try await event in stream {
                if case .snapshot(let document) = event { #expect(document.cards.first?.v2Presentation != nil) }
                break
            }
        }
    }
}
