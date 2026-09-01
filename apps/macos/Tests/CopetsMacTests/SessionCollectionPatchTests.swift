import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct SessionCollectionPatchTests {
    @Test func authoritativeExecutionCompletionInvalidatesOnlyTheChangedStatusRow() {
        let previous = makeSession(id: "status", status: .running)
        var completed = previous
        completed.executionStatus = "completed"

        let patch = SessionCollectionDiffer.patch(from: [previous], to: [completed], revision: 1)

        #expect(patch.updated.count == 1)
        #expect(patch.updated.first?.changedFields == [.status])
    }

    @Test
    func contentUpdatePreservesStableRowAndDoesNotPublishStructure() {
        let original = makeSession(id: "one", summary: "Before")
        let updated = makeSession(id: "one", summary: "After")
        let patch = SessionCollectionDiffer.patch(from: [original], to: [updated], revision: 1)
        let store = SessionIndexStore()
        store.apply(
            SessionCollectionDiffer.patch(from: [], to: [original], revision: 0),
            authoritativeSessions: [original]
        )
        let row = store.row(id: "one")
        let orderedIDs = store.orderedIDs

        store.apply(patch, authoritativeSessions: [updated])

        #expect(store.row(id: "one") === row)
        #expect(store.orderedIDs == orderedIDs)
        #expect(row?.session.summary == "After")
        #expect(row?.changedFields == [.summary])
    }

    @Test
    func independentlyReplacedArchiveIndexNeverMutatesTheActiveIndex() {
        let active = SessionIndexStore()
        let archive = SessionIndexStore()
        let activeSession = makeSession(id: "active", sessionKind: .worker)
        let archivedSession = makeSession(id: "archived", sessionKind: .worker, archived: true)

        active.replaceAll(with: [activeSession])
        archive.replaceAll(with: [archivedSession])

        #expect(active.sessions.map(\.id) == ["active"])
        #expect(archive.sessions.map(\.id) == ["archived"])
        archive.replaceAll(with: [])
        #expect(active.sessions.map(\.id) == ["active"])
        #expect(archive.sessions.isEmpty)
    }

    @Test
    func terminalStatusChangeUpdatesOnlyTheStableSessionRow() {
        let running = makeSession(id: "one", status: .running)
        let completed = makeSession(id: "one", status: .complete)
        let store = SessionIndexStore()
        store.apply(
            SessionCollectionDiffer.patch(from: [], to: [running], revision: 1),
            authoritativeSessions: [running]
        )
        let row = store.row(id: running.id)

        store.apply(
            SessionCollectionDiffer.patch(from: [running], to: [completed], revision: 2),
            authoritativeSessions: [completed]
        )

        #expect(store.row(id: running.id) === row)
        #expect(row?.session.status == .complete)
        #expect(row?.changedFields == [.status])
        #expect(store.orderedIDs == [running.id])
    }

    @Test
    func authoritativeStatusAdvanceDuringDragUpdatesTheRowWithoutStealingLocalOrder() {
        let first = makeSession(id: "first", status: .running)
        let second = makeSession(id: "second", status: .running)
        let store = SessionIndexStore()
        store.replaceAll(with: [first, second])
        let stableFirstRow = store.row(id: first.id)

        store.beginReorder()
        store.move(second.id, before: first.id)
        var completedFirst = first
        completedFirst.executionStatus = "completed"
        store.apply(
            SessionCollectionDiffer.patch(
                from: [first, second],
                to: [completedFirst, second],
                revision: 2
            ),
            authoritativeSessions: [completedFirst, second]
        )

        #expect(store.orderedIDs == [second.id, first.id])
        #expect(store.row(id: first.id) === stableFirstRow)
        #expect(store.row(id: first.id)?.session.executionTaskStatus == .complete)
        #expect(store.row(id: first.id)?.changedFields == [.status])
    }

    @Test
    func completedDragReconcilesToTheServerOrderAndPreservesStableRows() {
        let first = makeSession(id: "first")
        let second = makeSession(id: "second")
        let third = makeSession(id: "third")
        let store = SessionIndexStore()
        store.replaceAll(with: [first, second, third])
        let stableRows = Dictionary(uniqueKeysWithValues: store.rows.map { ($0.id, $0) })

        store.beginReorder()
        store.move(third.id, before: first.id)
        store.endReorder(authoritativeSessions: [second, third, first])

        #expect(store.orderedIDs == [second.id, third.id, first.id])
        #expect(store.row(id: first.id) === stableRows[first.id])
        #expect(store.row(id: second.id) === stableRows[second.id])
        #expect(store.row(id: third.id) === stableRows[third.id])
    }

    @Test
    func structuralPatchDescribesInsertRemoveAndMove() {
        let one = makeSession(id: "one")
        let two = makeSession(id: "two")
        let three = makeSession(id: "three")

        let patch = SessionCollectionDiffer.patch(
            from: [one, two],
            to: [two, three],
            revision: 8
        )

        #expect(patch.removedIDs == ["one"])
        #expect(patch.inserted.map(\.session.id) == ["three"])
        #expect(patch.moved.contains { $0.sessionID == "two" && $0.fromIndex == 1 && $0.toIndex == 0 })
        #expect(patch.orderedIDs == ["two", "three"])
        #expect(patch.hasStructuralChanges)
    }

    @Test
    func processorDecodesAndDiffsOffTheMainActor() async throws {
        let current = makeSession(id: "one", summary: "Before")
        let data = Data(
            """
            {"sessions":[{"id":"one","title":"one","agent":"Codex","status":"complete","progress":1,"summary":"After","updatedAt":"2026-08-12T00:00:00Z","accent":"cyan"}]}
            """.utf8
        )
        let result = try await SessionPayloadProcessor().processSnapshot(data: data, current: [current])

        #expect(result.sessions.first?.summary == "After")
        #expect(result.patch.updated.first?.changedFields.contains(SessionChangedFields.summary) == true)
    }

    @Test
    func processorPreservesCorptieTaskBindingMetadata() async throws {
        let current = makeSession(id: "one")
        let data = Data(
            """
            {"sessions":[{"id":"one","title":"one","agent":"Codex","objectiveId":"objective:1","taskId":"task:1","status":"complete","progress":1,"summary":"Summary","updatedAt":"2026-08-12T00:00:00Z","accent":"cyan"}]}
            """.utf8
        )

        let result = try await SessionPayloadProcessor().processSnapshot(data: data, current: [current])

        #expect(result.sessions.first?.objectiveId == "objective:1")
        #expect(result.sessions.first?.taskId == "task:1")
        #expect(result.patch.updated.first?.changedFields.contains(.metadata) == true)
    }

    @Test
    func pendingSelectionMatchesWhenTheSessionSnapshotArrivesFirst() {
        let session = makeSession(id: "codex:new-session")

        #expect(sessionMatchingPendingSelection("codex:new-session", in: [session])?.id == session.id)
        #expect(sessionMatchingPendingSelection("codex:missing", in: [session]) == nil)
        #expect(sessionMatchingPendingSelection(nil, in: [session]) == nil)
    }

    @Test
    func taskNavigationResolvesEveryDeclaredSessionRouteIdentifier() {
        let routed = makeSession(
            id: "openclacky:legacy-session",
            external: ExternalSession(
                provider: "codex-app-server",
                threadId: "provider-thread-after-switch",
                sessionId: "provider-thread-after-switch",
                agentSessionId: nil,
                connectionStatus: "connected",
                currentModel: nil,
                currentReasoningLevel: nil,
                cwd: nil,
                sandbox: nil,
                approvalPolicy: nil,
                source: "corptie",
                logicalSessionId: "logical:stable-session",
                workspace: nil,
                routingVersion: 3,
                providerSwitchInFlight: nil,
                providerTransition: nil
            )
        )

        #expect(sessionMatchingPendingSelection("openclacky:legacy-session", in: [routed])?.id == routed.id)
        #expect(sessionMatchingPendingSelection(" logical:stable-session ", in: [routed])?.id == routed.id)
        #expect(sessionMatchingPendingSelection("provider-thread-after-switch", in: [routed])?.id == routed.id)
    }

    @Test
    func canonicalSessionIdWinsOverAnotherSessionsRouteAlias() {
        let canonical = makeSession(id: "session:target")
        let aliasCollision = makeSession(
            id: "session:other",
            external: ExternalSession(
                provider: "test-provider",
                threadId: "session:target",
                sessionId: nil,
                agentSessionId: nil,
                connectionStatus: nil,
                currentModel: nil,
                currentReasoningLevel: nil,
                cwd: nil,
                sandbox: nil,
                approvalPolicy: nil,
                source: nil,
                logicalSessionId: nil,
                workspace: nil,
                routingVersion: nil,
                providerSwitchInFlight: nil,
                providerTransition: nil
            )
        )

        #expect(sessionMatchingPendingSelection("session:target", in: [aliasCollision, canonical])?.id == canonical.id)
        #expect(sessionMatchingPendingSelection("provider:missing", in: [aliasCollision, canonical]) == nil)
    }

    @Test
    func sessionDetailResolvesTheBoundAgentInsteadOfTheProviderLabel() {
        let session = makeSession(id: "codex:thread", agentId: "research-agent")
        let agent = Agent(
            agentId: "research-agent",
            name: "研究员",
            description: "",
            role: "independentContributor",
            status: "active",
            systemPrompt: "",
            capabilities: [],
            workDir: nil,
            avatarPath: nil,
            skillIds: nil,
            currentSessionId: session.id,
            createdAt: "2026-08-12T00:00:00Z",
            updatedAt: "2026-08-12T00:00:00Z"
        )

        #expect(sessionAgentDisplayName(session: session, agents: [agent]) == "研究员")
        #expect(sessionAgentDisplayName(session: session, agents: []) == "research-agent")
        #expect(sessionAgentDisplayName(session: makeSession(id: "unbound"), agents: [agent]) == "未挂载")
    }

    @Test
    func assistantChatGroupingDoesNotDependOnAgentCache() {
        let assistant = SessionRowModel(session: makeSession(
            id: "assistant-chat",
            agentId: "assistant",
            sessionKind: .assistantChat
        ))
        let worker = SessionRowModel(session: makeSession(
            id: "worker",
            agentId: "contributor",
            sessionKind: .worker,
            taskId: "task:1"
        ))
        let legacy = SessionRowModel(session: makeSession(id: "legacy", agentId: "unknown"))

        let groups = makeSessionGroups(
            rows: [worker, legacy, assistant],
            agents: [],
            tasks: [],
            objectives: [],
            category: .assistant
        )

        #expect(groups.map(\.key) == ["assistant:assistant"])
        #expect(groups[0].rows.map(\.id) == ["assistant-chat"])
        #expect(!groups.flatMap(\.rows).contains(where: { $0.id == legacy.id }))
        #expect(!groups.flatMap(\.rows).contains(where: { $0.id == worker.id }))
    }

    @Test
    func objectiveChatIsGroupedSeparatelyFromAssistantAndWorkerSessions() {
        let objective = SessionRowModel(session: makeSession(
            id: "objective-chat",
            agentId: "assistant",
            sessionKind: .objectiveChat,
            objectiveId: "objective:1"
        ))
        let assistant = SessionRowModel(session: makeSession(
            id: "assistant-chat",
            agentId: "assistant",
            sessionKind: .assistantChat
        ))
        let groups = makeSessionGroups(
            rows: [objective, assistant],
            agents: [],
            tasks: [],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .objective
        )

        #expect(groups.map(\.key) == ["objective:objective:1"])
        #expect(groups.map(\.title) == ["Sessions UI"])
        #expect(groups[0].rows.map(\.id) == ["objective-chat"])
    }

    @Test
    func activeWorkerSessionsExcludeBackendResolvedCompletedCorptieTasksAndGroupByObjective() {
        let active = SessionRowModel(session: makeSession(
            id: "active-worker",
            sessionKind: .worker,
            taskId: "task:active"
        ))
        let completed = SessionRowModel(session: makeSession(
            id: "completed-worker",
            sessionKind: .worker,
            taskId: "task:completed",
            archived: true
        ))
        let orphaned = SessionRowModel(session: makeSession(
            id: "orphaned-worker",
            sessionKind: .worker,
            taskId: "task:missing"
        ))

        let groups = makeSessionGroups(
            rows: [active, completed, orphaned],
            agents: [],
            tasks: [
                makeCorptieTask(id: "task:active", lifecycleState: "in_progress"),
                makeCorptieTask(id: "task:completed", lifecycleState: "done")
            ],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .worker
        )

        #expect(groups.map(\.key) == ["worker-objective:objective:1", "worker-objective:__no_objective__"])
        #expect(groups.map(\.title) == ["Sessions UI", L10n("No Objective")])
        #expect(groups[0].rows.map(\.id) == ["active-worker"])
        #expect(groups[1].rows.map(\.id) == ["orphaned-worker"])
    }

    @Test
    func ungroupedWorkerSessionsAppearOnceWithoutAnObjectiveHeader() {
        let first = SessionRowModel(session: makeSession(
            id: "first-worker",
            sessionKind: .worker,
            taskId: "task:first"
        ))
        let second = SessionRowModel(session: makeSession(
            id: "second-worker",
            sessionKind: .worker,
            taskId: "task:second"
        ))

        let groups = makeSessionGroups(
            rows: [first, second],
            agents: [],
            tasks: [
                makeCorptieTask(id: "task:first", lifecycleState: "in_progress"),
                makeCorptieTask(id: "task:second", lifecycleState: "todo")
            ],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .worker,
            workerGroupingMode: .none
        )

        #expect(groups.count == 1)
        #expect(groups[0].key == "worker-ungrouped")
        #expect(groups[0].showsHeader == false)
        #expect(groups[0].rows.map(\.id) == ["first-worker", "second-worker"])
        #expect(groups[0].rowSubtitles == [
            "first-worker": "Sessions UI",
            "second-worker": "Sessions UI"
        ])
    }

    @Test
    func sessionGroupsSortByLastMessageInsteadOfMetadataUpdateTime() {
        let newestMessage = SessionRowModel(session: makeSession(
            id: "newest-message",
            sessionKind: .worker,
            taskId: "task:newest",
            updatedAt: "2026-08-20T01:00:00Z",
            lastMessageAt: "2026-08-20T03:00:00Z"
        ))
        let newestMetadata = SessionRowModel(session: makeSession(
            id: "newest-metadata",
            sessionKind: .worker,
            taskId: "task:metadata",
            updatedAt: "2026-08-20T04:00:00Z",
            lastMessageAt: "2026-08-20T02:00:00Z"
        ))

        let groups = makeSessionGroups(
            rows: [newestMetadata, newestMessage],
            agents: [],
            tasks: [
                makeCorptieTask(id: "task:newest", lifecycleState: "in_progress"),
                makeCorptieTask(id: "task:metadata", lifecycleState: "in_progress")
            ],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .worker,
            workerGroupingMode: .none
        )

        #expect(groups[0].rows.map(\.id) == ["newest-message", "newest-metadata"])
    }

    @Test
    func archivedWorkerSessionsUseTheSessionArchiveFlagRatherThanCorptieTaskStatus() {
        let active = SessionRowModel(session: makeSession(
            id: "active-worker",
            sessionKind: .worker,
            taskId: "task:active"
        ))
        let completed = SessionRowModel(session: makeSession(
            id: "completed-worker",
            sessionKind: .worker,
            taskId: "task:completed",
            archived: true
        ))

        let groups = makeSessionGroups(
            rows: [active, completed],
            agents: [],
            tasks: [
                makeCorptieTask(id: "task:active", lifecycleState: "in_progress"),
                makeCorptieTask(id: "task:completed", lifecycleState: "done")
            ],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .worker,
            workerScope: .archived
        )

        #expect(groups.map(\.title) == ["Sessions UI"])
        #expect(groups.flatMap(\.rows).map(\.id) == ["completed-worker"])
        #expect(groups.map(\.showsHeader) == [true])
    }

    @Test
    func onlyAssistantSessionsAllowManualArchiveOperations() {
        let assistant = makeSession(id: "assistant", sessionKind: .assistantChat)
        let objective = makeSession(
            id: "objective",
            sessionKind: .objectiveChat,
            objectiveId: "objective:1"
        )
        let worker = makeSession(
            id: "worker",
            sessionKind: .worker,
            taskId: "task:1"
        )

        #expect(assistant.allowsManualArchive)
        #expect(!objective.allowsManualArchive)
        #expect(!worker.allowsManualArchive)
    }

    @Test
    func workerSelectionRespectsActiveAndArchiveScopes() {
        let active = SessionRowModel(session: makeSession(
            id: "active-worker",
            sessionKind: .worker,
            taskId: "task:active"
        ))
        let completed = SessionRowModel(session: makeSession(
            id: "completed-worker",
            sessionKind: .worker,
            taskId: "task:completed",
            archived: true
        ))
        #expect(resolvedSessionSelection(
            category: .worker,
            rows: [completed, active],
            selectedSessionId: "completed-worker",
            lastSelectedId: nil,
            workerScope: .active
        ) == "active-worker")
        #expect(resolvedSessionSelection(
            category: .worker,
            rows: [active, completed],
            selectedSessionId: "active-worker",
            lastSelectedId: nil,
            workerScope: .archived
        ) == "completed-worker")
    }

    @Test
    func sessionIsUnreadOnlyWhenAgentMessageCursorAdvancesPastReceipt() {
        #expect(isSessionUnread(makeSession(
            id: "unread",
            lastAgentMessageSequence: 8,
            lastReadMessageSequence: 5
        )))
        #expect(!isSessionUnread(makeSession(
            id: "read",
            lastAgentMessageSequence: 8,
            lastReadMessageSequence: 8
        )))
        #expect(!isSessionUnread(makeSession(id: "user-or-tool-only")))
        #expect(!isSessionUnread(makeSession(
            id: "running-with-agent-message",
            status: .running,
            lastAgentMessageSequence: 2,
            lastReadMessageSequence: 1
        )))
    }

    @Test
    func openingSessionAcknowledgesLatestAgentMessageWithoutTimelinePosition() {
        let unread = makeSession(
            id: "opened",
            lastAgentMessageSequence: 8,
            lastReadMessageSequence: 5
        )

        #expect(SessionReadAcknowledgementPolicy.sequenceForOpenedSession(
            unread,
            alreadySubmittedSequence: nil
        ) == 8)
        #expect(SessionReadAcknowledgementPolicy.sequenceForOpenedSession(
            unread,
            alreadySubmittedSequence: 8
        ) == nil)

        let read = makeSession(
            id: "already-read",
            lastAgentMessageSequence: 8,
            lastReadMessageSequence: 8
        )
        #expect(SessionReadAcknowledgementPolicy.sequenceForOpenedSession(
            read,
            alreadySubmittedSequence: nil
        ) == nil)
    }

    @Test
    func readReceiptCursorChangeInvalidatesUnreadGroupingWithoutReordering() {
        let unread = makeSession(
            id: "receipt",
            lastAgentMessageSequence: 3,
            lastReadMessageSequence: 1
        )
        let read = makeSession(
            id: "receipt",
            lastAgentMessageSequence: 3,
            lastReadMessageSequence: 3
        )
        let patch = SessionCollectionDiffer.patch(from: [unread], to: [read], revision: 9)

        #expect(patch.updated.first?.changedFields.contains(.metadata) == true)
        #expect(patch.updated.first?.changedFields.contains(.ordering) == false)
    }

    @Test
    func timelineRevisionWakesBackgroundSyncWithoutReorderingTheList() {
        let previous = makeSession(id: "timeline", timelineRevision: 7)
        let current = makeSession(id: "timeline", timelineRevision: 8)
        let patch = SessionCollectionDiffer.patch(from: [previous], to: [current], revision: 10)

        #expect(patch.updated.first?.changedFields == [.metadata])
        #expect(patch.moved.isEmpty)
    }

    @Test
    func readReceiptResponseClearsUnreadImmediatelyWithoutClearingConcurrentMessages() {
        let unread = makeSession(
            id: "logical-session",
            lastAgentMessageSequence: 8,
            lastReadMessageSequence: 3
        )
        let untouched = makeSession(
            id: "other-session",
            lastAgentMessageSequence: 4,
            lastReadMessageSequence: 1
        )
        let receipt = SessionReadReceiptResponse(
            sessionId: "logical-session",
            legacySessionId: "provider-session",
            lastAgentMessageSequence: 8,
            lastReadMessageSequence: 8
        )

        let store = AppStateStore()
        _ = store.apply(snapshot: .init(
            revision: 1,
            state: emptyControlPlaneState(sessions: [unread, untouched])
        ))
        store.acceptReadReceipt(receipt, requestedSessionID: "logical-session")
        let updated = store.session("logical-session")

        #expect(updated?.lastAgentMessageSequence == 8)
        #expect(updated?.lastReadMessageSequence == 8)
        #expect(updated.map(isSessionUnread) == false)
        #expect(store.session("other-session") == untouched)

        let concurrent = makeSession(
            id: "logical-session",
            lastAgentMessageSequence: 9,
            lastReadMessageSequence: 3
        )
        let concurrentStore = AppStateStore()
        _ = concurrentStore.apply(snapshot: .init(
            revision: 1,
            state: emptyControlPlaneState(sessions: [concurrent])
        ))
        concurrentStore.acceptReadReceipt(receipt, requestedSessionID: "logical-session")
        #expect(concurrentStore.sessions[0].lastAgentMessageSequence == 9)
        #expect(concurrentStore.sessions[0].lastReadMessageSequence == 8)
        #expect(isSessionUnread(concurrentStore.sessions[0]))
    }

    @Test
    func notificationScopeExcludesArchivedSessions() {
        let snapshots = SessionNotificationScope.activeSnapshots(from: [
            makeSession(id: "active", lastAgentMessageSequence: 2),
            makeSession(id: "archived", lastAgentMessageSequence: 3, archived: true),
            makeSession(
                id: "completed-task",
                sessionKind: .worker,
                taskId: "task:done",
                lastAgentMessageSequence: 4
            )
        ])

        #expect(snapshots.map(\.id) == ["active", "completed-task"])
        #expect(snapshots.first?.needsUserAttention == true)
    }

    @Test
    func unreadTabCountsUseSessionCategoryAndExcludeArchivedWorkSessions() {
        let activeWorker = makeSession(
            id: "active-worker",
            sessionKind: .worker,
            taskId: "task:active",
            lastAgentMessageSequence: 1
        )
        let archivedWorker = makeSession(
            id: "archived-worker",
            sessionKind: .worker,
            taskId: "task:done",
            lastAgentMessageSequence: 1,
            archived: true
        )
        let objective = makeSession(
            id: "objective",
            sessionKind: .objectiveChat,
            objectiveId: "objective:1",
            lastAgentMessageSequence: 1
        )
        let assistant = makeSession(
            id: "assistant",
            sessionKind: .assistantChat,
            status: .running
        )
        let sessions = [activeWorker, archivedWorker, objective, assistant]
        #expect(countUnreadSessions(
            in: sessions,
            category: .worker
        ) == 1)
        #expect(countUnreadSessions(
            in: sessions,
            category: .objective
        ) == 1)
        #expect(countUnreadSessions(
            in: sessions,
            category: .assistant
        ) == 0)
    }

    @Test
    func sessionCategoriesClassifyValidProductSessions() {
        #expect(SessionCategory(session: makeSession(id: "worker", sessionKind: .worker)) == .worker)
        #expect(SessionCategory(session: makeSession(id: "objective", sessionKind: .objectiveChat)) == .objective)
        #expect(SessionCategory(session: makeSession(id: "assistant", sessionKind: .assistantChat)) == .assistant)
    }

    @Test
    func assistantListAndSelectionExcludeMissingOrLegacyClassifications() {
        let legacy = makeSession(id: "legacy")
        let assistant = makeSession(id: "assistant", sessionKind: .assistantChat)
        let rows = [SessionRowModel(session: legacy), SessionRowModel(session: assistant)]

        let groups = makeSessionGroups(
            rows: rows,
            agents: [],
            tasks: [],
            objectives: [],
            category: .assistant
        )

        #expect(groups.flatMap(\.rows).map(\.id) == ["assistant"])
        #expect(resolvedSessionSelection(
            category: .assistant,
            rows: [SessionRowModel(session: legacy)],
            selectedSessionId: "legacy",
            lastSelectedId: "legacy"
        ) == nil)
        #expect(countUnreadSessions(
            in: [makeSession(id: "legacy-unread", lastAgentMessageSequence: 1)],
            category: .assistant
        ) == 0)
    }

    @Test
    func unknownAndEmptySessionKindsDecodeToHiddenLegacySentinel() throws {
        let decoder = JSONDecoder()
        let unknown = try decoder.decode(SessionKind.self, from: Data("\"unknown\"".utf8))
        let empty = try decoder.decode(SessionKind.self, from: Data("\"  \"".utf8))

        #expect(unknown == .legacy)
        #expect(empty == .legacy)
        #expect(makeSession(id: "missing").hasValidProductClassification == false)
    }

    @Test
    func sessionKindChangeInvalidatesGrouping() {
        let legacy = makeSession(id: "one")
        let assistant = makeSession(id: "one", agentId: "assistant", sessionKind: .assistantChat)
        let patch = SessionCollectionDiffer.patch(from: [legacy], to: [assistant], revision: 2)
        let store = SessionIndexStore()
        store.apply(
            SessionCollectionDiffer.patch(from: [], to: [legacy], revision: 1),
            authoritativeSessions: [legacy]
        )
        let previousGroupingRevision = store.groupingRevision

        store.apply(patch, authoritativeSessions: [assistant])

        #expect(patch.updated.first?.changedFields.contains(.metadata) == true)
        #expect(store.groupingRevision == previousGroupingRevision + 1)
    }

}

struct SessionCollectionWirePatchTests {
    @Test
    func appliesContentOnlyWirePatchWithoutChangingOrder() throws {
        let first = makeSession(id: "a", summary: "old")
        let second = makeSession(id: "b", summary: "stable")
        let changed = makeSession(id: "a", summary: "new")
        let patch = SessionCollectionPatchEnvelope(
            baseRevision: 3,
            revision: 4,
            orderedIds: nil,
            inserted: [],
            removedIds: [],
            updated: [.init(sessionId: "a", changedFields: ["summary"], session: changed)]
        )

        let result = BackendClient.applyingSessionCollectionPatch(patch, to: [first, second])
        #expect(result?.map(\.id) == ["a", "b"])
        #expect(result?.first?.summary == "new")
    }

    @Test
    func rejectsStructuralPatchWhoseCanonicalOrderDoesNotMatchContents() throws {
        let patch = SessionCollectionPatchEnvelope(
            baseRevision: 9,
            revision: 10,
            orderedIds: ["missing"],
            inserted: [],
            removedIds: [],
            updated: []
        )
        #expect(BackendClient.applyingSessionCollectionPatch(
            patch,
            to: [makeSession(id: "a", summary: "ready")]
        ) == nil)
    }
}

private func makeSession(
    id: String,
    summary: String = "Summary",
    agentId: String? = nil,
    sessionKind: SessionKind? = nil,
    taskId: String? = nil,
    objectiveId: String? = nil,
    status: TaskStatus = .complete,
    updatedAt: String = "2026-08-12T00:00:00Z",
    lastMessageAt: String? = nil,
    lastAgentMessageSequence: Int? = nil,
    lastReadMessageSequence: Int? = nil,
    timelineRevision: Int? = nil,
    archived: Bool = false,
    pinned: Bool = false,
    external: ExternalSession? = nil
) -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Codex",
        agentId: agentId,
        sessionKind: sessionKind,
        objectiveId: objectiveId,
        taskId: taskId,
        status: status,
        progress: 1,
        summary: summary,
        suggestedOptions: nil,
        suggestedPrompt: nil,
        activityStatus: nil,
        updatedAt: updatedAt,
        lastMessageAt: lastMessageAt,
        lastAgentMessageSequence: lastAgentMessageSequence,
        lastReadMessageSequence: lastReadMessageSequence,
        timelineRevision: timelineRevision,
        accent: .cyan,
        archived: archived,
        pinned: pinned,
        sortOrder: nil,
        capabilities: nil,
        external: external,
        actions: nil,
    )
}

private func emptyControlPlaneState(sessions: [TaskSession]) -> ControlPlaneStatePayload {
    .init(
        sessions: sessions,
        tasks: [],
        objectives: [],
        agents: [],
        skills: [],
        repositories: [],
        integrationRuns: []
    )
}

private func makeObjective(id: String, name: String) -> Objective {
    Objective(
        id: id,
        name: name,
        description: "",
        idealState: "",
        status: "active",
        priority: nil,
        targetDate: nil,
        tags: [],
        workspaceIds: [],
        relatedObjectiveIds: [],
        contributorAgentIds: [],
        createdAt: "2026-08-12T00:00:00Z",
        updatedAt: "2026-08-12T00:00:00Z"
    )
}

private func makeCorptieTask(id: String, lifecycleState: String) -> CorptieTask {
    CorptieTask(
        id: id,
        objectiveId: "objective:1",
        title: id,
        description: "",
        acceptanceCriteria: "",
        priority: "medium",
        lifecycleState: lifecycleState,
        mainWorkspaceId: nil,
        mainAgentId: nil,
        currentSessionId: nil,
        executionStatus: nil,
        acceptanceAssessment: nil,
        completionSuggestion: nil,
        createdAt: "2026-08-12T00:00:00Z",
        updatedAt: "2026-08-12T00:00:00Z"
    )
}
