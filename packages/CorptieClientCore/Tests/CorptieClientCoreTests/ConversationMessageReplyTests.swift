import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationMessageReplyTests {
    private func message(_ id: String, question: String? = nil, target: String? = nil,
                         text: String = "answer") throws -> ClientMessage {
        var object: [String: Any] = ["id": id, "type": question == nil ? "agentMessage" : "userMessage",
                                     "text": question ?? text]
        if let target {
            object["rawMetadataJSON"] = #"{"requestId":"request:\#(target)","replyToMessageId":"\#(target)","sourceSessionId":"logical:shadow"}"#
        }
        return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: object))
    }

    @Test func projectsMetadataAndSurvivesCacheRoundTrip() throws {
        let value = try message("reply:1", target: "question:1")
        #expect(value.replyAssociation?.requestId == "request:question:1")
        #expect(value.replyAssociation?.replyToMessageId == "question:1")
        #expect(value.replyAssociation?.sourceSessionId == "logical:shadow")
        let restored = try JSONDecoder().decode(ClientMessage.self, from: JSONEncoder().encode(value))
        #expect(restored == value)
        #expect(try message("legacy").replyAssociation == nil)
    }

    @Test func acceptsSanitizedAssociationWithoutRawMetadata() throws {
        let data = Data(#"{"id":"reply","type":"agentMessage","text":"answer","replyAssociation":{"requestId":"r","replyToMessageId":"q","sourceSessionId":"logical:shadow"}}"#.utf8)
        let value = try JSONDecoder().decode(ClientMessage.self, from: data)
        #expect(value.replyAssociation?.replyToMessageId == "q")
        #expect(value.rawMetadataJSON == nil)
    }

    @Test func malformedOrPartialMetadataDoesNotBreakMessageDecoding() throws {
        for raw in ["not JSON", "[]", #"{"requestId":"r"}"#, #"{"replyToMessageId":" "}"#, #"{"replyToMessageId":123}"#] {
            let data = try JSONSerialization.data(withJSONObject: ["id": "m", "type": "agentMessage", "text": "answer", "rawMetadataJSON": raw])
            #expect(try JSONDecoder().decode(ClientMessage.self, from: data).replyAssociation == nil)
        }
    }

    @Test func outOfOrderRepliesKeepTheirTargetsAndStreamingIdentity() throws {
        let q1 = try message("q1", question: "First question")
        let q2 = try message("q2", question: "Second question")
        let a2 = try message("stream:2", target: "q2", text: "partial")
        let a1 = try message("stream:1", target: "q1")
        let updated = try message("stream:2", target: "q2", text: "complete")
        let result = ClientTimelineWindowReconciler.reconcile(existing: [q1, q2, a2, a1],
            incoming: [q1, q2, updated, a1], nextBefore: nil, existingBefore: nil,
            authoritativeItemIds: [q1.id, q2.id, updated.id, a1.id])
        #expect(result.messages.map(\.id) == ["q1", "q2", "stream:2", "stream:1"])
        #expect(result.messages[2].text == "complete")
        #expect(result.messages[2].replyAssociation?.replyToMessageId == "q2")
        #expect(result.messages[3].replyAssociation?.replyToMessageId == "q1")
        #expect(a1.replyAssociation?.label(question: q1.text) == "回复：First question")
        #expect(a1.replyAssociation?.label(question: nil) == "回复：q1")
        #expect((a1.replyAssociation?.label(question: String(repeating: "x", count: 500)).count ?? 0) <= 183)
    }

    @Test func requestControlsAreAvailableByRequestState() throws {
        for (state, expected) in [("accepted", "cancel"), ("queued", "cancel"), ("preparing", "cancel"),
                                  ("running", "cancel"), ("waiting", "cancel"), ("failed", "retry"),
                                  ("completed", nil), ("cancelled", nil), ("future-state", nil)] as [(String, String?)] {
            let data = try JSONSerialization.data(withJSONObject: ["requestId": "r", "messageId": "m", "status": state])
            let request = try JSONDecoder().decode(ClientCoordinationRequest.self, from: data)
            #expect(request.controlAction == expected)
        }
    }

    @Test func requestListRemainsOptionalAndKeepsServerOrder() throws {
        let old = try JSONDecoder().decode(ClientCoordinationExecution.self, from: Data(#"{"status":"off","reason":"","requests":[]}"#.utf8))
        #expect(old.requests?.isEmpty == true)
        let absent = try JSONDecoder().decode(ClientCoordinationExecution.self, from: Data(#"{"status":"off","reason":""}"#.utf8))
        #expect(absent.requests == nil)
        let current = try JSONDecoder().decode(ClientCoordinationExecution.self, from: Data(#"{"status":"off","reason":"","requests":[{"requestId":"active","messageId":"m2","status":"running"},{"requestId":"failed","messageId":"m1","status":"failed"}]}"#.utf8))
        #expect(current.requests?.map(\.requestId) == ["active", "failed"])

    }
}
