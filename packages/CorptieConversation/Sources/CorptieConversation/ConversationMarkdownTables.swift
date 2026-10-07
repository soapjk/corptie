import Foundation
import Markdown

public struct ConversationMarkdownTable: Equatable, Hashable, Sendable {
    public enum Alignment: String, Sendable { case left, center, right }
    public struct Cell: Equatable, Hashable, Sendable {
        public let markdown: String
        public let plainText: String
    }
    public let rows: [[Cell]]
    public let alignments: [Alignment]
    public let originalText: String
    public let exceedsDisplayBudget: Bool

    public var tabSeparatedText: String {
        rows.map { row in
            row.map { $0.plainText.replacingOccurrences(of: "\t", with: " ")
                .replacingOccurrences(of: "\n", with: " ") }.joined(separator: "\t")
        }.joined(separator: "\n")
    }
}

/// GFM decides whether a table exists. No pipe splitting or delimiter regex is
/// used here. Source lines preserve ordinary Markdown and stable stream IDs.
public enum ConversationMarkdownTables {
    public static let maximumRows = 100
    public static let maximumColumns = 24
    public static let maximumCells = 400
    public static let maximumSourceBytes = 512 * 1_024

    public static func expanding(_ blocks: [ConversationLocatedContentBlock],
                                 messageID: String) -> [ConversationLocatedContentBlock] {
        blocks.flatMap { block in
            guard case .markdown(let text) = block.content, text.contains("|") else { return [block] }
            return parse(text, messageID: messageID, baseUTF16: block.startUTF16)
        }
    }

    public static func parse(_ text: String, messageID: String = "",
                             baseUTF16: Int = 0) -> [ConversationLocatedContentBlock] {
        let fallback = [ConversationLocatedContentBlock(messageID: messageID,
            startUTF16: baseUTF16, content: .markdown(text))]
        guard text.contains("|"), text.utf8.count <= maximumSourceBytes else { return fallback }
        let document = Document(parsing: text)
        var tables: [Table] = []
        func collect(_ node: any Markup) {
            if let table = node as? Table { tables.append(table); return }
            for child in node.children { collect(child) }
        }
        collect(document)
        guard !tables.isEmpty else { return fallback }
        // cmark locations are UTF-8 columns; use whole line boundaries instead
        // of treating those columns as Swift character or UTF-16 offsets.
        var starts = [text.startIndex]
        for index in text.indices where text[index].isNewline { starts.append(text.index(after: index)) }
        var cursor = text.startIndex
        var result: [ConversationLocatedContentBlock] = []
        func append(_ content: ConversationContentBlock, at index: String.Index) {
            result.append(.init(messageID: messageID,
                startUTF16: baseUTF16 + text[..<index].utf16.count, content: content))
        }
        for table in tables {
            guard let range = table.range, range.lowerBound.line > 0,
                  range.lowerBound.line <= starts.count else { continue }
            let lower = starts[range.lowerBound.line - 1]
            let upper = range.upperBound.line < starts.count
                ? starts[range.upperBound.line] : text.endIndex
            guard lower >= cursor else { continue }
            if cursor < lower { append(.markdown(String(text[cursor..<lower])), at: cursor) }
            let original = String(text[lower..<upper])
            let columns = table.maxColumnCount
            let rowCount = table.body.childCount + 1
            let oversized = columns > maximumColumns || rowCount > maximumRows
                || columns * rowCount > maximumCells || original.utf8.count > 128 * 1_024
            let rows: [[ConversationMarkdownTable.Cell]]
            if oversized {
                rows = []
            } else {
                func cells(_ container: any Markup) -> [ConversationMarkdownTable.Cell] {
                    container.children.compactMap { child in
                        guard let cell = child as? Table.Cell else { return nil }
                        return .init(markdown: cell.children.map { $0.format() }.joined(),
                                     plainText: plainText(cell))
                    }
                }
                rows = [cells(table.head)] + table.body.children.map(cells)
            }
            let alignments: [ConversationMarkdownTable.Alignment] = table.columnAlignments.map {
                switch $0 {
                case .center: .center
                case .right: .right
                default: .left
                }
            }
            append(.table(.init(rows: rows, alignments: alignments, originalText: original,
                                exceedsDisplayBudget: oversized)), at: lower)
            cursor = upper
        }
        if cursor < text.endIndex { append(.markdown(String(text[cursor...])), at: cursor) }
        return result.isEmpty ? fallback : result
    }

    private static func plainText(_ node: any Markup) -> String {
        // Swift Markdown's InlineCode.plainText deliberately retains backticks;
        // a spreadsheet export needs the actual cell value instead.
        if let code = node as? InlineCode { return code.code }
        if let text = node as? Markdown.Text { return text.string }
        if node is SoftBreak || node is LineBreak { return "\n" }
        return node.children.map(plainText).joined()
    }
}
