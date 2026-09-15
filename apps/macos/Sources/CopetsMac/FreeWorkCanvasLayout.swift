import SwiftUI
import os

/// Non-observable output of Layout. Reading it on mouse-down cannot invalidate
/// SwiftUI's graph, unlike feeding rendered anchors back into @State.
final class WorkCanvasLayoutSnapshot: Sendable {
    // Layout is Sendable; its output may be written while an interaction reads
    // the previous frames. Publish and copy each complete snapshot under a lock.
    private let storage = OSAllocatedUnfairLock(initialState: [String: CGRect]())

    var frames: [String: CGRect] {
        get { storage.withLock { $0 } }
        set { storage.withLock { $0 = newValue } }
    }
}

struct FreeWorkCanvasLayout: Layout {
    let positions: [String: CGPoint]
    let viewport: CGSize
    var worldOrigin: CGPoint = .zero
    var frozenFrames: [String: CGRect] = [:]
    var snapshot: WorkCanvasLayoutSnapshot? = nil
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
        // Offsets can invalidate SwiftUI Layout's cache. During a drag, never
        // remeasure the card trees: positions/sizes are the drag-start snapshot.
        if !frozenFrames.isEmpty {
            let frozen = subviews.compactMap { frozenFrames[$0[WorkPackingID.self]] }
            if frozen.count == subviews.count { return frozen }
        }
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
            // Retain initial placement across window resizing, without saving
            // geometry from a rendering callback. Explicit drop positions win.
            let established = (snapshot?.frames.mapValues(\.origin) ?? [:])
                .merging(positions, uniquingKeysWith: { _, explicit in explicit })
            cache.resolved = FreeWorkCanvasGeometry.frames(items: cache.items, positions: established, initialWidth: viewport.width)
            cache.positions = positions; cache.viewportWidth = viewport.width
        }
        return cache.resolved
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        let rects = frames(subviews, &cache)
        return CGSize(width: max(viewport.width, (rects.map(\.maxX).max() ?? 0) - worldOrigin.x + 80),
                      height: max(viewport.height, (rects.map(\.maxY).max() ?? 0) - worldOrigin.y + 80))
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let rects = frames(subviews, &cache)
        for (index, view) in subviews.enumerated() {
            let rect = rects[index]
            view.place(at: CGPoint(x: bounds.minX + rect.minX - worldOrigin.x, y: bounds.minY + rect.minY - worldOrigin.y), anchor: .topLeading,
                       proposal: ProposedViewSize(rect.size))
        }
        if frozenFrames.isEmpty {
            snapshot?.frames = Dictionary(uniqueKeysWithValues: zip(subviews, rects).map {
                ($0.0[WorkPackingID.self], $0.1)
            })
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
    private static func conflicts(_ a: CGRect, _ b: CGRect) -> Bool {
        let gap = 12.0
        return a.minX < b.maxX + gap && b.minX < a.maxX + gap && a.minY < b.maxY + gap && b.minY < a.maxY + gap
    }
    static func moved(_ origin: CGPoint, by delta: CGSize) -> CGPoint {
        CGPoint(x: origin.x + delta.width, y: origin.y + delta.height)
    }
}
