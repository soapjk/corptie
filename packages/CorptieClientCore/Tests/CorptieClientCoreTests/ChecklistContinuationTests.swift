import XCTest
@testable import CorptieClientCore

final class ChecklistContinuationTests: XCTestCase {
    func testOldPlansRemainProgressOnly() throws {
        let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: Data(#"{"schemaVersion":1,"planId":"old","revision":1,"lifecycle":"active","steps":[],"updatedAt":"now"}"#.utf8))
        XCTAssertNil(plan.continuation)
    }
    func testPauseIsExecutionStateRatherThanACompletionClaim() throws {
        let state = try JSONDecoder().decode(ClientChecklistContinuation.self, from: Data(#"{"enabled":true,"state":"paused_budget","generation":3,"pauseReason":"budget","reason":"Budget exhausted","nextStepIds":["verify"],"canPause":false,"canResume":false}"#.utf8))
        XCTAssertEqual(state.statusTitle, "验证预算已用尽")
        XCTAssertFalse(state.canResume)
    }
    func testARealDecisionRequiresVisibleQuestionAndPendingState() throws {
        let decoder = JSONDecoder()
        let value = #"{"id":"decision:1","revision":1,"status":"pending","question":"Which retention policy?","options":[],"allowsText":true}"#
        let decision = try decoder.decode(ClientCoordinationDecision.self, from: Data(value.utf8))
        XCTAssertTrue(decision.isPending)
        let resolved = value.replacingOccurrences(of: "pending", with: "answered")
        XCTAssertFalse(try decoder.decode(ClientCoordinationDecision.self, from: Data(resolved.utf8)).isPending)
    }
    func testPhasesAndExecutionStateSurviveTheSharedTimelineContract() throws {
        let data = Data(#"{"schemaVersion":1,"planId":"plan","taskId":"task","revision":2,"lifecycle":"active","updatedAt":"now","steps":[{"stepId":"verify","ordinal":1,"text":"Verify","status":"pending","phase":"verification","dependsOnStepIds":["implement"]}],"continuation":{"enabled":true,"state":"waiting_dependency","generation":1,"nextStepIds":["verify"],"canPause":true,"canResume":false}}"#.utf8)
        let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: data)
        XCTAssertEqual(plan.steps[0].phase, "verification")
        XCTAssertEqual(plan.steps[0].dependsOnStepIds, ["implement"])
        XCTAssertEqual(plan.continuation?.state, "waiting_dependency")
        var command = ExecutionChecklistCommand(action: "pause", revision: 2)
        command.planId = plan.planId
        let fields = try JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as! [String: Any]
        XCTAssertEqual(fields["planId"] as? String, "plan")
        XCTAssertEqual(fields["action"] as? String, "pause")
    }
    func testHostDecisionUsesSharedQuestionRenderingContract() throws {
        let data = Data(#"{"schemaVersion":1,"kind":"coordination_decision","responseMode":"answers","isBlocking":false,"canCancel":false,"questions":[{"id":"decision:1:2","header":"需要你决定","question":"Which policy?","isOther":true,"isSecret":false}]}"#.utf8)
        let input = try JSONDecoder().decode(ConversationUserInput.self, from: data)
        XCTAssertEqual(input.kind, "coordination_decision")
        XCTAssertEqual(input.questions[0].id, "decision:1:2")
    }

    func testProgressShowsExecutionPauseSeparatelyFromAUserQuestion() throws {
        let source = #"{"assignmentId":"step","title":"Implement","state":"paused","summary":"","reason":"","updatedAt":"now"}"#
        let item = try JSONDecoder().decode(ClientCoordinationProgressItem.self, from: Data(source.utf8))
        XCTAssertEqual(item.statusTitle, "已暂停")
        XCTAssertEqual(item.statusSymbol, "pause.circle")
    }

}
