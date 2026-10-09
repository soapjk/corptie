import Testing
@testable import CorptieConversation

private func parseSeries(_ points: String) -> ConversationContentBlock? {
    ConversationChartBlocks.parse("```corptie-chart\n{\"version\":1,\"type\":\"line\",\"title\":\"Latency\",\"data\":\(points)}\n```").first
}

@Test func multipleSeriesKeepIndependentOrderingAndDoNotInventPoints() {
    guard case .chart(let spec, _) = parseSeries(#"[{"x":1,"value":20,"series":"SG"},{"x":2,"value":30,"series":"SG"},{"x":1,"value":40,"series":"US"}]"#) else {
        Issue.record("Expected multi-series chart"); return
    }
    #expect(spec.data.count == 3)
    #expect(spec.data.last?.series == "US")
    #expect(ConversationChartDataText.label(for: spec.data[0], index: 0) == "SG · 1")
}

@Test func seriesRejectDuplicateXAndAmbiguousNames() {
    for points in [
        #"[{"x":1,"value":20,"series":"SG"},{"x":1,"value":30,"series":"SG"}]"#,
        #"[{"x":1,"value":20},{"x":2,"value":30,"series":"SG"}]"#,
        #"[{"x":1,"value":20,"series":" "}]"#
    ] {
        guard case .invalidChart = parseSeries(points) else { Issue.record("Invalid series accepted"); continue }
    }
}

@Test func localResourcesDeduplicateAndExcludeWebURLs() {
    let items = ConversationLocalResource.parse("![chart](</tmp/a b.png>) [download](</tmp/a b.png>) [web](https://example.com/a.png) [csv](/tmp/a.csv)")
    #expect(items.count == 2)
    #expect(items.first?.isImage == true)
    #expect(items.first?.fileName == "a b.png")
    #expect(items.last?.isImage == false)
}
