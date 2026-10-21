import SwiftUI
import struct Markdown.Document
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
struct ResourceDocumentChunk: Identifiable {
    struct Block: Identifiable {
        let id: String
        let content: ConversationContentBlock
        let attributed: NSAttributedString?
        let plain: Bool
    }
    let id: Int
    let text: String
    let blocks: [Block]
    let rawFallback: Bool
    init(id: Int, text: String, mimeType: String = "text/markdown", title: String = "") {
        self.id = id; self.text = text
        blocks = (try? Self.sources(id: id, text: text, mimeType: mimeType, title: title))?.map(Self.makeBlock) ?? []
        rawFallback = Self.isMarkdown(mimeType: mimeType, title: title) && blocks.contains { $0.plain }
    }
    private init(id: Int, text: String, blocks: [Block], rawFallback: Bool) {
        self.id = id; self.text = text; self.blocks = blocks; self.rawFallback = rawFallback
    }
    /// cmark work runs off the UI actor. Native font/math preparation is bounded
    /// per block and yields between batches; it never runs from a View's body.
    static func prepare(id: Int, text: String, mimeType: String, title: String, previous: Self? = nil) async throws -> Self {
        let task = Task.detached(priority: .userInitiated) {
            try sources(id: id, text: text, mimeType: mimeType, title: title)
        }
        let source = try await withTaskCancellationHandler(operation: { try await task.value }, onCancel: { task.cancel() })
        var blocks: [Block] = []
        for item in source {
            try Task.checkCancellation()
            let index = blocks.count
            if let old = previous?.blocks, old.indices.contains(index), old[index].id == item.id,
               old[index].content == item.content, old[index].plain == item.plain {
                blocks.append(old[index])
            } else { blocks.append(makeBlock(item)) }
            if blocks.count.isMultiple(of: 8) { await Task.yield() }
        }
        return Self(id: id, text: text, blocks: blocks,
            rawFallback: isMarkdown(mimeType: mimeType, title: title) && blocks.contains { $0.plain })
    }
    private struct Source: Sendable {
        let id: String
        let content: ConversationContentBlock
        let plain: Bool
    }
    private static func makeBlock(_ source: Source) -> Block {
        let attributed: NSAttributedString?
        if case .markdown(let text) = source.content, !source.plain {
            attributed = MessageMarkdown.make(text: text, style: .agent)
        } else { attributed = nil }
        return Block(id: source.id, content: source.content, attributed: attributed, plain: source.plain)
    }
    nonisolated private static func isMarkdown(mimeType: String, title: String) -> Bool {
        let mime = mimeType.lowercased().split(separator: ";").first.map(String.init) ?? ""
        return ["text/markdown", "text/x-markdown"].contains(mime)
            || ["md", "markdown"].contains((title as NSString).pathExtension.lowercased())
    }
    nonisolated private static func sources(id: Int, text: String, mimeType: String, title: String) throws -> [Source] {
        var result: [Source] = []
        var offset = 0
        func append(_ content: ConversationContentBlock, plain: Bool) {
            result.append(Source(id: "resource-\(id)-\(offset)", content: content, plain: plain)); offset += 1
        }
        func literal(_ value: String) {
            var cursor = value.startIndex
            while cursor < value.endIndex {
                let end = value.index(cursor, offsetBy: 2048, limitedBy: value.endIndex) ?? value.endIndex
                append(.markdown(String(value[cursor..<end])), plain: true); cursor = end
            }
        }
        try Task.checkCancellation()
        guard isMarkdown(mimeType: mimeType, title: title), text.utf8.count <= 512 * 1024 else { literal(text); return result }
        let located = ConversationMarkdownTables.parse(text, messageID: "resource-\(id)")
        for (index, block) in located.enumerated() {
            try Task.checkCancellation()
            if result.count >= 1024 {
                literal(located[index...].map { item in
                    switch item.content {
                    case .markdown(let value): value
                    case .table(let value): value.originalText
                    case .chart(_, let value), .invalidChart(let value, _): value
                    }
                }.joined())
                return result
            }
            guard case .markdown(let value) = block.content else { append(block.content, plain: false); continue }
            // Use the existing GFM parser's top-level source ranges, rather than
            // inventing paragraph/fence rules or measuring whole native views.
            var starts = [value.startIndex]
            for index in value.indices where value[index].isNewline { starts.append(value.index(after: index)) }
            var boundaries = [value.startIndex]
            for child in Document(parsing: value).children {
                if let line = child.range?.lowerBound.line, line > 0, line <= starts.count,
                   let last = boundaries.last, starts[line - 1] > last { boundaries.append(starts[line - 1]) }
                if boundaries.count > 1024 { break }
            }
            if boundaries.count > 1024 { literal(value); continue }
            boundaries.append(value.endIndex)
            for pair in zip(boundaries, boundaries.dropFirst()) where pair.0 < pair.1 {
                try Task.checkCancellation()
                if result.count >= 1024 { literal(String(value[pair.0...])); break }
                let part = String(value[pair.0..<pair.1])
                if part.utf16.count > 8192 { literal(part) }
                else {
                    for inner in ConversationMarkdownTables.parse(part) { append(inner.content, plain: false) }
                }
            }
        }
        return result
    }
}

struct ResourceDocumentView: View {
    let chunk: ResourceDocumentChunk
    @State private var width: CGFloat = 300
    var body: some View {
        LazyVStack(alignment: .leading, spacing: 8) {
            if chunk.rawFallback {
                Text("为保持流畅，超大文档或超长段落按原文显示；复制与导出仍保留正文。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            ForEach(chunk.blocks) { block in
                if let attributed = block.attributed { ResourceNativeText(value: attributed) }
                else if case .table(let table) = block.content {
                    ConversationMarkdownTableView(table: table, layout: .measured(table, width: width))
                } else if case .markdown(let text) = block.content {
                    Text(text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(GeometryReader { proxy in Color.clear.preference(key: ResourceDocumentWidth.self, value: proxy.size.width) })
        .onPreferenceChange(ResourceDocumentWidth.self) { if abs(width - $0) > 1 { width = max(1, $0) } }
    }
}

@MainActor func copyResourceText(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}
private struct ResourceDocumentWidth: PreferenceKey {
    static let defaultValue: CGFloat = 300
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// SwiftUI owns wrapping and layout; no NSTextView ensureLayout/height feedback.
private struct ResourceNativeText: View {
    let value: NSAttributedString
    var body: some View {
        text.textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
    }
    private var text: SwiftUI.Text {
        guard value.string.contains("\u{fffc}") else { return SwiftUI.Text(AttributedString(value)) }
        var result = SwiftUI.Text("")
        value.enumerateAttribute(.attachment, in: NSRange(location: 0, length: value.length)) { attachment, range, _ in
            if let math = attachment as? MessageMathAttachment, let image = math.image {
                #if os(macOS)
                result = result + Text(Image(nsImage: image))
                #else
                result = result + Text(Image(uiImage: image))
                #endif
            } else {
                result = result + Text(AttributedString(value.attributedSubstring(from: range)))
            }
        }
        return result
    }
}
