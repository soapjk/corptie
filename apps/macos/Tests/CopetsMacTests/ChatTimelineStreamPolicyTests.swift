import XCTest
@testable import CorptieMac

final class ChatTimelineStreamPolicyTests: XCTestCase {
    func testHealthySelectedStreamSuppressesSnapshotPolling() {
        XCTAssertFalse(ChatDetailRefreshPolicy.shouldPoll(
            sessionId: "session-a",
            isViewingHistory: false,
            streamHealth: .healthy(sessionId: "session-a")
        ))
    }

    func testConnectingFallbackAndMismatchedStreamsKeepPollingAvailable() {
        for health: ChatDetailStreamHealth in [
            .connecting(sessionId: "session-a"),
            .fallback(sessionId: "session-a"),
            .healthy(sessionId: "session-b")
        ] {
            XCTAssertTrue(ChatDetailRefreshPolicy.shouldPoll(
                sessionId: "session-a",
                isViewingHistory: false,
                streamHealth: health
            ))
        }
    }

    func testHistoricalAndClosedDetailsNeverPoll() {
        XCTAssertFalse(ChatDetailRefreshPolicy.shouldPoll(
            sessionId: "session-a",
            isViewingHistory: true,
            streamHealth: .fallback(sessionId: "session-a")
        ))
        XCTAssertFalse(ChatDetailRefreshPolicy.shouldPoll(
            sessionId: nil,
            isViewingHistory: false,
            streamHealth: .inactive
        ))
    }

    func testReconnectBackoffIsBounded() {
        XCTAssertEqual(ChatDetailRefreshPolicy.reconnectDelaySeconds(afterFailure: 0), 0)
        XCTAssertEqual(ChatDetailRefreshPolicy.reconnectDelaySeconds(afterFailure: 1), 2)
        XCTAssertEqual(ChatDetailRefreshPolicy.reconnectDelaySeconds(afterFailure: 2), 4)
        XCTAssertEqual(ChatDetailRefreshPolicy.reconnectDelaySeconds(afterFailure: 5), 30)
        XCTAssertEqual(ChatDetailRefreshPolicy.reconnectDelaySeconds(afterFailure: 20), 30)
    }
}
