import XCTest
@testable import CorptieMac

final class CollaborationProtocolModelTests: XCTestCase {
    func testMessageEnvelopeDecodesObjectiveWorkItemPayloadAndErrorContract() throws {
        let data = Data(#"""
        {
          "messageId": "message:1",
          "taskId": "task:1",
          "senderAgentId": "agent:a",
          "recipientAgentId": "agent:b",
          "messageType": "change_request",
          "body": "Implement it",
          "resourceVersion": "v1",
          "createdAt": "2026-08-20T00:00:00.000Z",
          "envelope": {
            "version": "2.0",
            "messageId": "message:1",
            "messageType": "change_request",
            "sender": { "agentId": "agent:a", "objectiveId": "objective:a" },
            "recipient": { "agentId": "agent:b", "objectiveId": "objective:b" },
            "objective": { "sourceId": "objective:a", "targetId": "objective:b" },
            "workItem": { "sourceId": "work_item:source", "id": "work_item:target" },
            "taskId": "task:1",
            "payload": {
              "body": "Implement it",
              "evidence": [{ "type": "test", "passed": true }],
              "resourceVersion": "v1"
            },
            "timestamp": "2026-08-20T00:00:00.000Z",
            "error": null
          }
        }
        """#.utf8)

        let message = try JSONDecoder().decode(CollaborationMessage.self, from: data)
        XCTAssertEqual(message.envelope?.version, "2.0")
        XCTAssertEqual(message.envelope?.objective.sourceId, "objective:a")
        XCTAssertEqual(message.envelope?.objective.targetId, "objective:b")
        XCTAssertEqual(message.envelope?.workItem.sourceId, "work_item:source")
        XCTAssertEqual(message.envelope?.workItem.id, "work_item:target")
        XCTAssertEqual(message.envelope?.payload.evidence?.count, 1)
        XCTAssertNil(message.envelope?.error)
    }
}
