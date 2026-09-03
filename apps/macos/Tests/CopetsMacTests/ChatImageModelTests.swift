import Foundation
import XCTest
@testable import CorptieMac

final class ChatImageModelTests: XCTestCase {
    func testTimelineItemDecodesManagedAndOriginalImagePaths() throws {
        let data = Data(#"""
        {
          "id":"message:image","turnId":"turn:one","turnStatus":"complete",
          "type":"userMessage","title":"User","text":"",
          "options":null,"status":"accepted","createdAt":"2026-09-03T00:00:00.000Z",
          "images":[{
            "managedPath":"chat-resources/tasks/task_one/session_one/images/a.png",
            "originalPath":"/Users/example/Desktop/a.png"
          }]
        }
        """#.utf8)

        let item = try JSONDecoder().decode(CodexThreadItem.self, from: data)
        XCTAssertEqual(item.images?.first?.managedPath, "chat-resources/tasks/task_one/session_one/images/a.png")
        XCTAssertEqual(item.images?.first?.originalPath, "/Users/example/Desktop/a.png")
    }
}
