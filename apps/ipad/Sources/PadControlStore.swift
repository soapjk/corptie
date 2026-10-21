import Foundation
import Observation
import CorptieClientCore

enum PadControlPresentation {
    static func status(_ value: String) -> String {
        ["active": "等待触发", "paused": "已暂停", "cancelled": "已取消", "expired": "已过期",
         "completed": "已完成", "failed": "失败", "error": "错误", "running": "执行中", "queued": "已触发",
         "claimed": "正在启动", "succeeded": "成功", "available": "可用", "missing": "不可用",
         "once": "单次", "interval": "周期", "condition": "条件", "processExit": "进程退出"][value] ?? value
    }
    static func date(_ value: String, timeZone: TimeZone = .autoupdatingCurrent,
                     locale: Locale = .autoupdatingCurrent) -> String {
        guard let date = ConversationTimestampText.date(from: value) else { return "时间不可用" }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .standard,
            locale: locale, timeZone: timeZone))
    }
    static func automationID(_ value: ClientInspectorValue) -> String? {
        guard let id = value["taskId"].text, !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return id
    }
}

struct PadControlSelection: Hashable {
    let kind: ClientControlKind
    let id: String
}

enum PadTab: Int, CaseIterable, Identifiable {
    case workspace, automations, worktrees, agents, resources, settings
    var id: Int { rawValue }
    var title: String {
        switch self { case .workspace: "工作台"; case .automations: "自动化"; case .worktrees: "Worktree"; case .agents: "Agents"; case .resources: "资源管理"; case .settings: "设置" }
    }
    var symbol: String {
        switch self { case .workspace: "circle.hexagongrid.fill"; case .automations: "bolt.badge.clock";
        case .worktrees: "arrow.triangle.branch"; case .agents: "person.2"; case .resources: "tray.full"; case .settings: "gearshape" }
    }
    var resources: [ClientControlKind] {
        switch self { case .workspace, .resources, .settings: []; case .automations: [.automations];
        case .worktrees: [.repositories]; case .agents: [.agents, .skills] }
    }

    static let optionalTabs: [Self] = [.automations, .worktrees, .agents, .resources]
    var isRequired: Bool { self == .workspace || self == .settings }
    var preferenceID: String {
        switch self {
        case .workspace: "workspace"
        case .automations: "automations"
        case .worktrees: "worktrees"
        case .agents: "agents"
        case .resources: "resources"
        case .settings: "settings"
        }
    }
}

/// The only new persistence is the user-authorized, local Tab visibility choice.
/// Store native UserDefaults string arrays, not JSON or derived digests.
@MainActor @Observable
final class PadTabPreferences {
    static let storageKey = "corptie.mobile.visibleOptionalTabs.v1"
    private(set) var optionalTabs: [PadTab]
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        optionalTabs = Self.normalized(defaults.stringArray(forKey: Self.storageKey))
    }

    static func normalized(_ identifiers: [String]?) -> [PadTab] {
        guard let identifiers else { return [.worktrees] }
        return Array(PadTab.optionalTabs.filter { identifiers.contains($0.preferenceID) }.prefix(3))
    }

    var visibleTabs: [PadTab] { [.workspace] + optionalTabs + [.settings] }
    func contains(_ tab: PadTab) -> Bool { tab.isRequired || optionalTabs.contains(tab) }
    func canEnable(_ tab: PadTab) -> Bool { contains(tab) || optionalTabs.count < 3 }

    func setEnabled(_ tab: PadTab, _ enabled: Bool) {
        guard !tab.isRequired, PadTab.optionalTabs.contains(tab) else { return }
        guard !enabled || canEnable(tab) else { return }
        let next = PadTab.optionalTabs.filter { $0 == tab ? enabled : optionalTabs.contains($0) }
        guard next != optionalTabs else { return }
        optionalTabs = next
        defaults.set(next.map(\.preferenceID), forKey: Self.storageKey)
    }

    func restoreDefaults() {
        guard optionalTabs != [.worktrees] else { return }
        optionalTabs = [.worktrees]
        defaults.set([PadTab.worktrees.preferenceID], forKey: Self.storageKey)
    }
}

@MainActor @Observable
final class PadControlStore {
    var worktrees = PadWorktreeStore()
    var items: [ClientControlKind: [ClientControlItem]] = [:]
    var cursors: [ClientControlKind: String] = [:]
    var errors: [ClientControlKind: String] = [:]
    var selections: [ClientControlKind: String] = [:]
    var routes: [PadTab: PadControlSelection] = [:]
    private(set) var automationNavigationRevision = 0
    var repository: ClientRepositoryDetail?
    var repositoryError = ""
    var loading: Set<ClientControlKind> = []
    var visibleTab = PadTab.workspace
    private(set) var dirty: Set<ClientControlKind> = []
    private var revision = 0
    private var repositoryRevision = 0
    private var worker: Task<Void, Never>?
    private var generation = UUID()
    private var active = false
    private var lastRefresh: [ClientControlKind: ContinuousClock.Instant] = [:]
    private var pushSynchronized = false

    /// The inspector and notifications use the same exact-resource route.
    @discardableResult
    func selectAutomation(id: String) -> PadTab? {
        guard !id.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        selections[.automations] = id
        routes[.automations] = PadControlSelection(kind: .automations, id: id)
        automationNavigationRevision &+= 1
        return .automations
    }

    func apply(_ snapshot: ClientControlSnapshot) {
        guard snapshot.schemaVersion == 2 else { return }
        let next: [ClientControlKind: [ClientControlItem]] = [
            .automations: snapshot.automations,
            .repositories: snapshot.repositories,
            .agents: snapshot.agents,
            .skills: snapshot.skills
        ]
        for (kind, values) in next where items[kind] != values { items[kind] = values }
        cursors = [:]
        errors = [:]
        dirty.subtract(next.keys)
        pushSynchronized = true
    }

    func activate(_ tab: PadTab, connection: PadConnection) {
        visibleTab = tab
        active = true
        // Normal synchronization is server-pushed. A read is scheduled only
        // after a legacy invalidation has explicitly marked data dirty.
        schedule(connection)
    }
    func invalidate(_ connection: PadConnection) {
        guard !pushSynchronized else { return }
        revision += 1
        dirty.formUnion(ClientControlKind.allCases)
        schedule(connection)
    }
    func pause() {
        active = false; generation = UUID()
        worker?.cancel(); worker = nil
        loading = []
    }
    private func schedule(_ connection: PadConnection) {
        guard active, worker == nil, visibleTab.resources.contains(where: { dirty.contains($0) }) else { return }
        let token = generation
        worker = Task { @MainActor in
            defer { if generation == token { worker = nil } }
            while !Task.isCancelled, connection.connected, active {
                guard let kind = visibleTab.resources.first(where: { dirty.contains($0) }) else { return }
                do {
                    try await Task.sleep(for: .milliseconds(500))
                    // Store invalidations can include unrelated Session updates.
                    // Bound background reads without delaying an explicit refresh.
                    if let last = lastRefresh[kind] {
                        let deadline = last.advanced(by: kind == .repositories ? .seconds(5) : .seconds(1))
                        try await Task.sleep(until: deadline, clock: .continuous)
                    }
                } catch { return }
                guard !Task.isCancelled, generation == token else { return }
                guard visibleTab.resources.contains(kind) else { continue }
                await refresh(kind, connection: connection)
                guard !Task.isCancelled, generation == token else { return }
                // Avoid retry storms; explicit refresh / next event retries failed reads.
                if errors[kind] != nil { dirty.remove(kind) }
            }
        }
    }
    func refresh(_ kind: ClientControlKind, connection: PadConnection, more: Bool = false) async {
        guard !loading.contains(kind), !more || cursors[kind] != nil else { return }
        let token = generation, version = revision
        lastRefresh[kind] = .now
        loading.insert(kind)
        defer { if generation == token { loading.remove(kind) } }
        do {
            let api = ClientControlAPI(transport: try await connection.transport())
            var next = more ? cursors[kind] : nil
            var result: [ClientControlItem] = more ? items[kind] ?? [] : []
            let target = more ? result.count + 1 : max(50, items[kind]?.count ?? 0)
            var budget = max(1, (target + 49) / 50) + 1
            repeat {
                guard budget > 0 else { throw ClientConnectionError.invalidResponse }
                budget -= 1
                let page = try await api.list(kind, cursor: next)
                result = PadWorkspace.merge(result, page.items)
                next = page.nextCursor
                try Task.checkCancellation()
            } while next != nil && result.count < target
            guard generation == token else { return }
            if items[kind] != result { items[kind] = result }
            cursors[kind] = next; errors[kind] = nil
            if revision == version { dirty.remove(kind) }
            // An event never changes the selected resource or active Tab.
            if kind == .repositories, visibleTab == .worktrees, let id = selections[kind] {
                await loadRepository(id, connection: connection)
            }
        } catch {
            guard !Task.isCancelled, generation == token else { return }
            errors[kind] = Self.explain(error)
        }
    }
    func loadRepository(_ id: String, connection: PadConnection) async {
        repositoryRevision += 1
        let version = repositoryRevision, token = generation
        if repository?.repository.id != id { repository = nil }
        repositoryError = ""
        do {
            let api = ClientControlAPI(transport: try await connection.transport())
            let result = try await api.repository(id)
            guard !Task.isCancelled, generation == token, version == repositoryRevision,
                  selections[.repositories] == id else { return }
            if repository != result { repository = result }
        } catch {
            guard !Task.isCancelled, generation == token, version == repositoryRevision else { return }
            repositoryError = Self.explain(error)
        }
    }
    static func explain(_ error: Error) -> String {
        switch error {
        case ClientConnectionError.httpStatus(403): "Mac 拒绝了这项请求，请刷新后重试。"
        case ClientConnectionError.httpStatus(404): "此资源或接口不可用，请检查 Mac 后端版本。"
        case ClientConnectionError.httpStatus(401): "设备授权已失效，请重新连接。"
        default: "同步失败，已保留上次数据。请重试。"
        }
    }
}
