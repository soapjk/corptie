import XCTest
@testable import CorptieMac

final class AppKitChatRowReusePolicyTests: XCTestCase {
    func testSameMessageIDWithChangedStatusRevisionIsNotReusable() {
        let previous = [AppKitChatRowReuseIdentity(id: "message:1", contentRevision: 10)]
        let next = [AppKitChatRowReuseIdentity(id: "message:1", contentRevision: 11)]

        XCTAssertEqual(
            AppKitChatRowReusePolicy.commonPrefixCount(previous: previous, next: next),
            0
        )
    }

    func testUnchangedRowsRemainReusableWhenAgentReplyIsAppended() {
        let previous = [AppKitChatRowReuseIdentity(id: "message:1", contentRevision: 11)]
        let next = [
            AppKitChatRowReuseIdentity(id: "message:1", contentRevision: 11),
            AppKitChatRowReuseIdentity(id: "agent:1", contentRevision: 1)
        ]

        XCTAssertEqual(
            AppKitChatRowReusePolicy.commonPrefixCount(previous: previous, next: next),
            1
        )
    }
}
