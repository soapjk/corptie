import Foundation

struct DetachedOrbBatchPriority: Equatable, Sendable {
    let identifier: String
    let currentRisk: Double
}

enum DetachedOrbBatchCoordinatorLogic {
    static func orderedIdentifiers(
        _ priorities: [DetachedOrbBatchPriority]
    ) -> [String] {
        priorities
            .sorted { lhs, rhs in
                if abs(lhs.currentRisk - rhs.currentRisk) > 0.000_001 {
                    return lhs.currentRisk > rhs.currentRisk
                }
                return lhs.identifier < rhs.identifier
            }
            .map(\.identifier)
    }

    static func nextDelay(
        interval: TimeInterval,
        batchDuration: TimeInterval
    ) -> TimeInterval {
        max(0, interval - max(0, batchDuration))
    }
}
