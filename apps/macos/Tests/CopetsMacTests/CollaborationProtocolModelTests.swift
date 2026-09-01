import XCTest
@testable import CorptieMac

final class CollaborationProtocolModelTests: XCTestCase {
    func testSessionChannelDecodesEqualParticipantsAndBidirectionalMessages() throws {
        let data = Data(#"""
        {
          "channel": {
            "channelId": "channel:1",
            "sessionAId": "session:a",
            "sessionBId": "session:b",
            "status": "active",
            "requestedBySessionId": "session:a",
            "authorizedAt": "2026-08-31T00:00:00.000Z",
            "revokedAt": null,
            "revocationReason": null,
            "resourceVersion": 1,
            "createdAt": "2026-08-31T00:00:00.000Z",
            "updatedAt": "2026-08-31T00:01:00.000Z"
          },
          "messages": [
            {
              "messageId": "channel_message:1",
              "channelId": "channel:1",
              "senderSessionId": "session:b",
              "recipientSessionId": "session:a",
              "messageKind": "message",
              "body": "Proactive reply",
              "inReplyToMessageId": null,
              "resourceContext": {},
              "idempotencyKey": "reply:1",
              "createdAt": "2026-08-31T00:01:00.000Z"
            }
          ]
        }
        """#.utf8)

        let response = try JSONDecoder().decode(SessionCollaborationChannelResponse.self, from: data)
        XCTAssertEqual(response.channel.sessionAId, "session:a")
        XCTAssertEqual(response.channel.sessionBId, "session:b")
        XCTAssertEqual(response.messages.first?.senderSessionId, "session:b")
        XCTAssertEqual(response.messages.first?.recipientSessionId, "session:a")
    }

    func testTaskC4471174DecodesHistoricalInitiatorSnapshotAndStableIdentities() throws {
        let data = Data(#"""
        {
          "taskId": "c4471174-177e-4fe9-ab1d-cd10e070da35",
          "contextId": "context:c4471174",
          "parentTaskId": null,
          "protocolVersion": "2.0",
          "sourceObjectiveId": "objective:source",
          "targetObjectiveId": "objective:target",
          "sourceTaskId": "task:source",
          "taskId": "task:target",
          "initiatorAgentId": "agent:initiator",
          "recipientAgentId": "agent:recipient",
          "initiatorSessionId": "session:historical-initiator",
          "recipientSessionId": "session:recipient-current",
          "initiatorNameAtSend": "Historical Initiator Session",
          "recipientNameAtSend": "Recipient Worker Session",
          "routingVersion": 7,
          "routeStatus": "active",
          "routingIntent": "existing_task_session",
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
        XCTAssertEqual(task.routingIntent, "existing_task_session")
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
          "initiatorCorptieTaskId": "task:source",
          "recipientSessionId": "logical:target",
          "recipientSessionTitle": "One-hour shadow",
          "recipientSessionKind": "worker",
          "recipientCorptieTaskId": "task:target",
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
        XCTAssertEqual(confirmation.recipientCorptieTaskId, "task:target")
        XCTAssertEqual(confirmation.routingVersion, 3)
    }

    func testMessageEnvelopeDecodesObjectiveCorptieTaskPayloadAndErrorContract() throws {
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
              "sourceTaskId": "task:source",
              "targetTaskId": "task:target"
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
        XCTAssertEqual(message.envelope?.resources.sourceTaskId, "task:source")
        XCTAssertEqual(message.envelope?.resources.targetTaskId, "task:target")
        XCTAssertEqual(message.envelope?.payload.evidence?.count, 1)
        XCTAssertNil(message.envelope?.error)
    }
}
