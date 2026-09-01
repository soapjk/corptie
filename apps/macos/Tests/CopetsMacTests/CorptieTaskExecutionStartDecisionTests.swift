import Testing
@testable import CorptieMac

struct CorptieTaskExecutionStartDecisionTests {
    @Test func resumesAnExistingSessionBeforeConsideringBoundAgent() {
        #expect(
            CorptieTaskExecutionStartDecision.resolve(
                status: "in_progress",
                currentSessionId: "session:existing",
                mainAgentId: "agent:bound"
            ) == .resume(sessionId: "session:existing")
        )
    }

    @Test func createsSessionDirectlyWithBoundAgent() {
        #expect(
            CorptieTaskExecutionStartDecision.resolve(
                status: "todo",
                currentSessionId: nil,
                mainAgentId: "agent:bound"
            ) == .createSession(agentId: "agent:bound")
        )
    }

    @Test func asksForAgentOnlyWhenNoSessionOrBindingExists() {
        #expect(
            CorptieTaskExecutionStartDecision.resolve(
                status: "todo",
                currentSessionId: nil,
                mainAgentId: "  "
            ) == .chooseAgent
        )
    }

    @Test func completedCorptieTaskUsesAtomicRestoreBeforeExistingSessionResume() {
        #expect(
            CorptieTaskExecutionStartDecision.resolve(
                status: "done",
                currentSessionId: "session:existing",
                mainAgentId: "agent:bound"
            ) == .restoreCompleted
        )
    }
}
