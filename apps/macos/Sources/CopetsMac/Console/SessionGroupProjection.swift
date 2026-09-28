import Combine
import CorptieConversation
import AppKit
import SwiftUI

enum WorkerSessionScope: Equatable {
    case active
    case archived
}

enum WorkerSessionGroupingMode: String, CaseIterable, Identifiable {
    case work
    case none

    var id: String { rawValue }

    @MainActor var title: String {
        switch self {
        case .work: L10n("Group by Work")
        case .none: L10n("All")
        }
    }
}

enum SessionCategory: String, CaseIterable, Identifiable {
    case worker
    case work
    case assistant

    var id: String { rawValue }

    init(session: TaskSession) {
        switch session.resolvedSessionKind {
        case .worker: self = .worker
        case .workChat: self = .work
        case .assistantChat, .legacy: self = .assistant
        }
    }

    @MainActor var title: String {
        switch self {
        case .worker: L10n("Worker")
        case .work: L10n("Work")
        case .assistant: L10n("Assistant")
        }
    }

    var systemImage: String {
        switch self {
        case .worker: "hammer"
        case .work: "scope"
        case .assistant: "sparkles"
        }
    }
}

/// The sidebar projection is expensive for large Session collections, but a
/// selection change does not alter any of its inputs. Keep the immutable
/// result behind an explicit revision key so SwiftUI may reevaluate
/// `UnifiedConsoleView.body` without repeating filtering, sorting, and grouping.
struct SessionGroupProjectionKey: Equatable {
    let groupingRevision: UInt64
    let filterRevision: UInt64
    let entityRevision: UInt64
    let category: SessionCategory
    let workerScope: WorkerSessionScope
    let workerGroupingMode: WorkerSessionGroupingMode
    let searchText: String
}

@MainActor
final class SessionGroupProjectionStore: ObservableObject {
    private var cachedKey: SessionGroupProjectionKey?
    private var cachedGroups: [SessionGroup] = []
    private(set) var computationCount = 0

    func groups(
        for key: SessionGroupProjectionKey,
        make: () -> [SessionGroup]
    ) -> [SessionGroup] {
        if cachedKey == key {
            return cachedGroups
        }
        let groups = make()
        cachedKey = key
        cachedGroups = groups
        computationCount += 1
        return groups
    }
}

@MainActor
func makeSessionGroups(
    rows: [SessionRowModel],
    agents: [Agent],
    tasks: [CorptieTask],
    works: [Work],
    category: SessionCategory,
    workerScope: WorkerSessionScope = .active,
    workerGroupingMode: WorkerSessionGroupingMode = .work
) -> [SessionGroup] {
    // Read each observable row exactly once. Repeated @Published property
    // access inside lazy filter + sort comparators dominated the 2,000-row
    // path even though the actual sort is cheap.
    var candidates: [(row: SessionRowModel, session: TaskSession, timestamp: String)] = []
    candidates.reserveCapacity(rows.count)
    for row in rows {
        let session = row.session
        guard session.hasValidProductClassification,
              SessionCategory(session: session) == category else { continue }
        candidates.append((row, session, session.lastMessageAt ?? session.updatedAt))
    }
    candidates.sort { left, right in
        if left.timestamp != right.timestamp { return left.timestamp > right.timestamp }
        return left.row.id < right.row.id
    }
    let agentsByID = Dictionary(uniqueKeysWithValues: agents.map { ($0.agentId, $0) })
    let tasksByID = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
    let worksByID = Dictionary(uniqueKeysWithValues: works.map { ($0.id, $0) })
    var assistantOrder: [String] = []
    var assistantRows: [String: [SessionRowModel]] = [:]
    var workOrder: [String] = []
    var workTitles: [String: String] = [:]
    var visibleWorkerRows: [SessionRowModel] = []
    var workerRows: [String: [SessionRowModel]] = [:]
    var workerWorkKeysByRowID: [String: String] = [:]
    var workRows: [String: [SessionRowModel]] = [:]

    func registerWork(_ workID: String?) -> String {
        let trimmedID = workID?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedID = trimmedID.flatMap { $0.isEmpty ? nil : $0 }
        let key = normalizedID ?? "__no_work__"
        if workTitles[key] == nil {
            workOrder.append(key)
            workTitles[key] = normalizedID.flatMap { worksByID[$0]?.name }
                ?? (normalizedID == nil ? L10n("No Work") : L10n("Unknown Work"))
        }
        return key
    }

    for candidate in candidates {
        let row = candidate.row
        let session = candidate.session
        switch session.resolvedSessionKind {
        case .assistantChat:
            let key = session.agentId ?? "__assistant_unbound__"
            if assistantRows[key] == nil { assistantOrder.append(key) }
            assistantRows[key, default: []].append(row)
        case .workChat:
            let workKey = registerWork(session.workId)
            workRows[workKey, default: []].append(row)
        case .worker:
            let task = session.taskId.flatMap { tasksByID[$0] }
            let isArchived = session.archived == true
            guard (workerScope == .archived) == isArchived else { continue }
            visibleWorkerRows.append(row)
            let workKey = registerWork(task?.workId ?? session.workId)
            workerWorkKeysByRowID[row.id] = workKey
            workerRows[workKey, default: []].append(row)
        case .legacy:
            continue
        }
    }

    var groups = assistantOrder.map { key in
        SessionGroup(
            key: "assistant:\(key)",
            title: agentsByID[key]?.name ?? L10n("Assistant Session"),
            rows: assistantRows[key] ?? []
        )
    }
    if category == .worker,
       workerScope == .active,
       workerGroupingMode == .none,
       !visibleWorkerRows.isEmpty {
        let rowSubtitles: [String: String] = Dictionary(
            uniqueKeysWithValues: visibleWorkerRows.compactMap { row -> (String, String)? in
                guard let workKey = workerWorkKeysByRowID[row.id],
                      let workTitle = workTitles[workKey] else { return nil }
                return (row.id, workTitle)
            }
        )
        groups.append(SessionGroup(
            key: "worker-ungrouped",
            title: "",
            rows: visibleWorkerRows,
            showsHeader: false,
            rowSubtitles: rowSubtitles
        ))
        return groups
    }
    for workKey in workOrder {
        if category == .worker,
           let rows = workerRows[workKey],
           !rows.isEmpty {
            groups.append(SessionGroup(
                key: "worker-work:\(workKey)",
                title: workTitles[workKey] ?? L10n("Unknown Work"),
                rows: rows
            ))
        } else if category == .work,
                  let rows = workRows[workKey],
                  !rows.isEmpty {
            groups.append(SessionGroup(
                key: "work:\(workKey)",
                title: workTitles[workKey] ?? L10n("Unknown Work"),
                rows: rows
            ))
        }
    }
    return groups
}

// 按搜索词筛选会话（匹配标题/摘要/Agent/工作目录，大小写不敏感）。
@MainActor
func filteredSessionRows(_ rows: [SessionRowModel], query: String) -> [SessionRowModel] {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return rows }
    return rows.filter { row in
        let session = row.session
        return [session.title, session.summary, session.agent, session.external?.cwd ?? ""]
            .contains { $0.localizedCaseInsensitiveContains(trimmed) }
    }
}

// 解析某个 Tab（SessionCategory）下应选中的会话 id：
//  - 当前选择仍属于该 Tab 且存在 → 保留；
//  - 否则若该 Tab 记住的上次选择仍存在 → 恢复；
//  - 否则回退到该 Tab 的第一个会话；
//  - 该 Tab 无会话时返回 nil。
@MainActor
func resolvedSessionSelection(
    category: SessionCategory,
    rows: [SessionRowModel],
    selectedSessionId: String?,
    lastSelectedId: String?,
    workerScope: WorkerSessionScope = .active
) -> String? {
    let visibleRows = rows.filter { row in
        guard row.session.hasValidProductClassification else { return false }
        guard SessionCategory(session: row.session) == category else { return false }
        guard category == .worker else { return true }
        return (workerScope == .archived) == isArchivedWorkerSession(row.session)
    }
    if let selectedSessionId,
       visibleRows.contains(where: { $0.id == selectedSessionId }) {
        return selectedSessionId
    }
    guard let first = visibleRows.first else { return nil }
    if let lastSelectedId, visibleRows.contains(where: { $0.id == lastSelectedId }) {
        return lastSelectedId
    }
    return first.id
}

func isArchivedWorkerSession(_ session: TaskSession) -> Bool {
    session.resolvedSessionKind == .worker && session.archived == true
}

enum SessionSelectionRecoveryPolicy {
    private static let historyLimit = 50

    static func recording(_ sessionID: String, in recentSessionIDs: [String]) -> [String] {
        var result = recentSessionIDs.filter { $0 != sessionID }
        result.insert(sessionID, at: 0)
        return Array(result.prefix(historyLimit))
    }

}

// 会话详细信息面板：对话区右侧一条固定竖列（参考 Rudder 的 IssueDetail rail）。
//   固定在右侧，常驻展示，无收起/展开按钮；竖向排列详情字段。
//   Rudder 契约：rail 固定 280px，sticky 顶部，仅 <48rem 移动端才隐藏。
