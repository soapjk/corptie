import Foundation
import RectanglePacking

/// Reuse the existing native MaxRects bridge, reserving the dropped card first.
/// Translate the packing origin, rather than rounding the user's world coordinate.
/// Runs only on entry/drop; no physics, text reads or per-frame measurement.
enum WorkCanvasClusterGeometry {
    static let nativePackingLimit = 256
    /// World-space density is content-driven, never a viewport-width constraint.
    static func packingWidth(_ frames: [String: CGRect], active: String) -> CGFloat {
        guard let anchor = frames[active] else { return 1 }
        let gap = WorkCanvasDropGeometry.gap
        let largest = frames.values.map { ceil($0.width) }.max() ?? 1
        let neighbour = frames.filter { $0.key != active }.values.map { ceil($0.width) }.max()
        let pairWidth = neighbour.map { ceil(anchor.width) + gap + $0 } ?? largest
        let area = frames.values.reduce(CGFloat(0)) { $0 + (ceil($1.width) + gap) * (ceil($1.height) + gap) }
        let rowWidth = frames.values.reduce(CGFloat(0)) { $0 + ceil($1.width) + gap } - gap
        let densityWidth = area.isFinite ? sqrt(area) * sqrt(1.25) : largest
        return ceil(min(rowWidth, max(largest, pairWidth, densityWidth)))
    }

    static func resolve(_ frames: [String: CGRect], active: String,
                        width _: CGFloat, order: [String] = []) -> [String: CGRect] {
        guard let anchor = frames[active], frames.values.allSatisfy({
            $0.minX.isFinite && $0.minY.isFinite && $0.width.isFinite && $0.height.isFinite &&
                $0.width > 0 && $0.height > 0
        }) else { return frames }
        var seen = Set<String>()
        let ids = (order + frames.keys.sorted()).filter { frames[$0] != nil && seen.insert($0).inserted }
        let stripWidth = packingWidth(frames, active: active)
        let centredX = floor((stripWidth - ceil(anchor.width)) / 2)
        let neighbour = frames.filter { $0.key != active }.values.map { ceil($0.width) }.max() ?? 0
        // Give the space beside the anchor full usable columns, not two
        // half-columns. This only translates the bin; its world point is fixed.
        let slot = neighbour + WorkCanvasDropGeometry.gap
        let localX = neighbour > 0 ? floor(centredX / slot) * slot : 0
        let origin = CGPoint(x: anchor.minX - localX, y: anchor.minY)
        let gap = WorkCanvasDropGeometry.gap
        if stripWidth + gap <= 32768, ids.count <= nativePackingLimit,
           ids.allSatisfy({ frames[$0]!.height + gap <= 1_000_000 }),
           let pinnedIndex = ids.firstIndex(of: active) {
            let input = ids.map { id -> CorptiePackedRect in
                let rect = frames[id]!
                return CorptiePackedRect(x: id == active ? Int32(localX) : -1,
                    y: id == active ? 0 : -1,
                    width: Int32(ceil(rect.width) + gap), height: Int32(ceil(rect.height) + gap))
            }
            var output = Array(repeating: CorptiePackedRect(), count: ids.count)
            let success = input.withUnsafeBufferPointer { source in
                output.withUnsafeMutableBufferPointer {
                    corptie_pack_rectangles(Int32(stripWidth + gap), source.baseAddress,
                        Int32(ids.count), Int32(pinnedIndex), $0.baseAddress) == 1
                }
            }
            if success {
                var result = Dictionary(uniqueKeysWithValues: zip(ids, output).map { id, rect in
                    (id, CGRect(x: origin.x + CGFloat(rect.x), y: origin.y + CGFloat(rect.y),
                                width: frames[id]!.width, height: frames[id]!.height))
                })
                result[active] = anchor
                // Mirroring has identical compactness and spacing. Prefer the
                // orientation with less total travel; ties keep native order.
                let mirrored = result.mapValues { rect in
                    CGRect(x: 2 * anchor.midX - rect.maxX, y: rect.minY,
                           width: rect.width, height: rect.height)
                }.merging([active: anchor], uniquingKeysWith: { _, pinned in pinned })
                func travel(_ candidate: [String: CGRect]) -> CGFloat {
                    ids.reduce(0) { total, id in
                        total + hypot(candidate[id]!.midX - frames[id]!.midX,
                                      candidate[id]!.midY - frames[id]!.midY)
                    }
                }
                return travel(mirrored) < travel(result) ? mirrored : result
            }
        }
        // Extreme inventories/native rejection: bounded linear shelf fallback.
        var result = [active: anchor]
        var x = origin.x, y = anchor.maxY + gap, rowHeight: CGFloat = 0
        for id in ids where id != active {
            let home = frames[id]!
            if x > origin.x, x + home.width > origin.x + stripWidth {
                x = origin.x; y += rowHeight + gap; rowHeight = 0
            }
            result[id] = CGRect(x: x, y: y, width: home.width, height: home.height)
            x += home.width + gap
            rowHeight = max(rowHeight, home.height)
        }
        return result
    }
}

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
        // World-space division/mirroring can differ by a floating-point ULP.
        // A subpixel rounding error at the exact gap is not a collision.
        let tolerance: CGFloat = 0.000001
        return a.minX < b.maxX + gap - tolerance && b.minX < a.maxX + gap - tolerance &&
            a.minY < b.maxY + gap - tolerance && b.minY < a.maxY + gap - tolerance
    }
}
