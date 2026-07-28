import CoreGraphics
import Foundation

struct OrbTrackedSafeRegion: Equatable, Sendable {
    let frame: CGRect
    let overlapCount: Int
    let lastObservedAt: Date
}

struct OrbSafeRegionMatch: Equatable, Sendable {
    let overlapCount: Int
    let coverage: Double

    static let none = OrbSafeRegionMatch(overlapCount: 0, coverage: 0)
}

struct OrbSafeRegionHistory: Equatable, Sendable {
    private struct FrameKey: Hashable {
        let minX: Int64
        let minY: Int64
        let width: Int64
        let height: Int64
    }

    var maximumAge: TimeInterval = 30
    var maximumRegionCount = 10
    private(set) var regions: [OrbTrackedSafeRegion] = []

    mutating func record(frames: [CGRect], at date: Date = Date()) {
        prune(at: date)
        let latestFrames = deduplicatedValidFrames(frames)
        guard maximumRegionCount > 0, !latestFrames.isEmpty else {
            regions.removeAll()
            return
        }

        var nextRegions: [OrbTrackedSafeRegion] = []
        nextRegions.reserveCapacity(regions.count * min(latestFrames.count, maximumRegionCount))
        var latestFrameHasHistoricalOverlap = Array(
            repeating: false,
            count: latestFrames.count
        )

        for historicalRegion in regions {
            for (latestIndex, latestFrame) in latestFrames.enumerated() {
                let intersection = historicalRegion.frame.intersection(latestFrame)
                guard !intersection.isNull, !intersection.isEmpty else {
                    continue
                }
                latestFrameHasHistoricalOverlap[latestIndex] = true
                nextRegions.append(
                    OrbTrackedSafeRegion(
                        frame: intersection,
                        overlapCount: historicalRegion.overlapCount + 1,
                        lastObservedAt: date
                    )
                )
            }
        }

        nextRegions.append(contentsOf: latestFrames.enumerated().compactMap { index, frame in
            guard !latestFrameHasHistoricalOverlap[index] else {
                return nil
            }
            return OrbTrackedSafeRegion(
                frame: frame,
                overlapCount: 1,
                lastObservedAt: date
            )
        })
        regions = compacted(nextRegions)
    }

    mutating func reset() {
        regions.removeAll()
    }

    mutating func prune(at date: Date = Date()) {
        regions.removeAll {
            date.timeIntervalSince($0.lastObservedAt) > maximumAge
        }
    }

    func match(for frame: CGRect) -> OrbSafeRegionMatch {
        guard !frame.isNull, !frame.isEmpty else {
            return .none
        }
        let frameArea = frame.width * frame.height
        guard frameArea > 0 else {
            return .none
        }

        return regions.reduce(.none) { best, region in
            let intersection = frame.intersection(region.frame)
            guard !intersection.isNull, !intersection.isEmpty else {
                return best
            }
            let coverage = min(
                1,
                max(0, Double(intersection.width * intersection.height / frameArea))
            )
            let candidate = OrbSafeRegionMatch(
                overlapCount: region.overlapCount,
                coverage: coverage
            )
            if candidate.overlapCount != best.overlapCount {
                return candidate.overlapCount > best.overlapCount ? candidate : best
            }
            return candidate.coverage > best.coverage ? candidate : best
        }
    }

    private func deduplicatedValidFrames(_ frames: [CGRect]) -> [CGRect] {
        var seen = Set<FrameKey>()
        return frames.filter { frame in
            guard !frame.isNull, !frame.isEmpty else {
                return false
            }
            return seen.insert(Self.frameKey(frame)).inserted
        }
    }

    private func compacted(_ candidates: [OrbTrackedSafeRegion]) -> [OrbTrackedSafeRegion] {
        var bestByFrame: [FrameKey: (region: OrbTrackedSafeRegion, order: Int)] = [:]
        for (order, candidate) in candidates.enumerated() {
            let identifier = Self.frameKey(candidate.frame)
            guard let existing = bestByFrame[identifier] else {
                bestByFrame[identifier] = (candidate, order)
                continue
            }
            if candidate.overlapCount > existing.region.overlapCount {
                bestByFrame[identifier] = (candidate, existing.order)
            }
        }
        return bestByFrame.values
            .sorted { lhs, rhs in
                if lhs.region.overlapCount != rhs.region.overlapCount {
                    return lhs.region.overlapCount > rhs.region.overlapCount
                }
                let lhsArea = lhs.region.frame.width * lhs.region.frame.height
                let rhsArea = rhs.region.frame.width * rhs.region.frame.height
                if lhsArea != rhsArea {
                    return lhsArea > rhsArea
                }
                return lhs.order < rhs.order
            }
            .prefix(maximumRegionCount)
            .map(\.region)
    }

    private static func frameKey(_ frame: CGRect) -> FrameKey {
        FrameKey(
            minX: Int64((frame.minX * 1_000).rounded()),
            minY: Int64((frame.minY * 1_000).rounded()),
            width: Int64((frame.width * 1_000).rounded()),
            height: Int64((frame.height * 1_000).rounded())
        )
    }
}
