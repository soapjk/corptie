import Foundation
import XCTest
@testable import CorptieMac

private final class ArtifactCollectionProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        if request.url!.path.contains("slow") {
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.15) { self.complete() }
        } else { complete() }
    }
    private func complete() {
        let status = request.url!.path.contains("failure") ? 503 : 200
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
            httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"artifacts":[],"nextOffset":100}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

@MainActor final class ArtifactCollectionCacheTests: XCTestCase {
    private func makeClient(limit: Int = 32) -> (ArtifactAPIClient, URLSession) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ArtifactCollectionProtocol.self]
        let session = URLSession(configuration: configuration)
        return (ArtifactAPIClient(baseURL: URL(string: "http://artifact-cache.test")!,
            urlSession: session, collectionCacheLimit: limit), session)
    }
    func testWorkAndTaskShareDefault32CollectionBudget() async {
        let (client, session) = makeClient()
        defer { session.invalidateAndCancel() }
        for index in 0..<16 { await client.refresh(workId: "work-\(index)") }
        for index in 0..<17 { await client.refresh(taskId: "task-\(index)") }
        XCTAssertEqual(client.workLoadStates.count + client.taskLoadStates.count, 32)
        XCTAssertEqual(client.artifactsByWork.count + client.artifactsByCorptieTask.count, 32)
        XCTAssertNil(client.workLoadStates["work-0"])
        XCTAssertFalse(client.hasMore(workId: "work-0", taskId: nil))
    }
    func testAccessKeepsRecentCollectionAndEvictionClearsPaginationAndFailure() async {
        let (client, session) = makeClient(limit: 2)
        defer { session.invalidateAndCancel() }
        await client.refresh(workId: "a")
        await client.refresh(taskId: "failure")
        _ = client.artifact(artifactId: "missing", workId: "a", taskId: nil)
        await client.refresh(taskId: "c")
        XCTAssertNotNil(client.artifactsByWork["a"])
        XCTAssertNil(client.taskLoadStates["failure"])
        await client.refresh(workId: "d")
        XCTAssertNil(client.artifactsByWork["a"])
        XCTAssertFalse(client.hasMore(workId: "a", taskId: nil))
        await client.loadMore(workId: "a", taskId: nil)
        XCTAssertNil(client.workLoadStates["a"])
    }
    func testLateResponseCannotResurrectEvictedCollection() async {
        let (client, session) = makeClient(limit: 1)
        defer { session.invalidateAndCancel() }
        let slow = Task { await client.refresh(workId: "slow") }
        while client.workLoadStates["slow"] == nil { await Task.yield() }
        await client.refresh(taskId: "current")
        await slow.value
        XCTAssertNil(client.workLoadStates["slow"])
        XCTAssertNil(client.artifactsByWork["slow"])
        XCTAssertFalse(client.hasMore(workId: "slow", taskId: nil))
        XCTAssertEqual(client.taskLoadStates.count, 1)
    }
}
