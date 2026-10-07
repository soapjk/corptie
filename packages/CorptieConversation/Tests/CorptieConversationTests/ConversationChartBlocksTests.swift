import Foundation
import Testing
#if os(macOS)
import AppKit
import SwiftUI
#endif
@testable import CorptieConversation

@Test func chartRemainsInsideOneOrderedMessage() {
    let source = "Before\n\n```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Compare\",\"data\":[{\"label\":\"A\",\"value\":2}]}\n```\n\nAfter"
    let blocks = ConversationChartBlocks.parse(source)
    #expect(blocks.count == 3)
    #expect(blocks[0] == .markdown("Before\n\n"))
    #expect(blocks[2] == .markdown("\nAfter"))
    guard case .chart(let chart, let original) = blocks[1] else {
        Issue.record("Expected chart in the original message position")
        return
    }
    #expect(chart.kind == .bar)
    #expect(chart.data.first?.value == 2)
    #expect(source.contains(original))
}

@Test func incompleteAndInvalidChartsRemainOriginalMarkdown() {
    let incomplete = "text\n```corptie-chart\n{\"version\":1"
    #expect(ConversationChartBlocks.parse(incomplete) == [.markdown(incomplete)])
    let invalid = "```corptie-chart\n{\"version\":1,\"type\":\"pie\",\"title\":\"Bad\",\"data\":[{\"label\":\"A\",\"value\":0}]}\n```"
    guard case .invalidChart(let original, let reason) = ConversationChartBlocks.parse(invalid).first else {
        Issue.record("Invalid chart should explain its raw fallback")
        return
    }
    #expect(original == invalid)
    #expect(reason.contains("无效"))
    let ordinary = "```json\n```corptie-chart\n{}\n```\n```"
    #expect(ConversationChartBlocks.parse(ordinary) == [.markdown(ordinary)])
}

@Test func markdownCodeContextsCannotImpersonateChartFences() {
    let chart = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Real\",\"data\":[{\"label\":\"A\",\"value\":2}]}\n```"
    let indented = chart.components(separatedBy: "\n").map { "    " + $0 }.joined(separator: "\n")
    #expect(ConversationChartBlocks.parse(indented) == [.markdown(indented)])
    let nested = "````markdown\n\(chart)\n````\n"
    #expect(ConversationChartBlocks.parse(nested) == [.markdown(nested)])
    let tilde = "~~~markdown\n\(chart)\n~~~\n"
    #expect(ConversationChartBlocks.parse(tilde) == [.markdown(tilde)])
    let after = ConversationChartBlocks.parse(nested + chart)
    #expect(after.count == 2)
    #expect(after[0] == .markdown(nested))
    if case .chart(let spec, _) = after[1] {
        #expect(spec.title == "Real")
    } else { Issue.record("A chart following a closed outer fence should render") }
    let threeSpaces = "   " + chart.replacingOccurrences(of: "\n```", with: "\n   ```")
    #expect(ConversationChartBlocks.parse(threeSpaces).contains {
        if case .chart = $0 { true } else { false }
    })
}

@Test func chartTypesHaveStrictDataShapes() {
    let line = "```corptie-chart\n{\"version\":1,\"type\":\"line\",\"title\":\"Trend\",\"data\":[{\"x\":1,\"value\":2},{\"x\":2,\"value\":3}]}\n```"
    #expect(ConversationChartBlocks.parse(line).count == 1)
    guard case .chart(let spec, _) = ConversationChartBlocks.parse(line)[0] else {
        Issue.record("Expected numeric line chart")
        return
    }
    #expect(spec.kind == .line)
    let unsorted = line.replacingOccurrences(of: "\"x\":2", with: "\"x\":0")
    #expect(ConversationChartBlocks.parse(unsorted).count == 1)
    if case .invalidChart(let original, _) = ConversationChartBlocks.parse(unsorted).first {
        #expect(original == unsorted)
    } else { Issue.record("Expected invalid chart fallback") }
    let future = line.replacingOccurrences(of: "\"version\":1", with: "\"version\":2")
    if case .invalidChart(let original, _) = ConversationChartBlocks.parse(future).first {
        #expect(original == future)
    } else { Issue.record("Expected unknown-version fallback") }
}

@Test func duplicateBarOrPieCategoriesKeepTheOriginalFence() {
    for kind in ["bar", "pie"] {
        let source = "```corptie-chart\n{\"version\":1,\"type\":\"\(kind)\",\"title\":\"Duplicate\",\"data\":[{\"label\":\"A\",\"value\":2},{\"label\":\" A \",\"value\":3}]}\n```"
        guard case .invalidChart(let original, _) = ConversationChartBlocks.parse(source).first else {
            Issue.record("Repeated \(kind) category must not silently aggregate")
            continue
        }
        #expect(original == source)
    }
}

@Test func lineChartAcceptsCompleteISO8601DatesButRejectsTrailingGarbage() {
    let source = "```corptie-chart\n{\"version\":1,\"type\":\"line\",\"title\":\"Daily\",\"data\":[{\"x\":\"2026-09-24\",\"value\":2},{\"x\":\"2026-09-25\",\"value\":3}]}\n```"
    guard case .chart(let spec, _) = ConversationChartBlocks.parse(source).first else {
        Issue.record("A date-only ISO-8601 line chart should render")
        return
    }
    #expect(spec.kind == .line)
    #expect(spec.data.count == 2)
    if case .date(let day, let source) = spec.data[1].x {
        #expect(source == "2026-09-25")
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let components = calendar.dateComponents([.year, .month, .day], from: day)
        #expect(components.year == 2026)
        #expect(components.month == 9)
        #expect(components.day == 25)
    } else { Issue.record("Date-only X values must remain local calendar dates") }
    let malformed = source.replacingOccurrences(of: "2026-09-25", with: "2026-09-25junk")
    if case .invalidChart = ConversationChartBlocks.parse(malformed).first {
        // Reject an apparent date whose formatter would silently parse a prefix.
    } else { Issue.record("A malformed date must retain its source text") }
    let timestamps = source.replacingOccurrences(of: "2026-09-24", with: "2026-09-24T10:00:00Z")
        .replacingOccurrences(of: "2026-09-25", with: "2026-09-25T10:00:00.125+08:00")
    if case .chart(let timestampSpec, _) = ConversationChartBlocks.parse(timestamps).first {
        #expect(timestampSpec.data.count == 2)
        #expect(ConversationChartDataText.label(for: timestampSpec.data[1], index: 1)
            == "2026-09-25T10:00:00.125+08:00")
    } else { Issue.record("Timezone-qualified ISO-8601 timestamps should render") }
    let malformedTimestamp = timestamps.replacingOccurrences(of: "+08:00", with: "+08:00junk")
    if case .invalidChart = ConversationChartBlocks.parse(malformedTimestamp).first {
    } else { Issue.record("A timestamp with trailing garbage must be rejected") }
    for impossibleDate in ["2026-02-29", "2026-02-30"] {
        let invalidDate = source.replacingOccurrences(of: "2026-09-25", with: impossibleDate)
        if case .invalidChart = ConversationChartBlocks.parse(invalidDate).first {
        } else { Issue.record("An impossible calendar date must retain its source text") }
    }
    let invalidOffset = timestamps.replacingOccurrences(of: "+08:00", with: "+25:00")
    if case .invalidChart = ConversationChartBlocks.parse(invalidOffset).first {
    } else { Issue.record("An out-of-range UTC offset must retain its source text") }
}

@Test func chartDataTextPreservesSmallValuesAndNumericXPrecision() {
    let source = "```corptie-chart\n{\"version\":1,\"type\":\"line\",\"title\":\"Precision\",\"data\":[{\"x\":1.23456789,\"value\":0.000000123456789}]}\n```"
    guard case .chart(let spec, _) = ConversationChartBlocks.parse(source).first else {
        Issue.record("Expected a valid precise numeric chart")
        return
    }
    let label = ConversationChartDataText.label(for: spec.data[0], index: 0)
    let value = ConversationChartDataText.value(for: spec.data[0], unit: nil)
    #expect(Double(label) == 1.23456789)
    #expect(Double(value) == 0.000000123456789)
    #expect(value != "0")
}

@Test func multipleChartsPreserveOrderAndBoundedFallback() {
    let chart = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"项目\",\"data\":[{\"label\":\"甲\",\"value\":1}]}\n```"
    let source = (0..<5).map { "段落\($0)\n\(chart)" }.joined(separator: "\n")
    let blocks = ConversationChartBlocks.parse(source)
    #expect(blocks.count == 10)
    #expect(blocks.filter { if case .chart = $0 { true } else { false } }.count == 4)
    guard case .invalidChart(let original, let reason) = blocks.last else {
        Issue.record("Fifth chart should preserve its original fenced source")
        return
    }
    #expect(original == chart)
    #expect(reason.contains("4"))
}

@Test func manyInvalidChartFencesKeepOriginalTextWithoutManyErrorViews() {
    let invalid = "```corptie-chart\n{bad json}\n```"
    let valid = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Valid\",\"data\":[{\"label\":\"A\",\"value\":1}]}\n```"
    let source = Array(repeating: invalid, count: 40).joined(separator: "\n") + "\n" + valid
    let blocks = ConversationChartBlocks.parse(source)
    #expect(blocks.filter { if case .invalidChart = $0 { true } else { false } }.count
        == ConversationChartBlocks.maximumCharts)
    #expect(blocks.filter { if case .chart = $0 { true } else { false } }.count == 1)
    let reconstructed = blocks.map { block in
        switch block {
        case .markdown(let text): text
        case .table(let table): table.originalText
        case .chart(_, let original), .invalidChart(let original, _): original
        }
    }.joined()
    #expect(reconstructed == source)
}

@Test @MainActor func finalTextReplacementRecomputesTheSameMessage() {
    let original = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Before\",\"data\":[{\"label\":\"A\",\"value\":1}]}\n```"
    let revised = original.replacingOccurrences(of: "Before", with: "After")
    let cache = ConversationChartBlockCache()
    #expect(cache.blocks(messageID: "message:one", authoritativeText: original)
        == cache.blocks(messageID: "message:one", authoritativeText: original))
    guard case .chart(let spec, _) = cache.blocks(messageID: "message:one", authoritativeText: revised).first else {
        Issue.record("Authoritative replacement should reparse the existing message")
        return
    }
    #expect(spec.title == "After")
}

@Test @MainActor func completedChartKeepsItsIdentityAcrossAppendOnlyStreaming() {
    let chart = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"A\",\"data\":[{\"label\":\"甲\",\"value\":1}]}\n```"
    let prefix = "😀 before\n"
    let first = prefix + chart
    let cache = ConversationChartBlockCache()
    let initial = cache.locatedBlocks(messageID: "message:stream", authoritativeText: first)
    let appended = cache.locatedBlocks(messageID: "message:stream", authoritativeText: first + "\nAfter")
    #expect(initial.count == 2)
    #expect(appended.count == 3)
    #expect(initial[1].id == appended[1].id)
    #expect(initial[1].startUTF16 == prefix.utf16.count)
    #expect(appended[2].id == "message:stream:\((prefix + chart + "\n").utf16.count)")

    let unfinished = cache.locatedBlocks(messageID: "message:stream",
        authoritativeText: prefix + "```corptie-chart\n{\"version\":1")
    #expect(unfinished.count == 1)
    #expect(unfinished[0].content == .markdown(prefix + "```corptie-chart\n{\"version\":1"))
}

@Test @MainActor func chartStreamingParseBenchmark() {
    guard ProcessInfo.processInfo.environment["CORPTIE_CHART_BENCHMARK"] == "1" else { return }
    let chart = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Streaming\",\"data\":[{\"label\":\"A\",\"value\":1}]}\n```"
    let cache = ConversationChartBlockCache()
    var text = chart
    var samples: [Double] = []
    for index in 0..<300 {
        text += "\nExplanation chunk \(index): " + String(repeating: "x", count: 200)
        let start = ProcessInfo.processInfo.systemUptime
        let blocks = cache.locatedBlocks(messageID: "message:stream-benchmark", authoritativeText: text)
        let elapsedMilliseconds = (ProcessInfo.processInfo.systemUptime - start) * 1_000
        #expect(blocks.count == 2)
        if index >= 20 { samples.append(elapsedMilliseconds) }
    }
    samples.sort()
    let p50 = samples[samples.count / 2]
    let p95 = samples[Int(Double(samples.count - 1) * 0.95)]
    let total = samples.reduce(0, +)
    print("Chart streaming parser: 300 updates, final UTF-16 length \(text.utf16.count), warm p50 \(p50) ms, p95 \(p95) ms, 280-update total \(total) ms")
}

#if os(macOS)
@Test @MainActor func oneHundredCategoryBarChartKeepsTheMeasuredCardHeight() {
    let points = (0..<100).map { "{\"label\":\"类别\($0)\",\"value\":\($0 + 1)}" }.joined(separator: ",")
    let source = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"100 categories\",\"data\":[\(points)]}\n```"
    guard case .chart(let spec, _) = ConversationChartBlocks.parse(source).first else {
        Issue.record("Expected a valid maximum-size category chart")
        return
    }
    let width: CGFloat = 300
    let expected = ConversationChartView.measuredHeight(spec: spec, width: width)
    let host = NSHostingView(rootView: ConversationChartView(spec: spec).frame(width: width))
    host.frame = NSRect(x: 0, y: 0, width: width, height: 1)
    host.layoutSubtreeIfNeeded()
    #expect(spec.data.count == 100)
    #expect(abs(host.fittingSize.height - expected) < 1)
}
#endif
