import XCTest
@testable import CorptieMac

final class CollaborationProtocolModelTests: XCTestCase {
    func testTaskC4471174DecodesHistoricalInitiatorSnapshotAndStableIdentities() throws {
        let data = Data(#"""
        {
          "taskId": "c4471174-177e-4fe9-ab1d-cd10e070da35",
          "contextId": "context:c4471174",
          "parentTaskId": null,
          "protocolVersion": "2.0",
          "sourceObjectiveId": "objective:source",
          "targetObjectiveId": "objective:target",
          "sourceWorkItemId": "work_item:source",
          "workItemId": "work_item:target",
          "initiatorAgentId": "agent:initiator",
          "recipientAgentId": "agent:recipient",
          "initiatorSessionId": "session:historical-initiator",
          "recipientSessionId": "session:recipient-current",
          "initiatorNameAtSend": "Historical Initiator Session",
          "recipientNameAtSend": "Recipient Worker Session",
          "routingVersion": 7,
          "routeStatus": "active",
          "routingIntent": "existing_work_item_session",
          "artifactStatus": "pending",
          "acceptanceStatus": "pending",
          "initiatorBindingId": "binding:historical",
          "recipientBindingId": "binding:recipient",
          "serviceId": null,
          "type": "change_request",
          "status": "proposed",
          "iteration": 1,
          "maxIterations": 3,
          "title": "Repair collaboration identity",
          "summary": "Preserve historical routing snapshots.",
          "acceptanceCriteria": [],
          "idempotencyKey": "request:repair-identity",
          "createdAt": "2026-08-23T00:00:00.000Z",
          "updatedAt": "2026-08-23T00:00:00.000Z",
          "completedAt": null,
          "messages": [],
          "artifacts": [],
          "events": []
        }
        """#.utf8)

        let task = try JSONDecoder().decode(CollaborationTask.self, from: data)
        XCTAssertEqual(task.initiatorAgentId, "agent:initiator")
        XCTAssertEqual(task.recipientAgentId, "agent:recipient")
        XCTAssertEqual(task.sourceObjectiveId, "objective:source")
        XCTAssertEqual(task.targetObjectiveId, "objective:target")
        XCTAssertEqual(task.initiatorSessionId, "session:historical-initiator")
        XCTAssertEqual(task.recipientSessionId, "session:recipient-current")
        XCTAssertEqual(task.initiatorNameAtSend, "Historical Initiator Session")
        XCTAssertEqual(task.recipientNameAtSend, "Recipient Worker Session")
        XCTAssertEqual(task.routingVersion, 7)
        XCTAssertEqual(task.routingIntent, "existing_work_item_session")
        XCTAssertEqual(task.idempotencyKey, "request:repair-identity")
    }

    func testPendingConfirmationDecodesExplicitAgentSessionAndObjectiveRoute() throws {
        let data = Data(#"""
        {
          "confirmationId": "confirmation:1",
          "initiatorAgentId": "agent:source",
          "initiatorName": "Stable Source Agent",
          "recipientAgentId": "agent:target",
          "recipientName": "Stable Target Agent",
          "sourceObjectiveId": "objective:source",
          "sourceObjectiveName": "MarketCow",
          "targetObjectiveId": "objective:target",
          "targetObjectiveName": "PolyMarket 实时套利",
          "initiatorSessionId": "logical:source",
          "initiatorSessionTitle": "Snapshot repair",
          "initiatorSessionKind": "worker",
          "initiatorWorkItemId": "work_item:source",
          "recipientSessionId": "logical:target",
          "recipientSessionTitle": "One-hour shadow",
          "recipientSessionKind": "worker",
          "recipientWorkItemId": "work_item:target",
          "routeStatus": "active",
          "routingVersion": 3,
          "taskTitle": "Run shadow",
          "summary": "Use the selected Objective.",
          "acceptanceCriteria": []
        }
        """#.utf8)

        let confirmation = try JSONDecoder().decode(PendingCollaborationConfirmation.self, from: data)
        XCTAssertEqual(confirmation.initiatorName, "Stable Source Agent")
        XCTAssertEqual(confirmation.targetObjectiveName, "PolyMarket 实时套利")
        XCTAssertEqual(confirmation.recipientSessionTitle, "One-hour shadow")
        XCTAssertEqual(confirmation.recipientSessionKind, "worker")
        XCTAssertEqual(confirmation.recipientWorkItemId, "work_item:target")
        XCTAssertEqual(confirmation.routingVersion, 3)
    }

    func testMessageEnvelopeDecodesObjectiveWorkItemPayloadAndErrorContract() throws {
        let data = Data(#"""
        {
          "messageId": "message:1",
          "taskId": "task:1",
          "senderAgentId": "agent:a",
          "recipientAgentId": "agent:b",
          "senderSessionId": "session:a",
          "recipientSessionId": "session:b",
          "messageType": "change_request",
          "body": "Implement it",
          "evidence": [{ "type": "test", "passed": true }],
          "resourceVersion": "v1",
          "idempotencyKey": "message:implement-it",
          "createdAt": "2026-08-20T00:00:00.000Z",
          "envelope": {
            "version": "3.0",
            "messageId": "message:1",
            "messageType": "change_request",
            "sender": { "sessionId": "session:a" },
            "recipient": { "sessionId": "session:b" },
            "resources": {
              "sourceAgentId": "agent:a",
              "targetAgentId": "agent:b",
              "sourceObjectiveId": "objective:a",
              "targetObjectiveId": "objective:b",
              "sourceWorkItemId": "work_item:source",
              "targetWorkItemId": "work_item:target"
            },
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
        XCTAssertEqual(message.envelope?.version, "3.0")
        XCTAssertEqual(message.senderSessionId, "session:a")
        XCTAssertEqual(message.recipientSessionId, "session:b")
        XCTAssertEqual(message.evidence?.count, 1)
        XCTAssertEqual(message.idempotencyKey, "message:implement-it")
        XCTAssertEqual(message.envelope?.sender.sessionId, "session:a")
        XCTAssertEqual(message.envelope?.recipient.sessionId, "session:b")
        XCTAssertEqual(message.envelope?.resources.sourceObjectiveId, "objective:a")
        XCTAssertEqual(message.envelope?.resources.targetObjectiveId, "objective:b")
        XCTAssertEqual(message.envelope?.resources.sourceWorkItemId, "work_item:source")
        XCTAssertEqual(message.envelope?.resources.targetWorkItemId, "work_item:target")
        XCTAssertEqual(message.envelope?.payload.evidence?.count, 1)
        XCTAssertNil(message.envelope?.error)
    }
}
