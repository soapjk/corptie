import SwiftUI
import CorptieClientCore

/// Twelve-point vertical spans include the gap after a card. Width remains
/// independent so compact heights don't shrink controls or force narrow text.
struct DetailWidgetSize: Equatable, CaseIterable, Sendable {
    let columns: Int
    let rows: Int
    private init(columns: Int, height: Int) {
        self.columns = columns
        rows = max(1, (height + 23) / 12)
    }
    var height: CGFloat { CGFloat(rows * 12 - 12) }
    static let strip = DetailWidgetSize(columns: 2, height: 84)
    static let small = DetailWidgetSize(columns: 1, height: 144)
    static let medium = DetailWidgetSize(columns: 2, height: 144)
    static let large = DetailWidgetSize(columns: 2, height: 300)
    static let tall = DetailWidgetSize(columns: 1, height: 300)
    static let extraLarge = DetailWidgetSize(columns: 2, height: 456)
    static let allCases: [DetailWidgetSize] = [.strip, .small, .medium, .large, .tall, .extraLarge]
    static func fitted(height: Int) -> Self {
        Self(columns: 2, height: min(360, max(60, height)))
    }
}

public enum ConversationDetailWidgetMetrics {
    public static let referenceUnit: CGFloat = 144
    public static let spacing: CGFloat = 12
    public static let railWidth: CGFloat = referenceUnit * 2 + spacing + 24
}

enum DetailWidgetSizing {
    /// Bounded estimates of the default visible preview only. No native text
    /// measurement, geometry publication, transcript scanning or deferred work.
    static func preferredSize(for card: ClientDetailBusinessCard) -> DetailWidgetSize {
        if card.loadState == "error" { return .fitted(height: 96) }
        let base = card.kind == "contextReferences" || card.actions.contains(where: { $0.operation == "editor.open" }) ? 68 : 54
        let page = card.nextCursor != nil
        switch card.payload {
        case .session(let value): return .fitted(height: value.workName.isEmpty ? 72 : 84)
        case .summary(let value): return .fitted(height: base + textHeight(value.text))
        case .work(let value): return .fitted(height: base + textHeight(value.name, lines: 2) + blockHeight(value.description))
        case .task(let value):
            let definition = blockHeight(value.description) + blockHeight(value.acceptanceCriteria) + blockHeight(value.verificationCriteria)
            let height = base + textHeight(value.title, lines: 2) + 24 + definition + summaryHeight(value.summary)
            return .fitted(height: height)
        case .provider: return .small
        case .worktree(let value):
            let detailed = value.tree?.dirty == true || (!value.blockedReason.isEmpty && value.blockedReason != "MAIN_WORKTREE") || value.job != nil
            return .fitted(height: detailed ? 216 : 144)
        case .turn: return .fitted(height: 144)
        case .hits(let list), .memories(let list):
            let heights = list.items.prefix(6).map { row in
                let controls = card.actions.contains { $0.target?.id == row.id && ($0.operation == "memory.update" || $0.operation == "memory.delete") }
                return max(16, textHeight(row.content)) + (controls ? 30 : 0)
            }
            return listSize(heights, base: base, page: page)
        case .references(let list):
            return listSize(list.items.prefix(6).map { textHeight($0.title, lines: 2) + 20 }, base: base, page: page)
        case .artifacts(let list):
            return listSize(list.items.prefix(6).map { max(16, textHeight($0.title, lines: 2)) + ($0.summary.isEmpty ? 0 : textHeight($0.summary) + 4) }, base: base, page: page)
        case .focus(let list):
            return listSize(list.items.prefix(6).map { textHeight($0.title, lines: 2) + summaryHeight($0.summary) }, base: base + 32, page: page)
        case .schedules(let list):
            return listSize(list.items.prefix(6).map { textHeight($0.name, lines: 2) + 20 + ($0.nextRunAt != nil || $0.runAt != nil ? 20 : 0) }, base: base, page: page)
        case .unsupported: return .fitted(height: 96)
        }
    }

    private static func listSize(_ heights: [Int], base: Int, page: Bool) -> DetailWidgetSize {
        let rows = heights.isEmpty ? 16 : heights.reduce(0, +) + max(0, heights.count - 1) * 12
        return .fitted(height: base + rows + (page ? 35 : 0))
    }
    private static func blockHeight(_ text: String) -> Int { text.isEmpty ? 0 : textHeight(text) + 7 }
    private static func summaryHeight(_ summary: ClientDetailBusinessTaskSummary) -> Int {
        guard summary.state == "ready" else { return 16 }
        var height = 0
        if !summary.focus.isEmpty { height += textHeight(summary.focus, lines: 4) + 4 }
        if !summary.progress.isEmpty { height += textHeight(summary.progress, lines: 4) + 4 }
        if summary.intervention == "required", summary.current != false {
            height += blockHeight(summary.nextAction.isEmpty ? summary.reason : summary.nextAction)
        }
        return height
    }
    private static func textHeight(_ text: String, lines maximum: Int = 3) -> Int {
        guard !text.isEmpty else { return 0 }
        var lines = 1, width = 8 // allow for the inline stamp on the first line
        for unit in text.utf16.prefix(160) {
            if unit == 10 { lines += 1; width = 0 }
            else {
                width += unit < 256 ? 1 : 2
                if width > 40 { lines += 1; width = unit < 256 ? 1 : 2 }
            }
            if lines >= maximum { return maximum * 16 }
        }
        return lines * 16
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
                    frames.append(CGRect(x: CGFloat(column) * (unit + gap), y: CGFloat(row) * gap,
                        width: CGFloat(span) * unit + CGFloat(span - 1) * gap,
                        height: widget.height))
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
