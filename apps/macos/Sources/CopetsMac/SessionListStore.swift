import Combine
import Foundation

@MainActor
final class SessionRowModel: ObservableObject, Identifiable {
    let id: String
    @Published private(set) var session: TaskSession
    private(set) var changedFields: SessionChangedFields = []

    init(session: TaskSession) {
        id = session.id
        self.session = session
    }

    func apply(_ patch: SessionContentPatch) {
        guard patch.sessionID == id, patch.session != session else { return }
        changedFields = patch.changedFields
        session = patch.session
    }
}

/// Authoritative, row-granular projection of the global Session state stream.
/// Selection, timeline, supplementary panels, and commands never write here.
@MainActor
final class SessionIndexStore: ObservableObject {
    @Published private(set) var orderedIDs: [String] = []
    @Published private(set) var groupingRevision: UInt64 = 0
    @Published private(set) var filterRevision: UInt64 = 0
    private var rowsByID: [String: SessionRowModel] = [:]
    private var isReordering = false

    var sessions: [TaskSession] {
        orderedIDs.compactMap { rowsByID[$0]?.session }
    }

    var rows: [SessionRowModel] {
        orderedIDs.compactMap { rowsByID[$0] }
    }

    func row(id: String) -> SessionRowModel? {
        rowsByID[id]
    }

    /// Replace one independently owned index (for example, the on-demand
    /// archive index) without routing it through the global active State Sync.
    /// Stable rows are retained for content-only changes.
    func replaceAll(with authoritativeSessions: [TaskSession]) {
        let patch = SessionCollectionDiffer.patch(
            from: sessions,
            to: authoritativeSessions,
            revision: 0
        )
        apply(patch, authoritativeSessions: authoritativeSessions)
    }

    func beginReorder() {
        isReordering = true
    }

    func move(_ sessionID: String, before targetSessionID: String?) {
        guard let sourceIndex = orderedIDs.firstIndex(of: sessionID) else { return }
        var next = orderedIDs
        let moved = next.remove(at: sourceIndex)
        if let targetSessionID, let targetIndex = next.firstIndex(of: targetSessionID) {
            next.insert(moved, at: targetIndex)
        } else {
            let movedIsPinned = rowsByID[moved]?.session.pinned == true
            let lastMatchingIndex = next.lastIndex {
                (rowsByID[$0]?.session.pinned == true) == movedIsPinned
            }
            next.insert(moved, at: lastMatchingIndex.map { $0 + 1 } ?? next.count)
        }
        guard next != orderedIDs else { return }
        orderedIDs = next
        groupingRevision &+= 1
    }

    func endReorder(authoritativeSessions: [TaskSession]) {
        isReordering = false
        replaceAll(with: authoritativeSessions)
    }

    func apply(_ patch: SessionCollectionPatch, authoritativeSessions: [TaskSession]) {
        if isReordering {
            applyContentOnly(authoritativeSessions)
            return
        }
        let nextByID = Dictionary(uniqueKeysWithValues: authoritativeSessions.map { ($0.id, $0) })
        var groupingChanged = patch.hasStructuralChanges
        var filterChanged = patch.hasStructuralChanges

        for id in patch.removedIDs {
            rowsByID[id] = nil
        }
        for insertion in patch.inserted {
            rowsByID[insertion.session.id] = SessionRowModel(session: insertion.session)
        }
        for contentPatch in patch.updated {
            if contentPatch.changedFields.contains(.workspace)
                || contentPatch.changedFields.contains(.ordering)
                || contentPatch.changedFields.contains(.metadata) {
                groupingChanged = true
            }
            if contentPatch.changedFields.contains(.identity)
                || contentPatch.changedFields.contains(.summary) {
                filterChanged = true
            }
            if let row = rowsByID[contentPatch.sessionID] {
                row.apply(contentPatch)
            } else {
                rowsByID[contentPatch.sessionID] = SessionRowModel(session: contentPatch.session)
            }
        }
        for session in authoritativeSessions where rowsByID[session.id] == nil {
            rowsByID[session.id] = SessionRowModel(session: session)
        }

        let nextIDs = patch.orderedIDs.filter { nextByID[$0] != nil }
        if orderedIDs != nextIDs {
            orderedIDs = nextIDs
        }
        if groupingChanged {
            groupingRevision &+= 1
        }
        if filterChanged {
            filterRevision &+= 1
        }
    }

    private func applyContentOnly(_ authoritativeSessions: [TaskSession]) {
        let nextByID = Dictionary(uniqueKeysWithValues: authoritativeSessions.map { ($0.id, $0) })
        for id in orderedIDs {
            guard let row = rowsByID[id], let next = nextByID[id], row.session != next,
                  let patch = SessionCollectionDiffer.patch(
                    from: [row.session],
                    to: [next],
                    revision: 0
                  ).updated.first else { continue }
            if patch.changedFields.contains(.workspace)
                || patch.changedFields.contains(.ordering)
                || patch.changedFields.contains(.metadata) {
                groupingRevision &+= 1
            }
            if patch.changedFields.contains(.identity)
                || patch.changedFields.contains(.summary) {
                filterRevision &+= 1
            }
            row.apply(patch)
        }
    }
}
