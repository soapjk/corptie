import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct SessionCollectionPatchTests {
    @Test
    func detailPreloadWarmsTheFirstVisiblePageWithoutASelection() {
        let ids = (0..<12).map { "session-\($0)" }

        let prioritized = SessionDetailPreloadPolicy.prioritizedSessionIDs(ids, selectedSessionID: nil)

        #expect(prioritized == Array(ids.prefix(SessionDetailPreloadPolicy.batchLimit)))
    }

    @Test
    func detailPreloadPrioritizesNeighborsAndExcludesTheSelection() {
        let prioritized = SessionDetailPreloadPolicy.prioritizedSessionIDs(
            ["one", "two", "three", "four", "five"],
            selectedSessionID: "three",
            limit: 4
        )

        #expect(prioritized == ["four", "two", "five", "one"])
        #expect(!prioritized.contains("three"))
    }

    @Test
    func detailPreloadDeduplicatesSessionIdentifiers() {
        let prioritized = SessionDetailPreloadPolicy.prioritizedSessionIDs(
            ["one", "one", "two", "three"],
            selectedSessionID: nil,
            limit: 8
        )

        #expect(prioritized == ["one", "two", "three"])
    }

    @Test
    func agentMessageCursorAdvanceRefreshesOnlyBackgroundSessionDetails() {
        let previous = [
            makeSession(id: "selected", lastAgentMessageSequence: 3),
            makeSession(id: "completed", lastAgentMessageSequence: 4),
            makeSession(id: "status-only", lastAgentMessageSequence: 2)
        ]
        let current = [
            makeSession(id: "selected", lastAgentMessageSequence: 5),
            makeSession(id: "completed", lastAgentMessageSequence: 5),
            makeSession(id: "status-only", lastAgentMessageSequence: 2),
            makeSession(id: "new-with-message", lastAgentMessageSequence: 1),
            makeSession(id: "new-without-message")
        ]

        let refreshes = SessionDetailPreloadPolicy.sessionsWithAdvancedAgentMessages(
            previous: previous,
            current: current,
            excluding: "selected"
        )

        #expect(refreshes.map(\.id) == ["completed", "new-with-message"])
    }

    @Test
    func contentUpdatePreservesStableRowAndDoesNotPublishStructure() {
        let original = makeSession(id: "one", summary: "Before")
        let updated = makeSession(id: "one", summary: "After")
        let patch = SessionCollectionDiffer.patch(from: [original], to: [updated], revision: 1)
        let store = SessionListStore()
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
    func processorPreservesWorkItemBindingMetadata() async throws {
        let current = makeSession(id: "one")
        let data = Data(
            """
            {"sessions":[{"id":"one","title":"one","agent":"Codex","objectiveId":"objective:1","workItemId":"work_item:1","status":"complete","progress":1,"summary":"Summary","updatedAt":"2026-08-12T00:00:00Z","accent":"cyan"}]}
            """.utf8
        )

        let result = try await SessionPayloadProcessor().processSnapshot(data: data, current: [current])

        #expect(result.sessions.first?.objectiveId == "objective:1")
        #expect(result.sessions.first?.workItemId == "work_item:1")
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
            workItemId: "work-item:1"
        ))
        let legacy = SessionRowModel(session: makeSession(id: "legacy", agentId: "unknown"))

        let groups = makeSessionGroups(
            rows: [worker, legacy, assistant],
            agents: [],
            workItems: [],
            objectives: [],
            category: .assistant
        )

        #expect(groups.map(\.key) == ["assistant:assistant", "__legacy__"])
        #expect(groups[0].rows.map(\.id) == ["assistant-chat"])
        #expect(groups[1].rows.map(\.id) == ["legacy"])
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
            workItems: [],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .objective
        )

        #expect(groups.map(\.key) == ["objective:objective:1"])
        #expect(groups.map(\.title) == ["Sessions UI"])
        #expect(groups[0].rows.map(\.id) == ["objective-chat"])
    }

    @Test
    func activeWorkerSessionsExcludeCompletedWorkItemsAndGroupByObjective() {
        let active = SessionRowModel(session: makeSession(
            id: "active-worker",
            sessionKind: .worker,
            workItemId: "work-item:active"
        ))
        let completed = SessionRowModel(session: makeSession(
            id: "completed-worker",
            sessionKind: .worker,
            workItemId: "work-item:completed"
        ))
        let orphaned = SessionRowModel(session: makeSession(
            id: "orphaned-worker",
            sessionKind: .worker,
            workItemId: "work-item:missing"
        ))

        let groups = makeSessionGroups(
            rows: [active, completed, orphaned],
            agents: [],
            workItems: [
                makeWorkItem(id: "work-item:active", status: "in_progress"),
                makeWorkItem(id: "work-item:completed", status: "done")
            ],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .worker
        )

        #expect(groups.map(\.key) == ["worker-objective:objective:1", "worker-objective:__no_objective__"])
        #expect(groups.map(\.title) == ["Sessions UI", L10n("No Objective")])
        #expect(groups[0].rows.map(\.id) == ["active-worker"])
        #expect(groups[1].rows.map(\.id) == ["orphaned-worker"])
        #expect(!groups.flatMap(\.rows).contains(where: { $0.id == completed.id }))
    }

    @Test
    func ungroupedWorkerSessionsAppearOnceWithoutAnObjectiveHeader() {
        let first = SessionRowModel(session: makeSession(
            id: "first-worker",
            sessionKind: .worker,
            workItemId: "work-item:first"
        ))
        let second = SessionRowModel(session: makeSession(
            id: "second-worker",
            sessionKind: .worker,
            workItemId: "work-item:second"
        ))

        let groups = makeSessionGroups(
            rows: [first, second],
            agents: [],
            workItems: [
                makeWorkItem(id: "work-item:first", status: "in_progress"),
                makeWorkItem(id: "work-item:second", status: "ready")
            ],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .worker,
            workerGroupingMode: .none
        )

        #expect(groups.count == 1)
        #expect(groups[0].key == "worker-ungrouped")
        #expect(groups[0].showsHeader == false)
        #expect(groups[0].rows.map(\.id) == ["first-worker", "second-worker"])
    }

    @Test
    func sessionGroupsSortByLastMessageInsteadOfMetadataUpdateTime() {
        let newestMessage = SessionRowModel(session: makeSession(
            id: "newest-message",
            sessionKind: .worker,
            workItemId: "work-item:newest",
            updatedAt: "2026-08-20T01:00:00Z",
            lastMessageAt: "2026-08-20T03:00:00Z"
        ))
        let newestMetadata = SessionRowModel(session: makeSession(
            id: "newest-metadata",
            sessionKind: .worker,
            workItemId: "work-item:metadata",
            updatedAt: "2026-08-20T04:00:00Z",
            lastMessageAt: "2026-08-20T02:00:00Z"
        ))

        let groups = makeSessionGroups(
            rows: [newestMetadata, newestMessage],
            agents: [],
            workItems: [
                makeWorkItem(id: "work-item:newest", status: "in_progress"),
                makeWorkItem(id: "work-item:metadata", status: "in_progress")
            ],
            objectives: [makeObjective(id: "objective:1", name: "Sessions UI")],
            category: .worker,
            workerGroupingMode: .none
        )

        #expect(groups[0].rows.map(\.id) == ["newest-message", "newest-metadata"])
    }

    @Test
    func archivedWorkerSessionsContainOnlyCompletedWorkItemsGroupedByObjective() {
        let active = SessionRowModel(session: makeSession(
            id: "active-worker",
            sessionKind: .worker,
            workItemId: "work-item:active"
        ))
        let completed = SessionRowModel(session: makeSession(
            id: "completed-worker",
            sessionKind: .worker,
            workItemId: "work-item:completed"
        ))

        let groups = makeSessionGroups(
            rows: [active, completed],
            agents: [],
            workItems: [
                makeWorkItem(id: "work-item:active", status: "in_progress"),
                makeWorkItem(id: "work-item:completed", status: "completed")
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
    func workerSelectionRespectsActiveAndArchiveScopes() {
        let active = SessionRowModel(session: makeSession(
            id: "active-worker",
            sessionKind: .worker,
            workItemId: "work-item:active"
        ))
        let completed = SessionRowModel(session: makeSession(
            id: "completed-worker",
            sessionKind: .worker,
            workItemId: "work-item:completed"
        ))
        let workItems = [
            makeWorkItem(id: "work-item:active", status: "in_progress"),
            makeWorkItem(id: "work-item:completed", status: "done")
        ]

        #expect(resolvedSessionSelection(
            category: .worker,
            rows: [completed, active],
            selectedSessionId: "completed-worker",
            lastSelectedId: nil,
            workItems: workItems,
            workerScope: .active
        ) == "active-worker")
        #expect(resolvedSessionSelection(
            category: .worker,
            rows: [active, completed],
            selectedSessionId: "active-worker",
            lastSelectedId: nil,
            workItems: workItems,
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

        let updated = BackendClient.applyingReadReceipt(
            receipt,
            requestedSessionID: "logical-session",
            to: [unread, untouched]
        )

        #expect(updated[0].lastAgentMessageSequence == 8)
        #expect(updated[0].lastReadMessageSequence == 8)
        #expect(!isSessionUnread(updated[0]))
        #expect(updated[1] == untouched)

        let concurrent = makeSession(
            id: "logical-session",
            lastAgentMessageSequence: 9,
            lastReadMessageSequence: 3
        )
        let concurrentUpdate = BackendClient.applyingReadReceipt(
            receipt,
            requestedSessionID: "logical-session",
            to: [concurrent]
        )
        #expect(concurrentUpdate[0].lastAgentMessageSequence == 9)
        #expect(concurrentUpdate[0].lastReadMessageSequence == 8)
        #expect(isSessionUnread(concurrentUpdate[0]))
    }

    @Test
    func completionNotificationPendingCountMeansUnreadAgentMessages() {
        let summary = SessionCompletionNotificationSummary.make(from: [
            makeSession(
                id: "completed-read",
                status: .complete,
                lastAgentMessageSequence: 4,
                lastReadMessageSequence: 4
            ),
            makeSession(
                id: "completed-unread",
                status: .complete,
                lastAgentMessageSequence: 7,
                lastReadMessageSequence: 5
            ),
            makeSession(id: "blocked-but-read", status: .blocked),
            makeSession(id: "failed", status: .failed)
        ])

        #expect(summary.completed == 2)
        #expect(summary.pending == 1)
        #expect(summary.failed == 1)
    }

    @Test
    func unreadTabCountsUseSessionCategoryAndExcludeArchivedWorkSessions() {
        let activeWorker = makeSession(
            id: "active-worker",
            sessionKind: .worker,
            workItemId: "work-item:active",
            lastAgentMessageSequence: 1
        )
        let archivedWorker = makeSession(
            id: "archived-worker",
            sessionKind: .worker,
            workItemId: "work-item:done",
            lastAgentMessageSequence: 1
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
        let workItems = [
            makeWorkItem(id: "work-item:active", status: "in_progress"),
            makeWorkItem(id: "work-item:done", status: "done")
        ]

        #expect(countUnreadSessions(
            in: sessions,
            category: .worker,
            workItems: workItems
        ) == 1)
        #expect(countUnreadSessions(
            in: sessions,
            category: .objective,
            workItems: workItems
        ) == 1)
        #expect(countUnreadSessions(
            in: sessions,
            category: .assistant,
            workItems: workItems
        ) == 0)
    }

    @Test
    func sessionCategoriesKeepLegacySessionsDiscoverableAsAssistantSessions() {
        #expect(SessionCategory(session: makeSession(id: "worker", sessionKind: .worker)) == .worker)
        #expect(SessionCategory(session: makeSession(id: "objective", sessionKind: .objectiveChat)) == .objective)
        #expect(SessionCategory(session: makeSession(id: "assistant", sessionKind: .assistantChat)) == .assistant)
        #expect(SessionCategory(session: makeSession(id: "legacy")) == .assistant)
    }

    @Test
    func sessionKindChangeInvalidatesGrouping() {
        let legacy = makeSession(id: "one")
        let assistant = makeSession(id: "one", agentId: "assistant", sessionKind: .assistantChat)
        let patch = SessionCollectionDiffer.patch(from: [legacy], to: [assistant], revision: 2)
        let store = SessionListStore()
        store.apply(
            SessionCollectionDiffer.patch(from: [], to: [legacy], revision: 1),
            authoritativeSessions: [legacy]
        )
        let previousGroupingRevision = store.groupingRevision

        store.apply(patch, authoritativeSessions: [assistant])

        #expect(patch.updated.first?.changedFields.contains(.metadata) == true)
        #expect(store.groupingRevision == previousGroupingRevision + 1)
    }

    @Test
    func commandResponseInsertionIsImmediateAndIdempotent() {
        let existing = makeSession(id: "existing", summary: "old")
        let created = makeSession(
            id: "created",
            agentId: "assistant",
            sessionKind: .assistantChat
        )

        let inserted = BackendClient.insertingCreatedSession(created, into: [existing])
        let repeated = BackendClient.insertingCreatedSession(created, into: inserted)

        #expect(inserted.map(\.id) == ["created", "existing"])
        #expect(repeated.map(\.id) == ["created", "existing"])
        #expect(repeated.first?.summary == created.summary)
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
    workItemId: String? = nil,
    objectiveId: String? = nil,
    status: TaskStatus = .complete,
    updatedAt: String = "2026-08-12T00:00:00Z",
    lastMessageAt: String? = nil,
    lastAgentMessageSequence: Int? = nil,
    lastReadMessageSequence: Int? = nil
) -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Codex",
        agentId: agentId,
        sessionKind: sessionKind,
        objectiveId: objectiveId,
        workItemId: workItemId,
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
        accent: .cyan,
        archived: false,
        pinned: false,
        sortOrder: nil,
        capabilities: nil,
        external: nil,
        actions: nil,
        pendingCollaborationConfirmation: nil
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

private func makeWorkItem(id: String, status: String) -> WorkItem {
    WorkItem(
        id: id,
        objectiveId: "objective:1",
        title: id,
        description: "",
        acceptanceCriteria: "",
        priority: "medium",
        status: status,
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
