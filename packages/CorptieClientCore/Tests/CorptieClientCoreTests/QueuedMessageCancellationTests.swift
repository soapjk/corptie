import Foundation
import Testing
@testable import CorptieClientCore

struct QueuedMessageCancellationTests {
    @Test func onlyAuthoritativelyQueuedUserMessagesCanBeCancelled() throws {
        for state in ["queued", "processing", "consumed", "failed", "cancelled"] {
            for type in ["userMessage", "agentMessage"] {
                let data = try JSONSerialization.data(withJSONObject: ["id": "m", "type": type,
                    "text": "test", "userMessageStatus": state, "queuedMessageTaskId": "operation:1"])
                let message = try JSONDecoder().decode(ClientMessage.self, from: data)
                #expect(message.cancellableQueuedMessageTaskID ==
                    (state == "queued" && type == "userMessage" ? "operation:1" : nil))
            }
        }
        #expect(ClientMessage(id: "local", text: "pending").cancellableQueuedMessageTaskID == nil)
    }
}
