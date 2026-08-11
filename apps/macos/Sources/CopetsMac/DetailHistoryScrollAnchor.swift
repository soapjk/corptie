import Foundation

struct DetailHistoryScrollAnchor: Equatable {
    let entryId: String

    static func resolve(orderedEntryIds: [String]) -> DetailHistoryScrollAnchor? {
        orderedEntryIds.first.map(DetailHistoryScrollAnchor.init(entryId:))
    }
}
