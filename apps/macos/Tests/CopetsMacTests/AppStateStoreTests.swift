import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct AppStateStoreTests {
    @Test func snapshotReplacesEveryNormalizedCollection() {
        let store = AppStateStore()
        let session = TaskSession.fixture(id: "session:1", title: "One")
        let snapshot = StateSnapshotEnvelope(
            revision: 7,
            state: .fixture(sessions: [session])
        )
        #expect(store.apply(snapshot: snapshot) == .applied)
        #expect(store.revision == 7)
        #expect(store.session("session:1")?.title == "One")
    }

    @Test func equalRevisionSnapshotCannotOverwriteAlreadyAppliedState() {
        let store = AppStateStore()
        let current = TaskSession.fixture(id: "session:1", title: "Current")
        let stale = TaskSession.fixture(id: "session:1", title: "Stale")

        #expect(store.apply(snapshot: .init(revision: 7, state: .fixture(sessions: [current]))) == .applied)
        #expect(store.apply(snapshot: .init(revision: 7, state: .fixture(sessions: [stale]))) == .duplicate)
        #expect(store.session("session:1")?.title == "Current")
    }

    @Test func duplicateSnapshotStillRestoresReachabilityAfterReconnect() {
        let store = AppStateStore()
        let snapshot = StateSnapshotEnvelope(revision: 7, state: .fixture())
        _ = store.apply(snapshot: snapshot)
        store.reportSyncError("connection lost")

        #expect(store.apply(snapshot: snapshot) == .duplicate)
        #expect(store.isReachable)
        #expect(store.syncError == nil)
    }

    @Test func firstRevisionZeroSnapshotStillInitializesEmptyStore() {
        let store = AppStateStore()
        let session = TaskSession.fixture(id: "session:zero", title: "Initial")

        #expect(store.apply(snapshot: .init(revision: 0, state: .fixture(sessions: [session]))) == .applied)
        #expect(store.session("session:zero")?.title == "Initial")
    }

    @Test func creationResponseIsImmediateIdempotentAndKeepsServerRevision() {
        let store = AppStateStore()
        _ = store.apply(snapshot: .init(revision: 7, state: .fixture()))
        let created = TaskSession.fixture(id: "session:created", title: "Created")

        let first = store.acceptCreatedSession(created)
        let repeated = store.acceptCreatedSession(created)

        #expect(first == created)
        #expect(repeated == created)
        #expect(store.sessions.map(\.id) == [created.id])
        #expect(store.revision == 7)
        #expect(store.pendingCreatedSessionIDs == [created.id])
    }

    @Test func equalRevisionSnapshotCannotRemovePendingCreationResponse() {
        let store = AppStateStore()
        _ = store.apply(snapshot: .init(revision: 7, state: .fixture()))
        let created = TaskSession.fixture(id: "session:created", title: "Created")
        store.acceptCreatedSession(created)

        #expect(store.apply(snapshot: .init(revision: 7, state: .fixture())) == .duplicate)
        #expect(store.session(created.id) == created)
        #expect(store.pendingCreatedSessionIDs == [created.id])
    }

    @Test func authoritativeSessionUpsertReconcilesPendingCreationResponse() {
        let store = AppStateStore()
        _ = store.apply(snapshot: .init(revision: 7, state: .fixture()))
        store.acceptCreatedSession(TaskSession.fixture(id: "session:created", title: "Provisional"))
        let authoritative = TaskSession.fixture(id: "session:created", title: "Authoritative")
        let changes = StateChangeSetEnvelope(
            snapshotRequired: false,
            baseRevision: 7,
            revision: 8,
            upserts: .fixture(sessions: [authoritative]),
            deletes: .fixture()
        )

        #expect(store.apply(changeSet: changes) == .applied)
        #expect(store.session(authoritative.id) == authoritative)
        #expect(store.pendingCreatedSessionIDs.isEmpty)
    }

    @Test func configurationResponseImmediatelyPublishesSelectedReasoningWithoutRegressingNewerState() {
        let store = AppStateStore()
        let medium = TaskSession.fixture(
            id: "session:reasoning",
            title: "Reasoning",
            updatedAt: "2026-08-18T00:00:00Z",
            currentReasoningLevel: "medium"
        )
        _ = store.apply(snapshot: .init(revision: 7, state: .fixture(sessions: [medium])))
        let xhigh = TaskSession.fixture(
            id: medium.id,
            title: medium.title,
            updatedAt: "2026-08-18T00:00:01Z",
            currentReasoningLevel: "xhigh"
        )

        #expect(store.acceptSessionConfiguration(xhigh, requestedSessionID: medium.id))
        #expect(store.session(medium.id)?.external?.currentReasoningLevel == "xhigh")
        #expect(store.revision == 7)

        let stale = TaskSession.fixture(
            id: medium.id,
            title: medium.title,
            updatedAt: "2026-08-18T00:00:00Z",
            currentReasoningLevel: "low"
        )
        #expect(!store.acceptSessionConfiguration(stale, requestedSessionID: medium.id))
        #expect(store.session(medium.id)?.external?.currentReasoningLevel == "xhigh")
    }

    @Test func sessionStatusChangeSetRefreshesAuthoritativeStatusImmediately() {
        let store = AppStateStore()
        let running = TaskSession.fixture(id: "session:status", title: "Status", status: .running)
        _ = store.apply(snapshot: .init(revision: 20, state: .fixture(sessions: [running])))
        let completed = TaskSession.fixture(id: running.id, title: running.title, status: .complete)
        let changes = StateChangeSetEnvelope(
            snapshotRequired: false,
            baseRevision: 20,
            revision: 21,
            upserts: .fixture(sessions: [completed]),
            deletes: .fixture()
        )

        #expect(store.apply(changeSet: changes) == .applied)
        #expect(store.revision == 21)
        #expect(store.session(running.id)?.status == .complete)
        #expect(store.syncError == nil)
    }

    @Test func changeSetsAreIdempotentAndRejectRevisionGaps() {
        let store = AppStateStore()
        _ = store.apply(snapshot: StateSnapshotEnvelope(revision: 3, state: .fixture()))
        let inserted = TaskSession.fixture(id: "session:2", title: "Two")
        let changes = StateChangeSetEnvelope(
            snapshotRequired: false,
            baseRevision: 3,
            revision: 4,
            upserts: .fixture(sessions: [inserted]),
            deletes: .fixture()
        )
        #expect(store.apply(changeSet: changes) == .applied)
        #expect(store.apply(changeSet: changes) == .duplicate)
        let gap = StateChangeSetEnvelope(
            snapshotRequired: false,
            baseRevision: 8,
            revision: 9,
            upserts: .fixture(),
            deletes: .fixture()
        )
        #expect(store.apply(changeSet: gap) == .revisionGap(expected: 4, received: 8))
    }

    @Test func snapshotDecodesIntegrationRunWireContract() throws {
        let payload = """
        {
          "revision": 12,
          "state": {
            "sessions": [],
            "workItems": [],
            "objectives": [],
            "agents": [],
            "skills": [],
            "repositories": [],
            "integrationRuns": [{
              "id": "integration:1",
              "repositoryId": "repository:1",
              "objectiveId": "objective:1",
              "status": "completed",
              "mainHeadBefore": "main:before",
              "mainHeadAfter": "main:after",
              "integrationWorktreeId": null,
              "integrationWorktreePath": null,
              "integrationBranch": null,
              "conflictWorkItemId": null,
              "conflictSessionId": null,
              "error": null,
              "items": [{
                "runId": "integration:1",
                "worktreeId": "worktree:1",
                "workItemId": "work_item:1",
                "workItemTitle": "Memory tools",
                "branchName": "feature/memory-tools",
                "sourceHeadOid": "source:1",
                "ordinal": 0,
                "status": "integrated",
                "conflictFiles": [],
                "mergedMainHead": "main:after",
                "error": null,
                "updatedAt": "2026-08-18T00:01:00Z"
              }],
              "counts": {
                "total": 1,
                "integrated": 1,
                "conflicts": 0,
                "failed": 0,
                "pending": 0
              },
              "createdAt": "2026-08-18T00:00:00Z",
              "updatedAt": "2026-08-18T00:01:00Z",
              "completedAt": "2026-08-18T00:01:00Z"
            }]
          }
        }
        """
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let snapshot = try decoder.decode(StateSnapshotEnvelope.self, from: Data(payload.utf8))

        #expect(snapshot.state.integrationRuns.first?.counts.total == 1)
        #expect(snapshot.state.integrationRuns.first?.items.first?.workItemTitle == "Memory tools")
    }

    @Test func snapshotDecodeErrorNamesTheMissingContractPath() {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let payload = Data(#"{"revision":1,"state":{"sessions":[],"workItems":[],"objectives":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[{}]}}"#.utf8)

        do {
            _ = try decoder.decode(StateSnapshotEnvelope.self, from: payload)
            Issue.record("Expected the incomplete integration run to fail decoding")
        } catch {
            let message = AppStateSyncController.syncErrorMessage(error)
            #expect(message.contains("state.integrationRuns[0]"))
            #expect(message.contains("字段"))
        }
    }

    @Test func snapshotToleratesLegacyWorkItemAcceptanceShapeAndNullCriteria() throws {
        let payload = Data(#"{"revision":13,"state":{"sessions":[],"workItems":[{"id":"work_item:legacy","objectiveId":"objective:1","title":"Legacy collaboration item","description":"","acceptanceCriteria":null,"priority":"medium","status":"done","mainWorkspaceId":null,"mainAgentId":null,"currentSessionId":null,"executionStatus":null,"acceptanceAssessment":{"status":"passed","source":"collaboration","collaborationTaskId":"task:1","assessedAt":"2026-08-19T23:59:34.703Z"},"completionSuggestion":null,"createdAt":"2026-08-19T00:00:00Z","updatedAt":"2026-08-19T00:01:00Z"}],"objectives":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[]}}"#.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let snapshot = try decoder.decode(StateSnapshotEnvelope.self, from: payload)

        #expect(snapshot.state.workItems.count == 1)
        #expect(snapshot.state.workItems[0].acceptanceCriteria == "")
        #expect(snapshot.state.workItems[0].acceptanceAssessment == nil)
    }

    @Test func changeSetDecodesArtifactInvalidationsWithoutEmbeddingArtifactPayloads() throws {
        let payload = Data(#"{"snapshotRequired":false,"baseRevision":20,"revision":22,"upserts":{"sessions":[],"workItems":[],"objectives":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[]},"deletes":{"sessions":[],"workItems":[],"objectives":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[]},"artifactInvalidations":["artifact:one"]}"#.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let changes = try decoder.decode(StateChangeSetEnvelope.self, from: payload)

        #expect(changes.artifactInvalidations == ["artifact:one"])
    }
}

private extension ControlPlaneStatePayload {
    static func fixture(sessions: [TaskSession] = []) -> Self {
        .init(sessions: sessions, workItems: [], objectives: [], agents: [], skills: [], repositories: [], integrationRuns: [])
    }
}

private extension StateEntityDeletes {
    static func fixture() -> Self {
        .init(sessions: [], workItems: [], objectives: [], agents: [], skills: [], repositories: [], integrationRuns: [])
    }
}

private extension TaskSession {
    static func fixture(
        id: String,
        title: String,
        status: TaskStatus = .running,
        updatedAt: String = "2026-08-18T00:00:00Z",
        currentReasoningLevel: String? = nil
    ) -> Self {
        .init(
            id: id, title: title, agent: "Codex", agentId: nil, sessionKind: .worker,
            objectiveId: nil, workItemId: nil, status: status, progress: 0,
            summary: "", suggestedOptions: nil, suggestedPrompt: nil, activityStatus: nil,
            updatedAt: updatedAt, accent: .cyan, archived: false,
            pinned: false, sortOrder: 0, capabilities: nil,
            external: currentReasoningLevel.map {
                ExternalSession(
                    provider: "codex-app-server", threadId: "thread-a", sessionId: nil,
                    agentSessionId: nil, connectionStatus: "connected", currentModel: "gpt-5.6-sol",
                    currentReasoningLevel: $0, cwd: "/tmp", sandbox: "workspace-write",
                    approvalPolicy: "on-request", source: "corptie", logicalSessionId: nil,
                    workspace: nil, routingVersion: nil, providerSwitchInFlight: nil,
                    providerTransition: nil
                )
            },
            actions: nil
        )
    }
}
