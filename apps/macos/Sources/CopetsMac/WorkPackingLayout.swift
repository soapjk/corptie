import SwiftUI
import RectanglePacking

struct WorkPackingID: LayoutValueKey { static let defaultValue = "" }
struct WorkPackingContentWidth: LayoutValueKey { static let defaultValue = false }

/// Only the outer Work surface uses packing. No timers, preferences, per-card
/// observers or transcript reads participate in geometry.
struct WorkPackingLayout: Layout {
    var selectedWorkID: String?
    var refreshRevision: Int
    var spacing: CGFloat = 12
    var fillsSingleItem = false

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
        // An unspecified proposal asks for content size, not a fixed 360-point card.
        let naturalWidth: CGFloat
        if proposed?.isFinite == true {
            naturalWidth = proposed!
        } else {
            naturalWidth = min(540, subviews.reduce(CGFloat(0)) { sum, view in
                let ideal = view.sizeThatFits(.unspecified).width
                return sum + min(336, max(1, ideal.isFinite ? ideal : 336)) + spacing
            } - (subviews.isEmpty ? 0 : spacing))
        }
        let width = max(1, floor(naturalWidth))
        if !cache.measured || cache.measuredWidth != width || cache.engine.refreshRevision != refreshRevision {
            let items = subviews.map { view -> WorkPackingEngine.Item in
                let ideal = view.sizeThatFits(.unspecified)
                let itemWidth = WorkCardGrid.resolvedWidth(ideal: ideal.width, available: width, gap: spacing,
                    contentSized: view[WorkPackingContentWidth.self],
                    fillsAvailable: fillsSingleItem && subviews.count == 1)
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

enum WorkCardGrid {
    static func resolvedWidth(ideal: CGFloat, available: CGFloat, gap: CGFloat,
                              contentSized: Bool, fillsAvailable: Bool) -> CGFloat {
        if fillsAvailable { return available }
        if contentSized { return min(available, max(1, ceil(ideal.isFinite ? ideal : available))) }
        return width(ideal: ideal, available: available, gap: gap)
    }
    static func width(ideal: CGFloat, available: CGFloat, gap: CGFloat) -> CGFloat {
        let columns = max(1, Int((available + gap) / (180 + gap)))
        let unit = floor((available + gap) / CGFloat(columns))
        let desired = ideal.isFinite ? max(1, ideal) : available
        let span = min(columns, 3, max(1, Int(ceil((desired + gap) / unit))))
        return min(available, CGFloat(span) * unit - gap)
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
