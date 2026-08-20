import XCTest
@testable import CorptieMac

@MainActor
final class WorkItemCreateFormTests: XCTestCase {
    func testAvailableAgentsAreAssignableContributorsOnly() {
        let available = agent(id: "agent:available", role: "independentContributor", status: "available")
        let unavailable = agent(id: "agent:unavailable", role: "independentContributor", status: "unavailable")
        let assistant = agent(id: "agent:assistant", role: "assistant", status: "available")
        let outside = agent(id: "agent:outside", role: "independentContributor", status: "available")

        let result = WorkItemCreateFormPolicy.availableAgents(
            from: [available, unavailable, assistant, outside],
            allowedAgentIds: [available.agentId, unavailable.agentId, assistant.agentId]
        )

        XCTAssertEqual(result.map(\.agentId), [available.agentId])
    }

    func testMissingAgentHasExplicitValidationAndCannotSubmit() {
        let message = WorkItemCreateFormPolicy.validationMessage(
            title: "Implement",
            detail: "Implement the feature",
            workspaceId: "repository:one",
            agentId: nil
        )

        XCTAssertEqual(message, L10n("请选择负责该 WorkItem 的 Agent。"))
    }

    func testCompleteFormPassesValidation() {
        XCTAssertNil(WorkItemCreateFormPolicy.validationMessage(
            title: "Implement",
            detail: "Implement the feature",
            workspaceId: "repository:one",
            agentId: "agent:one"
        ))
    }

    func testExecutionPresentationShowsNotStartedAndRunning() {
        XCTAssertEqual(
            WorkItemExecutionPresentation.label(executionStatus: "idle", sessionStatus: nil),
            L10n("Not Started")
        )
        XCTAssertEqual(
            WorkItemExecutionPresentation.label(executionStatus: "idle", sessionStatus: "running"),
            L10n("Running")
        )
    }

    private func agent(id: String, role: String, status: String) -> Agent {
        Agent(
            agentId: id,
            name: id,
            description: "",
            role: role,
            status: status,
            systemPrompt: "",
            capabilities: [],
            createdAt: "2026-08-20T00:00:00Z",
            updatedAt: "2026-08-20T00:00:00Z"
        )
    }
}
