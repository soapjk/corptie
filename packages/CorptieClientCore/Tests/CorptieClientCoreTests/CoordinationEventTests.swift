import XCTest
@testable import CorptieClientCore

final class CoordinationEventTests: XCTestCase {
    func testStructuredProvenanceAndLegacyMetadata() throws {
        let decoder = JSONDecoder()
        let paired = try decoder.decode(ClientMessage.self, from: Data(#"{"id":"a","type":"agentMessage","text":"result","coordinationEvent":{"kind":"summary","batchId":"b"}}"#.utf8))
        XCTAssertEqual(paired.coordinationEvent?.kind, "summary")
        XCTAssertEqual(paired.coordinationEvent?.batchId, "b")
        XCTAssertEqual(ConversationCoordinationEvent(rawMetadataJSON: #"{"executionMode":"shadow_report"}"#)?.kind, "summary")
        XCTAssertEqual(ConversationCoordinationEvent(rawMetadataJSON: #"{"progressBatchId":"b"}"#)?.kind, "delivery")
        XCTAssertNil(ConversationCoordinationEvent(rawMetadataJSON: #"{"text":"后台汇总"}"#))
        XCTAssertNil(ConversationCoordinationEvent(rawMetadataJSON: "invalid"))
        let failure = ConversationCoordinationEvent(rawMetadataJSON: #"{"coordinationEvent":{"kind":"failure","requestId":"r","sessionId":"s","phase":"planning","errorCode":"FAILED","retryable":true}}"#)
        XCTAssertEqual(failure?.requestId, "r"); XCTAssertEqual(failure?.sessionId, "s")
        XCTAssertEqual(failure?.retryable, true)
        for kind in ["failure", "receipt", "decision"] {
            let raw = "{\"coordinationEvent\":{\"kind\":\"\(kind)\",\"batchId\":\"b\"}}"
            XCTAssertEqual(ConversationCoordinationEvent(rawMetadataJSON: raw)?.kind, kind)
        }
    }
    func testHistoricalItemEnvelopeRestoresSpecialCardMetadataWithoutProseHeuristics() throws {
        for kind in ["summary", "failure", "receipt", "delivery", "decision"] {
            let metadata: [String: Any] = ["coordinationEvent": ["kind": kind, "requestId": "r", "sessionId": "s", "phase": "reading", "retryable": true]]
            var encoded = String(decoding: try JSONSerialization.data(withJSONObject: metadata), as: UTF8.self)
            for _ in 0..<3 {
                encoded = String(decoding: try JSONSerialization.data(withJSONObject: ["type": "agentMessage", "rawMetadataJSON": encoded]), as: UTF8.self)
                let event = try XCTUnwrap(ConversationCoordinationEvent(rawMetadataJSON: encoded))
                XCTAssertEqual(event.kind, kind)
                XCTAssertEqual(event.requestId, "r")
                XCTAssertEqual(event.phase, "reading")
                XCTAssertEqual(event.retryable, true)
            }
        }
        XCTAssertNil(ConversationCoordinationEvent(rawMetadataJSON: #"{"rawMetadataJSON":"broken","text":"后台汇总"}"#))
        XCTAssertNil(ConversationCoordinationEvent(rawMetadataJSON: #"{"payload":{"coordinationEvent":{"kind":"summary"}}}"#))
    }

}
