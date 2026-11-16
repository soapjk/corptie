import Foundation
import Testing
@testable import CorptieClientCore

@Test func childDiscardNoticeUsesAttentionAndRoutesToParentSession() throws {
    let data = Data(#"{"id":"child-discard:one","sessionId":"session:parent","title":"直接删除需要确认","body":"未合入，不会自动执行","occurredAt":"2026-11-15T00:00:00Z"}"#.utf8)
    let value = try JSONDecoder().decode(ClientUserDecisionNotice.self, from: data)
    let event = try #require(value.notification)
    #expect(event.category == .worktree)
    #expect(event.outcome == .attention)
    #expect(event.sessionID == "session:parent")
    #expect(event.jobID == nil)
}
