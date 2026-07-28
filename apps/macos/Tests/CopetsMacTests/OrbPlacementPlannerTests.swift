import CoreGraphics
import XCTest
@testable import CorptieMac

final class OrbPlacementPlannerTests: XCTestCase {
    private let screen = CGRect(x: 0, y: 0, width: 1_440, height: 900)
    private let orbSize = CGSize(width: 88, height: 88)
    private let current = CGPoint(x: 1_000, y: 600)

    func testCandidateGenerationIsNearToFarAndInsideVisibleFrame() {
        let candidates = OrbPlacementPlanner.candidateOrigins(
            currentOrigin: current,
            userAnchor: current,
            windowSize: orbSize,
            visibleFrame: screen
        )

        XCTAssertEqual(candidates.first, current)
        XCTAssertTrue(candidates.allSatisfy {
            screen.contains(CGRect(origin: $0, size: orbSize))
        })
        let distances = candidates.map { hypot($0.x - current.x, $0.y - current.y) }
        XCTAssertEqual(distances, distances.sorted())
        XCTAssertGreaterThan(distances.max() ?? 0, 300)
        XCTAssertLessThanOrEqual(
            candidates.count,
            38,
            "A single orb should use a sparse search grid, not over 100 overlapping masks"
        )
    }

    func testGenerationFiltersOccupiedAndAccessoryFrames() {
        let occupied = CGRect(x: 1_020, y: 580, width: 120, height: 120)
        let accessory = CGRect(x: 880, y: 570, width: 100, height: 180)
        let candidates = OrbPlacementPlanner.candidateOrigins(
            currentOrigin: current,
            userAnchor: current,
            windowSize: orbSize,
            visibleFrame: screen,
            occupiedFrames: [occupied],
            excludedFrames: [accessory]
        )

        XCTAssertTrue(candidates.allSatisfy {
            let frame = CGRect(origin: $0, size: orbSize)
            return !frame.intersects(occupied) && !frame.intersects(accessory)
        })
    }

    func testGenerationIncludesAllScreenEdgesBeyondTheRingRadius() {
        let candidates = OrbPlacementPlanner.candidateOrigins(
            currentOrigin: current,
            userAnchor: current,
            windowSize: orbSize,
            visibleFrame: screen
        )

        XCTAssertTrue(candidates.contains(CGPoint(x: screen.minX, y: current.y)))
        XCTAssertTrue(candidates.contains(
            CGPoint(x: screen.maxX - orbSize.width, y: current.y)
        ))
        XCTAssertTrue(candidates.contains(CGPoint(x: current.x, y: screen.minY)))
        XCTAssertTrue(candidates.contains(
            CGPoint(x: current.x, y: screen.maxY - orbSize.height)
        ))
    }

    func testSingleBatchSelectsSafestCandidateWithoutIndependentConfirmation() {
        let nearest = CGPoint(x: 952, y: 600)
        let farther = CGPoint(x: 880, y: 600)
        let input = makeInput(candidates: [
            candidate(farther, risk: 0.01),
            candidate(nearest, risk: 0.18)
        ])

        let plan = OrbPlacementPlanner.plan(input: input)

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected a move, got \(plan)")
        }
        XCTAssertEqual(proposal.origin, farther)
        XCTAssertEqual(plan.userAnchor, current)
    }

    func testInitialPlanPrefersFartherCandidateAmongSimilarlySafePositions() {
        let nearby = CGPoint(x: 952, y: 600)
        let farAway = CGPoint(x: 680, y: 600)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(candidates: [
                candidate(nearby, risk: 0.02),
                candidate(farAway, risk: 0.04)
            ])
        )

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected an immediate batch move")
        }
        XCTAssertEqual(proposal.origin, farAway)
    }

    func testMeaningfullyCleanerCandidateWinsEvenWhenItIsCloser() {
        let nearby = CGPoint(x: 952, y: 600)
        let farAway = CGPoint(x: 680, y: 600)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(candidates: [
                candidate(nearby, risk: 0.01),
                candidate(farAway, risk: 0.08)
            ])
        )

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected an immediate batch move")
        }
        XCTAssertEqual(proposal.origin, nearby)
    }

    func testHistoricallySafeCandidateWinsBeforeDistanceWhenRiskIsSimilar() {
        let persistentNearby = CGPoint(x: 904, y: 600)
        let transientFarAway = CGPoint(x: 680, y: 600)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(candidates: [
                candidate(persistentNearby, risk: 0.04, overlapCount: 8),
                candidate(transientFarAway, risk: 0.02, overlapCount: 2)
            ])
        )

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected an immediate batch move")
        }
        XCTAssertEqual(proposal.origin, persistentNearby)
    }

    func testScreenEdgePreferenceUsesRightThenTopThenLeftThenBottom() {
        let right = CGPoint(x: screen.maxX - orbSize.width, y: 400)
        let top = CGPoint(x: 700, y: screen.maxY - orbSize.height)
        let left = CGPoint(x: screen.minX, y: 400)
        let bottom = CGPoint(x: 700, y: screen.minY)
        let cases: [([CGPoint], CGPoint)] = [
            ([bottom, left, top, right], right),
            ([bottom, left, top], top),
            ([bottom, left], left),
            ([bottom], bottom)
        ]

        for (origins, expected) in cases {
            let plan = OrbPlacementPlanner.plan(
                input: makeInput(
                    candidates: origins.map { candidate($0, risk: 0.04) }
                )
            )
            guard case let .move(proposal) = plan.action else {
                return XCTFail("Expected an edge move for \(origins)")
            }
            XCTAssertEqual(proposal.origin, expected)
        }
    }

    func testMeaningfullySaferEdgeWinsBeforeDirectionalPreference() {
        let right = CGPoint(x: screen.maxX - orbSize.width, y: 400)
        let top = CGPoint(x: 700, y: screen.maxY - orbSize.height)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(candidates: [
                candidate(right, risk: 0.08),
                candidate(top, risk: 0.01)
            ])
        )

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected an edge move")
        }
        XCTAssertEqual(proposal.origin, top)
    }

    func testHighestOverlapCountWinsEvenWhenAnotherSafeRegionHasLowerRisk() {
        let persistent = CGPoint(x: 904, y: 600)
        let transient = CGPoint(x: 680, y: 600)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(candidates: [
                candidate(persistent, risk: 0.16, overlapCount: 9),
                candidate(transient, risk: 0.01, overlapCount: 3)
            ])
        )

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected an immediate batch move")
        }
        XCTAssertEqual(proposal.origin, persistent)
    }

    func testObservedModerateTextRiskCanMoveToClearlySaferCandidate() {
        let target = CGPoint(x: 952, y: 600)
        let input = makeInput(
            currentRisk: 0.283,
            candidates: [candidate(target, risk: 0.15)]
        )

        guard case let .move(proposal) = OrbPlacementPlanner.plan(input: input).action else {
            return XCTFail("Expected observed moderate content risk to trigger avoidance")
        }
        XCTAssertEqual(proposal.origin, target)
    }

    func testFirstMatchingEvaluationMovesInTheCurrentBatch() {
        let target = CGPoint(x: 952, y: 600)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(candidates: [candidate(target, risk: 0.1)])
        )

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected an immediate batch move")
        }
        XCTAssertEqual(proposal.origin, target)
    }

    func testCurrentBatchUsesNewlySaferCandidate() {
        let previousCandidate = CGPoint(x: 952, y: 600)
        let newlyCheaper = CGPoint(x: 976, y: 642)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(
                currentRisk: 0.55,
                candidates: [
                    candidate(previousCandidate, risk: 0.12),
                    candidate(newlyCheaper, risk: 0.02)
                ]
            )
        )

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected the safest current candidate")
        }
        XCTAssertEqual(proposal.origin, newlyCheaper)
    }

    func testUnsafeCandidateIsRejectedForSafeReplacement() {
        let unsafe = CGPoint(x: 952, y: 600)
        let replacement = CGPoint(x: 976, y: 642)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(
                currentRisk: 0.55,
                candidates: [
                    candidate(unsafe, risk: 0.24),
                    candidate(replacement, risk: 0.04)
                ]
            )
        )

        guard case let .move(proposal) = plan.action else {
            return XCTFail("Expected an immediate safe replacement")
        }
        XCTAssertEqual(proposal.origin, replacement)
    }

    func testNoSafeCandidateKeepsCurrentPosition() {
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(candidates: [
                candidate(CGPoint(x: 952, y: 600), risk: 0.3)
            ])
        )

        XCTAssertEqual(plan.action, .hold(.noSafeCandidate))
    }

    func testInsufficientImprovementKeepsCurrentPosition() {
        let input = makeInput(
            currentRisk: 0.43,
            candidates: [candidate(CGPoint(x: 952, y: 600), risk: 0.17)]
        )
        var configuration = OrbPlacementPlannerConfiguration()
        configuration.minimumImprovement = 0.30

        XCTAssertEqual(
            OrbPlacementPlanner.plan(input: input, configuration: configuration).action,
            .hold(.insufficientImprovement)
        )
    }

    func testLowCurrentRiskAndLowConfidenceKeepCurrentPosition() {
        XCTAssertEqual(
            OrbPlacementPlanner.plan(
                input: makeInput(currentRisk: 0.2, candidates: [])
            ).action,
            .hold(.currentPositionIsSafe)
        )
        XCTAssertEqual(
            OrbPlacementPlanner.plan(
                input: makeInput(
                    currentConfidence: 0.4,
                    candidates: [candidate(CGPoint(x: 952, y: 600), risk: 0.1)]
                )
            ).action,
            .hold(.lowCaptureConfidence)
        )
    }

    func testInteractionAndCooldownTakePriority() {
        XCTAssertEqual(
            OrbPlacementPlanner.plan(
                input: makeInput(candidates: [], interactionFrozen: true)
            ).action,
            .hold(.interactionFrozen)
        )
        XCTAssertEqual(
            OrbPlacementPlanner.plan(
                input: makeInput(candidates: [], cooldownActive: true)
            ).action,
            .hold(.cooldown)
        )
    }

    func testRecentPositionHistoryPreventsOscillation() {
        let previous = CGPoint(x: 952, y: 600)
        let alternative = CGPoint(x: 1_000, y: 528)
        let input = makeInput(
            candidates: [
                candidate(previous, risk: 0.05),
                candidate(alternative, risk: 0.10)
            ],
            recentOrigins: [previous]
        )

        guard case let .move(proposal) = OrbPlacementPlanner.plan(input: input).action else {
            return XCTFail("Expected the non-historical candidate")
        }
        XCTAssertEqual(proposal.origin, alternative)
    }

    func testNegativeCoordinateDisplayDoesNotCrossToPrimaryDisplay() {
        let secondary = CGRect(x: -1_920, y: 120, width: 1_920, height: 1_080)
        let anchor = CGPoint(x: -120, y: 900)
        let candidates = OrbPlacementPlanner.candidateOrigins(
            currentOrigin: anchor,
            userAnchor: anchor,
            windowSize: orbSize,
            visibleFrame: secondary
        )

        XCTAssertFalse(candidates.isEmpty)
        XCTAssertTrue(candidates.allSatisfy {
            secondary.contains(CGRect(origin: $0, size: orbSize))
                && $0.x + orbSize.width <= 0
        })
    }

    func testInvalidCrossScreenAndOverlappingEvaluationsAreRejected() {
        let overlapping = CGRect(x: 900, y: 580, width: 100, height: 100)
        let input = makeInput(
            candidates: [
                candidate(CGPoint(x: 1_400, y: 600), risk: 0.01),
                candidate(CGPoint(x: 920, y: 600), risk: 0.01)
            ],
            occupiedFrames: [overlapping]
        )

        XCTAssertEqual(OrbPlacementPlanner.plan(input: input).action, .hold(.noSafeCandidate))
    }

    func testOccupiedNearestCandidateSelectsNextSafePositionForMultipleOrbs() {
        let occupiedOrigin = CGPoint(x: 952, y: 600)
        let safeOrigin = CGPoint(x: 1_000, y: 500)
        let input = makeInput(
            candidates: [
                candidate(occupiedOrigin, risk: 0.05),
                candidate(safeOrigin, risk: 0.10)
            ],
            occupiedFrames: [CGRect(origin: occupiedOrigin, size: orbSize)]
        )

        guard case let .move(proposal) = OrbPlacementPlanner.plan(input: input).action else {
            return XCTFail("Expected the next non-overlapping candidate")
        }
        XCTAssertEqual(proposal.origin, safeOrigin)
    }

    func testAutomaticPlanNeverChangesUserAnchor() {
        let anchor = CGPoint(x: 980, y: 620)
        let target = CGPoint(x: 940, y: 620)
        let plan = OrbPlacementPlanner.plan(
            input: makeInput(
                userAnchor: anchor,
                candidates: [candidate(target, risk: 0.1)]
            )
        )

        XCTAssertEqual(plan.userAnchor, anchor)
    }

    private func candidate(
        _ origin: CGPoint,
        risk: Double,
        overlapCount: Int = 0,
        historicalCoverage: Double = 0
    ) -> OrbPlacementCandidate {
        OrbPlacementCandidate(
            origin: origin,
            contentRisk: risk,
            captureConfidence: 1,
            historicalOverlapCount: overlapCount,
            historicalCoverage: historicalCoverage
        )
    }

    private func makeInput(
        userAnchor: CGPoint? = nil,
        currentRisk: Double = 0.8,
        currentConfidence: Double = 1,
        candidates: [OrbPlacementCandidate],
        occupiedFrames: [CGRect] = [],
        recentOrigins: [CGPoint] = [],
        interactionFrozen: Bool = false,
        cooldownActive: Bool = false
    ) -> OrbPlacementPlanningInput {
        OrbPlacementPlanningInput(
            currentOrigin: current,
            userAnchor: userAnchor ?? current,
            windowSize: orbSize,
            visibleFrame: screen,
            occupiedFrames: occupiedFrames,
            excludedFrames: [],
            currentRisk: currentRisk,
            currentCaptureConfidence: currentConfidence,
            candidates: candidates,
            recentAutomaticOrigins: recentOrigins,
            interactionFrozen: interactionFrozen,
            cooldownActive: cooldownActive
        )
    }
}
