import Combine
import Foundation

/// A local projection of the shared registry. Session stream updates must not
/// invalidate the role grid or rebuild its search index.
@MainActor
final class RoleRegistryPresentation: ObservableObject {
    @Published private(set) var roles: [Role] = []
    @Published private(set) var skills: [Skill] = []
    @Published private(set) var syncError: String?
    @Published private(set) var isReachable = false
    @Published private(set) var hasLoaded = false
    @Published private(set) var isRefreshing = false

    private struct Registry: Equatable {
        let roles: [String: Role]
        let skills: [String: Skill]
    }

    private var roleIndex = RegistrySearchIndex<Role>()
    private var skillIndex = RegistrySearchIndex<Skill>()
    private var subscriptions = Set<AnyCancellable>()

    init(store: AppStateStore = .shared) {
        store.$state
            .map { Registry(roles: $0.roles, skills: $0.skills) }
            .removeDuplicates()
            .sink { [weak self] registry in
                guard let self else { return }
                let roles = registry.roles.values.sorted {
                    $0.createdAt == $1.createdAt
                        ? $0.roleId < $1.roleId : $0.createdAt < $1.createdAt
                }
                let skills = registry.skills.values.sorted {
                    let order = $0.name.localizedCaseInsensitiveCompare($1.name)
                    return order == .orderedSame
                        ? $0.skillId < $1.skillId : order == .orderedAscending
                }
                if self.roles != roles {
                    self.roleIndex = RegistrySearchIndex(items: roles) {
                        [$0.name, $0.description] + $0.capabilities
                    }
                    self.roles = roles
                }
                if self.skills != skills {
                    self.skillIndex = RegistrySearchIndex(items: skills) {
                        [$0.name, $0.description]
                    }
                    self.skills = skills
                }
            }
            .store(in: &subscriptions)
        store.$syncError.removeDuplicates().assign(to: &$syncError)
        store.$isReachable.removeDuplicates().sink { [weak self] reachable in
            self?.isReachable = reachable
            if reachable { self?.hasLoaded = true }
        }.store(in: &subscriptions)
    }

    func matchingRoles(_ query: String) -> [Role] { roleIndex.matches(query) }
    func matchingSkills(_ query: String) -> [Skill] { skillIndex.matches(query) }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        // One snapshot contains both registries. No new endpoint or polling.
        await AppStateSyncController.shared.refreshSnapshot()
    }

    func phase(itemCount: Int) -> RegistryLoadPhase {
        RegistryLoadPhase(itemCount: itemCount, hasLoaded: hasLoaded, error: syncError)
    }
}

enum RegistryLoadPhase: Equatable {
    case loading, failed, empty, content

    init(itemCount: Int, hasLoaded: Bool, error: String?) {
        if itemCount > 0 {
            self = .content
        } else if error != nil {
            self = .failed
        } else if hasLoaded {
            self = .empty
        } else {
            self = .loading
        }
    }
}

/// Normalization happens only when registry data changes, not for every card.
struct RegistrySearchIndex<Item> {
    private var entries: [(item: Item, text: String)] = []

    init() {}

    init(items: [Item], fields: (Item) -> [String]) {
        entries = items.map { ($0, Self.normalize(fields($0).joined(separator: "\n"))) }
    }

    func matches(_ query: String) -> [Item] {
        let terms = Self.normalize(query).split(whereSeparator: { $0.isWhitespace }).map(
            String.init)
        guard !terms.isEmpty else { return entries.map(\.item) }
        return entries.compactMap { entry in
            terms.allSatisfy { entry.text.contains($0) } ? entry.item : nil
        }
    }

    private static func normalize(_ text: String) -> String {
        text.precomposedStringWithCanonicalMapping.folding(
            options: .caseInsensitive, locale: Locale(identifier: "en_US_POSIX"))
    }
}
