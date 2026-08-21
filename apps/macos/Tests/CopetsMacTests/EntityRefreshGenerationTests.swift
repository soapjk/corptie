import Combine
import Testing
@testable import CorptieMac

@MainActor
struct EntityRefreshGenerationTests {
    @Test
    func newerBackendReadyRefreshSupersedesColdStartRequest() {
        var generation = EntityRefreshGeneration()

        let coldStartRequest = generation.begin()
        let backendReadyRequest = generation.begin()

        #expect(!generation.isCurrent(coldStartRequest))
        #expect(generation.isCurrent(backendReadyRequest))
    }

    @Test
    func sessionOnlyStateChangesDoNotInvalidateEntityDrivenViews() async {
        let store = AppStateStore()
        let client = EntityAPIClient(appState: store)
        var groupingInvalidations = 0
        let cancellable = client.sessionGroupingDidChange.sink {
            groupingInvalidations += 1
        }

        _ = store.apply(snapshot: StateSnapshotEnvelope(
            revision: 1,
            state: ControlPlaneStatePayload(
                sessions: [performanceSessionFixture()],
                workItems: [],
                objectives: [],
                agents: [],
                skills: [],
                repositories: [],
                integrationRuns: []
            )
        ))
        await Task.yield()

        #expect(client.workItemsRevision == 0)
        #expect(groupingInvalidations == 0)

        _ = store.apply(snapshot: StateSnapshotEnvelope(
            revision: 2,
            state: ControlPlaneStatePayload(
                sessions: [performanceSessionFixture()],
                workItems: [performanceWorkItemFixture()],
                objectives: [],
                agents: [],
                skills: [],
                repositories: [],
                integrationRuns: []
            )
        ))
        await Task.yield()

        #expect(client.workItemsRevision == 1)
        #expect(groupingInvalidations == 1)
        withExtendedLifetime(cancellable) {}
    }

    private func performanceSessionFixture() -> TaskSession {
        TaskSession(
            id: "session:performance",
            title: "Performance",
            agent: "Codex",
            agentId: nil,
            sessionKind: .worker,
            objectiveId: nil,
            workItemId: nil,
            status: .running,
            progress: 0,
            summary: "",
            suggestedOptions: nil,
            suggestedPrompt: nil,
            activityStatus: nil,
            updatedAt: "2026-08-21T00:00:00Z",
            accent: .cyan,
            archived: false,
            pinned: false,
            sortOrder: 0,
            capabilities: nil,
            external: nil,
            actions: nil,
            pendingCollaborationConfirmation: nil
        )
    }

    private func performanceWorkItemFixture() -> WorkItem {
        WorkItem(
            id: "work_item:performance",
            objectiveId: "objective:performance",
            title: "Performance",
            description: "",
            acceptanceCriteria: "",
            priority: "medium",
            status: "in_progress",
            mainWorkspaceId: nil,
            mainAgentId: nil,
            currentSessionId: "session:performance",
            executionStatus: "running",
            acceptanceAssessment: nil,
            completionSuggestion: nil,
            createdAt: "2026-08-21T00:00:00Z",
            updatedAt: "2026-08-21T00:00:00Z"
        )
    }
}
