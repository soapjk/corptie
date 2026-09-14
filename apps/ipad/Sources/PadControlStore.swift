import Foundation
import Observation
import CorptieClientCore

struct PadControlSelection: Hashable {
    let kind: ClientControlKind
    let id: String
}

enum PadTab: Int, CaseIterable, Identifiable {
    case workspace, automations, worktrees, agents
    var id: Int { rawValue }
    var title: String {
        switch self { case .workspace: "工作台"; case .automations: "自动化"; case .worktrees: "Worktrees"; case .agents: "Agents" }
    }
    var symbol: String {
        switch self { case .workspace: "circle.hexagongrid.fill"; case .automations: "bolt.badge.clock";
        case .worktrees: "arrow.triangle.branch"; case .agents: "person.2" }
    }
    var resources: [ClientControlKind] {
        switch self { case .workspace: []; case .automations: [.automations];
        case .worktrees: [.repositories]; case .agents: [.agents, .skills] }
    }
}

@MainActor @Observable
final class PadControlStore {
    var items: [ClientControlKind: [ClientControlItem]] = [:]
    var cursors: [ClientControlKind: String] = [:]
    var errors: [ClientControlKind: String] = [:]
    var selections: [ClientControlKind: String] = [:]
    var routes: [PadTab: PadControlSelection] = [:]
    var repository: ClientRepositoryDetail?
    var repositoryError = ""
    var loading: Set<ClientControlKind> = []
    var visibleTab = PadTab.workspace
    private(set) var dirty = Set(ClientControlKind.allCases)
    private var revision = 0
    private var repositoryRevision = 0
    private var worker: Task<Void, Never>?
    private var generation = UUID()
    private var active = false
    private var lastRefresh: [ClientControlKind: ContinuousClock.Instant] = [:]

    func activate(_ tab: PadTab, connection: PadConnection) {
        visibleTab = tab
        active = true
        // Refresh on entering a page too: Git may change outside Corptie events.
        dirty.formUnion(tab.resources)
        schedule(connection)
    }
    func invalidate(_ connection: PadConnection) {
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
        case ClientConnectionError.httpStatus(403): "设备未获四页浏览权限，请在 Mac 的设备设置中授权。"
        case ClientConnectionError.httpStatus(404): "此资源或接口不可用，请检查 Mac 后端版本。"
        case ClientConnectionError.httpStatus(401): "设备授权已失效，请重新连接。"
        default: "同步失败，已保留上次数据。请重试。"
        }
    }
}
