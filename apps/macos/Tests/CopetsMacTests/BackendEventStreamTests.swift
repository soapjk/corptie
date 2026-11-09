import Foundation
import CorptieClientCore
import XCTest
@testable import CorptieMac

final class BackendEventStreamTests: XCTestCase {
    func testOrdinaryAcknowledgementCannotMoveCursorBackwards() {
        XCTAssertEqual(cursor(10, id: "12"), 12)
        XCTAssertEqual(cursor(10, id: "3"), 10)
        XCTAssertEqual(cursor(10, id: nil), 10)
        XCTAssertEqual(cursor(10, id: "invalid"), 10)
    }

    func testReplayRebasesCursorEvenWhenBackendSequenceRestarted() {
        XCTAssertEqual(cursor(100, id: "101", name: "EventReplayRequired",
                              data: #"{"latestCursor":7}"#), 7)
        XCTAssertEqual(cursor(100, id: nil, name: "EventReplayRequired",
                              data: #"{"latestCursor":-1}"#), 0)
    }

    func testMalformedReplayUsesOrdinaryEventIdentifierFallback() {
        XCTAssertEqual(cursor(10, id: "11", name: "EventReplayRequired", data: "{}"), 11)
        XCTAssertEqual(cursor(10, id: nil, name: "EventReplayRequired", data: "bad"), 10)
    }

    func testCommentCannotAcknowledgeDelivery() {
        XCTAssertEqual(BackendEventStream.acknowledgedCursor(
            current: 10,
            event: ServerSentEvent(id: "20", name: "message", data: "", isComment: true)
        ), 10)
    }

    private func cursor(_ current: Int, id: String?, name: String = "message", data: String = "") -> Int {
        BackendEventStream.acknowledgedCursor(
            current: current,
            event: ServerSentEvent(id: id, name: name, data: data)
        )
    }
}

private final class EventEOFProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocolDidFinishLoading(self)
    }
}
extension BackendEventStreamTests {
    @MainActor func testCleanEOFBacksOffRatherThanRepeatedlyRunningConnected() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [EventEOFProtocol.self]
        let session = URLSession(configuration: config)
        let stream = BackendEventStream(baseURL: URL(string: "http://127.0.0.1:54321")!, urlSession: session)
        var connections = 0
        stream.start(connected: { connections += 1 }, disconnected: {}, receive: { _, _ in })
        defer { stream.stop(); session.invalidateAndCancel() }
        let deadline = ContinuousClock.now + .seconds(2)
        while connections == 0, ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(connections, 1)
    }
}

private final class TimelineWakeProtocol: URLProtocol, @unchecked Sendable {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func stopLoading() {}
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200,
            httpVersion: nil, headerFields: ["Content-Type": "text/event-stream"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("id: 1\nevent: SessionTimelineChanged\ndata: {}\n\n".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

extension BackendEventStreamTests {
    @MainActor
    func testTimelineWakeDoesNotWaitForSlowConnectionRecovery() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [TimelineWakeProtocol.self]
        let session = URLSession(configuration: config)
        let stream = BackendEventStream(baseURL: URL(string: "http://127.0.0.1:54321")!, urlSession: session)
        var received = false
        var recoveryFinished = false
        stream.start(connected: {
            try? await Task.sleep(for: .seconds(30))
            if !Task.isCancelled { recoveryFinished = true }
        }, disconnected: {}, receive: { name, _ in
            if name == "SessionTimelineChanged" { received = true }
        })
        defer { stream.stop(); session.invalidateAndCancel() }
        let deadline = ContinuousClock.now + .seconds(2)
        while !received && ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTAssertTrue(received)
        XCTAssertFalse(recoveryFinished)
    }
}
