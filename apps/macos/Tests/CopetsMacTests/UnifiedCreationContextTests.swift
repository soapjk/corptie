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
    @MainActor func testDraftPreservesContentAndRetryIdentityAcrossNavigation() {
        let draft = UnifiedCreationDraft()
        draft.prepare(.init(workID: "a", roleID: "agent", providerID: "provider", modelID: "model"))
        draft.prompt = "Keep this message"
        let request = draft.requestID
        draft.prepare(.init(workID: "b"))
        XCTAssertEqual(draft.workID, "a")
        XCTAssertEqual(draft.prompt, "Keep this message")
        XCTAssertEqual(draft.requestID, request)
        draft.prompt = ""
        draft.submissionStarted = true
        draft.prepare(.init(workID: "b"))
        XCTAssertEqual(draft.workID, "a")
    }
    @MainActor func testEmptyDraftCanAdoptNewNavigationContext() {
        let draft = UnifiedCreationDraft()
        draft.prepare(.init(workID: "a"))
        XCTAssertTrue(draft.taskMode)
        draft.prepare(.init())
        XCTAssertFalse(draft.taskMode)
        XCTAssertNil(draft.workID)
    }
}
