import Testing
@testable import CorptieMac

struct WorkItemExecutionStartDecisionTests {
    @Test func resumesAnExistingSessionBeforeConsideringBoundAgent() {
        #expect(
            WorkItemExecutionStartDecision.resolve(
                currentSessionId: "session:existing",
                mainAgentId: "agent:bound"
            ) == .resume(sessionId: "session:existing")
        )
    }

    @Test func createsSessionDirectlyWithBoundAgent() {
        #expect(
            WorkItemExecutionStartDecision.resolve(
                currentSessionId: nil,
                mainAgentId: "agent:bound"
            ) == .createSession(agentId: "agent:bound")
        )
    }

    @Test func asksForAgentOnlyWhenNoSessionOrBindingExists() {
        #expect(
            WorkItemExecutionStartDecision.resolve(
                currentSessionId: nil,
                mainAgentId: "  "
            ) == .chooseAgent
        )
    }
}
