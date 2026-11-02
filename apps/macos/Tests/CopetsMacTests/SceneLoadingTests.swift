import Foundation
import Testing
@testable import CorptieMac

@Suite(.serialized)
struct SceneLoadingTests {
    @MainActor @Test func failedRefreshKeepsOnlyTheSelectedScenesCachedRecords() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [SceneLoadingProtocol.self]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let client = SceneAPIClient(baseURL: URL(string: "http://127.0.0.1:49991")!, session: session)
        let scene = SceneInstance(instanceId: "one", templateId: "daily-checklist", templateVersion: 1,
                                  name: "One", timezone: "Asia/Shanghai", status: "active", instanceRevision: 1,
                                  resourceVersion: 1, createdAt: "", updatedAt: "")
        let record = SceneRecord(instanceId: "one", recordId: "record:one", recordType: "Item", data: [:],
                                 recordVersion: 1, archivedAt: nil, createdAt: "", updatedAt: "")
        let response = SceneViewResponse(scene: scene, view: .init(viewId: "checklist", title: "Checklist",
                                                                 kind: "list", recordTypes: ["Item"]),
                                         records: [record], nextOffset: nil)
        SceneLoadingProtocol.responses.set(status: 200, data: try JSONEncoder().encode(response))
        await client.loadScene(scene)
        #expect(client.records == [record])
        SceneLoadingProtocol.responses.set(status: 503, data: Data(#"{"error":"Unavailable"}"#.utf8))
        await client.loadScene(scene)
        #expect(client.records == [record])
        #expect(client.errorMessage != nil)
        let other = SceneInstance(instanceId: "two", templateId: "daily-checklist", templateVersion: 1,
                                  name: "Two", timezone: "Asia/Shanghai", status: "active", instanceRevision: 1,
                                  resourceVersion: 1, createdAt: "", updatedAt: "")
        await client.loadScene(other)
        #expect(client.records.isEmpty, "A failed scene switch must not display another scene's records")
        #expect(!client.isLoading)
    }
}

private final class SceneLoadingResponses: @unchecked Sendable {
    private let lock = NSLock()
    private var response: (Int, Data) = (503, Data())
    func set(status: Int, data: Data) { lock.withLock { response = (status, data) } }
    func get() -> (Int, Data) { lock.withLock { response } }
}

private final class SceneLoadingProtocol: URLProtocol, @unchecked Sendable {
    static let responses = SceneLoadingResponses()
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let (status, data) = Self.responses.get()
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil,
                                        headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
