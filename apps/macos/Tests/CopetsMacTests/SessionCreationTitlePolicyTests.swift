import XCTest
@testable import CorptieMac

final class SessionCreationTitlePolicyTests: XCTestCase {
    func testWorkItemTitleWinsForWorkerSessionCreation() {
        XCTAssertEqual(
            SessionCreationTitlePolicy.defaultTitle(
                workItemTitle: "  修复会话命名  ",
                suggestedAgentTitle: "Builder_Session_2",
                agentName: "Builder"
            ),
            "修复会话命名"
        )
    }

    func testOrdinaryAgentSessionKeepsExistingSuggestedTitlePolicy() {
        XCTAssertEqual(
            SessionCreationTitlePolicy.defaultTitle(
                workItemTitle: nil,
                suggestedAgentTitle: "Builder_Session_2",
                agentName: "Builder"
            ),
            "Builder_Session_2"
        )
        XCTAssertEqual(
            SessionCreationTitlePolicy.defaultTitle(
                workItemTitle: nil,
                suggestedAgentTitle: nil,
                agentName: "Builder"
            ),
            "Builder_Session"
        )
    }

    func testWorkerSessionRetryRecognizesAChangedAuthoritativeBinding() {
        XCTAssertEqual(
            WorkerSessionBackgroundRetryDecision.resolve(
                baselineSessionId: nil,
                currentSessionId: "session:new"
            ),
            .alreadyCreated
        )
        XCTAssertEqual(
            WorkerSessionBackgroundRetryDecision.resolve(
                baselineSessionId: "session:old",
                currentSessionId: "session:new"
            ),
            .alreadyCreated
        )
    }

    func testWorkerSessionRetryCreatesWhenBindingDidNotChange() {
        XCTAssertEqual(
            WorkerSessionBackgroundRetryDecision.resolve(
                baselineSessionId: nil,
                currentSessionId: nil
            ),
            .create
        )
        XCTAssertEqual(
            WorkerSessionBackgroundRetryDecision.resolve(
                baselineSessionId: "session:old",
                currentSessionId: " session:old "
            ),
            .create
        )
    }
}
