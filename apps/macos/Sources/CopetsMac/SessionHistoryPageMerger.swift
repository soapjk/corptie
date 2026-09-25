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

        var positions: [String: Int] = [:]
        positions.reserveCapacity(pageItems.count + currentItems.count)

        var merged: [CodexThreadItem] = []
        merged.reserveCapacity(pageItems.count + currentItems.count)
        for item in pageItems { append(item, to: &merged, positions: &positions) }
        for item in currentItems { append(item, to: &merged, positions: &positions) }
        return merged
    }

    /// An anchor window can be separated from the currently loaded tail by an
    /// intentional gap. Keep the bounded anchor neighborhood first, retain the
    /// cached tail for an immediate "jump to latest", and remove overlap by
    /// stable item identity without manufacturing intermediate history.
    static func mergeAnchorWindow(
        _ windowItems: [CodexThreadItem],
        with currentItems: [CodexThreadItem]
    ) -> [CodexThreadItem] {
        var positions: [String: Int] = [:]
        positions.reserveCapacity(windowItems.count + currentItems.count)
        var merged: [CodexThreadItem] = []
        merged.reserveCapacity(windowItems.count + currentItems.count)
        for item in windowItems { append(item, to: &merged, positions: &positions) }
        for item in currentItems { append(item, to: &merged, positions: &positions) }
        return merged
    }

    private static func append(
        _ item: CodexThreadItem,
        to merged: inout [CodexThreadItem],
        positions: inout [String: Int]
    ) {
        if let index = positions[item.id] {
            let current = merged[index]
            if current.type == "executionPlan", item.type == "executionPlan",
               let currentPlan = current.executionPlan,
               let candidatePlan = item.executionPlan,
               currentPlan.planId == candidatePlan.planId,
               candidatePlan.revision > currentPlan.revision {
                merged[index] = item
            }
            return
        }
        positions[item.id] = merged.count
        merged.append(item)
    }
}
