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
