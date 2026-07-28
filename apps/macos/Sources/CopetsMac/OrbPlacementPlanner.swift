import CoreGraphics
import Foundation

struct OrbPlacementCandidate: Equatable, Sendable {
    let origin: CGPoint
    let contentRisk: Double
    let captureConfidence: Double
    let historicalOverlapCount: Int
    let historicalCoverage: Double
}

struct OrbPlacementPlannerConfiguration: Equatable, Sendable {
    var searchRadii: [CGFloat] = [96, 192, 288, 360]
    var directionsPerRing = 8
    var maximumRadius: CGFloat = 360
    var triggerRisk = 0.26
    var safeRisk = 0.18
    var minimumImprovement = 0.08
    var minimumCaptureConfidence = 0.8
    var recentPositionExclusionRadius: CGFloat = 16
    var safestRiskTolerance = 0.025
    var anchorSeparationWeight = 0.18
    var edgePreferenceWeight = 0.03
}

struct OrbPlacementPlanningInput: Equatable, Sendable {
    let currentOrigin: CGPoint
    let userAnchor: CGPoint
    let windowSize: CGSize
    let visibleFrame: CGRect
    let occupiedFrames: [CGRect]
    let excludedFrames: [CGRect]
    let currentRisk: Double
    let currentCaptureConfidence: Double
    let candidates: [OrbPlacementCandidate]
    let recentAutomaticOrigins: [CGPoint]
    let interactionFrozen: Bool
    let cooldownActive: Bool
}

enum OrbPlacementHoldReason: Equatable, Sendable {
    case interactionFrozen
    case cooldown
    case lowCaptureConfidence
    case currentPositionIsSafe
    case noSafeCandidate
    case insufficientImprovement
}

struct OrbPlacementProposal: Equatable, Sendable {
    let origin: CGPoint
    let contentRisk: Double
    let placementCost: Double
}

enum OrbPlacementAction: Equatable, Sendable {
    case hold(OrbPlacementHoldReason)
    case move(OrbPlacementProposal)
}

struct OrbPlacementPlan: Equatable, Sendable {
    let action: OrbPlacementAction
    let userAnchor: CGPoint
}

enum OrbPlacementPlanner {
    static func candidateOrigins(
        currentOrigin: CGPoint,
        userAnchor: CGPoint,
        windowSize: CGSize,
        visibleFrame: CGRect,
        occupiedFrames: [CGRect] = [],
        excludedFrames: [CGRect] = [],
        configuration: OrbPlacementPlannerConfiguration = .init()
    ) -> [CGPoint] {
        guard windowSize.width > 0,
              windowSize.height > 0,
              configuration.maximumRadius > 0,
              configuration.directionsPerRing > 0 else {
            return []
        }

        var rawCandidates = [currentOrigin, userAnchor]
        for radius in configuration.searchRadii
        where radius > 0 && radius <= configuration.maximumRadius {
            for direction in 0..<configuration.directionsPerRing {
                let angle = Double(direction) * 2 * Double.pi
                    / Double(configuration.directionsPerRing)
                rawCandidates.append(
                    CGPoint(
                        x: userAnchor.x + radius * CGFloat(cos(angle)),
                        y: userAnchor.y + radius * CGFloat(sin(angle))
                    )
                )
            }
        }

        let maximumOriginX = visibleFrame.maxX - windowSize.width
        let maximumOriginY = visibleFrame.maxY - windowSize.height
        rawCandidates.append(contentsOf: [
            CGPoint(x: visibleFrame.minX, y: userAnchor.y),
            CGPoint(x: maximumOriginX, y: userAnchor.y),
            CGPoint(x: userAnchor.x, y: visibleFrame.minY),
            CGPoint(x: userAnchor.x, y: maximumOriginY)
        ])

        var seen = Set<String>()
        return rawCandidates
            .map { CGPoint(x: $0.x.rounded(), y: $0.y.rounded()) }
            .filter { origin in
                guard distance(origin, userAnchor) <= configuration.maximumRadius + 0.5 else {
                    return false
                }
                let frame = CGRect(origin: origin, size: windowSize)
                guard visibleFrame.contains(frame),
                      occupiedFrames.allSatisfy({ !$0.intersects(frame) }),
                      excludedFrames.allSatisfy({ !$0.intersects(frame) }) else {
                    return false
                }
                return seen.insert("\(origin.x),\(origin.y)").inserted
            }
            .sorted { lhs, rhs in
                let lhsDistance = distance(lhs, currentOrigin)
                let rhsDistance = distance(rhs, currentOrigin)
                if abs(lhsDistance - rhsDistance) > 0.001 {
                    return lhsDistance < rhsDistance
                }
                if lhs.y != rhs.y {
                    return lhs.y > rhs.y
                }
                return lhs.x < rhs.x
            }
    }

    static func plan(
        input: OrbPlacementPlanningInput,
        configuration: OrbPlacementPlannerConfiguration = .init()
    ) -> OrbPlacementPlan {
        if input.interactionFrozen {
            return hold(.interactionFrozen, input: input)
        }
        if input.cooldownActive {
            return hold(.cooldown, input: input)
        }
        guard input.currentCaptureConfidence >= configuration.minimumCaptureConfidence else {
            return hold(.lowCaptureConfidence, input: input)
        }
        guard input.currentRisk >= configuration.triggerRisk else {
            return hold(.currentPositionIsSafe, input: input)
        }

        let eligible = input.candidates.filter { candidate in
            guard candidate.captureConfidence >= configuration.minimumCaptureConfidence,
                  candidate.contentRisk <= configuration.safeRisk,
                  distance(candidate.origin, input.currentOrigin) > 0.5,
                  isValid(
                    origin: candidate.origin,
                    windowSize: input.windowSize,
                    visibleFrame: input.visibleFrame,
                    occupiedFrames: input.occupiedFrames,
                    excludedFrames: input.excludedFrames
                  ),
                  distance(candidate.origin, input.userAnchor) <= configuration.maximumRadius + 0.5
            else {
                return false
            }
            return input.recentAutomaticOrigins.allSatisfy {
                distance(candidate.origin, $0) > configuration.recentPositionExclusionRadius
            }
        }
        guard !eligible.isEmpty else {
            return hold(.noSafeCandidate, input: input)
        }

        let maximumOverlapCount = eligible.map(\.historicalOverlapCount).max() ?? 0
        let mostPersistentCandidates = maximumOverlapCount > 0
            ? eligible.filter { $0.historicalOverlapCount == maximumOverlapCount }
            : eligible
        let maximumHistoricalCoverage =
            mostPersistentCandidates.map(\.historicalCoverage).max() ?? 0
        let bestCoveredCandidates = maximumOverlapCount > 0
            ? mostPersistentCandidates.filter {
                abs($0.historicalCoverage - maximumHistoricalCoverage) <= 0.001
            }
            : mostPersistentCandidates

        let minimumRisk = bestCoveredCandidates.map(\.contentRisk).min() ?? 0
        let safestCandidates = bestCoveredCandidates.filter {
            $0.contentRisk <= minimumRisk + configuration.safestRiskTolerance
        }
        let selected = safestCandidates.min { lhs, rhs in
            let lhsSeparation = distance(lhs.origin, input.userAnchor)
            let rhsSeparation = distance(rhs.origin, input.userAnchor)
            if abs(lhsSeparation - rhsSeparation) > 0.5 {
                return lhsSeparation > rhsSeparation
            }
            return placementCost(candidate: lhs, input: input, configuration: configuration)
                < placementCost(candidate: rhs, input: input, configuration: configuration)
        }!

        guard input.currentRisk - selected.contentRisk >= configuration.minimumImprovement else {
            return hold(.insufficientImprovement, input: input)
        }

        let proposal = OrbPlacementProposal(
            origin: selected.origin,
            contentRisk: selected.contentRisk,
            placementCost: placementCost(
                candidate: selected,
                input: input,
                configuration: configuration
            )
        )
        return OrbPlacementPlan(
            action: .move(proposal),
            userAnchor: input.userAnchor
        )
    }

    private static func hold(
        _ reason: OrbPlacementHoldReason,
        input: OrbPlacementPlanningInput
    ) -> OrbPlacementPlan {
        OrbPlacementPlan(
            action: .hold(reason),
            userAnchor: input.userAnchor
        )
    }

    private static func isValid(
        origin: CGPoint,
        windowSize: CGSize,
        visibleFrame: CGRect,
        occupiedFrames: [CGRect],
        excludedFrames: [CGRect]
    ) -> Bool {
        let frame = CGRect(origin: origin, size: windowSize)
        return visibleFrame.contains(frame)
            && occupiedFrames.allSatisfy { !$0.intersects(frame) }
            && excludedFrames.allSatisfy { !$0.intersects(frame) }
    }

    private static func placementCost(
        candidate: OrbPlacementCandidate,
        input: OrbPlacementPlanningInput,
        configuration: OrbPlacementPlannerConfiguration
    ) -> Double {
        let normalizedAnchorSeparation = min(
            1,
            Double(distance(candidate.origin, input.userAnchor) / configuration.maximumRadius)
        )
        let frame = CGRect(origin: candidate.origin, size: input.windowSize)
        let edgeDistance = min(
            frame.minX - input.visibleFrame.minX,
            input.visibleFrame.maxX - frame.maxX,
            frame.minY - input.visibleFrame.minY,
            input.visibleFrame.maxY - frame.maxY
        )
        let normalizedEdgeDistance = min(
            1,
            max(0, Double(edgeDistance / max(1, configuration.maximumRadius)))
        )
        return candidate.contentRisk
            - configuration.anchorSeparationWeight * normalizedAnchorSeparation
            + configuration.edgePreferenceWeight * normalizedEdgeDistance
    }

    private static func distance(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }
}
