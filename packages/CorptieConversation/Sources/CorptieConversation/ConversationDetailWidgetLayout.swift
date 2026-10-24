import SwiftUI
import CorptieClientCore

/// Integer multiples of one square, including the gaps between occupied cells.
enum DetailWidgetSize: String, CaseIterable, Sendable {
    case small, medium, large, tall, extraLarge
    var columns: Int { self == .small || self == .tall ? 1 : 2 }
    var rows: Int {
        switch self { case .small, .medium: 1; case .large, .tall: 2; case .extraLarge: 3 }
    }
}

public enum ConversationDetailWidgetMetrics {
    public static let referenceUnit: CGFloat = 170
    public static let spacing: CGFloat = 12
    public static let railWidth: CGFloat = referenceUnit * 2 + spacing + 24
}

enum DetailWidgetSizing {

    /// Bounded metadata work only. Never measures text, reads a transcript, or
    /// feeds view geometry back into observable presentation state.
    static func preferredSize(for card: ClientDetailBusinessCard) -> DetailWidgetSize {
        if card.loadState == "error" { return .medium }
        switch card.payload {
        case .session: return .small
        case .summary(let value): return textSize(value.text)
        case .work(let value): return textSize(length: count(value.name) + count(value.description))
        case .task(let value):
            let definition = count(value.description) + count(value.acceptanceCriteria) + count(value.verificationCriteria)
            let summary = count(value.summary.focus) + count(value.summary.progress)
                + (value.summary.intervention == "required" ? count(value.summary.nextAction.isEmpty ? value.summary.reason : value.summary.nextAction) : 0)
            let length = definition + summary + count(value.title)
            return length > 1400 ? .extraLarge : length > 180 ? .large : .medium
        case .provider: return .medium
        case .worktree(let value):
            return value.tree?.dirty == true || (!value.blockedReason.isEmpty && value.blockedReason != "MAIN_WORKTREE") || value.job != nil ? .large : .medium
        case .turn: return .small
        case .hits(let list), .memories(let list):
            let text = list.items.prefix(9).reduce(0) { $0 + count($1.content) }
            if list.hasMore || list.items.count > 8 || text > 1400 { return .extraLarge }
            if list.items.count > 3 || text > 280 { return .large }
            return list.items.count <= 1 && text <= 80 ? .small : .medium
        case .references(let list):
            if list.hasMore || list.items.count > 8 { return .extraLarge }
            if list.items.count <= 1 { return .small }
            return list.items.count <= 4 && list.items.allSatisfy({ count($0.title) <= 24 }) ? .tall : .large
        case .artifacts(let list):
            if list.hasMore || list.items.count > 8 { return .extraLarge }
            if list.items.count <= 1 { return .medium }
            return list.items.count <= 3 && list.items.allSatisfy({ count($0.title) <= 24 && count($0.summary) <= 60 }) ? .tall : .large
        case .focus(let list): return list.hasMore || list.items.count > 6 ? .extraLarge : .large
        case .schedules(let list):
            if list.hasMore || list.items.count > 6 { return .extraLarge }
            if list.items.count <= 1 { return .small }
            return list.items.count <= 3 ? .tall : .large
        case .unsupported: return .medium
        }
    }

    private static func count(_ text: String) -> Int { text.utf16.prefix(1401).count }
    private static func textSize(_ text: String) -> DetailWidgetSize {
        textSize(length: count(text))
    }
    private static func textSize(length: Int) -> DetailWidgetSize {
        switch length { case ...80: .small; case ...280: .medium; case ...1400: .large; default: .extraLarge }
    }
}

struct DetailWidgetPlacement: Equatable {
    let frames: [CGRect]
    let size: CGSize

    static func make(width: CGFloat, widgets: [DetailWidgetSize]) -> Self {
        let width = width.isFinite ? max(1, width) : ConversationDetailWidgetMetrics.railWidth - 24
        let gap = ConversationDetailWidgetMetrics.spacing
        let columns = width >= 292 ? 2 : 1
        let unit = columns == 2 ? (width - gap) / 2 : width
        var occupied = Set<Int>()
        var frames: [CGRect] = []
        var cursor = 0
        for widget in widgets {
            let span = min(columns, widget.columns)
            var position = cursor
            while true {
                let row = position / columns, column = position % columns
                let cells = (row..<(row + widget.rows)).flatMap { r in (column..<(column + span)).map { r * columns + $0 } }
                if column + span <= columns && cells.allSatisfy({ !occupied.contains($0) }) {
                    occupied.formUnion(cells)
                    frames.append(CGRect(x: CGFloat(column) * (unit + gap), y: CGFloat(row) * (unit + gap),
                        width: CGFloat(span) * unit + CGFloat(span - 1) * gap,
                        height: CGFloat(widget.rows) * unit + CGFloat(widget.rows - 1) * gap))
                    cursor = position + span
                    break
                }
                position += 1
            }
        }
        return Self(frames: frames, size: CGSize(width: width, height: frames.map(\.maxY).max() ?? 0))
    }
}

struct DetailWidgetLayout: Layout {
    // Reorderable containers wrap each row and don't forward LayoutValueKey
    // traits. Keep the bounded size directory alongside the ordered card data.
    let sizes: [DetailWidgetSize]
    struct Cache { var widgets: [DetailWidgetSize] = []; var placement: DetailWidgetPlacement? }
    func makeCache(subviews: Subviews) -> Cache { Cache() }
    func updateCache(_ cache: inout Cache, subviews: Subviews) { cache.placement = nil }
    private func plan(width: CGFloat?, subviews: Subviews, cache: inout Cache) -> DetailWidgetPlacement {
        let width = width.flatMap { $0.isFinite ? $0 : nil } ?? ConversationDetailWidgetMetrics.railWidth - 24
        let widgets = subviews.indices.map { $0 < sizes.count ? sizes[$0] : .medium }
        if let value = cache.placement, value.size.width == max(1, width), cache.widgets == widgets { return value }
        let value = DetailWidgetPlacement.make(width: width, widgets: widgets)
        cache.widgets = widgets; cache.placement = value
        return value
    }
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
        plan(width: proposal.width, subviews: subviews, cache: &cache).size
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
        let value = plan(width: bounds.width, subviews: subviews, cache: &cache)
        for (index, frame) in value.frames.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading, proposal: ProposedViewSize(frame.size))
        }
    }
}

private struct DetailWidgetSizeKey: EnvironmentKey { static let defaultValue: DetailWidgetSize? = nil }
extension EnvironmentValues {
    var detailWidgetSize: DetailWidgetSize? {
        get { self[DetailWidgetSizeKey.self] }
        set { self[DetailWidgetSizeKey.self] = newValue }
    }
}
extension View {
    func detailWidget(_ size: DetailWidgetSize) -> some View {
        environment(\.detailWidgetSize, size)
    }
}
