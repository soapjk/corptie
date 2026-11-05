import Foundation
import Testing
@testable import CorptieClientCore

struct ExecutionChecklistTests {
    @Test func taskChecklistRetainsIdentityAndStaysOutsideProcessing() throws {
        let source: [String: Any] = [
            "id": "checklist:task:one", "type": "executionChecklist", "turnId": "turn:one", "text": "执行清单 1/2",
            "executionPlan": ["schemaVersion": 1, "planId": "checklist:task:one", "taskId": "task:one", "revision": 3,
                "lifecycle": "paused", "completedCount": 1, "stopReason": "user_interrupted", "executionAvailable": false,
                "updatedAt": "2026-11-03T00:00:00Z", "steps": [
                    ["stepId": "item:one", "ordinal": 0, "text": "实现", "status": "completed", "condition": "类型一致"],
                    ["stepId": "item:two", "ordinal": 1, "text": "验证", "status": "blocked", "reason": "需要用户输入"]]]
        ]
        let item = try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: source))
        let plan = try #require(item.executionPlan)
        #expect(plan.taskId == "task:one")
        #expect(plan.completedCount == 1)
        #expect(plan.executionAvailable == false)
        #expect(plan.steps[1].reason == "需要用户输入")
        let entries = ConversationTimeline.makeEntries(from: [item])
        #expect(entries.count == 1)
        #expect(!entries[0].isProcessGroup)
        #expect(item.presentationKind == .executionPlan)
    }
    @Test func mutationPreservesOperationIdentityForSafeRetry() throws {
        let command = ExecutionChecklistCommand(action: "status", revision: 7, itemID: "item:one", status: "pending")
        let first = try JSONEncoder().encode(command), second = try JSONEncoder().encode(command)
        let firstObject = try #require(JSONSerialization.jsonObject(with: first) as? NSDictionary)
        let secondObject = try #require(JSONSerialization.jsonObject(with: second) as? NSDictionary)
        #expect(firstObject == secondObject)
        #expect(firstObject["expectedRevision"] as? Int == 7)
        #expect(firstObject["taskId"] == nil)
    }
    @Test func childAssignmentDecodesAndCommandsReuseTheExistingEndpointShape() throws {
        let data = Data(#"{"schemaVersion":1,"planId":"plan:one","revision":1,"lifecycle":"active","updatedAt":"now","steps":[{"stepId":"one","ordinal":0,"text":"API","status":"pending","assignment":{"taskId":"task:child","dispatchId":"dispatch:one","title":"API child","status":"running"}},{"stepId":"two","ordinal":1,"text":"Verify","status":"pending"}]}"#.utf8)
        let plan = try JSONDecoder().decode(ConversationExecutionPlan.self, from: data)
        #expect(plan.steps[0].assignment?.taskId == "task:child")
        #expect(plan.steps[1].assignment == nil)
        let command = ExecutionChecklistCommand(action: "assign", revision: 1, itemIDs: ["one", "two"], dispatchID: "dispatch:one")
        let fields = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(command)) as? [String: Any])
        #expect(fields["itemIds"] as? [String] == ["one", "two"])
        #expect(fields["dispatchId"] as? String == "dispatch:one")
        #expect(fields["taskId"] == nil)
    }

}
