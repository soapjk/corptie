import XCTest
@testable import CorptieMac

@MainActor
final class UserMessageProcessingStateTests: XCTestCase {
    func testAuthoritativeQueuedMessageDecodesPositionAndRoutesToVisibleStatusCard() throws {
        let item = try JSONDecoder().decode(
            CodexThreadItem.self,
            from: Data(
                """
                {
                  "id": "work:message-2",
                  "turnId": "work:message-2",
                  "turnStatus": "queued",
                  "type": "userMessage",
                  "title": "User",
                  "text": "Follow up",
                  "status": "queued",
                  "userMessageStatus": "queued",
                  "queuePosition": 2,
                  "createdAt": "2026-08-18T00:00:00.000Z"
                }
                """.utf8
            )
        )

        XCTAssertEqual(item.authoritativeUserMessageState, .queued)
        XCTAssertEqual(item.queuePosition, 2)
        XCTAssertEqual(ChatTimelineRowRouting.route(for: ChatDisplayEntry(kind: .message(item))), .swiftUI)
        XCTAssertEqual(makeChatDisplayEntries(from: [item]).count, 1)
    }

    func testProcessingAndTerminalStatesAreNotInferredFromTimelinePosition() throws {
        let ordinary = item(status: nil, userMessageStatus: nil)
        let processing = item(status: "running", userMessageStatus: "processing")
        let consumed = item(status: nil, userMessageStatus: "consumed")

        XCTAssertNil(ordinary.authoritativeUserMessageState)
        XCTAssertEqual(processing.authoritativeUserMessageState, .processing)
        XCTAssertEqual(consumed.authoritativeUserMessageState, .consumed)
        XCTAssertEqual(ChatTimelineRowRouting.route(for: ChatDisplayEntry(kind: .message(processing))), .swiftUI)
        XCTAssertEqual(ChatTimelineRowRouting.route(for: ChatDisplayEntry(kind: .message(consumed))), .native)
    }

    func testUnknownAuthoritativeStateDoesNotFallBackToLegacyQueuedStatus() {
        let future = item(status: "queued", userMessageStatus: "provider-injected")
        XCTAssertNil(future.authoritativeUserMessageState)
    }

    private func item(status: String?, userMessageStatus: String?) -> CodexThreadItem {
        CodexThreadItem(
            id: "message",
            turnId: "turn",
            turnStatus: "running",
            type: "userMessage",
            title: "User",
            text: "Message",
            options: nil,
            status: status,
            createdAt: "2026-08-18T00:00:00.000Z",
            userMessageStatus: userMessageStatus
        )
    }
}
