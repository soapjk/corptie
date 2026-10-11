import Foundation

public struct ClientTimelineWindowReconciliation: Sendable {
    public let messages: [ClientMessage]
    public let before: String?
    public let retainedPrefix: Bool
    public let duplicateCount: Int
}

/// Reconciles a bounded latest window with already resident history in linear
/// time. Supplemental conversation boundaries may overlap the retained prefix;
/// authoritative IDs alone define where the bounded window replaces old data.
public enum ClientTimelineWindowReconciler {
    public static func reconcile(
        existing: [ClientMessage],
        incoming: [ClientMessage],
        nextBefore: String?,
        existingBefore: String?,
        authoritativeItemIds: [String]?,
        supplementalItemIds _: [String]? = nil
    ) -> ClientTimelineWindowReconciliation {
        let (oldItems, oldDuplicates) = stableUnique(existing)
        let (newItems, newDuplicates) = stableUnique(incoming)
        guard !newItems.isEmpty else {
            return ClientTimelineWindowReconciliation(
                messages: [], before: nextBefore, retainedPrefix: false,
                duplicateCount: oldDuplicates + newDuplicates
            )
        }

        let authoritativeIDs = authoritativeItemIds.map(Set.init)
        let cut: Int?
        if let authoritativeIDs, !authoritativeIDs.isEmpty {
            cut = oldItems.firstIndex(where: { authoritativeIDs.contains($0.id) })
        } else if authoritativeItemIds != nil {
            cut = nil
        } else {
            let incomingIDs = Set(newItems.map(\.id))
            cut = oldItems.firstIndex(where: { incomingIDs.contains($0.id) })
        }

        guard let cut else {
            return ClientTimelineWindowReconciliation(
                messages: newItems, before: nextBefore, retainedPrefix: false,
                duplicateCount: oldDuplicates + newDuplicates
            )
        }

        var result = Array(oldItems.prefix(cut))
        var positions = Dictionary(uniqueKeysWithValues: result.enumerated().map { ($0.element.id, $0.offset) })
        var crossWindowDuplicates = 0
        for item in newItems {
            if let index = positions[item.id] {
                result[index] = item
                crossWindowDuplicates += 1
            } else {
                positions[item.id] = result.count
                result.append(item)
            }
        }
        return ClientTimelineWindowReconciliation(
            messages: result,
            before: cut > 0 ? existingBefore : nextBefore,
            retainedPrefix: cut > 0,
            duplicateCount: oldDuplicates + newDuplicates + crossWindowDuplicates
        )
    }

    private static func stableUnique(_ items: [ClientMessage]) -> ([ClientMessage], Int) {
        var positions: [String: Int] = [:]
        positions.reserveCapacity(items.count)
        var result: [ClientMessage] = []
        result.reserveCapacity(items.count)
        var duplicates = 0
        for item in items {
            if let index = positions[item.id] {
                result[index] = item
                duplicates += 1
            } else {
                positions[item.id] = result.count
                result.append(item)
            }
        }
        return (result, duplicates)
    }
}
