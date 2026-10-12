import Foundation
import SwiftUI
import CryptoKit

/// Prepared away from SwiftUI rendering. This is an internal presentation
/// primitive; registering a wire component requires catalog negotiation.
final class ConversationDetailRichContent: Sendable {
    enum Format: Hashable, Sendable { case markdown, chart }
    let blocks: [ConversationLocatedContentBlock]
    let retainedBytes: Int

    init(source: String, identity: String, format: Format) {
        switch format {
        case .markdown:
            // Chart fences in Markdown remain text. A chart is an explicit
            // component, not an implicit expansion of every Markdown field.
            blocks = ConversationMarkdownTables.parse(source, messageID: identity)
        case .chart:
            let parsed = ConversationChartBlocks.parseLocated(source, messageID: identity)
            if parsed.count == 1, case .chart = parsed[0].content {
                blocks = parsed
            } else {
                blocks = [.init(messageID: identity, startUTF16: 0, content: .markdown(source))]
            }
        }
        // Includes retained source, parsed cells and point labels. Conservative
        // accounting bounds cache growth without walking it during rendering.
        retainedBytes = source.utf16.count * 16 + blocks.reduce(0) { total, block in
            switch block.content {
            case .table(let table): total + 512 + table.rows.reduce(0) { $0 + $1.count * 256 } + table.rows.count * 128
            case .chart(let chart, _): total + 512 + chart.data.count * 256
            default: total + 512
            }
        }
    }
}

/// Per-consumer cache: no global retention across authentication scopes. The
/// actor performs parsing once per changed value and bounds entries and bytes.
actor ConversationDetailRichContentCache {
    struct Key: Hashable, Sendable {
        let scope: String
        let cardID: String
        let nodeID: String
    }
    struct Parameters: Hashable, Sendable {
        var rendererVersion: Int = 1
        var localeID: String = ""
    }
    private struct CacheKey: Hashable {
        let identity: Key
        let contentHash: SHA256.Digest
        let format: ConversationDetailRichContent.Format
        let parameters: Parameters
    }
    private struct Entry {
        let content: ConversationDetailRichContent
        let cost: Int
        var access: UInt64
    }
    private var entries: [CacheKey: Entry] = [:]
    private var sequence: UInt64 = 0
    private(set) var retainedBytes = 0
    private(set) var preparationCount = 0
    var entryCount: Int { entries.count }
    private let maximumEntries: Int
    private let maximumBytes: Int
    init(maximumEntries: Int = 64, maximumBytes: Int = 2 * 1024 * 1024) {
        self.maximumEntries = max(0, maximumEntries)
        self.maximumBytes = max(0, maximumBytes)
    }

    func content(key: Key, source: String, format: ConversationDetailRichContent.Format,
                 parameters: Parameters = .init()) async throws -> ConversationDetailRichContent {
        try Task.checkCancellation()
        guard source.utf8.count <= 256 * 1024 else { throw ClientDetailRichContentFailure.oversized }
        let cacheKey = CacheKey(identity: key, contentHash: SHA256.hash(data: Data(source.utf8)), format: format, parameters: parameters)
        sequence &+= 1
        if var entry = entries[cacheKey] {
            entry.access = sequence
            entries[cacheKey] = entry
            return entry.content
        }
        preparationCount += 1
        // Length-prefixed identity prevents separator collisions; no source or
        // credentials are put into presentation identifiers.
        let identity = SHA256.hash(data: Data([key.scope, key.cardID, key.nodeID].map { "\($0.utf8.count):\($0)" }.joined().utf8))
            .map { String(format: "%02x", $0) }.joined()
        let content = ConversationDetailRichContent(source: source, identity: identity, format: format)
        try Task.checkCancellation()
        let cost = content.retainedBytes + (key.scope.utf16.count + key.cardID.utf16.count + key.nodeID.utf16.count + parameters.localeID.utf16.count) * 2 + 512
        guard maximumEntries > 0, cost <= maximumBytes else { return content }
        entries[cacheKey] = .init(content: content, cost: cost, access: sequence)
        retainedBytes += cost
        while entries.count > maximumEntries || retainedBytes > maximumBytes {
            guard let oldest = entries.min(by: { $0.value.access < $1.value.access })?.key,
                  let removed = entries.removeValue(forKey: oldest) else { break }
            retainedBytes -= removed.cost
        }
        return content
    }

    func removeScope(_ scope: String) {
        for key in entries.keys.filter({ $0.identity.scope == scope }) {
            if let removed = entries.removeValue(forKey: key) { retainedBytes -= removed.cost }
        }
    }
    func removeAll() { entries.removeAll(); retainedBytes = 0 }
}

private enum ClientDetailRichContentFailure: Error { case oversized }

/// Width is supplied by the owning layout. There is no per-cell measurement
/// layer, network access or parser in body, and only tables scroll horizontally.
struct ConversationDetailRichContentView: View {
    private struct Block: Identifiable {
        let id: String
        let content: ConversationContentBlock
        let text: AttributedString?
        let tableLayout: ConversationMarkdownTableLayout?
    }
    private let blocks: [Block]
    init(content: ConversationDetailRichContent, width: CGFloat) {
        blocks = content.blocks.map { block in
            let text: AttributedString?
            let layout: ConversationMarkdownTableLayout?
            switch block.content {
            case .markdown(let source):
                // The existing native Markdown formatter has no HTML renderer
                // or image loader; links require an explicit platform handler.
                text = AttributedString(MessageMarkdown.make(text: source, style: .agent))
                layout = nil
            case .table(let table):
                text = nil
                layout = ConversationMarkdownTableLayout.measured(table, width: width)
            case .chart, .invalidChart:
                text = nil; layout = nil
            }
            return Block(id: block.id, content: block.content, text: text, tableLayout: layout)
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(blocks) { block in
                switch block.content {
                case .markdown:
                    if let text = block.text {
                        Text(text).textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                            .environment(\.openURL, OpenURLAction { _ in .discarded })
                    }
                case .table(let table):
                    if let layout = block.tableLayout {
                        ConversationMarkdownTableView(table: table, layout: layout)
                    }
                case .chart(let spec, _): ConversationChartView(spec: spec)
                case .invalidChart(let source, _): Text(verbatim: source).font(.caption)
                }
            }
        }
    }
}
