import SwiftUI

struct WorkCanvasAnchors: PreferenceKey {
    static var defaultValue: [String: Anchor<CGRect>] { [:] }
    static func reduce(value: inout [String: Anchor<CGRect>], nextValue: () -> [String: Anchor<CGRect>]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}
struct WorkCanvasOrigins: PreferenceKey {
    static var defaultValue: [String: CGRect] { [:] }
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

struct FreeWorkCanvasLayout: Layout {
    let positions: [String: CGPoint]
    let viewport: CGSize
    struct Cache {
        var items: [WorkPackingEngine.Item] = []
        var measured = false
        var resolved: [CGRect] = []
        var positions: [String: CGPoint] = [:]
        var viewportWidth: CGFloat = -1
    }
    func makeCache(subviews: Subviews) -> Cache { Cache() }
    func updateCache(_ cache: inout Cache, subviews: Subviews) { cache.measured = false }
    private func frames(_ subviews: Subviews, _ cache: inout Cache) -> [CGRect] {
        let remeasure = !cache.measured
        if remeasure {
            cache.items = subviews.map { view in
                let width = WorkCardGrid.width(ideal: view.sizeThatFits(.unspecified).width)
                let size = view.sizeThatFits(.init(width: width, height: nil))
                return .init(id: view[WorkPackingID.self], size: CGSize(width: width, height: ceil(size.height)))
            }
            cache.measured = true
        }
        if remeasure || cache.positions != positions || cache.viewportWidth != viewport.width {
            cache.resolved = FreeWorkCanvasGeometry.frames(items: cache.items, positions: positions, initialWidth: viewport.width)
            cache.positions = positions; cache.viewportWidth = viewport.width
        }
        return cache.resolved
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let rects = frames(subviews, &cache)
        return CGSize(width: max(viewport.width, (rects.map(\.maxX).max() ?? 0) + 80),
                      height: max(viewport.height, (rects.map(\.maxY).max() ?? 0) + 80))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let rects = frames(subviews, &cache)
        for (index, view) in subviews.enumerated() {
            let rect = rects[index]
            view.place(at: CGPoint(x: bounds.minX + rect.minX, y: bounds.minY + rect.minY), anchor: .topLeading,
                       proposal: ProposedViewSize(rect.size))
        }
    }
}

enum FreeWorkCanvasGeometry {
    static func frames(items: [WorkPackingEngine.Item], positions: [String: CGPoint], initialWidth: CGFloat) -> [CGRect] {
        if !items.contains(where: { positions[$0.id] != nil }) {
            var packing = WorkPackingEngine()
            packing.update(items: items, width: max(initialWidth, items.map(\.size.width).max() ?? 1), spacing: 12,
                           selectedWorkID: nil, refreshRevision: 0)
            return packing.frames
        }
        var bottom = items.compactMap { item in positions[item.id].map { $0.y + item.size.height } }.max() ?? 0
        var placed: [CGRect] = []
        return items.map { item in
            var rect = CGRect(origin: positions[item.id] ?? CGPoint(x: 0, y: bottom + 12), size: item.size)
            // Sweep top-to-bottom; y only increases, without iterative packing.
            // Keep every non-conflicting free coordinate and card size exact.
            for obstacle in placed.sorted(by: { $0.minY < $1.minY }) where conflicts(obstacle, rect) {
                rect.origin.y = obstacle.maxY + 12
            }
            placed.append(rect)
            bottom = max(bottom, rect.maxY)
            return rect
        }
    }
    static func permitsMove(_ frame: CGRect, by delta: CGSize, obstacles: [CGRect]) -> Bool {
        let proposed = frame.offsetBy(dx: delta.width, dy: delta.height)
        return !obstacles.contains { conflicts($0, proposed) }
    }
    private static func conflicts(_ a: CGRect, _ b: CGRect) -> Bool {
        a.minX < b.maxX + 12 && b.minX < a.maxX + 12 && a.minY < b.maxY + 12 && b.minY < a.maxY + 12
    }
    static func moved(_ origin: CGPoint, by delta: CGSize) -> CGPoint {
        // Canvas starts at its top-left boundary; coordinates are never grid-rounded.
        CGPoint(x: max(0, origin.x + delta.width), y: max(0, origin.y + delta.height))
    }
}
