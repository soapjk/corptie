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
}
