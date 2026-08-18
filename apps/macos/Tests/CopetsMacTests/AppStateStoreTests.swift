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
        let payload = Data(#"{"revision":1,"state":{"sessions":[],"workItems":[],"objectives":[],"agents":[],"repositories":[],"integrationRuns":[{}]}}"#.utf8)

        do {
            _ = try decoder.decode(StateSnapshotEnvelope.self, from: payload)
            Issue.record("Expected the incomplete integration run to fail decoding")
        } catch {
            let message = AppStateSyncController.syncErrorMessage(error)
            #expect(message.contains("state.integrationRuns[0]"))
            #expect(message.contains("字段"))
        }
    }
}

private extension ControlPlaneStatePayload {
    static func fixture(sessions: [TaskSession] = []) -> Self {
        .init(sessions: sessions, workItems: [], objectives: [], agents: [], repositories: [], integrationRuns: [])
    }
}

private extension StateEntityDeletes {
    static func fixture() -> Self {
        .init(sessions: [], workItems: [], objectives: [], agents: [], repositories: [], integrationRuns: [])
    }
}

private extension TaskSession {
    static func fixture(id: String, title: String) -> Self {
        .init(
            id: id, title: title, agent: "Codex", agentId: nil, sessionKind: .worker,
            objectiveId: nil, workItemId: nil, status: .running, progress: 0,
            summary: "", suggestedOptions: nil, suggestedPrompt: nil, activityStatus: nil,
            updatedAt: "2026-08-18T00:00:00Z", accent: .cyan, archived: false,
            pinned: false, sortOrder: 0, capabilities: nil, external: nil,
            actions: nil, pendingCollaborationConfirmation: nil
        )
    }
}
