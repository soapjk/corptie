import SwiftUI
import RectanglePacking

struct WorkPackingID: LayoutValueKey { static let defaultValue = "" }

/// Size one Task from its content, independently of siblings and the viewport.
/// Arrangement belongs to SwiftUI's VStack, not the rectangle packing engine.
struct ContentSizedTaskCardLayout: Layout {
    func makeCache(subviews: Subviews) -> CGSize? { nil }
    func updateCache(_ cache: inout CGSize?, subviews: Subviews) { cache = nil }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout CGSize?) -> CGSize {
        if let cache { return cache }
        guard let child = subviews.first else { return .zero }
        let width = WorkCardGrid.width(ideal: child.sizeThatFits(.unspecified).width, maximum: 384)
        let measured = child.sizeThatFits(ProposedViewSize(width: width, height: nil))
        let size = CGSize(width: width, height: max(1, ceil(measured.height.isFinite ? measured.height : 1)))
        cache = size
        return size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout CGSize?) {
        subviews.first?.place(at: bounds.origin, anchor: .topLeading, proposal: ProposedViewSize(bounds.size))
    }
}

/// Only the outer Work surface uses packing. No timers, preferences, per-card
/// observers or transcript reads participate in geometry.
struct WorkPackingLayout: Layout {
    var selectedWorkID: String?
    var refreshRevision: Int
    var spacing: CGFloat = 12
    var contentLayout = false
    var availableWidth: CGFloat? = nil

    struct Cache {
        var measured = false
        var measuredWidth: CGFloat = -1
        var engine = WorkPackingEngine()
        var items: [WorkPackingEngine.Item] = []
        var contentWidth: CGFloat = 0
    }

    func makeCache(subviews: Subviews) -> Cache { Cache() }
    func updateCache(_ cache: inout Cache, subviews: Subviews) {
        // Remeasure changed content before deciding whether packing needs to run.
        cache.measured = false
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        if proposal.width == 0 { return .zero }
        update(width: proposal.width, subviews: subviews, cache: &cache)
        return CGSize(width: cache.measuredWidth, height: cache.engine.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        guard bounds.width > 0 else { return }
        update(width: bounds.width, subviews: subviews, cache: &cache)
        for (index, subview) in subviews.enumerated() {
            let frame = cache.engine.frames[index]
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }

    private func update(width proposed: CGFloat?, subviews: Subviews, cache: inout Cache) {
        if !cache.measured {
            cache.items = subviews.map { view -> WorkPackingEngine.Item in
                let ideal = view.sizeThatFits(.unspecified)
                let itemWidth = WorkCardGrid.width(ideal: ideal.width, maximum: contentLayout ? 384 : 792)
                let measured = view.sizeThatFits(ProposedViewSize(width: itemWidth, height: nil))
                return .init(id: view[WorkPackingID.self],
                    size: CGSize(width: itemWidth, height: max(1, ceil(measured.height.isFinite ? measured.height : 1))))
            }
            cache.contentWidth = contentLayout ? WorkCardGrid.contentWidth(items: cache.items, gap: spacing)
                : (cache.items.map(\.size.width).max() ?? 192)
            cache.measured = true
        }
        let requested = availableWidth ?? proposed ?? cache.contentWidth
        let width = contentLayout ? cache.contentWidth : max(cache.items.map(\.size.width).max() ?? 1,
            requested.isFinite ? floor(requested) : cache.contentWidth)
        do {
            cache.engine.update(items: cache.items, width: width, spacing: spacing,
                selectedWorkID: selectedWorkID, refreshRevision: refreshRevision)
            cache.measuredWidth = width
            cache.measured = true
        }
    }
}

enum WorkCardGrid {
    static func width(ideal: CGFloat, maximum: CGFloat = 792) -> CGFloat {
        min(maximum, max(192, ceil((ideal.isFinite ? ideal : 192) / 24) * 24))
    }
    static func contentWidth(items: [WorkPackingEngine.Item], gap: CGFloat) -> CGFloat {
        let minimum = items.map(\.size.width).max() ?? 192
        guard items.count > 1 else { return minimum }
        // Bounded content-only alternatives; never use the viewport to size a Work.
        let candidates = Set([minimum, max(minimum, 384), max(minimum, 576), max(minimum, 768)]).sorted()
        if items.count > 64 { return candidates.last! }
        var best = minimum, area = CGFloat.infinity
        for candidate in candidates {
            var engine = WorkPackingEngine()
            engine.update(items: items, width: candidate, spacing: gap, selectedWorkID: nil, refreshRevision: 0)
            let score = candidate * engine.height
            if score < area { area = score; best = candidate }
        }
        return best
    }
}

/// Pure geometry + a thin C bridge to upstream MaxRects. Input order stays
/// deterministic even when a later card fills a hole above an earlier card.
struct WorkPackingEngine {
    struct Item: Equatable { let id: String; let size: CGSize }
    private(set) var frames: [CGRect] = []
    private(set) var height: CGFloat = 0
    private(set) var packingCount = 0
    private(set) var refreshRevision = -1
    private var items: [Item] = []
    private var width: CGFloat = -1
    private var spacing: CGFloat = -1

    mutating func update(items next: [Item], width nextWidth: CGFloat, spacing nextSpacing: CGFloat,
        selectedWorkID: String?, refreshRevision nextRefresh: Int) {
        guard next != items || nextWidth != width || nextSpacing != spacing || nextRefresh != refreshRevision else { return }
        let gap = max(0, ceil(nextSpacing))
        var output = Array(repeating: CorptiePackedRect(), count: next.count)
        let safe = nextWidth.isFinite && nextWidth > 0 && nextWidth + gap <= 32768 && next.count <= 1024
            && next.allSatisfy { $0.size.width.isFinite && $0.size.height.isFinite && $0.size.width > 0
                && $0.size.width <= nextWidth && $0.size.height > 0 && $0.size.height + gap <= 1000000 }
        var success = false
        if safe {
            let input = next.map { item -> CorptiePackedRect in
                return CorptiePackedRect(x: -1,
                    y: -1,
                    width: Int32(ceil(item.size.width) + gap), height: Int32(ceil(item.size.height) + gap))
            }
            success = input.withUnsafeBufferPointer { buffer in
                output.withUnsafeMutableBufferPointer {
                    corptie_pack_rectangles(Int32(floor(nextWidth) + gap), buffer.baseAddress,
                        Int32(next.count), -1, $0.baseAddress) == 1
                }
            }
        }
        packingCount += 1
        if success {
            frames = zip(next, output).map { item, result in
                CGRect(origin: CGPoint(x: Int(result.x), y: Int(result.y)), size: item.size)
            }
        } else {
            // Bounded fallback for extreme inventories/native rejection:
            // show every card, never silently drop or overlap an item.
            var y: CGFloat = 0
            frames = next.map { item in
                defer { y += item.size.height + gap }
                return CGRect(origin: CGPoint(x: 0, y: y), size: item.size)
            }
        }
        height = frames.map(\.maxY).max() ?? 0
        items = next; width = nextWidth; spacing = nextSpacing; refreshRevision = nextRefresh
    }
}
