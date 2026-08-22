import Combine
import Foundation

struct ControlPlaneStatePayload: Decodable, Sendable {
    var sessions: [TaskSession]
    var workItems: [WorkItem]
    var objectives: [Objective]
    var agents: [Agent]
    var skills: [Skill]
    var repositories: [GitRepository]
    var integrationRuns: [ProjectIntegrationRun]
}

struct StateSnapshotEnvelope: Decodable, Sendable {
    let revision: Int64
    let state: ControlPlaneStatePayload
}

struct StateEntityDeletes: Decodable, Sendable {
    var sessions: [String]
    var workItems: [String]
    var objectives: [String]
    var agents: [String]
    var skills: [String]
    var repositories: [String]
    var integrationRuns: [String]
}

struct StateChangeSetEnvelope: Decodable, Sendable {
    let snapshotRequired: Bool
    let baseRevision: Int64
    let revision: Int64
    let upserts: ControlPlaneStatePayload
    let deletes: StateEntityDeletes
}

enum AppStateApplyResult: Equatable {
    case applied
    case duplicate
    case revisionGap(expected: Int64, received: Int64)
}

struct NormalizedAppState: Equatable {
    var sessions: [String: TaskSession] = [:]
    var workItems: [String: WorkItem] = [:]
    var objectives: [String: Objective] = [:]
    var agents: [String: Agent] = [:]
    var skills: [String: Skill] = [:]
    var repositories: [String: GitRepository] = [:]
    var integrationRuns: [String: ProjectIntegrationRun] = [:]
}

@MainActor
final class AppStateStore: ObservableObject {
    static let shared = AppStateStore()

    @Published private(set) var revision: Int64 = 0
    @Published private(set) var state = NormalizedAppState() {
        didSet {
            // `sessions` is accessed on every tab switch and list render; keep
            // the sorted result cached so the O(n log n) sort is not repeated
            // for each read against an unchanged state. Only invalidate when the
            // sessions dictionary actually changes — unrelated entity updates
            // (workItems/objectives/agents…) must not drop the sort cache.
            if oldValue.sessions != state.sessions {
                cachedSessions = nil
            }
        }
    }
    @Published private(set) var syncError: String?
    private var cachedSessions: [TaskSession]?
    private var hasAppliedAuthoritativeState = false
    private(set) var pendingCreatedSessionIDs = Set<String>()
    /// Authoritative server reachability, flipped by the sync engine on every
    /// snapshot/change-set success or transport failure. Unlike `syncError` it
    /// also emits on the very first success, so `isOnline` cannot be left stale
    /// by a nil→nil error transition during the launch race.
    @Published private(set) var isReachable = false

    var sessions: [TaskSession] {
        if let cachedSessions { return cachedSessions }
        let sorted = state.sessions.values.sorted(by: Self.sessionPrecedes)
        cachedSessions = sorted
        return sorted
    }
    var workItems: [WorkItem] { state.workItems.values.sorted { $0.createdAt < $1.createdAt } }
    var objectives: [Objective] { state.objectives.values.sorted { $0.createdAt > $1.createdAt } }
    var agents: [Agent] { state.agents.values.sorted { $0.createdAt < $1.createdAt } }
    var skills: [Skill] { state.skills.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending } }
    var repositories: [GitRepository] { state.repositories.values.sorted { $0.name < $1.name } }
    var integrationRuns: [ProjectIntegrationRun] {
        state.integrationRuns.values.sorted { $0.createdAt > $1.createdAt }
    }

    func session(_ id: String) -> TaskSession? { state.sessions[id] }
    func workItem(_ id: String) -> WorkItem? { state.workItems[id] }
    func objective(_ id: String) -> Objective? { state.objectives[id] }
    func agent(_ id: String) -> Agent? { state.agents[id] }

    @discardableResult
    func apply(snapshot: StateSnapshotEnvelope) -> AppStateApplyResult {
        // A revision identifies one immutable control-plane state. Concurrent
        // snapshot requests can finish out of order; accepting an equal-revision
        // response would let a slower, older provider projection overwrite a
        // change-set that was already applied while the request was in flight.
        // Keep the first revision-0 snapshot valid for fresh/empty stores.
        if hasAppliedAuthoritativeState, snapshot.revision < revision {
            return .duplicate
        }
        if hasAppliedAuthoritativeState, snapshot.revision == revision {
            // The payload is redundant, but the successful HTTP response is
            // still authoritative reachability evidence after a reconnect.
            syncError = nil
            isReachable = true
            return .duplicate
        }
        state = Self.normalized(snapshot.state)
        pendingCreatedSessionIDs.removeAll()
        revision = snapshot.revision
        hasAppliedAuthoritativeState = true
        syncError = nil
        isReachable = true
        return .applied
    }

    @discardableResult
    func apply(changeSet: StateChangeSetEnvelope) -> AppStateApplyResult {
        if changeSet.revision <= revision { return .duplicate }
        guard changeSet.baseRevision == revision else {
            let result = AppStateApplyResult.revisionGap(expected: revision, received: changeSet.baseRevision)
            syncError = "State revision gap: expected \(revision), received \(changeSet.baseRevision)."
            return result
        }
        var next = state
        Self.upsert(changeSet.upserts.sessions, into: &next.sessions, id: \TaskSession.id)
        Self.upsert(changeSet.upserts.workItems, into: &next.workItems, id: \WorkItem.id)
        Self.upsert(changeSet.upserts.objectives, into: &next.objectives, id: \Objective.id)
        Self.upsert(changeSet.upserts.agents, into: &next.agents, id: \Agent.agentId)
        Self.upsert(changeSet.upserts.skills, into: &next.skills, id: \Skill.skillId)
        Self.upsert(changeSet.upserts.repositories, into: &next.repositories, id: \GitRepository.id)
        Self.upsert(changeSet.upserts.integrationRuns, into: &next.integrationRuns, id: \ProjectIntegrationRun.id)
        changeSet.deletes.sessions.forEach { next.sessions[$0] = nil }
        changeSet.deletes.workItems.forEach { next.workItems[$0] = nil }
        changeSet.deletes.objectives.forEach { next.objectives[$0] = nil }
        changeSet.deletes.agents.forEach { next.agents[$0] = nil }
        changeSet.deletes.skills.forEach { next.skills[$0] = nil }
        changeSet.deletes.repositories.forEach { next.repositories[$0] = nil }
        changeSet.deletes.integrationRuns.forEach { next.integrationRuns[$0] = nil }
        state = next
        pendingCreatedSessionIDs.subtract(changeSet.upserts.sessions.map(\.id))
        pendingCreatedSessionIDs.subtract(changeSet.deletes.sessions)
        revision = changeSet.revision
        hasAppliedAuthoritativeState = true
        syncError = nil
        isReachable = true
        return .applied
    }

    func reportSyncError(_ message: String) {
        syncError = message
        isReachable = false
    }

    // A successful creation response is committed server state and provides the
    // command's read-your-write guarantee. Merge it into the one normalized
    // client store immediately without inventing a server revision; the next
    // snapshot/change-set remains authoritative for ordering and live fields.
    @discardableResult
    func acceptCreatedSession(_ session: TaskSession) -> TaskSession {
        if state.sessions[session.id] == nil {
            pendingCreatedSessionIDs.insert(session.id)
        }
        var next = state
        next.sessions[session.id] = session
        state = next
        return next.sessions[session.id] ?? session
    }

    func replaceActiveSessions(_ sessions: [TaskSession]) {
        var next = state
        next.sessions = next.sessions.filter { $0.value.archived == true }
        Self.upsert(sessions, into: &next.sessions, id: \TaskSession.id)
        state = next
    }

    func hydrate(objectives: [Objective]) {
        var next = state
        Self.upsert(objectives, into: &next.objectives, id: \Objective.id)
        state = next
    }

    func hydrate(agents: [Agent]) {
        var next = state
        Self.upsert(agents, into: &next.agents, id: \Agent.agentId)
        state = next
    }

    func hydrate(repositories: [GitRepository]) {
        var next = state
        Self.upsert(repositories, into: &next.repositories, id: \GitRepository.id)
        state = next
    }

    private static func normalized(_ payload: ControlPlaneStatePayload) -> NormalizedAppState {
        NormalizedAppState(
            sessions: Dictionary(uniqueKeysWithValues: payload.sessions.map { ($0.id, $0) }),
            workItems: Dictionary(uniqueKeysWithValues: payload.workItems.map { ($0.id, $0) }),
            objectives: Dictionary(uniqueKeysWithValues: payload.objectives.map { ($0.id, $0) }),
            agents: Dictionary(uniqueKeysWithValues: payload.agents.map { ($0.agentId, $0) }),
            skills: Dictionary(uniqueKeysWithValues: payload.skills.map { ($0.skillId, $0) }),
            repositories: Dictionary(uniqueKeysWithValues: payload.repositories.map { ($0.id, $0) }),
            integrationRuns: Dictionary(uniqueKeysWithValues: payload.integrationRuns.map { ($0.id, $0) })
        )
    }

    private static func upsert<Entity, ID: Hashable>(
        _ entities: [Entity],
        into dictionary: inout [ID: Entity],
        id: KeyPath<Entity, ID>
    ) {
        for entity in entities { dictionary[entity[keyPath: id]] = entity }
    }

    private static func sessionPrecedes(_ left: TaskSession, _ right: TaskSession) -> Bool {
        if (left.pinned == true) != (right.pinned == true) { return left.pinned == true }
        let leftOrder = left.sortOrder ?? .greatestFiniteMagnitude
        let rightOrder = right.sortOrder ?? .greatestFiniteMagnitude
        if leftOrder != rightOrder { return leftOrder < rightOrder }
        return left.updatedAt > right.updatedAt
    }
}
