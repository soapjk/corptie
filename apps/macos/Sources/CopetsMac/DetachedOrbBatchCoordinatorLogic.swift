import CoreGraphics
import Foundation

struct DetachedOrbBatchPriority: Equatable, Sendable {
    let identifier: String
    let currentRisk: Double
}

enum DetachedOrbBatchOutcome: Equatable, Sendable {
    case active
    case stable
    case captureFailure
    case idle
}

struct DetachedOrbObservationCadence: Equatable, Sendable {
    var activeInterval: TimeInterval = 2
    var stableInterval: TimeInterval = 5
    var stableBatchesBeforeBackoff = 3
    var initialFailureInterval: TimeInterval = 5
    var maximumFailureInterval: TimeInterval = 20

    private(set) var consecutiveStableBatches = 0
    private(set) var consecutiveCaptureFailures = 0

    mutating func nextInterval(after outcome: DetachedOrbBatchOutcome) -> TimeInterval {
        switch outcome {
        case .active:
            consecutiveStableBatches = 0
            consecutiveCaptureFailures = 0
            return activeInterval
        case .stable:
            consecutiveCaptureFailures = 0
            consecutiveStableBatches += 1
            return consecutiveStableBatches >= stableBatchesBeforeBackoff
                ? stableInterval
                : activeInterval
        case .captureFailure:
            consecutiveStableBatches = 0
            consecutiveCaptureFailures += 1
            let multiplier = pow(2, Double(max(0, consecutiveCaptureFailures - 1)))
            return min(maximumFailureInterval, initialFailureInterval * multiplier)
        case .idle:
            consecutiveStableBatches = 0
            consecutiveCaptureFailures = 0
            return stableInterval
        }
    }
}

enum DetachedOrbBatchCoordinatorLogic {
    static func canCommitBatch(
        evaluatedCount: Int,
        expectedCount: Int,
        hasIncompleteEvaluation: Bool
    ) -> Bool {
        !hasIncompleteEvaluation
            && expectedCount > 0
            && evaluatedCount == expectedCount
    }

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
