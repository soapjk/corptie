import XCTest
@testable import CorptieMac

@MainActor
final class ConversationWelcomeTests: XCTestCase {
    private func detail(items: [CodexThreadItem] = [], turns: Int = 0) -> CodexThreadDetail {
        CodexThreadDetail(
            id: "thread", title: "Assistant", status: .complete, source: nil,
            connectionStatus: nil, currentModel: nil, currentReasoningLevel: nil,
            activityStatus: nil, cwd: nil, createdAt: "", updatedAt: "",
            canSend: true, sendUnavailableReason: nil, capabilities: nil,
            turnCount: turns, items: items
        )
    }

    private func welcome(_ detail: CodexThreadDetail?, assistant: Bool = true,
                         loading: Bool = false, error: Bool = false,
                         submitted: Bool = false) -> Bool {
        ConversationWelcomePolicy.showsWelcome(
            detail: detail, sessionID: "assistant", isAssistant: assistant,
            isLoading: loading, hasLoadError: error, hasSubmittedMessage: submitted
        )
    }

    func testOnlyConfirmedEmptyHistoryIsWelcomed() {
        XCTAssertTrue(welcome(detail()))
        XCTAssertTrue(welcome(detail(), assistant: false))
        XCTAssertFalse(welcome(nil))
        XCTAssertFalse(welcome(detail(), loading: true))
        XCTAssertFalse(welcome(detail(), error: true))
        XCTAssertFalse(welcome(detail(turns: 2)))
        var paged = detail()
        paged.hasMoreHistory = true
        XCTAssertFalse(welcome(paged))
        paged.hasMoreHistory = false
        paged.historyItemsCount = 12
        XCTAssertFalse(welcome(paged))
    }

    func testProductIntroductionIsWelcomeUntilConversationBegins() {
        let intro = CodexThreadItem(
            id: "first-run:introduction:v1:assistant", turnId: "intro", turnStatus: "completed",
            type: "agentMessage", title: "Corptie", text: "Welcome",
            options: nil, status: "completed", createdAt: nil
        )
        XCTAssertTrue(welcome(detail(items: [intro], turns: 1)))
        XCTAssertFalse(welcome(detail(items: [intro]), assistant: false))
        XCTAssertFalse(welcome(detail(items: [intro]), submitted: true))
        let reply = CodexThreadItem(
            id: "user", turnId: "turn", turnStatus: "running", type: "userMessage",
            title: "User", text: "Help", options: nil, status: "queued", createdAt: nil
        )
        XCTAssertFalse(welcome(detail(items: [intro, reply], turns: 1)))
        XCTAssertFalse(welcome(detail(items: [reply])))
    }

    func testAcknowledgedFirstSendAndDelayedSnapshotNeverRestoreWelcome() {
        let fixture = ChatPerformanceFixture.make(configuration: .init(
            turnCount: 1, rawItemCount: 3, longMessageCharacters: 32
        ))
        let empty = detail()
        let overlay = SessionTimelineLocalOverlay()
        let acknowledged = overlay.acknowledge(
            "How do I begin?", messageID: "first", deliveryID: "delivery",
            to: fixture.session, residentDetail: empty, now: "2026-10-23T00:00:00Z"
        )
        XCTAssertTrue(welcome(empty))
        // Accepted submission moves the composer before its HTTP echo arrives.
        XCTAssertFalse(welcome(empty, submitted: true))
        XCTAssertFalse(welcome(acknowledged))
        XCTAssertFalse(welcome(overlay.reconcile(empty, for: fixture.session.id)))
    }
}
