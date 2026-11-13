import Foundation
import Testing
@testable import CorptieClientCore

struct SubagentActivityTests {
    func item(_ id: String, child: String = "a", event: String, status: String) throws -> ClientMessage {
        let data: [String: Any] = ["id": id, "type": "subAgentActivity", "text": "", "turnStatus": "inProgress",
            "subagentActivity": ["schemaVersion": 1, "activityId": id, "childId": child, "name": child, "event": event, "status": status]]
        return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: data))
    }
    @Test func notificationsAggregateAndFollowupDoesNotImplyRunning() throws {
        let a = try item("a1", event: "started", status: "running")
        let done = try item("a2", event: "completed", status: "completed")
        let followup = try item("a3", event: "interacted", status: "unknown")
        let b = try item("b1", child: "b", event: "started", status: "running")
        let items = [a,b,done,followup,followup]
        let steps = ConversationExecutionProjection.steps(for: items)
        #expect(steps.count == 2)
        #expect(steps[0].state == .unknown)
        #expect(steps[0].subagent?.activities.count == 3)
        #expect(steps[1].state == .running)
        #expect(ConversationExecutionProjection.displayedCount(for: items) == 2)
        #expect(ConversationExecutionProjection.subagentCount(for: items) == 2)
        #expect(ConversationProcessPresentation(state: .running, count: 2, subagentCount: 2).summary(languageCode: "zh").contains("2 个子 agent"))
    }
    @Test func terminalAndLargeHistoryRemainStable() throws {
        let items = try (0..<2000).map { try item("e\($0)", child: "child\($0 % 20)", event: "completed", status: "completed") }
        let steps = ConversationExecutionProjection.steps(for: items)
        #expect(steps.count == 20)
        #expect(steps.allSatisfy { $0.state == .completed && $0.subagent?.activities.count == 100 })
        #expect(steps == ConversationExecutionProjection.steps(for: items))
    }
}
