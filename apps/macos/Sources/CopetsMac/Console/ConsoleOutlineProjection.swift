import Combine
import CorptieConversation
import CorptieClientCore
import Foundation

struct ConsoleOutlineProjectionKey: Equatable, Sendable {
    let entityRevision: UInt64
    let sessionRevision: UInt64
    let search: String
    let sort: WorkOutlineSort
    var expandedTaskIDs: Set<String> = []
    var archiveRevision: UInt64 = 0
    var archiveFilterRevision: UInt64 = 0
    var showsArchive = false
}

/// Prepared when the inventory changes, never while toggling a Work card.
struct ConsoleOutlineWorkRows {
    static let empty = Self(orderedTasks: [])
    var structureRevision = 0
    let rootCount: Int
    let initialRows: [CorptieTask]
    let allRows: [CorptieTask]
    let nativeRoots: [CorptieTask]
    let nativePreviewRoots: [CorptieTask]
    let nativeChildren: [String: [CorptieTask]]

    init(orderedTasks: [CorptieTask]) {
        let roots = orderedTasks.filter { $0.parentTaskId == nil }
        nativeRoots = roots
        nativePreviewRoots = Array(roots.prefix(WorkOutlineTaskDisclosurePolicy.defaultVisibleCount))
        nativeChildren = Dictionary(grouping: orderedTasks.filter { $0.parentTaskId != nil }, by: { $0.parentTaskId! })
        rootCount = roots.count
        allRows = orderedTasks
        let initialRootIDs = Set(roots.prefix(WorkOutlineTaskDisclosurePolicy.defaultVisibleCount).map(\.id))
        initialRows = orderedTasks.filter { initialRootIDs.contains($0.parentTaskId ?? $0.id) }
    }

    func rows(showsAll: Bool) -> [CorptieTask] { showsAll ? allRows : initialRows }

    init(group: ConsoleOutlineComputedGroup, tasks: [String: CorptieTask]) {
        let ordered = group.nativeIDs.compactMap { tasks[$0] }
        let ids = Set(ordered.map(\.id))
        nativeRoots = ordered.filter { $0.parentTaskId == nil || !ids.contains($0.parentTaskId!) }
        nativePreviewRoots = Array(nativeRoots.prefix(WorkOutlineTaskDisclosurePolicy.defaultVisibleCount))
        nativeChildren = Dictionary(grouping: ordered.filter { $0.parentTaskId.map(ids.contains) == true }, by: { $0.parentTaskId! })
        rootCount = group.rootCount
        initialRows = group.initialIDs.compactMap { tasks[$0] }
        allRows = group.allIDs.compactMap { tasks[$0] }
    }
}

struct ConsoleOutlineProjection {
    let tasksByWorkID: [String: [CorptieTask]]
    var works: [Work]
    let processingWorkIDs: Set<String>
    var workRowsByWorkID: [String: ConsoleOutlineWorkRows] = [:]
    var archivedTasksByWorkID: [String: [CorptieTask]] = [:]
    var archivedRowsByWorkID: [String: [SessionRowModel]] = [:]
    static let empty = Self(tasksByWorkID: [:], works: [], processingWorkIDs: [])
}

struct ConsoleOutlineTaskRecord: Equatable, Sendable {
    let id: String, workID: String, parentID: String?, title: String, description: String, updatedAt: String
    let archived: Bool, done: Bool
}

struct ConsoleOutlineGroupSource: Equatable, Sendable {
    let records: [ConsoleOutlineTaskRecord]
    let directIDs: [String]
    let expanded: Set<String>
    let sort: WorkOutlineSort
    let activity: [String: String]
}

struct ConsoleOutlineComputedGroup: Sendable {
    let source: ConsoleOutlineGroupSource
    let rootCount: Int
    let initialIDs: [String]
    let allIDs: [String]
    let nativeIDs: [String]
}

struct ConsoleOutlineComputation: Sendable {
    let key: ConsoleOutlineProjectionKey
    var workIDs: [String]
    let active: [String: ConsoleOutlineComputedGroup]
    let archived: [String: ConsoleOutlineComputedGroup]
    let archivedSessionIDs: [String: [String]]
    let rebuiltWorkIDs: Set<String>
    let usedMainThread: Bool
}

/// Only Sendable values cross the worker boundary; no observable stores or UI models.
struct ConsoleOutlineSnapshot: Sendable {
    struct WorkRecord: Sendable { let id: String }
    let key: ConsoleOutlineProjectionKey
    let tasks: [ConsoleOutlineTaskRecord]
    let works: [WorkRecord]
    let sessions: [TaskSession]
    let archivedSessions: [TaskSession]

    @MainActor init(key: ConsoleOutlineProjectionKey, tasks: [CorptieTask], works: [Work],
                    sessions: [TaskSession], archivedSessions: [TaskSession]) {
        self.key = key
        let searching = !key.search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        self.tasks = tasks.map {
            ConsoleOutlineTaskRecord(id: $0.id, workID: $0.workId, parentID: $0.parentTaskId,
                title: searching || key.sort == .name ? $0.title : "", description: searching ? $0.description : "",
                updatedAt: key.sort == .updated ? $0.updatedAt : "", archived: $0.archived == true, done: $0.lifecycleState == "done")
        }
        self.works = works.map { WorkRecord(id: $0.id) }
        self.sessions = key.sort == .updated ? sessions : []
        self.archivedSessions = key.showsArchive ? archivedSessions : []
    }

    nonisolated func compute(previous: ConsoleOutlineComputation?) -> ConsoleOutlineComputation? {
        guard !Task.isCancelled else { return nil }
        let query = key.search.trimmingCharacters(in: .whitespacesAndNewlines)
        let byID = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        var taskActivity: [String: String] = [:]
        for session in sessions {
            guard let date = session.lastMessageAt else { continue }
            if let id = session.taskId { taskActivity[id] = max(taskActivity[id] ?? "", date) }
        }
        var rebuilt: Set<String> = []
        func groups(archived: Bool, old: [String: ConsoleOutlineComputedGroup]) -> [String: ConsoleOutlineComputedGroup] {
            let matching = tasks.filter {
                $0.archived == archived && (archived || !$0.done)
                    && (query.isEmpty || $0.title.localizedCaseInsensitiveContains(query)
                        || (!archived && $0.description.localizedCaseInsensitiveContains(query)))
            }
            var result: [String: ConsoleOutlineComputedGroup] = [:]
            for (workID, direct) in Dictionary(grouping: matching, by: \.workID) {
                if Task.isCancelled { break }
                let ids = Set(direct.map(\.id))
                let missing = Set(direct.compactMap(\.parentID)).subtracting(ids)
                let parents = missing.isEmpty ? [] : tasks.filter { missing.contains($0.id) }
                let records = direct + parents
                let recordIDs = Set(records.map(\.id))
                let activity: [String: String] = key.sort == .updated
                    ? Dictionary(records.compactMap { record in taskActivity[record.id].map { (record.id, $0) } },
                        uniquingKeysWith: { _, last in last }) : [:]
                let source = ConsoleOutlineGroupSource(records: records, directIDs: direct.map(\.id),
                    expanded: key.showsArchive && key.search.isEmpty ? key.expandedTaskIDs.intersection(recordIDs) : recordIDs,
                    sort: key.sort, activity: activity)
                if let cached = old[workID], cached.source == source { result[workID] = cached; continue }
                rebuilt.insert(workID)
                let ordered = key.sort.ordered(direct, id: { $0.id }, title: { $0.title }, updatedAt: { $0.updatedAt },
                    activityAt: { activity[$0.id] }, prioritizesActivity: true) + parents
                let orderedIDs = TaskHierarchyIndex.visibleOrder(nodes: ordered.map {
                    .init(id: $0.id, workId: $0.workID, parentTaskId: $0.parentID)
                }, expanded: source.expanded)
                let roots = orderedIDs.filter { byID[$0]?.parentID == nil }
                let initial = Set(roots.prefix(WorkOutlineTaskDisclosurePolicy.defaultVisibleCount))
                result[workID] = ConsoleOutlineComputedGroup(source: source, rootCount: roots.count,
                    initialIDs: orderedIDs.filter { initial.contains(byID[$0]?.parentID ?? $0) }, allIDs: orderedIDs, nativeIDs: TaskHierarchyIndex.visibleOrder(nodes: ordered.map {
                        .init(id: $0.id, workId: $0.workID, parentTaskId: $0.parentID)
                    }, expanded: recordIDs))
            }
            return result
        }
        let active = groups(archived: false, old: previous?.active ?? [:])
        let archived = key.showsArchive ? groups(archived: true, old: previous?.archived ?? [:]) : [:]
        let excluded = archived.mapValues { Set($0.source.directIDs) }
        var archiveIDs: [String: [String]] = [:]
        for session in archivedSessions where session.resolvedSessionKind == .worker {
            if !query.isEmpty && ![session.title, session.summary, session.agent, session.external?.cwd ?? ""]
                .contains(where: { $0.localizedCaseInsensitiveContains(query) }) { continue }
            let workID = session.workId ?? session.taskId.flatMap { byID[$0]?.workID } ?? ""
            if let taskID = session.taskId, excluded[workID]?.contains(taskID) == true { continue }
            archiveIDs[workID, default: []].append(session.id)
        }
        guard !Task.isCancelled else { return nil }
        // Work positions survive sort, activity and inventory refreshes. Only
        // Task groups above use the selected ordering; newly seen Works append.
        let incomingWorkIDs = works.map(\.id)
        let incoming = Set(incomingWorkIDs)
        let retained = (previous?.workIDs ?? []).filter { incoming.contains($0) }
        let known = Set(retained)
        let workIDs = retained + incomingWorkIDs.filter { !known.contains($0) }
        return ConsoleOutlineComputation(key: key, workIDs: workIDs, active: active, archived: archived,
            archivedSessionIDs: archiveIDs, rebuiltWorkIDs: rebuilt, usedMainThread: Thread.isMainThread)
    }
}

/// A single bounded published snapshot. Rendering never invokes a builder.
@MainActor
final class ConsoleOutlineProjectionStore: ObservableObject {
    @Published private(set) var prepared = ConsoleOutlineProjection.empty
    private(set) var preparedKey: ConsoleOutlineProjectionKey?
    private(set) var requestedKey: ConsoleOutlineProjectionKey?
    private var computation: ConsoleOutlineComputation?
    private var worker: Task<ConsoleOutlineComputation?, Never>?
    private var generation: UInt64 = 0
    private(set) var computationCount = 0
    private(set) var rebuiltWorkIDs: Set<String> = []
    private(set) var lastComputationUsedMainThread = false

    private static let manualWorkOrderKey = "console.workOutline.manualOrder.v1"
    private let defaults: UserDefaults?
    private var manualWorkOrder: [String]

    // Tests and transient projections remain in-memory unless a preferences
    // store is explicitly supplied by the application host.
    init(defaults: UserDefaults? = nil) {
        self.defaults = defaults
        manualWorkOrder = defaults?.stringArray(forKey: Self.manualWorkOrderKey) ?? []
    }

    /// Reorder only the small Work inventory; reuse all prepared Task rows.
    @discardableResult
    func moveWork(_ sourceID: String, relativeTo targetID: String, after: Bool) -> Bool {
        guard sourceID != targetID,
              let source = prepared.works.firstIndex(where: { $0.id == sourceID }),
              prepared.works.contains(where: { $0.id == targetID }) else { return false }
        var works = prepared.works
        let moved = works.remove(at: source)
        guard let target = works.firstIndex(where: { $0.id == targetID }) else { return false }
        works.insert(moved, at: target + (after ? 1 : 0))
        let ids = works.map(\.id)
        guard ids != prepared.works.map(\.id) else { return false }
        computation?.workIDs = ids
        var next = prepared
        next.works = works
        prepared = next
        manualWorkOrder = ids
        defaults?.set(ids, forKey: Self.manualWorkOrderKey)
        return true
    }

    func prepare(key: ConsoleOutlineProjectionKey, tasks: [CorptieTask], works: [Work], sessions: [TaskSession],
                 archivedRows: [SessionRowModel] = [], isCurrent: () -> Bool = { true }) async {
        requestedKey = key
        if preparedKey == key {
            generation &+= 1; worker?.cancel(); worker = nil
            return
        }
        generation &+= 1
        let requested = generation
        worker?.cancel()
        let snapshot = ConsoleOutlineSnapshot(key: key, tasks: tasks, works: works, sessions: sessions,
            archivedSessions: archivedRows.map(\.session))
        let previous = computation
        let work = Task.detached(priority: .userInitiated) { snapshot.compute(previous: previous) }
        worker = work
        let result = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
        guard requested == generation else { return }
        worker = nil
        guard !Task.isCancelled, isCurrent(), var result else { return }
        // A drag may have committed while the background snapshot was running.
        let incoming = Set(result.workIDs)
        let preferredOrder = manualWorkOrder.isEmpty ? (computation?.workIDs ?? []) : manualWorkOrder
        var seen: Set<String> = []
        let retained = preferredOrder.filter { incoming.contains($0) && seen.insert($0).inserted }
        let known = Set(retained)
        result.workIDs = retained + result.workIDs.filter { !known.contains($0) }
        let tasksByID = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let worksByID = Dictionary(works.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        let archivedByID = Dictionary(archivedRows.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        var rows = result.active.mapValues { ConsoleOutlineWorkRows(group: $0, tasks: tasksByID) }
        for id in rows.keys {
            rows[id]?.structureRevision = result.rebuiltWorkIDs.contains(id)
                ? computationCount + 1 : prepared.workRowsByWorkID[id]?.structureRevision ?? 0
        }
        let projection = ConsoleOutlineProjection(tasksByWorkID: rows.mapValues(\.allRows),
            works: result.workIDs.compactMap { worksByID[$0] }, processingWorkIDs: [], workRowsByWorkID: rows,
            archivedTasksByWorkID: result.archived.mapValues { $0.allIDs.compactMap { tasksByID[$0] } },
            archivedRowsByWorkID: result.archivedSessionIDs.mapValues { $0.compactMap { archivedByID[$0] } })
        computation = result
        preparedKey = key
        rebuiltWorkIDs = result.rebuiltWorkIDs
        lastComputationUsedMainThread = result.usedMainThread
        computationCount += 1
        prepared = projection
    }
}
