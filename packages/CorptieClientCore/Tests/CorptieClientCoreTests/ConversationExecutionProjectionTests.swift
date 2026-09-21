import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationExecutionProjectionTests {
    @Test func toolSummariesStayBoundedAndPreserveIdentityAndState() throws {
        let source: [[String: String]] = [
            ["id": "context", "type": "contextCompaction", "text": "compacted", "title": "internal", "turnStatus": "running"],
            ["id": "tool", "type": "commandExecution", "text": "Build:\n" + String(repeating: "x", count: 500), "title": "Build", "status": "failed", "turnStatus": "running"],
            ["id": "progress", "type": "agentMessage", "text": "checking", "turnStatus": "running"]]
        let items = try JSONDecoder().decode([ClientMessage].self, from: JSONSerialization.data(withJSONObject: source))
        let steps = ConversationExecutionProjection.steps(for: items)
        #expect(steps.map(\.id) == ["context", "tool", "progress"])
        #expect(steps.map(\.kind) == [.context, .action, .context])
        #expect(steps.map(\.state) == [.completed, .failed, .running])
        #expect(steps[0].title == "Context compacted")
        #expect(steps[1].detail?.count == 180)
        #expect(steps[1].detail?.hasSuffix("…") == true)
        #expect(steps[1].detail?.contains("Build:") == false)
        #expect(ConversationExecutionProjection.plainText(for: steps).contains("[Execution Action] Build"))
    }
}
