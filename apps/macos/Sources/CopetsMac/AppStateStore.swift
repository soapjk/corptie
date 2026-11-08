import Combine
import Foundation
import CorptieClientCore

struct ControlPlaneStatePayload: Decodable, Sendable {
    var sessions: [TaskSession]
    var tasks: [CorptieTask]
    var works: [Work]
    var roles: [Role]
    var skills: [Skill]
    var repositories: [GitRepository]
    var integrationRuns: [ProjectIntegrationRun]
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case sessions
        case tasks
        case works
        case roles = "agents"
        case skills
        case repositories
        case integrationRuns
    }
}

struct StateSnapshotEnvelope: Decodable, Sendable {
    let revision: Int64
    let state: ControlPlaneStatePayload
}

struct StateEntityDeletes: Decodable, Sendable {
    var sessions: [String]
    var tasks: [String]
    var works: [String]
    var roles: [String]
    var skills: [String]
    var repositories: [String]
    var integrationRuns: [String]
    // Legacy transport names remain stable; business code uses Role.
    enum CodingKeys: String, CodingKey {
        case sessions
        case tasks
        case works
        case roles = "agents"
        case skills
        case repositories
        case integrationRuns
    }
}

struct StateChangeSetEnvelope: Decodable, Sendable {
    let snapshotRequired: Bool
    let baseRevision: Int64
    let revision: Int64
    let upserts: ControlPlaneStatePayload
    let deletes: StateEntityDeletes
    /// Artifact bodies remain behind their paginated API. The revisioned State
    /// stream carries only IDs whose metadata/version/reference projection was
    /// invalidated, allowing the dedicated client to refetch loaded scopes.
    var artifactInvalidations: [String]? = nil
}

enum AppStateApplyResult: Equatable {
    case applied
    case duplicate
    case revisionGap(expected: Int64, received: Int64)
}

/// Aggregated outcome of applying a burst of revisioned change-sets as one
/// state publication. `gapRevision` carries the revision the caller must reach
/// with a snapshot before the stream can be considered healthy again.
struct AppStateBatchApplyResult: Equatable {
    var lastResult: AppStateApplyResult = .duplicate
    var appliedCount = 0
    var hasArtifactInvalidations = false
    var gapRevision: Int64?
}

/// Entity families whose derived projections are cached by `AppStateStore`.
/// A mutation declares the families it touches, so invalidation stays O(1)
/// instead of deep-comparing whole dictionaries on every State SSE frame.
struct StateCacheScope: OptionSet {
    let rawValue: UInt8
    static let sessions = StateCacheScope(rawValue: 1 << 0)
    static let tasks = StateCacheScope(rawValue: 1 << 1)
    static let works = StateCacheScope(rawValue: 1 << 2)
    static let roles = StateCacheScope(rawValue: 1 << 3)
    static let skills = StateCacheScope(rawValue: 1 << 4)
    static let repositories = StateCacheScope(rawValue: 1 << 5)
    static let integrationRuns = StateCacheScope(rawValue: 1 << 6)
    static let all: StateCacheScope = [
        .sessions, .tasks, .works, .roles, .skills, .repositories, .integrationRuns
    ]
}

struct NormalizedAppState: Equatable {
    var sessions: [String: TaskSession] = [:]
    var tasks: [String: CorptieTask] = [:]
    var works: [String: Work] = [:]
    var roles: [String: Role] = [:]
    var skills: [String: Skill] = [:]
    var repositories: [String: GitRepository] = [:]
    var integrationRuns: [String: ProjectIntegrationRun] = [:]
}

/// Constant-size commit counters. `$state` holds whole entity dictionaries, so
/// comparing it — or one of its maps — is O(n) in the number of Sessions/Tasks
/// and used to run on every State frame, stealing main-thread time from window
/// dragging and live resize. Subscribers that only care about one entity family
/// observe the matching counter instead, which is O(1) to compare.
struct AppStateCommitToken: Equatable {
    var sessions: UInt64 = 0
    var tasks: UInt64 = 0
    var works: UInt64 = 0
    var roles: UInt64 = 0
    var skills: UInt64 = 0
    var repositories: UInt64 = 0
    var integrationRuns: UInt64 = 0
    var sequence: UInt64 = 0
}

@MainActor
final class AppStateStore: ObservableObject {
    static let shared = AppStateStore()

    @Published private(set) var revision: Int64 = 0
    /// The single normalized control-plane value. Cache invalidation is driven
    /// explicitly by `commit(_:touching:)`; a `didSet` deep-equality scan here
    /// used to compare every dictionary on each State SSE frame and was a
    /// main-thread hotspot during streaming.
    @Published private(set) var state = NormalizedAppState()
    /// Monotonic counters published after `state` is committed, so a synchronous
    /// subscriber always observes the new state value.
    @Published private(set) var commitToken = AppStateCommitToken()
    @Published private(set) var syncError: String?
    private var cachedSessions: [TaskSession]?
    private var cachedActiveSessions: [TaskSession]?
    private var cachedTasks: [CorptieTask]?
    private var cachedWorks: [Work]?
    private var cachedRoles: [Role]?
    private var cachedSkills: [Skill]?
    private var cachedRepositories: [GitRepository]?
    private var cachedIntegrationRuns: [ProjectIntegrationRun]?
    private var cachedSessionAliases: [String: String]?
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
    var activeSessions: [TaskSession] {
        if let cachedActiveSessions { return cachedActiveSessions }
        let result = sessions.filter { $0.archived != true }
        cachedActiveSessions = result
        return result
    }
    var tasks: [CorptieTask] {
        if let cachedTasks { return cachedTasks }
        let result = state.tasks.values.sorted { $0.createdAt < $1.createdAt }
        cachedTasks = result
        return result
    }
    var works: [Work] {
        if let cachedWorks { return cachedWorks }
        let result = state.works.values.sorted { $0.createdAt > $1.createdAt }
        cachedWorks = result
        return result
    }
    var roles: [Role] {
        if let cachedRoles { return cachedRoles }
        let result = state.roles.values.sorted { $0.createdAt < $1.createdAt }
        cachedRoles = result
        return result
    }
    var skills: [Skill] {
        if let cachedSkills { return cachedSkills }
        let result = state.skills.values.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        cachedSkills = result
        return result
    }
    var repositories: [GitRepository] {
        if let cachedRepositories { return cachedRepositories }
        let result = state.repositories.values.sorted { $0.name < $1.name }
        cachedRepositories = result
        return result
    }
    var integrationRuns: [ProjectIntegrationRun] {
        if let cachedIntegrationRuns { return cachedIntegrationRuns }
        let result = state.integrationRuns.values.sorted { $0.createdAt > $1.createdAt }
        cachedIntegrationRuns = result
        return result
    }

    /// The one write path for normalized state. Every caller declares which
    /// entity families it mutated, keeping derived-cache invalidation constant
    /// time regardless of how many Sessions or Tasks the store holds.
    private func commit(_ next: NormalizedAppState, touching scope: StateCacheScope) {
        if scope.contains(.sessions) {
            cachedSessions = nil
            cachedActiveSessions = nil
            cachedSessionAliases = nil
        }
        if scope.contains(.tasks) { cachedTasks = nil }
        if scope.contains(.works) { cachedWorks = nil }
        if scope.contains(.roles) { cachedRoles = nil }
        if scope.contains(.skills) { cachedSkills = nil }
        if scope.contains(.repositories) { cachedRepositories = nil }
        if scope.contains(.integrationRuns) { cachedIntegrationRuns = nil }
        self.state = next
        var token = commitToken
        token.sequence &+= 1
        if scope.contains(.sessions) { token.sessions &+= 1 }
        if scope.contains(.tasks) { token.tasks &+= 1 }
        if scope.contains(.works) { token.works &+= 1 }
        if scope.contains(.roles) { token.roles &+= 1 }
        if scope.contains(.skills) { token.skills &+= 1 }
        if scope.contains(.repositories) { token.repositories &+= 1 }
        if scope.contains(.integrationRuns) { token.integrationRuns &+= 1 }
        commitToken = token
    }

    private static func touchedScope(_ changes: StateChangeSetEnvelope) -> StateCacheScope {
        var scope: StateCacheScope = []
        let upserts = changes.upserts, deletes = changes.deletes
        if !upserts.sessions.isEmpty || !deletes.sessions.isEmpty { scope.insert(.sessions) }
        if !upserts.tasks.isEmpty || !deletes.tasks.isEmpty { scope.insert(.tasks) }
        if !upserts.works.isEmpty || !deletes.works.isEmpty { scope.insert(.works) }
        if !upserts.roles.isEmpty || !deletes.roles.isEmpty { scope.insert(.roles) }
        if !upserts.skills.isEmpty || !deletes.skills.isEmpty { scope.insert(.skills) }
        if !upserts.repositories.isEmpty || !deletes.repositories.isEmpty { scope.insert(.repositories) }
        if !upserts.integrationRuns.isEmpty || !deletes.integrationRuns.isEmpty { scope.insert(.integrationRuns) }
        return scope
    }

    private static func merge(_ changes: StateChangeSetEnvelope, into next: inout NormalizedAppState) {
        upsert(changes.upserts.sessions, into: &next.sessions, id: \TaskSession.id)
        upsert(changes.upserts.tasks, into: &next.tasks, id: \CorptieTask.id)
        upsert(changes.upserts.works, into: &next.works, id: \Work.id)
        upsert(changes.upserts.roles, into: &next.roles, id: \Role.roleId)
        upsert(changes.upserts.skills, into: &next.skills, id: \Skill.skillId)
        upsert(changes.upserts.repositories, into: &next.repositories, id: \GitRepository.id)
        upsert(changes.upserts.integrationRuns, into: &next.integrationRuns, id: \ProjectIntegrationRun.id)
        for id in changes.deletes.sessions { next.sessions[id] = nil }
        for id in changes.deletes.tasks { next.tasks[id] = nil }
        for id in changes.deletes.works { next.works[id] = nil }
        for id in changes.deletes.roles { next.roles[id] = nil }
        for id in changes.deletes.skills { next.skills[id] = nil }
        for id in changes.deletes.repositories { next.repositories[id] = nil }
        for id in changes.deletes.integrationRuns { next.integrationRuns[id] = nil }
    }

    func session(_ id: String) -> TaskSession? {
        if let direct = state.sessions[id] { return direct }
        if cachedSessionAliases == nil {
            cachedSessionAliases = ClientDetailNavigationPolicy.sessionAliases(state.sessions.values
                .filter { $0.archived != true }.map { (id: $0.id, logicalID: $0.external?.logicalSessionId) })
        }
        guard let resolved = cachedSessionAliases?[id] else { return nil }
        return state.sessions[resolved]
    }
    func task(_ id: String) -> CorptieTask? { state.tasks[id] }
    func work(_ id: String) -> Work? { state.works[id] }
    func agent(_ id: String) -> Role? { state.roles[id] }

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
        let normalized = Self.normalized(snapshot.state)
        // A snapshot is a low-frequency full replacement. Comparing the
        // families once keeps the O(1) commit counters honest: a family whose
        // contents did not change must not wake its subscribers. Change-sets
        // (the hot path) already carry an exact scope and never pay for this.
        var scope: StateCacheScope = []
        if normalized.sessions != state.sessions { scope.insert(.sessions) }
        if normalized.tasks != state.tasks { scope.insert(.tasks) }
        if normalized.works != state.works { scope.insert(.works) }
        if normalized.roles != state.roles { scope.insert(.roles) }
        if normalized.skills != state.skills { scope.insert(.skills) }
        if normalized.repositories != state.repositories { scope.insert(.repositories) }
        if normalized.integrationRuns != state.integrationRuns { scope.insert(.integrationRuns) }
        commit(normalized, touching: scope)
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
        Self.merge(changeSet, into: &next)
        commit(next, touching: Self.touchedScope(changeSet))
        pendingCreatedSessionIDs.subtract(changeSet.upserts.sessions.map(\.id))
        pendingCreatedSessionIDs.subtract(changeSet.deletes.sessions)
        revision = changeSet.revision
        hasAppliedAuthoritativeState = true
        syncError = nil
        isReachable = true
        return .applied
    }

    /// Apply a burst of consecutive change-sets with a single `state`
    /// publication. Frames still validate against a chained working revision,
    /// so batching can neither reorder nor silently skip a revision. A gap
    /// commits the frames already applied, then reports the revision a
    /// snapshot must reach before the stream is healthy again.
    @discardableResult
    func apply(changeSets: [StateChangeSetEnvelope]) -> AppStateBatchApplyResult {
        guard !changeSets.isEmpty else { return AppStateBatchApplyResult() }
        var next = state
        var scope: StateCacheScope = []
        var workingRevision = revision
        var result = AppStateBatchApplyResult()
        var gap: (expected: Int64, received: Int64, targetRevision: Int64)?

        for changes in changeSets {
            if changes.revision <= workingRevision {
                result.lastResult = .duplicate
                continue
            }
            guard changes.baseRevision == workingRevision else {
                gap = (workingRevision, changes.baseRevision, changes.revision)
                break
            }
            Self.merge(changes, into: &next)
            scope.formUnion(Self.touchedScope(changes))
            if !(changes.artifactInvalidations ?? []).isEmpty {
                result.hasArtifactInvalidations = true
            }
            pendingCreatedSessionIDs.subtract(changes.upserts.sessions.map(\.id))
            pendingCreatedSessionIDs.subtract(changes.deletes.sessions)
            workingRevision = changes.revision
            result.appliedCount += 1
            result.lastResult = .applied
        }

        if result.appliedCount > 0 {
            commit(next, touching: scope)
            revision = workingRevision
            hasAppliedAuthoritativeState = true
            isReachable = true
            if gap == nil { syncError = nil }
        }
        if let gap {
            result.lastResult = .revisionGap(expected: gap.expected, received: gap.received)
            result.gapRevision = gap.targetRevision
            syncError = "State revision gap: expected \(gap.expected), received \(gap.received)."
        }
        return result
    }

    func reportSyncError(_ message: String) {
        syncError = message
        isReachable = false
    }

    /// A successful State SSE HTTP handshake is authoritative reachability
    /// even when the client already has the latest revision and the server
    /// correctly emits no redundant state frame.
    func reportStateStreamConnected() {
        syncError = nil
        isReachable = true
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
        commit(next, touching: .sessions)
        return next.sessions[session.id] ?? session
    }

    /// Model/reasoning commands return the committed Session projection. Apply
    /// it immediately so the composer has read-your-write state while the
    /// revisioned State stream catches up. Merge only the two configuration
    /// fields and their server timestamp so a command response cannot regress
    /// execution or Timeline state that arrived concurrently on the State
    /// stream. Keeping the timestamp is also the causal watermark that rejects
    /// a slower response from an earlier configuration command.
    @discardableResult
    func acceptSessionConfiguration(_ session: TaskSession, requestedSessionID: String) -> Bool {
        guard session.id == requestedSessionID,
              var current = state.sessions[requestedSessionID],
              let committedExternal = session.external else { return false }
        if current.updatedAt > session.updatedAt {
            return current.external?.currentModel == committedExternal.currentModel
                && current.external?.currentReasoningLevel == committedExternal.currentReasoningLevel
        }
        var external = current.external ?? committedExternal
        external.currentModel = committedExternal.currentModel
        external.currentReasoningLevel = committedExternal.currentReasoningLevel
        current.external = external
        current.updatedAt = session.updatedAt
        var next = state
        next.sessions[requestedSessionID] = current
        commit(next, touching: .sessions)
        return true
    }

    /// `SessionWorkspaceSwitched` is emitted only after the logical Session's
    /// new route is committed. Merge that route immediately so a send racing
    /// the revisioned State stream cannot target the previous Provider Thread.
    /// Timeline/read cursors remain monotonic because they are Session state,
    /// not Provider binding state.
    @discardableResult
    func acceptSessionWorkspaceTransition(_ session: TaskSession) -> TaskSession? {
        guard var current = state.sessions[session.id],
              let committedExternal = session.external else { return nil }
        current.external = committedExternal
        current.transitionState = session.transitionState
        current.readiness = session.readiness
        current.notReadyReason = session.notReadyReason
        current.actions = session.actions
        current.updatedAt = max(current.updatedAt, session.updatedAt)
        current.timelineRevision = max(current.timelineRevision ?? 0, session.timelineRevision ?? 0)
        current.lastAgentMessageSequence = max(
            current.lastAgentMessageSequence ?? 0,
            session.lastAgentMessageSequence ?? 0
        )
        current.lastReadMessageSequence = max(
            current.lastReadMessageSequence ?? 0,
            session.lastReadMessageSequence ?? 0
        )
        var next = state
        next.sessions[session.id] = current
        commit(next, touching: .sessions)
        return current
    }

    /// `/clear` commits the replacement before returning it. Apply that exact
    /// command result atomically without exposing a generic Session snapshot
    /// mutation API to presentation code.
    func acceptSessionReplacement(previousSessionID: String, session: TaskSession) {
        var next = state
        next.sessions[previousSessionID] = nil
        next.sessions[session.id] = session
        pendingCreatedSessionIDs.remove(previousSessionID)
        pendingCreatedSessionIDs.insert(session.id)
        commit(next, touching: .sessions)
    }

    /// A read-receipt response is a committed Corptie projection. Merge only
    /// its monotonic cursors so a concurrent newer message cannot be cleared.
    func acceptReadReceipt(_ receipt: SessionReadReceiptResponse, requestedSessionID: String) {
        let matchingIDs = Set([
            requestedSessionID,
            receipt.sessionId,
            receipt.legacySessionId
        ].compactMap { $0 })
        var next = state
        for id in matchingIDs {
            guard var session = next.sessions[id] else { continue }
            session.lastAgentMessageSequence = max(
                session.lastAgentMessageSequence ?? 0,
                receipt.lastAgentMessageSequence
            )
            session.lastReadMessageSequence = max(
                session.lastReadMessageSequence ?? 0,
                receipt.lastReadMessageSequence
            )
            next.sessions[id] = session
        }
        commit(next, touching: .sessions)
    }

    @discardableResult
    func acceptCorptieTask(_ task: CorptieTask) -> CorptieTask {
        var next = state
        next.tasks[task.id] = task
        commit(next, touching: .tasks)
        return task
    }

    func installPerformanceFixtureSession(_ session: TaskSession) {
        var next = state
        next.sessions = next.sessions.filter { $0.value.archived == true }
        next.sessions[session.id] = session
        commit(next, touching: .sessions)
        // A local fixture is ready immediately; it deliberately has no State SSE.
        syncError = nil
        isReachable = true
    }

    func hydrate(works: [Work]) {
        var next = state
        Self.upsert(works, into: &next.works, id: \Work.id)
        commit(next, touching: .works)
    }

    func hydrate(roles: [Role]) {
        var next = state
        Self.upsert(roles, into: &next.roles, id: \Role.roleId)
        commit(next, touching: .roles)
    }

    func hydrate(repositories: [GitRepository]) {
        var next = state
        Self.upsert(repositories, into: &next.repositories, id: \GitRepository.id)
        commit(next, touching: .repositories)
    }

    private static func normalized(_ payload: ControlPlaneStatePayload) -> NormalizedAppState {
        NormalizedAppState(
            sessions: Dictionary(uniqueKeysWithValues: payload.sessions.map { ($0.id, $0) }),
            tasks: Dictionary(uniqueKeysWithValues: payload.tasks.map { ($0.id, $0) }),
            works: Dictionary(uniqueKeysWithValues: payload.works.map { ($0.id, $0) }),
            roles: Dictionary(uniqueKeysWithValues: payload.roles.map { ($0.roleId, $0) }),
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
