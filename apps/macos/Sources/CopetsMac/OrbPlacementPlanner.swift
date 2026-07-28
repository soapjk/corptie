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
    var searchSeparationWeight = 0.18
    var edgePreferenceWeight = 0.03
    var preferredEdgeDistance: CGFloat = 24
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

struct OrbPlacementDirectionStatistic: Equatable, Sendable {
    let safeCandidateCount: Int
    let minimumRisk: Double?
}

struct OrbPlacementDirectionalDiagnostics: Equatable, Sendable {
    let right: OrbPlacementDirectionStatistic
    let top: OrbPlacementDirectionStatistic
    let left: OrbPlacementDirectionStatistic
    let bottom: OrbPlacementDirectionStatistic
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
        let verticalEdgeSlots = evenlySpacedValues(
            from: visibleFrame.minY,
            through: maximumOriginY,
            count: 6
        )
        let horizontalEdgeSlots = evenlySpacedValues(
            from: visibleFrame.minX,
            through: maximumOriginX,
            count: 6
        )
        for y in verticalEdgeSlots {
            rawCandidates.append(CGPoint(x: maximumOriginX, y: y))
            rawCandidates.append(CGPoint(x: visibleFrame.minX, y: y))
        }
        for x in horizontalEdgeSlots {
            rawCandidates.append(CGPoint(x: x, y: maximumOriginY))
            rawCandidates.append(CGPoint(x: x, y: visibleFrame.minY))
        }

        var seen = Set<String>()
        return rawCandidates
            .map { CGPoint(x: $0.x.rounded(), y: $0.y.rounded()) }
            .filter { origin in
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

        let eligible = eligibleCandidates(input: input, configuration: configuration)
        guard !eligible.isEmpty else {
            return hold(.noSafeCandidate, input: input)
        }

        let edgeCandidates = eligible.filter {
            edgePlacement(
                origin: $0.origin,
                windowSize: input.windowSize,
                visibleFrame: input.visibleFrame
            ).distance <= configuration.preferredEdgeDistance
        }
        let edgePool = edgeCandidates.isEmpty ? eligible : edgeCandidates
        let placements = edgePool.map {
            (
                candidate: $0,
                edge: edgePlacement(
                    origin: $0.origin,
                    windowSize: input.windowSize,
                    visibleFrame: input.visibleFrame
                )
            )
        }
        let preferredPriority = placements.map(\.edge.priority).min() ?? 0
        let directionCandidates = placements
            .filter { $0.edge.priority == preferredPriority }
            .map(\.candidate)
        let maximumOverlapCount =
            directionCandidates.map(\.historicalOverlapCount).max() ?? 0
        let mostPersistentCandidates = maximumOverlapCount > 0
            ? directionCandidates.filter {
                $0.historicalOverlapCount == maximumOverlapCount
            }
            : directionCandidates
        let maximumHistoricalCoverage =
            mostPersistentCandidates.map(\.historicalCoverage).max() ?? 0
        let bestCoveredCandidates = maximumOverlapCount > 0
            ? mostPersistentCandidates.filter {
                abs($0.historicalCoverage - maximumHistoricalCoverage) <= 0.001
            }
            : mostPersistentCandidates
        let selected = bestCoveredCandidates.min { lhs, rhs in
            let lhsEdge = edgePlacement(
                origin: lhs.origin,
                windowSize: input.windowSize,
                visibleFrame: input.visibleFrame
            )
            let rhsEdge = edgePlacement(
                origin: rhs.origin,
                windowSize: input.windowSize,
                visibleFrame: input.visibleFrame
            )
            if abs(lhsEdge.distance - rhsEdge.distance) > 0.5 {
                return lhsEdge.distance < rhsEdge.distance
            }
            if abs(lhs.contentRisk - rhs.contentRisk) > 0.001 {
                return lhs.contentRisk < rhs.contentRisk
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

    static func directionalDiagnostics(
        input: OrbPlacementPlanningInput,
        configuration: OrbPlacementPlannerConfiguration = .init()
    ) -> OrbPlacementDirectionalDiagnostics {
        let edgeCandidates = eligibleCandidates(input: input, configuration: configuration)
            .compactMap { candidate -> (candidate: OrbPlacementCandidate, priority: Int)? in
                let edge = edgePlacement(
                    origin: candidate.origin,
                    windowSize: input.windowSize,
                    visibleFrame: input.visibleFrame
                )
                guard edge.distance <= configuration.preferredEdgeDistance else {
                    return nil
                }
                return (candidate, edge.priority)
            }
        func statistic(priority: Int) -> OrbPlacementDirectionStatistic {
            let candidates = edgeCandidates
                .filter { $0.priority == priority }
                .map(\.candidate)
            return OrbPlacementDirectionStatistic(
                safeCandidateCount: candidates.count,
                minimumRisk: candidates.map(\.contentRisk).min()
            )
        }
        return OrbPlacementDirectionalDiagnostics(
            right: statistic(priority: 0),
            top: statistic(priority: 1),
            left: statistic(priority: 2),
            bottom: statistic(priority: 3)
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

    private static func eligibleCandidates(
        input: OrbPlacementPlanningInput,
        configuration: OrbPlacementPlannerConfiguration
    ) -> [OrbPlacementCandidate] {
        input.candidates.filter { candidate in
            guard candidate.captureConfidence >= configuration.minimumCaptureConfidence,
                  candidate.contentRisk <= configuration.safeRisk,
                  distance(candidate.origin, input.currentOrigin) > 0.5,
                  isValid(
                    origin: candidate.origin,
                    windowSize: input.windowSize,
                    visibleFrame: input.visibleFrame,
                    occupiedFrames: input.occupiedFrames,
                    excludedFrames: input.excludedFrames
                  )
            else {
                return false
            }
            return input.recentAutomaticOrigins.allSatisfy {
                distance(candidate.origin, $0) > configuration.recentPositionExclusionRadius
            }
        }
    }

    private static func placementCost(
        candidate: OrbPlacementCandidate,
        input: OrbPlacementPlanningInput,
        configuration: OrbPlacementPlannerConfiguration
    ) -> Double {
        let normalizedSearchSeparation = min(
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
            - configuration.searchSeparationWeight * normalizedSearchSeparation
            + configuration.edgePreferenceWeight * normalizedEdgeDistance
    }

    private static func edgePlacement(
        origin: CGPoint,
        windowSize: CGSize,
        visibleFrame: CGRect
    ) -> (priority: Int, distance: CGFloat) {
        let frame = CGRect(origin: origin, size: windowSize)
        let distances = [
            max(0, visibleFrame.maxX - frame.maxX), // right
            max(0, visibleFrame.maxY - frame.maxY), // top
            max(0, frame.minX - visibleFrame.minX), // left
            max(0, frame.minY - visibleFrame.minY) // bottom
        ]
        let priority = distances.indices.min {
            if abs(distances[$0] - distances[$1]) <= 0.5 {
                return $0 < $1
            }
            return distances[$0] < distances[$1]
        } ?? 0
        return (priority, distances[priority])
    }

    private static func evenlySpacedValues(
        from minimum: CGFloat,
        through maximum: CGFloat,
        count: Int
    ) -> [CGFloat] {
        guard count > 1, maximum > minimum else {
            return [minimum]
        }
        let step = (maximum - minimum) / CGFloat(count - 1)
        return (0..<count).map { minimum + CGFloat($0) * step }
    }

    private static func distance(_ lhs: CGPoint, _ rhs: CGPoint) -> CGFloat {
        hypot(lhs.x - rhs.x, lhs.y - rhs.y)
    }
}
