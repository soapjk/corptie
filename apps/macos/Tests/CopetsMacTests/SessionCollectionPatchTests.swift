import Foundation
import Testing
@testable import CorptieMac

@MainActor
struct SessionCollectionPatchTests {
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

private func makeSession(id: String, summary: String = "Summary") -> TaskSession {
    TaskSession(
        id: id,
        title: id,
        agent: "Codex",
        status: .complete,
        progress: 1,
        summary: summary,
        suggestedOptions: nil,
        suggestedPrompt: nil,
        activityStatus: nil,
        updatedAt: "2026-08-12T00:00:00Z",
        accent: .cyan,
        archived: false,
        pinned: false,
        sortOrder: nil,
        avatarPath: nil,
        capabilities: nil,
        external: nil,
        actions: nil,
        pendingCollaborationConfirmation: nil
    )
}
