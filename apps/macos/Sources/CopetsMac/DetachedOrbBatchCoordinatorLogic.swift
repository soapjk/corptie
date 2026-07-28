import CoreGraphics
import Foundation

struct DetachedOrbBatchPriority: Equatable, Sendable {
    let identifier: String
    let currentRisk: Double
}

enum DetachedOrbBatchCoordinatorLogic {
    static func sharedCaptureMaximumDimension(
        sharedSampleRect: CGRect,
        individualSampleRects: [CGRect],
        individualMaximumDimension: Int = 384,
        sharedMaximumDimension: Int = 1_024
    ) -> Int {
        guard !sharedSampleRect.isNull,
              !sharedSampleRect.isEmpty,
              individualMaximumDimension > 0,
              sharedMaximumDimension > 0 else {
            return max(1, min(individualMaximumDimension, sharedMaximumDimension))
        }
        let sharedLongestSide = max(sharedSampleRect.width, sharedSampleRect.height)
        let requiredScale = individualSampleRects.reduce(0.0) { best, rect in
            let longestSide = max(rect.width, rect.height)
            guard longestSide > 0 else {
                return best
            }
            return max(best, CGFloat(individualMaximumDimension) / longestSide)
        }
        let requiredDimension = Int(ceil(sharedLongestSide * requiredScale))
        return max(
            3,
            min(sharedMaximumDimension, max(individualMaximumDimension, requiredDimension))
        )
    }

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
