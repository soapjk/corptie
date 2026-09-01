import XCTest
@testable import CorptieMac

@MainActor
final class CorptieTaskCreateFormTests: XCTestCase {
    func testAvailableAgentsAreAssignableContributorsOnly() {
        let available = agent(id: "agent:available", role: "independentContributor", status: "available")
        let unavailable = agent(id: "agent:unavailable", role: "independentContributor", status: "unavailable")
        let assistant = agent(id: "agent:assistant", role: "assistant", status: "available")
        let outside = agent(id: "agent:outside", role: "independentContributor", status: "available")

        let result = CorptieTaskCreateFormPolicy.availableAgents(
            from: [available, unavailable, assistant, outside],
            allowedAgentIds: [available.agentId, unavailable.agentId, assistant.agentId]
        )

        XCTAssertEqual(result.map(\.agentId), [available.agentId])
    }

    func testMissingAgentHasExplicitValidationAndCannotSubmit() {
        let message = CorptieTaskCreateFormPolicy.validationMessage(
            title: "Implement",
            detail: "Implement the feature",
            workspaceId: "repository:one",
            agentId: nil
        )

        XCTAssertEqual(message, L10n("请选择负责该 CorptieTask 的 Agent。"))
    }

    func testCompleteFormPassesValidation() {
        XCTAssertNil(CorptieTaskCreateFormPolicy.validationMessage(
            title: "Implement",
            detail: "Implement the feature",
            workspaceId: "repository:one",
            agentId: "agent:one"
        ))
    }

    func testExecutionPresentationShowsNotStartedAndRunning() {
        XCTAssertEqual(
            CorptieTaskExecutionPresentation.label(executionStatus: "idle", sessionStatus: nil),
            L10n("Not Started")
        )
        XCTAssertEqual(
            CorptieTaskExecutionPresentation.label(executionStatus: "idle", sessionStatus: "running"),
            L10n("Running")
        )
    }

    func testProviderSelectionUsesPreferredCreatableProviderAndKeepsUserChoice() throws {
        let providers = try providerCatalog()
        XCTAssertEqual(
            CorptieTaskCreateProviderPolicy.selection(
                current: "",
                preferred: "claude-sdk",
                providers: providers
            ),
            "claude-sdk"
        )
        XCTAssertEqual(
            CorptieTaskCreateProviderPolicy.selection(
                current: "codex-app-server",
                preferred: "claude-sdk",
                providers: providers
            ),
            "codex-app-server"
        )
    }

    func testProviderSelectionExcludesProvidersThatCannotCreateSessions() throws {
        let providers = try providerCatalog()
        XCTAssertEqual(
            CorptieTaskCreateProviderPolicy.selection(
                current: "read-only",
                preferred: "read-only",
                providers: providers
            ),
            "codex-app-server"
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

    private func providerCatalog() throws -> [AgentProviderDescriptor] {
        let data = Data(#"""
        {
          "defaultProviderId": "claude-sdk",
          "providers": [
            {"id":"codex-app-server","displayName":"Codex","transport":"app-server","aliases":[],"capabilities":["session.create"],"runtime":{"lifecycle":"managed"},"configuration":{"fields":[]}},
            {"id":"claude-sdk","displayName":"Claude","transport":"sdk","aliases":[],"capabilities":["session.create"],"runtime":{"lifecycle":"managed"},"configuration":{"fields":[]}},
            {"id":"read-only","displayName":"Read Only","transport":"test","aliases":[],"capabilities":[],"runtime":{"lifecycle":"managed"},"configuration":{"fields":[]}}
          ]
        }
        """#.utf8)
        return try JSONDecoder().decode(AgentProvidersResponse.self, from: data).providers
    }
}
