import XCTest
@testable import CorptieMac

final class SuggestedOptionRoutingTests: XCTestCase {
    func testRoutesAnOptionToTheLatestMatchingPendingChoice() {
        let older = choice(
            id: "choice-1",
            status: "selected",
            optionId: "question-0-option-0"
        )
        let pending = choice(
            id: "choice-2",
            status: "pending",
            optionId: "question-1-option-1"
        )

        XCTAssertEqual(
            SuggestedOptionRouting.pendingChoiceId(
                for: "question-1-option-1",
                items: [older, pending]
            ),
            "choice-2"
        )
    }

    func testLeavesOrdinarySuggestedMessagesOnTheMessagePath() {
        let message = CodexThreadItem(
            id: "message-1",
            turnId: "turn-1",
            turnStatus: "complete",
            type: "agentMessage",
            title: "Agent",
            text: "Choose a follow-up",
            options: [option(id: "follow-up")],
            status: nil,
            createdAt: nil
        )

        XCTAssertNil(
            SuggestedOptionRouting.pendingChoiceId(
                for: "follow-up",
                items: [message]
            )
        )
    }

    private func choice(id: String, status: String, optionId: String) -> CodexThreadItem {
        CodexThreadItem(
            id: id,
            turnId: "turn-1",
            turnStatus: "running",
            type: "choice",
            title: "Question",
            text: "Pick one",
            options: [option(id: optionId)],
            status: status,
            createdAt: nil
        )
    }

    private func option(id: String) -> CodexApprovalOption {
        CodexApprovalOption(
            id: id,
            label: id,
            role: "message-choice",
            index: 0,
            selected: false
        )
    }
}
