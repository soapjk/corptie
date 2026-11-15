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
}
