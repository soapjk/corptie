import XCTest
@testable import CorptieMac

@MainActor
final class SessionSendFailureTests: XCTestCase {
    func testFailureDoesNotDependOnLanguageOrGlobalStatus() {
        let state = SessionCommandController()
        state.setSendFailure("发送失败：服务器错误", sessionID: "a")
        state.sendStatusMessage = "Sent to Codex"
        XCTAssertEqual(state.sendFailures["a"], "发送失败：服务器错误")
        XCTAssertNil(state.sendFailures["b"])
        state.setSendFailure("Send failed: offline", sessionID: "b")
        state.setSendFailure(nil, sessionID: "a")
        XCTAssertNil(state.sendFailures["a"])
        XCTAssertEqual(state.sendFailures["b"], "Send failed: offline")
    }
    func testRecoveryOnlyClearsTheMatchingAuthoritativeMessage() throws {
        let state = SessionCommandController()
        func item(_ id: String, _ status: String, source: String = "server") throws -> CodexThreadItem {
            let data = try JSONSerialization.data(withJSONObject: ["id": id, "turnId": "turn", "turnStatus": "complete", "type": "userMessage", "title": "User", "text": "hello", "status": "accepted", "userMessageStatus": status, "sourceType": source])
            return try JSONDecoder().decode(CodexThreadItem.self, from: data)
        }
        state.setSendFailure("timeout", sessionID: "a", messageID: "message-a")
        state.setSendFailure("timeout-b", sessionID: "b", messageID: "message-b")
        for value in [try item("other", "processing"), try item("message-a", "failed"),
                      try item("message-a", "processing", source: "local_submission")] {
            state.reconcileSendFailure(sessionID: "a", items: [value])
            XCTAssertEqual(state.sendFailures["a"], "timeout")
        }
        state.sendStatusMessage = "timeout"
        state.reconcileSendFailure(sessionID: "a", items: [try item("message-a", "consumed")])
        XCTAssertNil(state.sendFailures["a"])
        XCTAssertNil(state.sendStatusMessage)
        XCTAssertEqual(state.sendFailures["b"], "timeout-b")
        state.setSendFailure("new failure", sessionID: "a", messageID: "new-message")
        state.reconcileSendFailure(sessionID: "a", items: [try item("message-a", "consumed")])
        XCTAssertEqual(state.sendFailures["a"], "new failure")
    }
}
