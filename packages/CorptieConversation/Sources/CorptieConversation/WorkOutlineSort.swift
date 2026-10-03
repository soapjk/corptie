import Foundation

public enum WorkOutlineSort: String, CaseIterable, Sendable {
    case standard, updated, name

    public var title: String {
        switch self {
        case .standard: "默认顺序"
        case .updated: "最近更新"
        case .name: "名称"
        }
    }

    public func ordered<Item>(_ items: [Item], id: (Item) -> String,
                              title: (Item) -> String, updatedAt: (Item) -> String,
                              activityAt: (Item) -> String? = { _ in nil },
                              prioritizesActivity: Bool = false) -> [Item] {
        guard self != .standard else { return items }
        let indexed = items.map { (item: $0, id: id($0), title: title($0),
                                   updatedAt: updatedAt($0), activityAt: activityAt($0)) }
        return indexed.sorted { left, right in
            if self == .updated {
                if prioritizesActivity, left.activityAt != right.activityAt {
                    return (left.activityAt ?? "") > (right.activityAt ?? "")
                }
                let lhs = left.activityAt ?? left.updatedAt
                let rhs = right.activityAt ?? right.updatedAt
                if lhs != rhs { return lhs > rhs }
                if prioritizesActivity, left.updatedAt != right.updatedAt {
                    return left.updatedAt > right.updatedAt
                }
            } else {
                let order = left.title.localizedStandardCompare(right.title)
                if order != .orderedSame { return order == .orderedAscending }
            }
            return left.id < right.id
        }.map(\.item)
    }
}

/// Both clients persist only explicit expansion: newly discovered groups stay folded.
public struct WorkOutlineExpansionStore {
    private static let worksKey = "corptie.workOutline.expandedWorkIDs.v2"
    private static let chatKey = "corptie.workOutline.chatExpanded.v2"
    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    public func load() -> Set<String> {
        if let saved = defaults.stringArray(forKey: Self.worksKey) { return Set(saved) }
        // Mobile already recorded explicit expansions; desktop's old inverse
        // preference cannot distinguish untouched groups from user expansions.
        return Set(defaults.stringArray(forKey: "corptie.mobile.expandedWorkIDs.v1") ?? [])
    }

    public func save(_ ids: Set<String>) {
        defaults.set(ids.sorted(), forKey: Self.worksKey)
    }

    public func loadChat() -> Bool {
        if defaults.object(forKey: Self.chatKey) != nil { return defaults.bool(forKey: Self.chatKey) }
        if defaults.object(forKey: "console.workOutline.assistantCollapsed.v1") != nil {
            return !defaults.bool(forKey: "console.workOutline.assistantCollapsed.v1")
        }
        return false
    }

    public func saveChat(_ expanded: Bool) { defaults.set(expanded, forKey: Self.chatKey) }
}
