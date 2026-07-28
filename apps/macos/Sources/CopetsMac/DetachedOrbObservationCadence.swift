import Foundation

struct DetachedOrbObservationCadence: Equatable, Sendable {
    private(set) var consecutiveSafeObservations = 0
    var activeInterval: TimeInterval = 2
    var maximumSafeInterval: TimeInterval = 6

    mutating func nextDelay(after reason: OrbPlacementHoldReason) -> TimeInterval {
        switch reason {
        case .awaitingConfirmation:
            consecutiveSafeObservations = 0
            return 0.65
        case .currentPositionIsSafe:
            consecutiveSafeObservations += 1
            return min(
                maximumSafeInterval,
                activeInterval * Double(consecutiveSafeObservations)
            )
        case .interactionFrozen,
             .cooldown,
             .lowCaptureConfidence,
             .noSafeCandidate,
             .insufficientImprovement:
            consecutiveSafeObservations = 0
            return activeInterval
        }
    }

    mutating func reset() {
        consecutiveSafeObservations = 0
    }
}
