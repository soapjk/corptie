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

@MainActor
final class SessionListStore: ObservableObject {
    @Published private(set) var orderedIDs: [String] = []
    @Published private(set) var groupingRevision: UInt64 = 0
    @Published private(set) var filterRevision: UInt64 = 0
    private var rowsByID: [String: SessionRowModel] = [:]

    var sessions: [TaskSession] {
        orderedIDs.compactMap { rowsByID[$0]?.session }
    }

    var rows: [SessionRowModel] {
        orderedIDs.compactMap { rowsByID[$0] }
    }

    func row(id: String) -> SessionRowModel? {
        rowsByID[id]
    }

    func apply(_ patch: SessionCollectionPatch, authoritativeSessions: [TaskSession]) {
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
}
