import Testing
@testable import CorptieMac

struct WorkItemExecutionStartDecisionTests {
    @Test func resumesAnExistingSessionBeforeConsideringBoundAgent() {
        #expect(
            WorkItemExecutionStartDecision.resolve(
                status: "in_progress",
                currentSessionId: "session:existing",
                mainAgentId: "agent:bound"
            ) == .resume(sessionId: "session:existing")
        )
    }

    @Test func createsSessionDirectlyWithBoundAgent() {
        #expect(
            WorkItemExecutionStartDecision.resolve(
                status: "todo",
                currentSessionId: nil,
                mainAgentId: "agent:bound"
            ) == .createSession(agentId: "agent:bound")
        )
    }

    @Test func asksForAgentOnlyWhenNoSessionOrBindingExists() {
        #expect(
            WorkItemExecutionStartDecision.resolve(
                status: "todo",
                currentSessionId: nil,
                mainAgentId: "  "
            ) == .chooseAgent
        )
    }

    @Test func completedWorkItemUsesAtomicRestoreBeforeExistingSessionResume() {
        #expect(
            WorkItemExecutionStartDecision.resolve(
                status: "done",
                currentSessionId: "session:existing",
                mainAgentId: "agent:bound"
            ) == .restoreCompleted
        )
    }
}
