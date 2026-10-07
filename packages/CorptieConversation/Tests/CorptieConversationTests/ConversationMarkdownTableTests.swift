import Foundation
import Testing
@testable import CorptieConversation

private func tables(_ text: String) -> [ConversationMarkdownTable] {
    ConversationMarkdownTables.parse(text).compactMap {
        if case .table(let value) = $0.content { return value }; return nil
    }
}

@Test func gfmTablesRetainAlignmentAndInlineFormatting() throws {
    let source = "前文中文😀\n\n| 名称 | 数量 |\n| :--- | ---: |\n| **BTC** | `42` |\n\n后文"
    let blocks = ConversationMarkdownTables.parse(source, messageID: "one")
    #expect(blocks.count == 3)
    let table = try #require(tables(source).first)
    #expect(table.alignments == [.left, .right])
    #expect(table.rows.count == 2)
    #expect(table.rows[1][0].plainText == "BTC")
    #expect(table.rows[1][0].markdown.contains("**BTC**"))
    #expect(table.tabSeparatedText == "名称\t数量\nBTC\t42")
    let reconstructed = blocks.map {
        switch $0.content {
        case .markdown(let text): text
        case .table(let value): value.originalText
        default: ""
        }
    }.joined()
    #expect(reconstructed == source)
    #expect(blocks[1].startUTF16 == "前文中文😀\n\n".utf16.count)
}

@Test func tablesHandleEscapesOptionalBordersAndMissingCells() throws {
    let source = "A | B | C\n--- | :---: | ---:\nx\\|y | [link](https://example.com)\na | b | c | ignored\n"
    let table = try #require(tables(source).first)
    #expect(table.alignments == [.left, .center, .right])
    #expect(table.rows[1].count == 3)
    #expect(table.rows[1][0].plainText == "x|y")
    #expect(table.rows[1][2].plainText.isEmpty)
    #expect(table.rows[2].count == 3)
    #expect(table.rows[1][1].markdown.contains("https://example.com"))
}

@Test func codeFencesAndInvalidDelimitersStayText() {
    for source in ["```\n| A | B |\n| --- | --- |\n```", "| A | B |\n| --- |\n", "A | B\nnot a delimiter"] {
        #expect(tables(source).isEmpty)
        #expect(ConversationMarkdownTables.parse(source).count == 1)
    }
}

@Test func windowsNewlinesKeepTableAndFollowingTextSeparate() throws {
    let source = "Before\r\n\r\n| A | B |\r\n| --- | --- |\r\n| 1 | 2 |\r\n\r\nAfter"
    let blocks = ConversationMarkdownTables.parse(source)
    #expect(blocks.count == 3)
    #expect(tables(source).first?.rows.count == 2)
    guard case .markdown(let after) = blocks.last?.content else {
        Issue.record("Following text must stay outside table"); return
    }
    #expect(after.contains("After"))
}

@Test func streamingAndFinalReplacementKeepSourceIdentity() throws {
    let prefix = "Intro\n\n| A | B |\n| --- | --- |\n"
    #expect(tables("Intro\n\n| A | B |").isEmpty)
    let first = ConversationMarkdownTables.parse(prefix, messageID: "stream")
    let appended = ConversationMarkdownTables.parse(prefix + "| next | 1 |\n", messageID: "stream")
    #expect(first[1].id == appended[1].id)
    #expect(tables(prefix + "| next | 1 |\n")[0].rows.count == 2)
    #expect(tables(prefix.replacingOccurrences(of: "A", with: "New"))[0].rows[0][0].plainText == "New")
}

@Test func excessiveTablesRemainCopyableWithoutAllocatingCells() throws {
    let source = "| A | B |\n| --- | --- |\n"
        + Array(repeating: "| value | 1 |", count: ConversationMarkdownTables.maximumRows).joined(separator: "\n")
    let table = try #require(tables(source).first)
    #expect(table.exceedsDisplayBudget)
    #expect(table.rows.isEmpty)
    #expect(table.originalText == source)
}

@Test @MainActor func tableLayoutIsBoundedAndSharedWithMeasurement() throws {
    let table = try #require(tables("| Name | Description | Number |\n| --- | --- | ---: |\n| BTC | 很长的中文内容需要自然换行，而不是撑宽整个聊天页面。 | 12 |\n").first)
    let phone = ConversationMarkdownTableLayout.measured(table, width: 180)
    #expect(phone.viewportWidth == 180)
    #expect(phone.contentWidth >= 216)
    #expect(phone.columnWidths.allSatisfy { $0 >= 72 && $0 <= 260 })
    #expect(phone.rowHeights.count == table.rows.count)
    #expect(phone.height == phone.rowHeights.reduce(0, +) + 12)
    #expect(phone === ConversationMarkdownTableLayout.measured(table, width: 180))
    let wide = ConversationMarkdownTableLayout.measured(table, width: 600)
    #expect(wide.height <= phone.height)
}

@Test @MainActor func tableAndChartShareContentCacheWithoutLosingBlocks() throws {
    let chart = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Test\",\"data\":[{\"label\":\"A\",\"value\":1}]}\n```"
    let source = "| A | B |\n| --- | --- |\n| x | y |\n\n" + chart
    let blocks = ConversationChartBlockCache.shared.locatedBlocks(messageID: "mixed-table-chart", authoritativeText: source)
    #expect(blocks.contains { if case .table = $0.content { true } else { false } })
    #expect(blocks.contains { if case .chart = $0.content { true } else { false } })
    let changed = ConversationChartBlockCache.shared.locatedBlocks(messageID: "mixed-table-chart", authoritativeText: "plain")
    #expect(changed.count == 1)
    #expect(changed[0].content == .markdown("plain"))
}

@Test @MainActor func tableParsingAndLayoutPerformanceProbe() throws {
    var cold: [Double] = []
    var warm: [Double] = []
    for index in 0..<100 {
        let source = "| Name | Description | Value |\n| --- | --- | ---: |\n"
            + (0..<10).map { "| BTC\(index)-\($0) | 中文说明、**重点**和`代码` | \($0) |" }.joined(separator: "\n")
        let start = ProcessInfo.processInfo.systemUptime
        let table = try #require(tables(source).first)
        _ = ConversationMarkdownTableLayout.measured(table, width: 320)
        cold.append((ProcessInfo.processInfo.systemUptime - start) * 1_000)
        let cachedStart = ProcessInfo.processInfo.systemUptime
        _ = ConversationMarkdownTableLayout.measured(table, width: 320)
        warm.append((ProcessInfo.processInfo.systemUptime - cachedStart) * 1_000)
    }
    cold.sort(); warm.sort()
    print("TABLE_PARSE_LAYOUT rows=11 columns=3 cold_p50_ms=\(cold[50]) cold_p95_ms=\(cold[95]) cached_p95_ms=\(warm[95])")
}
