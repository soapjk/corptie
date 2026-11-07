import Foundation
import XCTest
import CorptieClientCore
@testable import CorptieMac

private actor SnapshotTestServer {
    var requests = 0
    private var gate: CheckedContinuation<Void, Never>?
    func fetch() async -> Data {
        requests += 1
        let revision = requests == 1 ? 1 : 5
        if requests == 1 { await withCheckedContinuation { gate = $0 } }
        return Data("{\"revision\":\(revision),\"state\":{\"sessions\":[],\"tasks\":[],\"works\":[],\"agents\":[],\"skills\":[],\"repositories\":[],\"integrationRuns\":[]}}".utf8)
    }
    func release() { gate?.resume(); gate = nil }
}
@MainActor final class StateSyncRecoveryTests: XCTestCase {
    private func makeController(_ server: SnapshotTestServer) throws -> (AppStateSyncController, AppStateStore) {
        let url = URL(string: "http://127.0.0.1:54321")!
        let transport = BackendTransport(endpoint: try BackendEndpoint(url), data: { request in
            let data = await server.fetch()
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }, bytes: { _ in throw URLError(.unsupportedURL) })
        let store = AppStateStore()
        return (AppStateSyncController(store: store, baseURL: url, transport: transport, artifactsChanged: {}), store)
    }
    func testConcurrentSnapshotRefreshesShareOneRequest() async throws {
        let server = SnapshotTestServer()
        let (controller, store) = try makeController(server)
        let tasks = (0..<20).map { _ in Task { await controller.refreshSnapshot() } }
        while await server.requests == 0 { await Task.yield() }
        for _ in 0..<30 { await Task.yield() }
        let requests = await server.requests
        XCTAssertEqual(requests, 1)
        XCTAssertTrue(controller.isProcessingEvents)
        await server.release()
        for task in tasks { await task.value }
        XCTAssertEqual(store.revision, 1)
        XCTAssertFalse(controller.isProcessingEvents)
    }
    func testNewerGapRequiresSnapshotToReachItsRevision() async throws {
        let server = SnapshotTestServer()
        let (controller, store) = try makeController(server)
        let first = Task { await controller.refreshSnapshot(minimumRevision: 1) }
        while await server.requests == 0 { await Task.yield() }
        let newer = Task { await controller.refreshSnapshot(minimumRevision: 5) }
        for _ in 0..<20 { await Task.yield() }
        await server.release()
        await first.value; await newer.value
        XCTAssertEqual(store.revision, 5)
        let count = await server.requests
        XCTAssertEqual(count, 2)
    }
    func testStopRejectsResponseFromCancelledSnapshotEvenIfTransportReturns() async throws {
        let server = SnapshotTestServer()
        let (controller, store) = try makeController(server)
        let task = Task { await controller.refreshSnapshot() }
        while await server.requests == 0 { await Task.yield() }
        controller.stop()
        await server.release()
        await task.value
        XCTAssertEqual(store.revision, 0)
        XCTAssertFalse(controller.isProcessingEvents)
    }
    func testTypedDecoderKeepsUnknownEventsOutOfState() async throws {
        let decoder = StateStreamDecoder()
        let frame = try await decoder.decodeFrame(name: "unknown", data: "not-json")
        guard case .ignored = frame else { return XCTFail("Unknown frame must not be decoded as state") }
        do {
            _ = try await decoder.decodeFrame(name: "state-snapshot", data: "not-json")
            XCTFail("Malformed state must fail")
        } catch { }
    }
}
