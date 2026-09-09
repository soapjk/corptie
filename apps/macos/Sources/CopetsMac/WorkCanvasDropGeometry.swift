import Foundation

/// One-shot, axis-aligned minimum translation. Occupied spans are merged before
/// choosing a direction, so a short move into a third card is never accepted.
/// This preserves uninvolved cards; it is not a global repacking algorithm.
enum WorkCanvasDropGeometry {
    static let gap: CGFloat = 12

    static func resolve(_ frames: [String: CGRect], active: String) -> [String: CGRect] {
        guard frames[active] != nil else { return frames }
        var result = frames
        let ids = frames.keys.filter { $0 != active }.sorted {
            let a = frames[$0]!, b = frames[$1]!
            return a.minY == b.minY ? $0 < $1 : a.minY < b.minY
        }
        for id in ids {
            let home = result[id]!
            let obstacles = result.filter { $0.key != id }.map(\.value)
            guard obstacles.contains(where: { conflicts(home, $0) }) else { continue }
            let xs = nearestFreeCoordinates(home.minX, spans: obstacles.compactMap {
                home.minY < $0.maxY + gap && $0.minY < home.maxY + gap
                    ? ($0.minX - home.width - gap, $0.maxX + gap) : nil
            })
            let ys = nearestFreeCoordinates(home.minY, spans: obstacles.compactMap {
                home.minX < $0.maxX + gap && $0.minX < home.maxX + gap
                    ? ($0.minY - home.height - gap, $0.maxY + gap) : nil
            })
            let candidates = xs.map { CGPoint(x: $0, y: home.minY) } + ys.map { CGPoint(x: home.minX, y: $0) }
            let ordered = candidates.sorted {
                let a = hypot($0.x - home.minX, $0.y - home.minY)
                let b = hypot($1.x - home.minX, $1.y - home.minY)
                if a != b { return a < b }
                return $0.y == $1.y ? $0.x < $1.x : $0.y < $1.y
            }
            if let point = ordered.first(where: { point in
                !obstacles.contains { conflicts(CGRect(origin: point, size: home.size), $0) }
            }) {
                result[id] = CGRect(origin: point, size: home.size)
            }
        }
        return result
    }

    private static func nearestFreeCoordinates(_ origin: CGFloat,
                                               spans: [(CGFloat, CGFloat)]) -> [CGFloat] {
        let sorted = spans.sorted { $0.0 == $1.0 ? $0.1 < $1.1 : $0.0 < $1.0 }
        var merged: [(CGFloat, CGFloat)] = []
        for span in sorted {
            if let last = merged.last, span.0 < last.1 {
                merged[merged.count - 1].1 = max(last.1, span.1)
            } else { merged.append(span) }
        }
        // Intervals are open: touching at the requested gap is legal.
        guard let occupied = merged.first(where: { $0.0 < origin && origin < $0.1 }) else { return [origin] }
        return [occupied.0, occupied.1].filter { $0.isFinite }
    }

    static func conflicts(_ a: CGRect, _ b: CGRect) -> Bool {
        a.minX < b.maxX + gap && b.minX < a.maxX + gap &&
        a.minY < b.maxY + gap && b.minY < a.maxY + gap
    }
}
