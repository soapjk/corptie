import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct AppStateStoreTests {
    @Test func taskMenuLookupTracksAuthoritativeUpdatesAndRemovalWithoutAnInventoryScan() throws {
        let store = AppStateStore()
        let client = EntityAPIClient(appState: store)
        var task = CorptieTask(id: "task:menu", workId: "work:menu", title: "Before",
             priority: "medium", lifecycleState: "in_progress", mainRoleId: nil,
            currentSessionId: nil, executionStatus: nil, acceptanceAssessment: nil, completionSuggestion: nil,
            createdAt: "2026-11-13T00:00:00Z", updatedAt: "2026-11-13T00:00:00Z")
        var state = ControlPlaneStatePayload.fixture()
        state.tasks = [task]
        _ = store.apply(snapshot: .init(revision: 1, state: state))
        #expect(client.task(task.id)?.title == "Before")
        task.title = "After"
        state.tasks = [task]
        _ = store.apply(snapshot: .init(revision: 2, state: state))
        #expect(client.task(task.id)?.title == "After")
        state.tasks = []
        _ = store.apply(snapshot: .init(revision: 3, state: state))
        #expect(client.task(task.id) == nil)
    }

    @Test func logicalSessionLookupUsesExactMetadataAndRetiresAmbiguousOrArchivedAliases() throws {
        func session(_ id: String, archived: Bool = false) throws -> TaskSession {
            var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(TaskSession.fixture(id: id, title: id))) as! [String: Any]
            object["external"] = ["provider": "test-provider", "logicalSessionId": "logical:exact"]
            object["archived"] = archived
            return try JSONDecoder().decode(TaskSession.self, from: JSONSerialization.data(withJSONObject: object))
        }
        let store = AppStateStore(), first = try session("legacy-a"), second = try session("legacy-b")
        _ = store.apply(snapshot: .init(revision: 1, state: .fixture(sessions: [first])))
        #expect(store.session("logical:exact")?.id == "legacy-a")
        _ = store.apply(snapshot: .init(revision: 2, state: .fixture(sessions: [second])))
        #expect(store.session("logical:exact")?.id == "legacy-b")
        _ = store.apply(snapshot: .init(revision: 3, state: .fixture(sessions: [first, second])))
        #expect(store.session("logical:exact") == nil)
        _ = store.apply(snapshot: .init(revision: 4, state: .fixture(sessions: [try session("legacy-b", archived: true)])))
        #expect(store.session("logical:exact") == nil)
    }
    @Test func liveDevelopmentSnapshotDecodesIntoConsoleCollections() async throws {
        guard let port = ProcessInfo.processInfo.environment["CORPTIE_TEST_LIVE_PREVIEW_PORT"],
              let url = URL(string: "http://127.0.0.1:\(port)/state/snapshot") else {
            return
        }
        let (data, _) = try await URLSession.shared.data(from: url)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let snapshot = try decoder.decode(StateSnapshotEnvelope.self, from: data)
        #expect(!snapshot.state.works.isEmpty)
        #expect(!snapshot.state.tasks.isEmpty)
        #expect(!snapshot.state.sessions.isEmpty)
        let store = AppStateStore()
        #expect(store.apply(snapshot: snapshot) == .applied)
        #expect(store.works.count == snapshot.state.works.count)
        #expect(store.tasks.count == snapshot.state.tasks.count)
        #expect(store.sessions.count == snapshot.state.sessions.count)
    }

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
            "tasks": [],
            "works": [],
            "agents": [],
            "skills": [],
            "repositories": [],
            "integrationRuns": [{
              "id": "integration:1",
              "repositoryId": "repository:1",
              "workId": "work:1",
              "status": "completed",
              "mainHeadBefore": "main:before",
              "mainHeadAfter": "main:after",
              "integrationWorktreeId": null,
              "integrationWorktreePath": null,
              "integrationBranch": null,
              "conflictCorptieTaskId": null,
              "conflictSessionId": null,
              "error": null,
              "items": [{
                "runId": "integration:1",
                "worktreeId": "worktree:1",
                "taskId": "task:1",
                "taskTitle": "Memory tools",
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
        #expect(snapshot.state.integrationRuns.first?.items.first?.taskTitle == "Memory tools")
    }

    @Test func snapshotDecodeErrorNamesTheMissingContractPath() {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let payload = Data(#"{"revision":1,"state":{"sessions":[],"tasks":[],"works":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[{}]}}"#.utf8)

        do {
            _ = try decoder.decode(StateSnapshotEnvelope.self, from: payload)
            Issue.record("Expected the incomplete integration run to fail decoding")
        } catch {
            let message = AppStateSyncController.syncErrorMessage(error)
            #expect(message.contains("state.integrationRuns[0]"))
            #expect(message.contains("字段"))
        }
    }

    @Test func snapshotRejectsLegacyCorptieTaskShape() {
        let payload = Data(#"{"revision":13,"state":{"sessions":[],"tasks":[{"id":"task:legacy","workId":"work:1","title":"Legacy collaboration item","description":"","acceptanceCriteria":null,"priority":"medium","status":"done","mainAgentId":null,"currentSessionId":null,"executionStatus":null,"acceptanceAssessment":{"status":"passed","source":"collaboration","collaborationTaskId":"task:1","assessedAt":"2026-08-19T23:59:34.703Z"},"completionSuggestion":null,"createdAt":"2026-08-19T00:00:00Z","updatedAt":"2026-08-19T00:01:00Z"}],"works":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[]}}"#.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        #expect(throws: DecodingError.self) {
            _ = try decoder.decode(StateSnapshotEnvelope.self, from: payload)
        }
    }

    @Test func changeSetDecodesArtifactInvalidationsWithoutEmbeddingArtifactPayloads() throws {
        let payload = Data(#"{"snapshotRequired":false,"baseRevision":20,"revision":22,"upserts":{"sessions":[],"tasks":[],"works":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[]},"deletes":{"sessions":[],"tasks":[],"works":[],"agents":[],"skills":[],"repositories":[],"integrationRuns":[]},"artifactInvalidations":["artifact:one"]}"#.utf8)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let changes = try decoder.decode(StateChangeSetEnvelope.self, from: payload)

        #expect(changes.artifactInvalidations == ["artifact:one"])
    }

    @Test func batchedChangeSetsApplyInRevisionOrderAndPublishStateOnce() {
        let store = AppStateStore()
        _ = store.apply(snapshot: .init(revision: 1, state: .fixture()))
        var publications = 0
        let cancellable = store.$state.sink { _ in publications += 1 }
        defer { cancellable.cancel() }
        let baseline = publications

        let batch = (2...6).map { revision in
            StateChangeSetEnvelope(
                snapshotRequired: false,
                baseRevision: Int64(revision - 1),
                revision: Int64(revision),
                upserts: .fixture(sessions: [
                    TaskSession.fixture(id: "session:\(revision)", title: "Step \(revision)")
                ]),
                deletes: .fixture()
            )
        }

        let result = store.apply(changeSets: batch)

        #expect(result.appliedCount == 5)
        #expect(result.lastResult == .applied)
        #expect(result.gapRevision == nil)
        #expect(store.revision == 6)
        #expect(store.sessions.count == 5)
        #expect(publications == baseline + 1)
    }

    @Test func batchedChangeSetsCommitAppliedFramesBeforeReportingGap() {
        let store = AppStateStore()
        _ = store.apply(snapshot: .init(revision: 4, state: .fixture()))
        let valid = StateChangeSetEnvelope(
            snapshotRequired: false, baseRevision: 4, revision: 5,
            upserts: .fixture(sessions: [TaskSession.fixture(id: "session:5", title: "Five")]),
            deletes: .fixture()
        )
        let gap = StateChangeSetEnvelope(
            snapshotRequired: false, baseRevision: 9, revision: 10,
            upserts: .fixture(), deletes: .fixture()
        )

        let result = store.apply(changeSets: [valid, gap])

        #expect(result.appliedCount == 1)
        #expect(store.revision == 5)
        #expect(store.sessions.map(\.id) == ["session:5"])
        #expect(result.gapRevision == 10)
        #expect(result.lastResult == .revisionGap(expected: 5, received: 9))
    }

    @Test func scopedCacheInvalidationKeepsEveryDerivedProjectionFresh() {
        func role(_ id: String, _ day: String) -> Role {
            Role(roleId: id, name: id, description: "", status: "available",
                 systemPrompt: "", capabilities: [], createdAt: day, updatedAt: day)
        }
        let store = AppStateStore()
        _ = store.apply(snapshot: .init(
            revision: 1,
            state: .fixture(
                sessions: [TaskSession.fixture(id: "session:1", title: "One")],
                roles: [role("role:one", "2026-01-01")]
            )
        ))
        #expect(store.roles.map(\.roleId) == ["role:one"])
        #expect(store.sessions.map(\.id) == ["session:1"])

        // A roles-only change must refresh the roles projection without
        // disturbing the cached sessions projection.
        _ = store.apply(changeSet: StateChangeSetEnvelope(
            snapshotRequired: false, baseRevision: 1, revision: 2,
            upserts: .fixture(roles: [role("role:two", "2026-01-02")]),
            deletes: .fixture()
        ))
        #expect(store.roles.map(\.roleId) == ["role:one", "role:two"])
        #expect(store.sessions.map(\.id) == ["session:1"])

        // hydrate(roles:) goes through the same explicit invalidation path.
        store.hydrate(roles: [role("role:three", "2026-01-03")])
        #expect(store.roles.map(\.roleId) == ["role:one", "role:two", "role:three"])
        #expect(store.sessions.map(\.id) == ["session:1"])
    }

    @Test func commitCountersAdvanceOnlyForTouchedEntityFamilies() {
        let store = AppStateStore()
        #expect(store.commitToken == AppStateCommitToken())
        _ = store.apply(snapshot: .init(revision: 1, state: .fixture(
            sessions: [TaskSession.fixture(id: "session:0", title: "Zero")]
        )))
        let afterSnapshot = store.commitToken
        #expect(afterSnapshot.sequence == 1)
        #expect(afterSnapshot.sessions == 1)
        // A snapshot only bumps families whose contents actually changed.
        #expect(afterSnapshot.tasks == 0)
        #expect(afterSnapshot.roles == 0)

        _ = store.apply(changeSet: StateChangeSetEnvelope(
            snapshotRequired: false, baseRevision: 1, revision: 2,
            upserts: .fixture(sessions: [TaskSession.fixture(id: "session:1", title: "One")]),
            deletes: .fixture()
        ))
        #expect(store.commitToken.sequence == afterSnapshot.sequence + 1)
        #expect(store.commitToken.sessions == afterSnapshot.sessions + 1)
        #expect(store.commitToken.tasks == afterSnapshot.tasks)
        #expect(store.commitToken.roles == afterSnapshot.roles)
    }

    @Test func unrelatedEntityFramesDoNotAdvanceTheSessionCommitCounter() {
        let store = AppStateStore()
        _ = store.apply(snapshot: .init(revision: 1, state: .fixture()))
        let before = store.commitToken
        let role = Role(roleId: "role:one", name: "one", description: "",
                        status: "available", systemPrompt: "", capabilities: [],
                        createdAt: "2026-01-01", updatedAt: "2026-01-01")
        _ = store.apply(changeSet: StateChangeSetEnvelope(
            snapshotRequired: false, baseRevision: 1, revision: 2,
            upserts: .fixture(roles: [role]),
            deletes: .fixture()
        ))
        #expect(store.commitToken.sessions == before.sessions)
        #expect(store.commitToken.roles == before.roles + 1)
        #expect(store.commitToken.sequence == before.sequence + 1)
    }

    @Test func batchedChangeSetsAdvanceTheCommitTokenOnlyOnce() {
        let store = AppStateStore()
        _ = store.apply(snapshot: .init(revision: 1, state: .fixture()))
        let before = store.commitToken
        let batch = (2...6).map { revision in
            StateChangeSetEnvelope(
                snapshotRequired: false,
                baseRevision: Int64(revision - 1),
                revision: Int64(revision),
                upserts: .fixture(sessions: [
                    TaskSession.fixture(id: "session:\(revision)", title: "Step \(revision)")
                ]),
                deletes: .fixture()
            )
        }
        _ = store.apply(changeSets: batch)
        #expect(store.commitToken.sequence == before.sequence + 1)
        #expect(store.commitToken.sessions == before.sessions + 1)
        #expect(store.commitToken.tasks == before.tasks)
    }
}

private extension ControlPlaneStatePayload {
    static func fixture(sessions: [TaskSession] = [], roles: [Role] = []) -> Self {
        .init(sessions: sessions, tasks: [], works: [], roles: roles, skills: [], repositories: [], integrationRuns: [])
    }
}

private extension StateEntityDeletes {
    static func fixture() -> Self {
        .init(sessions: [], tasks: [], works: [], roles: [], skills: [], repositories: [], integrationRuns: [])
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
            id: id, title: title, agent: "Codex", roleId: nil, sessionKind: .worker,
            workId: nil, taskId: nil, status: status, progress: 0,
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
