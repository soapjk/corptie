import Foundation
import Testing
@testable import CorptieClientCore

struct ClientDetailPresentationPolicyTests {
    @MainActor @Test func realStoreObservationUsesActualRichProfileRatherThanPoolsLegacyDefault() async throws {
        let url = try #require(Bundle.module.url(forResource: "detail-v2-business-dates", withExtension: "json", subdirectory: "Fixtures"))
        let fixture = try ClientDetailV2JSON.decode(Data(contentsOf: url))
        let state = fixture["snapshot"]
        let data = try JSONEncoder().encode(state)
        let negotiation = try ClientDetailV2Negotiation.components(clientCapabilities: fixture["clientCapabilities"].items.compactMap(\.text))
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { _ in
            throw ClientConnectionError.invalidResponse
        }, bytes: { request in
            let body = try ClientDetailV2JSON.decode(try #require(request.httpBody))
            #expect(body["catalog"].text == negotiation.catalog)
            #expect(body["clientCapabilities"] == fixture["clientCapabilities"])
            let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
            continuation.yield(Data("event: detail-snapshot\ndata: ".utf8) + data + Data("\n\n".utf8)); continuation.finish()
            return (BackendByteStream(chunks: stream), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                headerFields: ["Content-Type": "text/event-stream"])!)
        })
        let api = ClientDetailAPI(transport: transport, route: .pairedDevice, negotiation: negotiation), store = ClientDetailStore()
        let task = Task { await store.observe(scope: "unique-rich-store-observation", sessionID: "legacy", api: { api }) }
        for _ in 0..<100 where store.orderedCards.isEmpty { try await Task.sleep(for: .milliseconds(10)) }
        task.cancel(); await task.value
        #expect(store.canonicalSessionID == state["sessionId"].text)
        #expect(store.orderedCards.count == state["manifest"]["order"].items.count)
    }
    @Test func refreshedTransportRetainsFixedProfileWithoutReusingOldCredentials() async throws {
        let profile = try ClientDetailV2Negotiation.components(clientCapabilities: ["detail.markdown", "detail.status"])
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { request in
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json; corptie-detail=native-v2-components-1")
            #expect(request.value(forHTTPHeaderField: "X-Corptie-Detail-Capabilities") == "detail.markdown,detail.status")
            throw ClientServiceFailure(statusCode: 418, code: "FRESH_CREDENTIAL_TRANSPORT")
        }, bytes: { _ in throw ClientConnectionError.invalidResponse })
        let refreshed = ClientDetailAPI(transport: transport, route: .pairedDevice).negotiating(profile)
        #expect(refreshed.negotiation == profile)
        await #expect(throws: ClientServiceFailure(statusCode: 418, code: "FRESH_CREDENTIAL_TRANSPORT")) {
            try await refreshed.v2.snapshot(sessionID: "s")
        }
    }
    @MainActor @Test func failedNewScopeNegotiationCannotRetainPreviousCardsOrRefreshToken() throws {
        let store = ClientDetailStore()
        store.beginPresentation(scope: "server/account/session-a")
        let document = try ClientDetailV2Tests().fixture().snapshot.renderingDocument()
        try store.apply(.snapshot(document))
        #expect(!store.orderedCards.isEmpty)
        let card = try #require(store.orderedCards.first)
        store.beginPresentation(scope: "server/account/session-a")
        #expect(store.orderedCards.first === card)
        store.beginPresentation(scope: "server/account/session-b")
        #expect(store.orderedCards.isEmpty)
        store.presentationFailed(scope: "server/account/session-a")
        #expect(store.error == nil)
        store.presentationFailed(scope: "server/account/session-b")
        #expect(store.error != nil)
    }
    private let actual = ["detail.dateTime", "detail.keyValue", "detail.markdown", "detail.resourceList", "detail.status"]
    private func api(_ body: String, route: ClientDetailAPI.Route = .desktop,
                     negotiation: ClientDetailV2Negotiation = .legacy, status: Int = 200) throws -> ClientDetailAPI {
        let data = Data(body.utf8)
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1:1234")!), data: { request in
            #expect(request.url?.path == "\(route == .desktop ? "" : "/client/v1")/sessions/s/detail/capabilities")
            #expect(request.value(forHTTPHeaderField: "Accept") == "application/json")
            #expect(request.httpMethod == "GET")
            return (data, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: [:])!)
        }, bytes: { _ in throw ClientConnectionError.invalidResponse })
        return .init(transport: transport, route: route, negotiation: negotiation)
    }
    @Test func hostAdvertisementSelectsSameActualCapabilitiesOnDesktopAndPaired() async throws {
        let body = #"{"schemaVersion":1,"catalogs":["native-v2","native-v2-components-1"],"requiredCapabilities":["detail.dateTime","detail.keyValue","detail.markdown","detail.resourceList","detail.status"],"writes":false}"#
        for route in [ClientDetailAPI.Route.desktop, .pairedDevice] {
            let configured = try await api(body, route: route).forPresentation(sessionID: "s", clientCapabilities: actual)
            #expect(configured.negotiation.catalog == "native-v2-components-1")
            #expect(configured.negotiation.clientCapabilities == actual)
        }
    }
    @Test func closedGateRemainsLegacyButExplicitRichCannotDowngrade() async throws {
        let body = #"{"schemaVersion":1,"catalogs":["native-v2"],"requiredCapabilities":[],"writes":false}"#
        #expect(try await api(body).forPresentation(sessionID: "s", clientCapabilities: actual).negotiation.isLegacy)
        let rich = try ClientDetailV2Negotiation.components(clientCapabilities: actual)
        await #expect(throws: ClientDetailV2Canonical.Failure.shape) {
            try await api(body, negotiation: rich).forPresentation(sessionID: "s", clientCapabilities: actual)
        }
    }
    @Test func malformedAdvertisementsAndReducedCapabilitiesFailClosed() async throws {
        for body in [
            #"{"schemaVersion":2,"catalogs":["native-v2"],"requiredCapabilities":[],"writes":false}"#,
            #"{"schemaVersion":1,"catalogs":["native-v2-components-1"],"requiredCapabilities":[],"writes":false}"#,
            #"{"schemaVersion":1,"catalogs":["native-v2"],"requiredCapabilities":["detail.image"],"writes":false}"#,
            #"{"schemaVersion":1,"catalogs":["native-v2","native-v2-components-1"],"requiredCapabilities":["detail.status","detail.markdown"],"writes":false}"#
        ] {
            await #expect(throws: ClientDetailV2Canonical.Failure.shape) {
                try await api(body).forPresentation(sessionID: "s", clientCapabilities: actual)
            }
        }
        let body = #"{"schemaVersion":1,"catalogs":["native-v2","native-v2-components-1"],"requiredCapabilities":["detail.image"],"writes":false}"#
        await #expect(throws: ClientServiceFailure(statusCode: 409, code: "DETAIL_CAPABILITY_UNAVAILABLE")) {
            try await api(body).forPresentation(sessionID: "s", clientCapabilities: actual)
        }
    }
    @Test func olderHostEndpointAbsenceIsNotRichFailureFallback() async throws {
        let old = try await api(#"{"code":"ROUTE_NOT_FOUND"}"#, status: 404).forPresentation(sessionID: "s", clientCapabilities: actual)
        #expect(old.negotiation.isLegacy)
        let rich = try ClientDetailV2Negotiation.components(clientCapabilities: actual)
        await #expect(throws: ClientServiceFailure(statusCode: 404, code: "ROUTE_NOT_FOUND")) {
            try await api(#"{"code":"ROUTE_NOT_FOUND"}"#, negotiation: rich, status: 404).forPresentation(sessionID: "s", clientCapabilities: actual)
        }
    }
}
