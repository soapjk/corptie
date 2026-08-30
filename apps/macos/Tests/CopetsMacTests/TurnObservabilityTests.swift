import XCTest
@testable import CorptieMac

final class TurnTimelineV4Tests: XCTestCase {
    func testSummaryDecodesProviderNeutralIdentityAndWallUnion() throws {
        let data = Data("""
        {"summary":{"schemaVersion":4,"analysisVersion":"ct-obs-code-task-r4-a1",
        "identity":{"logicalSessionId":"session:1","turnId":"turn:1","turnExecutionId":"turn_execution:1",
        "providerBindingId":"binding:1","bindingGeneration":2},
        "wall":{"finalized":true,"wallClockMs":100,"observedWatermarkMs":null},
        "wallPartition":{"attributedUnionMs":95,"unattributedMs":5,"overlapMs":20},
        "inclusive":{"host.queue":10,"process.test":85},"spanCount":9,
        "completeness":{"state":"complete","droppedEventCount":0,"missingTerminal":false,"rawCaptureStatus":"available"}}}
        """.utf8)
        let envelope = try JSONDecoder().decode(TurnTimeSummaryEnvelope.self, from: data)
        XCTAssertEqual(envelope.summary.turnExecutionId, "turn_execution:1")
        XCTAssertEqual(Set(envelope.summary.categories.keys), Set(["host.queue", "process.test"]))
        XCTAssertEqual(envelope.summary.displayedCriticalPathMs, 95)
        XCTAssertEqual(envelope.summary.displayedUnattributedMs, 5)
        XCTAssertTrue(envelope.summary.dataCompleteness.exact)
    }

    func testLargeTraceUsesAggregationTier() {
        XCTAssertEqual(TurnTracePresentationTier.resolve(spanCount: 200), .spans)
        XCTAssertEqual(TurnTracePresentationTier.resolve(spanCount: 201), .categoryAggregation)
    }

    func testTimelinePageDecodesProviderNeutralSpanWithoutProviderPayload() throws {
        let data = Data("""
        {"schemaVersion":4,"turnExecutionId":"turn_execution:1","items":[{"kind":"span","traceId":"trace","spanId":"span",
        "parentSpanId":null,"operation":"process.search","intervalClass":"process.search",
        "startObservedAtUnixNano":"1000000","endObservedAtUnixNano":"3000000","status":"completed"}]}
        """.utf8)
        let trace = try JSONDecoder().decode(TurnRawTrace.self, from: data)
        XCTAssertEqual(trace.spans[0].operation, "process.search")
        XCTAssertNil(trace.spans[0].operationDetail)
        XCTAssertNil(trace.spans[0].codeLocation)
        XCTAssertEqual(trace.spans[0].durationMs, 2)
    }

    func testSessionSurfaceStartsCollapsedLoadsOnlySummaryAndDoesNotSubscribeToLiveTelemetry() throws {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("Sources/CopetsMac/TurnObservability.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)
        XCTAssertTrue(source.contains("@State private var isAnalysisExpanded = false"))
        XCTAssertTrue(source.contains("@State private var isTraceExpanded = false"))
        XCTAssertTrue(source.contains("Text(\"上一次 \\(durationText(summary.wallClockMs))\")"))
        XCTAssertTrue(source.contains("await model.loadSummary(sessionId: sessionId)"))
        XCTAssertTrue(source.contains("if isTraceExpanded { await model.loadTraceIfNeeded() }"))
        XCTAssertTrue(source.contains("推断用途：为下一步"))
        XCTAssertTrue(source.contains("Provider 未提供安全阶段标签"))
        XCTAssertTrue(source.contains("Text(\"最慢操作\")"))
        XCTAssertTrue(source.contains("Trace 加载失败"))
        XCTAssertTrue(source.contains("span.operationDetail ?? span.operation"))
        XCTAssertFalse(source.contains(".onReceive("))
        XCTAssertFalse(source.contains("ServerSentEvents"))
        XCTAssertTrue(source.contains("TurnTracePresentationTier.resolve(spanCount:"))
    }
}
