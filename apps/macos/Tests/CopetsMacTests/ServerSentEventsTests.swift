import XCTest
@testable import CorptieMac

final class ServerSentEventsTests: XCTestCase {
    func testDecodesConsecutiveFramesFromRawBytesWithoutDependingOnAsyncLines() {
        var parser = ServerSentEventParser()
        let wire = """
        id: 21
        event: SessionTimelineChanged
        data: {"revision":1}

        id: 22
        event: AgentWorkCompleted
        data: first
        data: second
        

        """

        let events = Array(wire.utf8).flatMap { parser.append($0) } + parser.finish()

        XCTAssertEqual(events, [
            ServerSentEvent(id: "21", name: "SessionTimelineChanged", data: "{\"revision\":1}"),
            ServerSentEvent(id: "22", name: "AgentWorkCompleted", data: "first\nsecond")
        ])
    }

    func testIgnoresHeartbeatFramesAndDispatchesFollowingEvent() {
        var parser = ServerSentEventParser()
        let wire = ": keepalive\n\nid: 7\nevent: state-change-set\ndata: {}\n\n"

        let events = Array(wire.utf8).flatMap { parser.append($0) }

        XCTAssertEqual(events, [
            ServerSentEvent(id: nil, name: "", data: "", isComment: true),
            ServerSentEvent(id: "7", name: "state-change-set", data: "{}")
        ])
    }
}
