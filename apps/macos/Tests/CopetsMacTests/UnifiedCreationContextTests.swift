import XCTest
@testable import CorptieMac

final class UnifiedCreationContextTests: XCTestCase {
    private func session(work: String? = nil) throws -> TaskSession {
        var body: [String: Any] = ["id": "s", "title": "Example", "agent": "Agent", "agentId": "agent:a", "sessionKind": "assistantChat", "status": "complete", "progress": 0, "summary": "", "updatedAt": "now", "accent": "cyan"]
        if let work { body["workId"] = work }
        return try JSONDecoder().decode(TaskSession.self, from: JSONSerialization.data(withJSONObject: body))
    }
    func testChatSpaceIgnoresStaleWorkAndSessionWork() throws {
        let context = UnifiedCreationContext.resolve(session: try session(work: "old"), workID: "stale", chatSpace: true)
        XCTAssertNil(context.workID)
        XCTAssertEqual(context.roleID, "agent:a")
    }
    func testSelectedWorkWinsAndNoContextDefaultsToChat() throws {
        XCTAssertEqual(UnifiedCreationContext.resolve(session: try session(work: "old"), workID: "current").workID, "current")
        XCTAssertNil(UnifiedCreationContext.resolve(session: nil, workID: nil).workID)
        XCTAssertEqual(UnifiedCreationContext.resolve(session: try session(work: "current"), workID: nil).workID, "current")
    }
}
