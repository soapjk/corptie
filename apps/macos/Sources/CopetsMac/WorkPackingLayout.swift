import SwiftUI
import RectanglePacking

struct WorkPackingID: LayoutValueKey { static let defaultValue = "" }

/// Only the outer Work surface uses packing. No timers, preferences, per-card
/// observers or transcript reads participate in geometry.
struct WorkPackingLayout: Layout {
    var selectedWorkID: String?
    var refreshRevision: Int
    var spacing: CGFloat = 12

    struct Cache {
        var measured = false
        var measuredWidth: CGFloat = -1
        var engine = WorkPackingEngine()
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
        let width = max(1, floor(proposed?.isFinite == true ? proposed! : 360))
        if !cache.measured || cache.measuredWidth != width || cache.engine.refreshRevision != refreshRevision {
            let items = subviews.map { view -> WorkPackingEngine.Item in
                let ideal = view.sizeThatFits(.unspecified)
                let itemWidth = min(width, max(1, ceil(ideal.width.isFinite ? ideal.width : width)))
                let measured = view.sizeThatFits(ProposedViewSize(width: itemWidth, height: nil))
                return .init(id: view[WorkPackingID.self],
                    size: CGSize(width: itemWidth, height: max(1, ceil(measured.height.isFinite ? measured.height : 1))))
            }
            cache.engine.update(items: items, width: width, spacing: spacing,
                selectedWorkID: selectedWorkID, refreshRevision: refreshRevision)
            cache.measuredWidth = width
            cache.measured = true
        }
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
