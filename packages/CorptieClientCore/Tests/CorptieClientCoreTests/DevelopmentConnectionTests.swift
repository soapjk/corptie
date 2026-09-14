import Foundation
import Testing
@testable import CorptieClientCore

struct DevelopmentConnectionTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CORPTIE_CLIENT_CORE_TEST_URL"] != nil))
    func readsDevelopmentSnapshotAndEventUsingSharedTransport() async throws {
        let raw = try #require(ProcessInfo.processInfo.environment["CORPTIE_CLIENT_CORE_TEST_URL"])
        let endpoint = try BackendEndpoint(#require(URL(string: raw)))
        #expect(endpoint.isLoopback)
        guard endpoint.isLoopback else { return }
        let transport = try BackendTransport(endpoint: endpoint)
        let (health, _) = try await transport.data(for: endpoint.request(path: ["health"]))
        let healthJSON = try #require(JSONSerialization.jsonObject(with: health) as? [String: Any])
        // Do not run this integration test against the production backend.
        #expect(healthJSON["developmentPreview"] as? Bool == true)
        guard healthJSON["developmentPreview"] as? Bool == true else { return }
        let (capabilities, _) = try await transport.data(for: endpoint.request(path: ["client-capabilities"]))
        #expect(try !JSONDecoder().decode(ClientCapabilities.self, from: capabilities).supportsRemoteConnection)
        let (snapshot, _) = try await transport.data(for: endpoint.request(path: ["state", "snapshot"]))
        #expect(try JSONSerialization.jsonObject(with: snapshot) is [String: Any])
        var request = try endpoint.request(path: ["state", "events"], query: [.init(name: "after", value: "0")])
        request.timeoutInterval = 20
        let (bytes, _) = try await transport.bytes(for: request)
        var parser = ServerSentEventParser()
        for try await byte in bytes {
            if let event = parser.append(byte).first {
                #expect(event.isComment || !event.data.isEmpty)
                return
            }
        }
        Issue.record("State stream ended without a frame")
    }
}
