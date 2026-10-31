import Testing
@testable import CorptieMac

struct CorptieTaskExecutionStartDecisionTests {
    @Test func resumesAnExistingSessionBeforeConsideringBoundAgent() {
        #expect(
            CorptieTaskExecutionStartDecision.resolve(
                status: "in_progress",
                currentSessionId: "session:existing",
                mainRoleId: "agent:bound"
            ) == .resume(sessionId: "session:existing")
        )
    }

    @Test func createsSessionDirectlyWithBoundAgent() {
        #expect(
            CorptieTaskExecutionStartDecision.resolve(
                status: "todo",
                currentSessionId: nil,
                mainRoleId: "agent:bound"
            ) == .createSession(roleId: "agent:bound")
        )
    }

    @Test func asksForAgentOnlyWhenNoSessionOrBindingExists() {
        #expect(
            CorptieTaskExecutionStartDecision.resolve(
                status: "todo",
                currentSessionId: nil,
                mainRoleId: "  "
            ) == .chooseAgent
        )
    }

    @Test func completedCorptieTaskUsesAtomicRestoreBeforeExistingSessionResume() {
        #expect(
            CorptieTaskExecutionStartDecision.resolve(
                status: "done",
                currentSessionId: "session:existing",
                mainRoleId: "agent:bound"
            ) == .restoreCompleted
        )
    }
}
