import XCTest
@testable import CorptieMac

final class SessionMailboxModelTests: XCTestCase {
    func testSummaryDoesNotRequireBodyAndPreservesIndependentState() throws {
        let data = Data(#"{"messages":[{"messageId":"mailbox:one","sourceType":"channel","sourceId":"channel:one","senderSessionId":"session:peer","intent":"action_required","preview":"request","state":"pending","executionStatus":null,"read":true,"manualRequested":false,"batchId":null,"batchCount":0,"turnId":null,"canHandle":true,"createdAt":"2026-10-31T00:00:00Z","cursor":"1"}],"hasMore":false,"beforeCursor":"1","pendingCount":1,"unreadCount":0,"paused":true}"#.utf8)
        let page = try JSONDecoder().decode(SessionMailboxPage.self, from: data)
        XCTAssertTrue(page.paused)
        XCTAssertEqual(page.pendingCount, 1)
        XCTAssertEqual(page.unreadCount, 0)
        XCTAssertTrue(page.messages[0].read)
        XCTAssertNil(page.messages[0].body)
        XCTAssertTrue(page.messages[0].canHandle)
    }
}
