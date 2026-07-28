import CoreGraphics
import Foundation

struct OrbSafeRegionSnapshot: Equatable, Sendable {
    let date: Date
    let frames: [CGRect]
}

struct OrbSafeRegionHistory: Equatable, Sendable {
    var maximumAge: TimeInterval = 30
    var maximumSnapshotCount = 12
    private(set) var snapshots: [OrbSafeRegionSnapshot] = []

    mutating func record(frames: [CGRect], at date: Date = Date()) {
        prune(at: date)
        snapshots.append(
            OrbSafeRegionSnapshot(
                date: date,
                frames: frames.filter { !$0.isNull && !$0.isEmpty }
            )
        )
        if snapshots.count > maximumSnapshotCount {
            snapshots.removeFirst(snapshots.count - maximumSnapshotCount)
        }
    }

    mutating func reset() {
        snapshots.removeAll()
    }

    mutating func prune(at date: Date = Date()) {
        snapshots.removeAll {
            date.timeIntervalSince($0.date) > maximumAge
        }
    }

    func persistenceScore(for frame: CGRect) -> Double {
        guard !frame.isNull, !frame.isEmpty, !snapshots.isEmpty else {
            return 0
        }
        let frameArea = frame.width * frame.height
        guard frameArea > 0 else {
            return 0
        }

        let accumulatedCoverage = snapshots.reduce(0.0) { total, snapshot in
            let bestCoverage = snapshot.frames.reduce(0.0) { best, safeFrame in
                let intersection = frame.intersection(safeFrame)
                guard !intersection.isNull, !intersection.isEmpty else {
                    return best
                }
                let intersectionArea = intersection.width * intersection.height
                return max(best, Double(intersectionArea / frameArea))
            }
            return total + bestCoverage
        }
        return min(1, max(0, accumulatedCoverage / Double(snapshots.count)))
    }
}
