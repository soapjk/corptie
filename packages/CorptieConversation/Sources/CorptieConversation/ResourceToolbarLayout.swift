import SwiftUI

/// Wraps labelled actions without duplicating controls or measuring into view state.
struct ResourceToolbarLayout: Layout {
    static func arrangement(sizes: [CGSize], width: CGFloat) -> (size: CGSize, frames: [CGRect]) {
        let available = max(0, width)
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        var frames: [CGRect] = []
        for size in sizes {
            let size = CGSize(width: min(available, size.width), height: size.height)
            if x > 0, x + size.width > available {
                x = 0; y += rowHeight + 8; rowHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + 8; rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: available, height: y + rowHeight), frames)
    }
    private func plan(_ proposal: ProposedViewSize, _ subviews: Subviews) -> (size: CGSize, frames: [CGRect]) {
        let ideal = subviews.map { $0.sizeThatFits(.unspecified) }
        let width = proposal.width ?? ideal.reduce(0) { $0 + $1.width + 8 }
        let sizes = zip(subviews, ideal).map { view, size in
            view.sizeThatFits(ProposedViewSize(width: min(width, size.width), height: nil))
        }
        return Self.arrangement(sizes: sizes, width: width)
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        plan(proposal, subviews).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let frames = plan(ProposedViewSize(width: bounds.width, height: nil), subviews).frames
        for (view, frame) in zip(subviews, frames) {
            view.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}
