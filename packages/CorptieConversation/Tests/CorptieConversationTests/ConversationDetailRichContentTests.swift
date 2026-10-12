import Foundation
import Testing
import SwiftUI
#if os(macOS)
import AppKit
#endif
@testable import CorptieConversation

struct ConversationDetailRichContentTests {
    private let table = "| Resource | State |\n| --- | --- |\n| Task | Ready |"
    private let chart = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Count\",\"data\":[{\"label\":\"A\",\"value\":2}]}\n```"
    private func key(_ node: String, scope: String = "user/server/session") -> ConversationDetailRichContentCache.Key {
        .init(scope: scope, cardID: "resources", nodeID: node)
    }

    @Test func repeatedValuesReusePreparationAndIdentity() async throws {
        let cache = ConversationDetailRichContentCache()
        let first = try await cache.content(key: key("table"), source: table, format: .markdown)
        let second = try await cache.content(key: key("table"), source: table, format: .markdown)
        #expect(first === second)
        #expect(await cache.preparationCount == 1)
        let changed = try await cache.content(key: key("table"), source: table + "\n| Work | Done |", format: .markdown)
        #expect(first !== changed)
        #expect(first.blocks.first?.id == changed.blocks.first?.id)
        #expect(await cache.preparationCount == 2)
    }

    @Test func scopesAndFormatsDoNotShareCachedContent() async throws {
        let cache = ConversationDetailRichContentCache()
        let markdown = try await cache.content(key: key("chart"), source: chart, format: .markdown)
        #expect(!markdown.blocks.contains { if case .chart = $0.content { true } else { false } })
        let plotted = try await cache.content(key: key("chart"), source: chart, format: .chart)
        #expect(plotted.blocks.count == 1)
        #expect(plotted.blocks.contains { if case .chart = $0.content { true } else { false } })
        let other = try await cache.content(key: key("chart", scope: "other-user"), source: chart, format: .chart)
        #expect(plotted !== other)
        #expect(plotted.blocks.first?.id != other.blocks.first?.id)
        await cache.removeScope("user/server/session")
        let refreshed = try await cache.content(key: key("chart"), source: chart, format: .chart)
        #expect(refreshed !== plotted)
        let retained = try await cache.content(key: key("chart", scope: "other-user"), source: chart, format: .chart)
        #expect(retained === other)
    }

    @Test func cacheEvictsOldestAndRejectsOversizedRetention() async throws {
        let cache = ConversationDetailRichContentCache(maximumEntries: 2, maximumBytes: 8192)
        let first = try await cache.content(key: key("a"), source: table, format: .markdown)
        _ = try await cache.content(key: key("b"), source: table, format: .markdown)
        _ = try await cache.content(key: key("c"), source: table, format: .markdown)
        let evicted = try await cache.content(key: key("a"), source: table, format: .markdown)
        #expect(evicted !== first)
        _ = try await cache.content(key: key("huge"), source: String(repeating: "x", count: 8192), format: .markdown)
        #expect(await cache.retainedBytes <= 8192)
        await cache.removeScope("user/server/session")
        #expect(await cache.retainedBytes == 0)
    }

    @Test func concurrentRequestsPrepareOnceAndParametersInvalidate() async throws {
        let cache = ConversationDetailRichContentCache()
        let key = key("table"), source = table
        let contents = try await withThrowingTaskGroup(of: ConversationDetailRichContent.self) { group in
            for _ in 0..<32 { group.addTask { try await cache.content(key: key, source: source, format: .markdown) } }
            var values: [ConversationDetailRichContent] = []
            for try await value in group { values.append(value) }
            return values
        }
        #expect(contents.allSatisfy { $0 === contents[0] })
        #expect(await cache.preparationCount == 1)
        let localized = try await cache.content(key: key, source: source, format: .markdown, parameters: .init(rendererVersion: 1, localeID: "zh_CN"))
        let changedVersion = try await cache.content(key: key, source: source, format: .markdown, parameters: .init(rendererVersion: 2, localeID: "zh_CN"))
        #expect(contents[0] !== localized && localized !== changedVersion)
        #expect(await cache.preparationCount == 3)
    }

    @Test func lruTouchAndParsedMemoryAccountingStayBounded() async throws {
        let cache = ConversationDetailRichContentCache(maximumEntries: 2, maximumBytes: 16384)
        let a = try await cache.content(key: key("a"), source: table, format: .markdown)
        let b = try await cache.content(key: key("b"), source: table, format: .markdown)
        _ = try await cache.content(key: key("a"), source: table, format: .markdown)
        _ = try await cache.content(key: key("c"), source: table, format: .markdown)
        #expect(try await cache.content(key: key("a"), source: table, format: .markdown) === a)
        #expect(try await cache.content(key: key("b"), source: table, format: .markdown) !== b)
        #expect(await cache.entryCount == 2)
        #expect(await cache.retainedBytes > table.utf8.count * 2)
        for i in 0..<100 {
            _ = try await cache.content(key: key(String(i)), source: String(repeating: "x", count: 32768), format: .markdown)
        }
        #expect(await cache.retainedBytes <= 16384)
        #expect(await cache.entryCount <= 2)
        await cache.removeAll()
        #expect(await cache.retainedBytes == 0)
    }

    private actor Gate {
        var continuation: CheckedContinuation<Void, Never>?
        var released = false
        func wait() async {
            if !released { await withCheckedContinuation { continuation = $0 } }
        }
        func release() { released = true; continuation?.resume(); continuation = nil }
    }
    @Test func canceledAndOversizedWorkCannotPublishOrGrowCache() async throws {
        let cache = ConversationDetailRichContentCache(), gate = Gate(), key = key("canceled"), source = table
        let task = Task { await gate.wait(); return try await cache.content(key: key, source: source, format: .markdown) }
        task.cancel(); await gate.release()
        do { _ = try await task.value; Issue.record("Canceled cache request returned content") }
        catch { #expect(error is CancellationError) }
        #expect(await cache.preparationCount == 0)
        do {
            _ = try await cache.content(key: key, source: String(repeating: "x", count: 256 * 1024 + 1), format: .markdown)
            Issue.record("Oversized input was parsed")
        } catch { }
        #expect(await cache.entryCount == 0)
        #expect(await cache.retainedBytes == 0)
    }

    @Test func invalidChartAndMultipleChartsFallBackToText() {
        for source in [chart.replacingOccurrences(of: "\"value\":2", with: "\"value\":null"), chart + "\n" + chart] {
            let content = ConversationDetailRichContent(source: source, identity: "fixture", format: .chart)
            #expect(content.blocks.count == 1)
            #expect(content.blocks.first?.content == .markdown(source))
        }
    }

    @MainActor @Test func nativeTableAndChartFitDetailWidths() {
        #if os(macOS)
        for source in [table, chart] {
            let content = ConversationDetailRichContent(source: source, identity: "fixture", format: source == table ? .markdown : .chart)
            for width in [240.0, 375.0, 768.0] {
                let view = NSHostingView(rootView: ConversationDetailRichContentView(content: content, width: width).frame(width: width))
                view.frame = NSRect(x: 0, y: 0, width: width, height: 500)
                view.layoutSubtreeIfNeeded()
                #expect(abs(view.fittingSize.width - width) < 1)
                #expect(view.fittingSize.height > 20)
                #expect(view.fittingSize.height < 500)
            }
        }
        #endif
    }
}
