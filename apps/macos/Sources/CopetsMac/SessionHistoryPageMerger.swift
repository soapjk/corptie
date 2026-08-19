import Foundation

enum SessionHistoryPageMerger {
    /// Prepends a page only while the cursor used to request it is still the
    /// active oldest item. A second response for the same cursor is stale after
    /// the first response advances the window and must not be applied again.
    static func prepend(
        pageItems: [CodexThreadItem],
        to currentItems: [CodexThreadItem],
        requestedBeforeID: String
    ) -> [CodexThreadItem]? {
        guard currentItems.first?.id == requestedBeforeID else { return nil }

        var seen = Set<String>()
        seen.reserveCapacity(pageItems.count + currentItems.count)

        var merged: [CodexThreadItem] = []
        merged.reserveCapacity(pageItems.count + currentItems.count)
        for item in pageItems where seen.insert(item.id).inserted {
            merged.append(item)
        }
        for item in currentItems where seen.insert(item.id).inserted {
            merged.append(item)
        }
        return merged
    }
}
