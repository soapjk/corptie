import SwiftUI
#if os(macOS)
import AppKit
private typealias TableFont = NSFont
#else
import UIKit
private typealias TableFont = UIFont
#endif

/// Immutable measured cells are shared by on-screen layout and macOS row
/// measurement. No GeometryReader, cell-size preferences, or per-frame work.
@MainActor
public final class ConversationMarkdownTableLayout {
    public let cells: [[NSAttributedString]]
    public let columnWidths: [CGFloat]
    public let rowHeights: [CGFloat]
    public let textHeights: [[CGFloat]]
    public let viewportWidth: CGFloat
    public var contentWidth: CGFloat { columnWidths.reduce(0, +) }
    public var height: CGFloat { rowHeights.reduce(0, +) + 12 }
    public static let horizontalInset: CGFloat = 8
    public static let verticalInset: CGFloat = 6

    @MainActor private final class CellMeasurement {
        let text: NSAttributedString
        let naturalWidth: CGFloat
        var heights: [CGFloat: CGFloat] = [:]
        init(_ text: NSAttributedString) {
            self.text = text
            #if os(macOS)
            naturalWidth = ceil(text.boundingRect(with: CGSize(width: 10_000, height: 10_000),
                options: [.usesLineFragmentOrigin, .usesFontLeading]).width)
            #else
            naturalWidth = ceil(text.boundingRect(with: CGSize(width: 10_000, height: 10_000),
                options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil).width)
            #endif
        }
        func height(width: CGFloat) -> CGFloat {
            // Bounding-rect natural width and TextKit wrapping are not identical
            // at glyph boundaries. Cache the actual container width, not a
            // clamped estimate that can alias two different line layouts.
            let key = max(1, width)
            if let value = heights[key] { return value }
            let value = ConversationMarkdownTableLayout.textHeight(text, width: width)
            if heights.count >= 8 { heights.removeAll(keepingCapacity: true) }
            heights[key] = value
            return value
        }
    }
    private static let cellCache: NSCache<NSString, CellMeasurement> = {
        let value = NSCache<NSString, CellMeasurement>()
        value.countLimit = 2_048; value.totalCostLimit = 4 * 1_024 * 1_024
        return value
    }()

    private static let cache: NSCache<NSString, ConversationMarkdownTableLayout> = {
        let value = NSCache<NSString, ConversationMarkdownTableLayout>()
        value.countLimit = 128
        value.totalCostLimit = 8 * 1_024 * 1_024
        return value
    }()

    public static func measured(_ table: ConversationMarkdownTable, width: CGFloat,
                                style: MessageMarkdown.Style = .agent) -> ConversationMarkdownTableLayout {
        let normalized = width.isFinite ? max(20, floor(width)) : 320
        let key = "\(style):\(normalized):\(table.originalText)" as NSString
        if let value = cache.object(forKey: key) { return value }
        let value = ConversationMarkdownTableLayout(table, width: normalized, style: style)
        let cost = table.originalText.utf16.count * 8 + value.cells.reduce(0) {
            $0 + $1.reduce(0) { $0 + $1.length * 16 + 128 }
        }
        if cost <= 8 * 1_024 * 1_024 { cache.setObject(value, forKey: key, cost: cost) }
        return value
    }

    private init(_ table: ConversationMarkdownTable, width: CGFloat, style: MessageMarkdown.Style) {
        viewportWidth = width
        guard !table.exceedsDisplayBudget else {
            cells = []; columnWidths = []; rowHeights = [44]; textHeights = []; return
        }
        let measuredCells: [[CellMeasurement]] = table.rows.enumerated().map { row, values in
            values.enumerated().map { column, cell in
                let alignment = table.alignments.indices.contains(column) ? table.alignments[column] : .left
                let key = "\(style):\(row == 0):\(alignment.rawValue):\(cell.markdown)" as NSString
                if let cached = Self.cellCache.object(forKey: key) { return cached }
                let value = NSMutableAttributedString(attributedString:
                    MessageMarkdown.make(text: cell.markdown, style: style))
                let range = NSRange(location: 0, length: value.length)
                value.enumerateAttribute(.paragraphStyle, in: range) { attribute, range, _ in
                    let paragraph = (attribute as? NSParagraphStyle)?.mutableCopy() as? NSMutableParagraphStyle
                        ?? NSMutableParagraphStyle()
                    paragraph.alignment = alignment == .right ? .right : alignment == .center ? .center : .left
                    value.addAttribute(.paragraphStyle, value: paragraph, range: range)
                }
                if row == 0 {
                    value.enumerateAttribute(.font, in: range) { attribute, range, _ in
                        guard let font = attribute as? TableFont else { return }
                        #if os(macOS)
                        let bold = NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
                        #else
                        let descriptor = font.fontDescriptor.withSymbolicTraits(
                            font.fontDescriptor.symbolicTraits.union(.traitBold)) ?? font.fontDescriptor
                        let bold = UIFont(descriptor: descriptor, size: font.pointSize)
                        #endif
                        value.addAttribute(.font, value: bold, range: range)
                    }
                }
                let measured = CellMeasurement(value.copy() as! NSAttributedString)
                Self.cellCache.setObject(measured, forKey: key, cost: cell.markdown.utf16.count * 8 + value.length * 16 + 256)
                return measured
            }
        }
        self.cells = measuredCells.map { $0.map(\.text) }
        let count = measuredCells.first?.count ?? 0
        var widths = (0..<count).map { column in
            let natural = measuredCells.map { row -> CGFloat in
                guard row.indices.contains(column) else { return 0 }
                return row[column].naturalWidth
            }.max() ?? 0
            return min(260, max(72, natural + Self.horizontalInset * 2))
        }
        // Shrink spacious columns evenly, but never crush all columns merely
        // to avoid horizontal scrolling on a phone.
        var excess = widths.reduce(0, +) - width
        while excess > 0.5 {
            let candidates = widths.indices.filter { widths[$0] > 72.5 }
            guard !candidates.isEmpty else { break }
            let share = excess / CGFloat(candidates.count)
            for index in candidates {
                let reduction = min(share, widths[index] - 72)
                widths[index] -= reduction; excess -= reduction
            }
        }
        columnWidths = widths
        let textHeights = measuredCells.map { row in
            row.enumerated().map { column, cell in
                cell.height(width: widths[column] - Self.horizontalInset * 2)
            }
        }
        self.textHeights = textHeights
        rowHeights = textHeights.map { max(26, ($0.max() ?? 0) + Self.verticalInset * 2) }
    }

    private static func textHeight(_ text: NSAttributedString, width: CGFloat) -> CGFloat {
        let storage = NSTextStorage(attributedString: text)
        let manager = NSLayoutManager()
        manager.usesFontLeading = true
        let container = NSTextContainer(size: CGSize(width: max(1, width), height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        manager.addTextContainer(container); storage.addLayoutManager(manager)
        manager.ensureLayout(for: container)
        return max(14, ceil(manager.usedRect(for: container).height))
    }
}

public struct ConversationMarkdownTableView: View {
    public let table: ConversationMarkdownTable
    public let layout: ConversationMarkdownTableLayout
    public var allowsSelection: Bool
    public var openLink: (URL) -> Void
    public var selectText: (() -> Void)?

    public init(table: ConversationMarkdownTable, layout: ConversationMarkdownTableLayout,
                allowsSelection: Bool = true, openLink: @escaping (URL) -> Void = { _ in },
                selectText: (() -> Void)? = nil) {
        self.table = table; self.layout = layout
        self.allowsSelection = allowsSelection; self.openLink = openLink
        self.selectText = selectText
    }

    public var body: some View {
        Group {
            if table.exceedsDisplayBudget {
                Text("表格过大，暂不展开；可复制完整 Markdown 表格。")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(width: layout.viewportWidth, height: layout.height, alignment: .leading)
            } else {
                ScrollView(.horizontal) {
                    VStack(spacing: 0) {
                        ForEach(layout.cells.indices, id: \.self) { row in
                            HStack(alignment: .top, spacing: 0) {
                                ForEach(layout.cells[row].indices, id: \.self) { column in
                                    TableNativeText(text: layout.cells[row][column],
                                        size: CGSize(width: layout.columnWidths[column] - 16,
                                                     height: layout.textHeights[row][column]),
                                        allowsSelection: allowsSelection, openLink: openLink)
                                        .frame(width: layout.columnWidths[column] - 16,
                                               height: layout.textHeights[row][column])
                                        .padding(.horizontal, 8).padding(.vertical, 6)
                                        .frame(width: layout.columnWidths[column], height: layout.rowHeights[row],
                                               alignment: .topLeading)
                                        .background(row == 0 ? Color.primary.opacity(0.06) : .clear)
                                        .overlay(alignment: .trailing) {
                                            Rectangle().fill(Color.primary.opacity(0.12)).frame(width: 0.5)
                                        }
                                        .accessibilityLabel("\(row == 0 ? "表头" : "第\(row)行")，\(table.rows[0][column].plainText)：\(table.rows[row][column].plainText)")
                                }
                            }
                            .overlay(alignment: .bottom) {
                                Rectangle().fill(Color.primary.opacity(0.12)).frame(height: 0.5)
                            }
                        }
                    }
                    .frame(width: layout.contentWidth)
                }
                .frame(width: layout.viewportWidth, height: layout.height, alignment: .topLeading)
            }
        }
        .contextMenu {
            Button(table.exceedsDisplayBudget ? "复制完整 Markdown 表格" : "复制表格") {
                let value = table.exceedsDisplayBudget ? table.originalText : table.tabSeparatedText
                #if os(macOS)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(value, forType: .string)
                #else
                UIPasteboard.general.string = value
                #endif
            }
            if let selectText { Button("选择文本", action: selectText) }
        }
        .accessibilityIdentifier("message-markdown-table")
    }
}

#if os(macOS)
private struct TableNativeText: NSViewRepresentable {
    let text: NSAttributedString
    let size: CGSize
    let allowsSelection: Bool
    let openLink: (URL) -> Void
    final class Coordinator: NSObject, NSTextViewDelegate {
        var openLink: (URL) -> Void = { _ in }
        func textView(_ view: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
            if let url = link as? URL { openLink(url); return true }; return false
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> NSTextView {
        let storage = NSTextStorage(); let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0; container.widthTracksTextView = false
        manager.usesFontLeading = true
        manager.addTextContainer(container); storage.addLayoutManager(manager)
        let view = NSTextView(frame: .zero, textContainer: container)
        view.isEditable = false; view.drawsBackground = false; view.textContainerInset = .zero
        view.isHorizontallyResizable = false; view.isVerticallyResizable = false
        view.delegate = context.coordinator
        return view
    }
    func updateNSView(_ view: NSTextView, context: Context) {
        context.coordinator.openLink = openLink
        view.isSelectable = allowsSelection
        view.textContainer?.containerSize = CGSize(width: size.width, height: .greatestFiniteMagnitude)
        if !view.attributedString().isEqual(to: text) { view.textStorage?.setAttributedString(text) }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextView, context: Context) -> CGSize? { size }
}
#else
private struct TableNativeText: UIViewRepresentable {
    let text: NSAttributedString
    let size: CGSize
    let allowsSelection: Bool
    let openLink: (URL) -> Void
    final class Coordinator: NSObject, UITextViewDelegate {
        var openLink: (URL) -> Void = { _ in }
        func textView(_ view: UITextView, primaryActionFor textItem: UITextItem,
                      defaultAction: UIAction) -> UIAction? {
            guard case .link(let url) = textItem.content else { return defaultAction }
            return UIAction { [weak self] _ in self?.openLink(url) }
        }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIView(context: Context) -> UITextView {
        let storage = NSTextStorage(); let manager = NSLayoutManager()
        let container = NSTextContainer(size: CGSize(width: 0, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0; container.widthTracksTextView = false
        manager.usesFontLeading = true
        manager.addTextContainer(container); storage.addLayoutManager(manager)
        let view = UITextView(frame: .zero, textContainer: container)
        view.isEditable = false; view.isScrollEnabled = false; view.backgroundColor = .clear
        view.textContainerInset = .zero; view.delegate = context.coordinator
        return view
    }
    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.openLink = openLink
        view.textContainer.size = CGSize(width: size.width, height: .greatestFiniteMagnitude)
        view.isSelectable = true
        for case let recognizer as UILongPressGestureRecognizer in view.gestureRecognizers ?? [] {
            recognizer.isEnabled = allowsSelection
        }
        if !allowsSelection { view.selectedRange = NSRange(location: 0, length: 0) }
        if !view.attributedText.isEqual(to: text) { view.attributedText = text }
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? { size }
}
#endif
