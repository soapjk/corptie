import Foundation

struct SessionChangedFields: OptionSet, Equatable, Sendable {
    let rawValue: UInt16

    static let identity = Self(rawValue: 1 << 0)
    static let summary = Self(rawValue: 1 << 1)
    static let status = Self(rawValue: 1 << 2)
    static let activity = Self(rawValue: 1 << 3)
    static let connection = Self(rawValue: 1 << 4)
    static let capabilities = Self(rawValue: 1 << 5)
    static let workspace = Self(rawValue: 1 << 6)
    static let suggestedOptions = Self(rawValue: 1 << 7)
    static let ordering = Self(rawValue: 1 << 8)
    static let metadata = Self(rawValue: 1 << 9)
}

struct SessionContentPatch: Equatable, Sendable {
    let sessionID: String
    let changedFields: SessionChangedFields
    let session: TaskSession
}

struct SessionInsertion: Equatable, Sendable {
    let index: Int
    let session: TaskSession
}

struct SessionMove: Equatable, Sendable {
    let sessionID: String
    let fromIndex: Int
    let toIndex: Int
}

struct SessionCollectionPatch: Equatable, Sendable {
    let revision: UInt64
    let orderedIDs: [String]
    let inserted: [SessionInsertion]
    let removedIDs: [String]
    let moved: [SessionMove]
    let updated: [SessionContentPatch]

    var hasStructuralChanges: Bool {
        !inserted.isEmpty || !removedIDs.isEmpty || !moved.isEmpty
    }

    var isEmpty: Bool {
        !hasStructuralChanges && updated.isEmpty
    }
}

enum SessionCollectionDiffer {
    static func patch(
        from previous: [TaskSession],
        to next: [TaskSession],
        revision: UInt64
    ) -> SessionCollectionPatch {
        let previousByID = Dictionary(uniqueKeysWithValues: previous.map { ($0.id, $0) })
        let nextByID = Dictionary(uniqueKeysWithValues: next.map { ($0.id, $0) })
        let previousIndex = Dictionary(uniqueKeysWithValues: previous.enumerated().map { ($0.element.id, $0.offset) })
        let nextIndex = Dictionary(uniqueKeysWithValues: next.enumerated().map { ($0.element.id, $0.offset) })

        let inserted = next.enumerated().compactMap { index, session in
            previousByID[session.id] == nil ? SessionInsertion(index: index, session: session) : nil
        }
        let removedIDs = previous.compactMap { session in
            nextByID[session.id] == nil ? session.id : nil
        }
        let moved = next.compactMap { session -> SessionMove? in
            guard let fromIndex = previousIndex[session.id],
                  let toIndex = nextIndex[session.id],
                  fromIndex != toIndex else {
                return nil
            }
            return SessionMove(sessionID: session.id, fromIndex: fromIndex, toIndex: toIndex)
        }
        let updated = next.compactMap { session -> SessionContentPatch? in
            guard let previousSession = previousByID[session.id], previousSession != session else {
                return nil
            }
            return SessionContentPatch(
                sessionID: session.id,
                changedFields: changedFields(from: previousSession, to: session),
                session: session
            )
        }

        return SessionCollectionPatch(
            revision: revision,
            orderedIDs: next.map(\.id),
            inserted: inserted,
            removedIDs: removedIDs,
            moved: moved,
            updated: updated
        )
    }

    static func changedFields(from previous: TaskSession, to next: TaskSession) -> SessionChangedFields {
        var fields: SessionChangedFields = []
        if previous.title != next.title
            || previous.agent != next.agent
            || previous.accent != next.accent {
            fields.insert(.identity)
        }
        if previous.summary != next.summary { fields.insert(.summary) }
        if previous.status != next.status || previous.progress != next.progress { fields.insert(.status) }
        if previous.activityStatus != next.activityStatus || previous.updatedAt != next.updatedAt {
            fields.insert(.activity)
        }
        if previous.external?.connectionStatus != next.external?.connectionStatus
            || previous.external?.agentSessionId != next.external?.agentSessionId {
            fields.insert(.connection)
        }
        if previous.capabilities != next.capabilities || previous.actions != next.actions {
            fields.insert(.capabilities)
        }
        if previous.external?.workspace != next.external?.workspace
            || previous.external?.cwd != next.external?.cwd
            || previous.external?.threadId != next.external?.threadId
            || previous.external?.routingVersion != next.external?.routingVersion {
            fields.insert(.workspace)
        }
        if previous.suggestedOptions != next.suggestedOptions
            || previous.suggestedPrompt != next.suggestedPrompt
            || previous.pendingCollaborationConfirmation != next.pendingCollaborationConfirmation {
            fields.insert(.suggestedOptions)
        }
        if previous.pinned != next.pinned
            || previous.sortOrder != next.sortOrder
            || previous.archived != next.archived
            || previous.lastMessageAt != next.lastMessageAt {
            fields.insert(.ordering)
        }
        if previous.external != next.external
            || previous.agentId != next.agentId
            || previous.sessionKind != next.sessionKind
            || previous.objectiveId != next.objectiveId
            || previous.workItemId != next.workItemId {
            fields.insert(.metadata)
        }
        return fields
    }
}
