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
