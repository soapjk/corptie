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
