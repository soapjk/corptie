import Foundation
import XCTest
@testable import CorptieClientCore

final class VerificationPerformanceTests: XCTestCase {
    func testOldSessionPayloadRemainsCompatibleAndPauseIsExplicit() throws {
        let old = #"{"id":"s","title":"Session","executionStatus":"completed","updatedAt":"2026-11-15"}"#
        XCTAssertNil(try JSONDecoder().decode(ClientSession.self, from: Data(old.utf8)).verificationPause)
        let data = #"{"id":"s","title":"Session","executionStatus":"completed","updatedAt":"2026-11-15","verificationPause":{"instructionId":"i","reason":"budget"}}"#
        let session = try JSONDecoder().decode(ClientSession.self, from: Data(data.utf8))
        XCTAssertEqual(session.verificationPause?.reason, "budget")
    }
    func testBudgetNoticeIsTypedAndPreservesInstructionScope() throws {
        let raw = #"{"coordinationEvent":{"kind":"verification_budget","sessionId":"logical:s","instructionId":"instruction:one"}}"#
        let event = try XCTUnwrap(ConversationCoordinationEvent(rawMetadataJSON: raw))
        XCTAssertEqual(event.kind, "verification_budget")
        XCTAssertEqual(event.instructionId, "instruction:one")
        XCTAssertEqual(event.sessionId, "logical:s")
        XCTAssertNil(ConversationCoordinationEvent(rawMetadataJSON: #"{"text":"验证预算耗尽"}"#))
    }
    @MainActor func testNativeNoticeRespectsExistingPreferencesAndDeduplicatesAfterRestart() throws {
        let data = #"{"id":"pause:i:1","sessionId":"logical:s","instructionId":"i","title":"Paused","body":"Used 3 of 3","occurredAt":"2026-11-15T00:00:00Z"}"#
        let notice = try JSONDecoder().decode(ClientVerificationNotice.self, from: Data(data.utf8))
        let event = try XCTUnwrap(notice.notification)
        XCTAssertEqual(event.category, .verification)
        XCTAssertEqual(event.outcome, .attention)
        XCTAssertEqual(event.sessionID, "logical:s")
        let defaults = UserDefaults(suiteName: "BudgetTests.\(UUID().uuidString)")!
        let preferences = OperationNotificationPreferences(defaults: defaults)
        XCTAssertTrue(preferences.allows(event))
        preferences.setCategory(.verification, enabled: false)
        XCTAssertFalse(preferences.allows(event))
        let ledger = OperationNotificationLedger(defaults: defaults, scope: "server")
        XCTAssertTrue(ledger.consume(event))
        XCTAssertFalse(OperationNotificationLedger(defaults: defaults, scope: "server").consume(event))
    }
    func testHistoryIsPagedWithoutOutputCopies() throws {
        let data = #"{"runs":[{"executionId":"r","status":"passed","createdAt":"2026-11-15","executorSessionId":"child:s","executorTaskId":"task:c"}],"hasMore":true,"nextCursor":"10"}"#
        let page = try JSONDecoder().decode(ClientVerificationRunPage.self, from: Data(data.utf8))
        XCTAssertEqual(page.nextCursor,"10")
        XCTAssertEqual(page.runs.first?.executorSessionId,"child:s")
    }
}
