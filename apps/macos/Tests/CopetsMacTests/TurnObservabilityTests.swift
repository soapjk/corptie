import XCTest
@testable import CorptieMac

final class TurnObservabilityTests: XCTestCase {
    func testSummaryDecodesProviderNeutralIdentityAndAllTimingCategories() throws {
        let categories = ["queue", "dispatch", "context", "model", "tool", "mcp", "persistence", "delivery", "other"]
        let categoryJSON = categories.map { "\"\($0)\":{\"inclusiveMs\":1,\"estimateMs\":null,\"precise\":true}" }.joined(separator: ",")
        let data = Data("""
        {"summary":{"tenantId":"tenant:1","sessionId":"session:1","logicalTurnId":"turn:1","turnRunId":"turn_run:1",
        "providerId":"provider:1","providerSessionId":"native:1","bindingId":"binding:1","agentId":"agent:1",
        "objectiveId":"objective:1","workItemId":"work_item:1","workspaceId":"worktree:1","analysisVersion":"v1",
        "observabilityLevel":"native","wallClockMs":100,"criticalPathMs":80,"estimatedCriticalPathMs":null,
        "unattributedMs":5,"estimatedUnattributedMs":null,"categories":{\(categoryJSON)},"spanCount":9,
        "dataCompleteness":{"status":"complete","coverageRatio":0.95,"exact":true,"spanCount":9},"retryCount":1,
        "recovered":true,"startedAt":"2026-08-28T00:00:00Z","endedAt":"2026-08-28T00:00:01Z"}}
        """.utf8)
        let envelope = try JSONDecoder().decode(TurnTimeSummaryEnvelope.self, from: data)
        XCTAssertEqual(envelope.summary.turnRunId, "turn_run:1")
        XCTAssertEqual(Set(envelope.summary.categories.keys), Set(categories))
        XCTAssertEqual(envelope.summary.displayedCriticalPathMs, 80)
        XCTAssertTrue(envelope.summary.recovered)
    }

    func testLargeTraceUsesAggregationTier() {
        XCTAssertEqual(TurnTracePresentationTier.resolve(spanCount: 200), .spans)
        XCTAssertEqual(TurnTracePresentationTier.resolve(spanCount: 201), .categoryAggregation)
    }

    func testTraceDecodesDevelopmentOperationAndSafeCodeLocation() throws {
        let data = Data("""
        {"observabilityLevel":"native","spans":[{"traceId":"trace","spanId":"span","parentSpanId":null,
        "name":"code.search","startTimeUnixNano":"1000000","endTimeUnixNano":"3000000","status":"ok",
        "attributes":{"corptie.category":"tool","corptie.operation":"code.search",
        "corptie.operation.detail":"rg","corptie.activity.phase":"code-navigation","code.file.path":"apps/backend/src/server.mjs",
        "code.line.number":6985,"code.function.name":"route"}}]}
        """.utf8)
        let trace = try JSONDecoder().decode(TurnRawTrace.self, from: data)
        XCTAssertEqual(trace.spans[0].operation, "code.search")
        XCTAssertEqual(trace.spans[0].operationDetail, "rg")
        XCTAssertEqual(trace.spans[0].activityPhase, "code-navigation")
        XCTAssertEqual(trace.spans[0].codeLocation, "apps/backend/src/server.mjs:6985 · route")
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
        XCTAssertTrue(source.contains("span.operationDetail ?? span.name"))
        XCTAssertFalse(source.contains(".onReceive("))
        XCTAssertFalse(source.contains("ServerSentEvents"))
        XCTAssertTrue(source.contains("TurnTracePresentationTier.resolve(spanCount:"))
    }
}
