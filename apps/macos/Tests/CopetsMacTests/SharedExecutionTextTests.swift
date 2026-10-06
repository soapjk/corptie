import AppKit
import SwiftUI
import XCTest
import CorptieConversation
import CorptieClientCore
@testable import CorptieMac

@MainActor
final class SharedExecutionTextTests: XCTestCase {
    func testNativeChecklistUsesExactShortHeightAndBoundsLongPlans() throws {
        func plan(count: Int, completed: Int, revision: Int) throws -> ConversationExecutionPlan {
            let source: [String: Any] = [
                "schemaVersion": 1, "planId": "plan:height-probe", "revision": revision,
                "lifecycle": "active", "updatedAt": "2026-09-25T00:00:00Z",
                "steps": (0..<count).map { index in [
                    "stepId": "step:\(index)", "ordinal": index,
                    "text": "检查第 \(index) 项及其较长的说明，确保窄卡片会正确换行",
                    "status": index < completed ? "completed" : "pending"
                ] as [String: Any] }
            ]
            return try JSONDecoder().decode(ConversationExecutionPlan.self,
                from: JSONSerialization.data(withJSONObject: source))
        }
        func layout(for plan: ConversationExecutionPlan, revision: Int) -> NativeTimelineLayoutCache.Layout {
            let step = NativeExecutionTimelineStep(id: "item:plan", kind: .action,
                state: .running, title: "Plan", detail: nil, plan: plan)
            let row = AppKitChatTimelineRow(id: "process:plan-layout", contentRevision: revision,
                nativeText: "", copyText: "", nativeStyle: .process,
                title: "", metadata: "", expandableTurnId: "turn:plan", isExpanded: true,
                processCount: 1, processSteps: [step], showsHeader: false)
            return NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 360)
        }
        let short = try plan(count: 3, completed: 1, revision: 1)
        let first = layout(for: short, revision: 1)
        let block = try XCTUnwrap(first.processBlocks.first)
        let width = first.cardWidth - 36
        let host = NSHostingView(rootView: ExecutionPlanChecklist(plan: short)
            .frame(width: width, alignment: .leading))
        host.frame = NSRect(x: 0, y: 0, width: width, height: 1)
        host.layoutSubtreeIfNeeded()
        XCTAssertEqual(block.textHeight, ceil(host.fittingSize.height), accuracy: 1)
        XCTAssertEqual(block.attributedText.length, 0)

        let measuredBefore = NativePlanChecklistHeightCache.shared.measurementCount
        let statusUpdate = try plan(count: 3, completed: 2, revision: 2)
        let second = layout(for: statusUpdate, revision: 2)
        XCTAssertEqual(second.processBlocks[0].textHeight, block.textHeight)
        XCTAssertEqual(NativePlanChecklistHeightCache.shared.measurementCount, measuredBefore,
            "Changing only completion status must not remeasure checklist text")

        let long = layout(for: try plan(count: 200, completed: 5, revision: 3), revision: 3)
        XCTAssertEqual(long.processBlocks[0].textHeight, 300)
        XCTAssertLessThan(long.rowHeight, 400)
    }

    func testNativeChecklistRevisionLayoutBenchmark() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_PLAN_BENCHMARK"] == "1" else {
            throw XCTSkip("Set CORPTIE_PLAN_BENCHMARK=1 for 1/20/200-step native checklist layout measurements")
        }
        for stepCount in [1, 20, 200] {
            let rows: [AppKitChatTimelineRow] = try (0..<120).map { revision in
                let planSource: [String: Any] = [
                    "schemaVersion": 1, "planId": "plan:ui-benchmark:\(stepCount)",
                    "revision": revision + 1, "lifecycle": "active",
                    "updatedAt": "2026-09-25T00:00:00Z",
                    "steps": (0..<stepCount).map { index in [
                        "stepId": "step:\(index)", "ordinal": index,
                        "text": "Benchmark step \(index) with stable wording across revisions",
                        "status": index <= revision % stepCount ? "completed" : "pending"
                    ] as [String: Any] }
                ]
                let plan = try JSONDecoder().decode(ConversationExecutionPlan.self,
                    from: JSONSerialization.data(withJSONObject: planSource))
                let step = NativeExecutionTimelineStep(id: "item:ui-benchmark:\(stepCount)",
                    kind: .action, state: .running, title: "Plan", detail: nil, plan: plan)
                return AppKitChatTimelineRow(id: "process:ui-benchmark:\(stepCount)",
                    contentRevision: revision + 1, nativeText: "", copyText: "",
                    nativeStyle: .process, title: "", metadata: "",
                    expandableTurnId: "turn:ui-benchmark:\(stepCount)", isExpanded: true,
                    processCount: 1, processSteps: [step], showsHeader: false)
            }
            let measurementBefore = NativePlanChecklistHeightCache.shared.measurementCount
            var samples: [Double] = []
            for (index, row) in rows.enumerated() {
                let start = ProcessInfo.processInfo.systemUptime
                let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 360)
                let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1_000
                XCTAssertEqual(layout.processBlocks.count, 1)
                XCTAssertLessThan(layout.rowHeight, 400)
                if index >= 20 { samples.append(elapsed) }
            }
            let newMeasurements = NativePlanChecklistHeightCache.shared.measurementCount - measurementBefore
            XCTAssertLessThanOrEqual(newMeasurements, stepCount == 1 ? 1 : 0)
            samples.sort()
            print("PLAN_UI_LAYOUT steps=\(stepCount) n=100 p50_ms=\(samples[50]) p95_ms=\(samples[95]) measured_short_checklists=\(newMeasurements)")
        }
    }

    func testChartAndImageShareOneMeasuredMessageRow() {
        let text = "Before\n```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Compare\",\"data\":[{\"label\":\"A\",\"value\":2}]}\n```\nAfter"
        let image = ChatTimelineImage(managedPath: "/tmp/chart-image.png",
            displayURL: URL(fileURLWithPath: "/tmp/chart-image.png"), originalPath: nil)
        let plain = AppKitChatTimelineRow(id: "message:chart-image", contentRevision: 1,
            nativeText: text, copyText: text, nativeStyle: .agent,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false)
        let mixed = AppKitChatTimelineRow(id: "message:chart-image", contentRevision: 2,
            nativeText: text, copyText: text, nativeStyle: .agent,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false, images: [image])
        XCTAssertTrue(MacSharedMessageTextCard.supports(mixed))
        let plainLayout = NativeTimelineLayoutCache.shared.layout(for: plain, columnWidth: 520)
        let mixedLayout = NativeTimelineLayoutCache.shared.layout(for: mixed, columnWidth: 520)
        XCTAssertEqual(mixedLayout.richBlocks.count, 3)
        XCTAssertEqual(mixedLayout.rowHeight, plainLayout.rowHeight + 96, accuracy: 0.5)
    }

    func testChartMessageWithActionsKeepsRichBlocksAndActionSpace() {
        let text = "Before\n```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Compare\",\"data\":[{\"label\":\"A\",\"value\":2}]}\n```\nAfter"
        let plain = AppKitChatTimelineRow(id: "message:chart-actions", contentRevision: 1,
            nativeText: text, copyText: text, nativeStyle: .agent,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false)
        let action = AppKitChatTimelineRow.Action(id: "choose", label: "Continue",
            isDestructive: false, kind: .sendMessage("Continue"))
        let actionable = AppKitChatTimelineRow(id: "message:chart-actions", contentRevision: 2,
            nativeText: text, copyText: text, nativeStyle: .agent,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false, actions: [action])
        XCTAssertTrue(MacSharedMessageTextCard.supports(actionable))
        let plainLayout = NativeTimelineLayoutCache.shared.layout(for: plain, columnWidth: 520)
        let actionLayout = NativeTimelineLayoutCache.shared.layout(for: actionable, columnWidth: 520)
        XCTAssertEqual(actionLayout.richBlocks.count, 3)
        XCTAssertEqual(actionLayout.rowHeight, plainLayout.rowHeight + 34, accuracy: 0.5)
    }

    func testBarLineAndPieRemainOrderedInsideOneMessageCard() {
        let text = """
        Overview
        ```corptie-chart
        {"version":1,"type":"bar","title":"Bar","data":[{"label":"A","value":2}]}
        ```
        Then the trend
        ```corptie-chart
        {"version":1,"type":"line","title":"Line","data":[{"x":1,"value":2},{"x":2,"value":3}]}
        ```
        Finally the split
        ```corptie-chart
        {"version":1,"type":"pie","title":"Pie","data":[{"label":"A","value":2},{"label":"B","value":3}]}
        ```
        Conclusion
        """
        let row = AppKitChatTimelineRow(id: "message:three-chart-kinds", contentRevision: 1,
            nativeText: text, copyText: text, nativeStyle: .agent,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false)
        XCTAssertTrue(MacSharedMessageTextCard.supports(row))

        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 320)
        XCTAssertEqual(layout.richBlocks.count, 7)
        let kinds = layout.richBlocks.compactMap { block -> ConversationChartSpec.Kind? in
            guard case .chart(_, let spec, _) = block else { return nil }
            return spec.kind
        }
        XCTAssertEqual(kinds, [.bar, .line, .pie])
        XCTAssertEqual(layout.rowHeight,
            NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 320).rowHeight)
        XCTAssertGreaterThan(layout.rowHeight, 3 * ConversationChartView.contentHeight)
    }

    func testInlineChartKeepsOneNativeMessageRowAndExactCachedHeight() {
        let text = "Before\n```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Compare\",\"data\":[{\"label\":\"A\",\"value\":2}]}\n```\nAfter"
        let row = AppKitChatTimelineRow(id: "message:chart", contentRevision: 1,
            nativeText: text, copyText: text, nativeStyle: .agent,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false)
        XCTAssertTrue(MacSharedMessageTextCard.supports(row))
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 520)
        XCTAssertEqual(layout.richBlocks.count, 3)
        XCTAssertGreaterThan(layout.textHeight, 150)
        XCTAssertEqual(layout.rowHeight, NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 520).rowHeight)
        if case .chart(_, let shortSpec, let shortHeight) = layout.richBlocks[1] {
            let shortHost = NSHostingView(rootView: ConversationChartView(spec: shortSpec)
                .frame(width: layout.cardWidth - 20))
            shortHost.frame = NSRect(x: 0, y: 0, width: layout.cardWidth - 20, height: 1)
            shortHost.layoutSubtreeIfNeeded()
            XCTAssertEqual(shortHost.fittingSize.height, shortHeight, accuracy: 1,
                "Short chart should fit its native row without extra empty height")
        }
        let longNote = String(repeating: "可核查来源说明。", count: 25)
        let withNote = text.replacingOccurrences(of: "\"data\":", with: "\"sourceNote\":\"\(longNote)\",\"data\":")
        let noteRow = AppKitChatTimelineRow(id: "message:chart-note", contentRevision: 1,
            nativeText: withNote, copyText: withNote, nativeStyle: .agent,
            title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
            showsHeader: false)
        let noteLayout = NativeTimelineLayoutCache.shared.layout(for: noteRow, columnWidth: 300)
        XCTAssertGreaterThan(noteLayout.rowHeight, layout.rowHeight)
        guard case .chart(_, let spec, let measuredHeight) = noteLayout.richBlocks.first(where: {
            if case .chart = $0 { return true }
            return false
        }) else {
            XCTFail("Expected measured chart block")
            return
        }
        let host = NSHostingView(rootView: ConversationChartView(spec: spec)
            .frame(width: noteLayout.cardWidth - 20))
        host.frame = NSRect(x: 0, y: 0, width: noteLayout.cardWidth - 20, height: 1)
        host.layoutSubtreeIfNeeded()
        let fitted = host.fittingSize.height
        XCTAssertEqual(fitted, measuredHeight, accuracy: 1,
            "Chart with a long source note should fit the native row exactly")
    }

    func testChartBlockFitsNarrowAndWideCardsWithMaximumMetadata() throws {
        let json = try JSONSerialization.data(withJSONObject: [
            "version": 1, "type": "bar",
            "title": String(repeating: "长标题", count: 30),
            "unit": String(repeating: "单位", count: 20),
            "sourceNote": String(repeating: "模型提供的来源说明。", count: 25),
            "data": [["label": "A", "value": 2]]
        ])
        let text = "```corptie-chart\n\(String(decoding: json, as: UTF8.self))\n```"
        for columnWidth: CGFloat in [220, 300, 520] {
            let row = AppKitChatTimelineRow(id: "message:chart-width-\(Int(columnWidth))",
                contentRevision: 1, nativeText: text, copyText: text,
                nativeStyle: .agent, title: "", metadata: "", expandableTurnId: nil,
                isExpanded: false, showsHeader: false)
            let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: columnWidth)
            guard case .chart(_, let spec, let allocated) = layout.richBlocks.first else {
                XCTFail("Expected a chart at width \(columnWidth)")
                continue
            }
            let contentWidth = layout.cardWidth - 20
            let host = NSHostingView(rootView: ConversationChartView(spec: spec)
                .frame(width: contentWidth))
            host.frame = NSRect(x: 0, y: 0, width: contentWidth, height: 1)
            host.layoutSubtreeIfNeeded()
            let fitted = host.fittingSize.height
            XCTAssertGreaterThanOrEqual(allocated + 1, fitted,
                "Chart content must not clip at width \(columnWidth)")
            XCTAssertLessThanOrEqual(allocated - fitted, 8,
                "Chart block must not add large empty space at width \(columnWidth)")
        }
    }

    func testCompletedChartHeightIsReusedWhileTrailingTextStreams() {
        let chart = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Height-cache-append-20260925\",\"data\":[{\"label\":\"A\",\"value\":2}]}\n```"
        let cache = NativeTimelineLayoutCache.shared
        let before = cache.chartMeasurementCount
        func row(_ suffix: String) -> AppKitChatTimelineRow {
            let text = chart + suffix
            return AppKitChatTimelineRow(id: "message:chart-stream", contentRevision: text.count,
                nativeText: text, copyText: text, nativeStyle: .agent, title: "", metadata: "",
                expandableTurnId: nil, isExpanded: false, showsHeader: false)
        }
        let first = cache.layout(for: row("\nA"), columnWidth: 480)
        let appended = cache.layout(for: row("\nA longer explanation"), columnWidth: 480)
        XCTAssertEqual(cache.chartMeasurementCount - before, 1,
            "Appending ordinary text must not remeasure an unchanged chart")
        XCTAssertEqual(first.richBlocks.first(where: { if case .chart = $0 { true } else { false } })?.id,
            appended.richBlocks.first(where: { if case .chart = $0 { true } else { false } })?.id)
        _ = cache.layout(for: row("\nA longer explanation"), columnWidth: 300)
        XCTAssertEqual(cache.chartMeasurementCount - before, 2,
            "A genuinely different card width must be measured separately")
    }

    func testChangingOnlyChartValuesDoesNotRemeasureItsUnchangedChrome() {
        let cache = NativeTimelineLayoutCache.shared
        let baseline = cache.chartMeasurementCount
        func row(value: Int, title: String = "Value-cache-20260925") -> AppKitChatTimelineRow {
            let text = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"\(title)\",\"data\":[{\"label\":\"A\",\"value\":\(value)}]}\n```"
            return AppKitChatTimelineRow(id: "message:chart-values", contentRevision: value,
                nativeText: text, copyText: text, nativeStyle: .agent, title: "", metadata: "",
                expandableTurnId: nil, isExpanded: false, showsHeader: false)
        }
        let first = cache.layout(for: row(value: 1), columnWidth: 360)
        for value in 2...100 {
            _ = cache.layout(for: row(value: value), columnWidth: 360)
        }
        let changed = cache.layout(for: row(value: 200), columnWidth: 360)
        XCTAssertEqual(cache.chartMeasurementCount - baseline, 1)
        XCTAssertEqual(first.rowHeight, changed.rowHeight)
        guard case .chart(_, let revisedSpec, let allocatedHeight) = changed.richBlocks[0] else {
            XCTFail("Expected the revised chart to remain a chart")
            return
        }
        XCTAssertEqual(revisedSpec.data[0].value, 200)
        let host = NSHostingView(rootView: ConversationChartView(spec: revisedSpec)
            .frame(width: changed.cardWidth - 20))
        host.frame = NSRect(x: 0, y: 0, width: changed.cardWidth - 20, height: 1)
        host.layoutSubtreeIfNeeded()
        XCTAssertEqual(host.fittingSize.height, allocatedHeight, accuracy: 1)
        _ = cache.layout(for: row(value: 300, title: "Value-cache-new-title-20260925"), columnWidth: 360)
        XCTAssertEqual(cache.chartMeasurementCount - baseline, 2,
            "Changing the measured title still requires a new height")
    }

    func testMultiChartHistoryLayoutBenchmark() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_CHART_BENCHMARK"] == "1" else {
            throw XCTSkip("Set CORPTIE_CHART_BENCHMARK=1 for 1/20/200-row chart layout measurements")
        }
        let cache = NativeTimelineLayoutCache.shared
        for count in [1, 20, 200] {
            let rows: [AppKitChatTimelineRow] = (0..<count).map { index in
                let title = "Benchmark-\(count)-\(index)"
                let text = """
                Before \(title)
                ```corptie-chart
                {"version":1,"type":"bar","title":"Bar \(title)","data":[{"label":"A","value":2}]}
                ```
                Between
                ```corptie-chart
                {"version":1,"type":"line","title":"Line \(title)","data":[{"x":1,"value":2},{"x":2,"value":3}]}
                ```
                Between again
                ```corptie-chart
                {"version":1,"type":"pie","title":"Pie \(title)","data":[{"label":"A","value":2},{"label":"B","value":3}]}
                ```
                After
                """
                return AppKitChatTimelineRow(id: "message:chart-benchmark:\(count):\(index)",
                    contentRevision: 1, nativeText: text, copyText: text, nativeStyle: .agent,
                    title: "", metadata: "", expandableTurnId: nil, isExpanded: false,
                    showsHeader: false)
            }
            func measure() -> [Double] {
                rows.map { row in
                    let start = ProcessInfo.processInfo.systemUptime
                    let layout = cache.layout(for: row, columnWidth: 360)
                    XCTAssertEqual(layout.richBlocks.count, 7)
                    return (ProcessInfo.processInfo.systemUptime - start) * 1_000
                }
            }
            let chartMeasurementsBefore = cache.chartMeasurementCount
            let cold = measure().sorted()
            let newChartMeasurements = cache.chartMeasurementCount - chartMeasurementsBefore
            let warm = measure().sorted()
            XCTAssertEqual(newChartMeasurements, count * 3)
            XCTAssertEqual(cache.chartMeasurementCount - chartMeasurementsBefore, count * 3,
                "Revisiting cached rows must not rebuild chart hosts")
            let p95Index = Int(Double(count - 1) * 0.95)
            print("CHART_LAYOUT rows=\(count) charts_per_row=3 cold_p95_ms=\(cold[p95Index]) "
                + "warm_p95_ms=\(warm[p95Index]) measured_chart_hosts=\(newChartMeasurements)")
        }
    }

    func testExpandedProcessUsesMeasuredSemanticSubcardsInOneRow() {
        let steps: [NativeExecutionTimelineStep] = [
            .init(id: "tool:one", kind: .action, state: .completed,
                  title: "Read source", detail: "Read two files"),
            .init(id: "change:one", kind: .result, state: .completed,
                  title: "Files changed", detail: "One file updated")
        ]
        let row = AppKitChatTimelineRow(id: "process:one", contentRevision: 1,
            nativeText: "", copyText: "", nativeStyle: .process,
            title: "", metadata: "", expandableTurnId: "turn:one", isExpanded: true,
            processCount: 2, processSteps: steps, showsHeader: false)
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 480)
        XCTAssertEqual(layout.processBlocks.count, 2)
        XCTAssertEqual(layout.textHeight,
            layout.processBlocks[0].height + 6 + layout.processBlocks[1].height,
            accuracy: 0.5)
        XCTAssertEqual(layout.rowHeight, layout.textHeight + 48, accuracy: 0.5)
        XCTAssertEqual(layout.processBlocks.map(\.step.id), steps.map(\.id))
    }

    func testCollapsedCurrentStepGetsASecondLineWithoutChangingRowIdentity() throws {
        let collapsed = AppKitChatTimelineRow(id: "process:current", contentRevision: 1,
            nativeText: "", copyText: "", nativeStyle: .process,
            title: "", metadata: "", expandableTurnId: "turn:current", isExpanded: false,
            processCount: 2, processState: .running,
            processCurrentStepTitle: "Verify the result", showsHeader: false)
        let layout = NativeTimelineLayoutCache.shared.layout(for: collapsed, columnWidth: 480)
        XCTAssertGreaterThanOrEqual(layout.rowHeight, 48)
        XCTAssertEqual(collapsed.id, "process:current")
        XCTAssertFalse(collapsed.processPrimarySummary.contains("Verify the result"))
    }

    func testCollapsedProcessSummaryWrapsWithinTheCachedNativeRow() {
        var row = AppKitChatTimelineRow(id: "process:long-summary", contentRevision: 1,
            nativeText: "", copyText: "", nativeStyle: .process,
            title: "", metadata: "", expandableTurnId: "turn:long-summary", isExpanded: false,
            processCount: 999, processDuration: "123456h 59m 59.99s", showsHeader: false)
        row.processLanguageCode = "en"
        let narrow = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 140)
        XCTAssertGreaterThan(narrow.rowHeight, 32)
        XCTAssertEqual(narrow.rowHeight,
            NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 140).rowHeight)

        var localized = AppKitChatTimelineRow(id: "process:localized-summary", contentRevision: 1,
            nativeText: "", copyText: "", nativeStyle: .process,
            title: "", metadata: "", expandableTurnId: "turn:localized-summary", isExpanded: false,
            processCount: 1, processDuration: "1m 12.00s", showsHeader: false)
        localized.processLanguageCode = "en"
        let english = NativeTimelineLayoutCache.shared.layout(for: localized, columnWidth: 480)
        localized.processLanguageCode = "zh-Hans"
        let chinese = NativeTimelineLayoutCache.shared.layout(for: localized, columnWidth: 480)
        XCTAssertNotEqual(english.cardWidth, chinese.cardWidth,
            "Changing language must invalidate the cached process summary geometry")
    }

    func testLongToolResultKeepsTheNativeRowBounded() throws {
        let toolJSON: [String: Any] = ["schemaVersion": 1, "toolId": "tool:long",
            "name": "terminal", "status": "completed", "result": String(repeating: "line\n", count: 300)]
        let tool = try JSONDecoder().decode(ConversationToolExecution.self,
            from: JSONSerialization.data(withJSONObject: toolJSON))
        let step = NativeExecutionTimelineStep(id: "step:long", kind: .action,
            state: .completed, title: "Run command", detail: nil, tool: tool)
        let row = AppKitChatTimelineRow(id: "process:long", contentRevision: 1,
            nativeText: "", copyText: "", nativeStyle: .process,
            title: "", metadata: "", expandableTurnId: "turn:long", isExpanded: true,
            processCount: 1, processSteps: [step], showsHeader: false)
        let layout = NativeTimelineLayoutCache.shared.layout(for: row, columnWidth: 480)
        XCTAssertEqual(layout.processBlocks.count, 1)
        XCTAssertTrue(layout.processBlocks[0].hasOverflow)
        XCTAssertEqual(layout.processBlocks[0].attributedText.length, 0,
            "Structured tool content must not be flattened into the legacy text leaf")
        XCTAssertEqual(layout.processBlocks[0].textHeight,
            ExecutionStructuredStepPresentation(step: step).height)
        XCTAssertLessThan(layout.rowHeight, 200)
    }

    func testCollapsedPlanRevisionUpdatesTheSameProcessRow() throws {
        func planItem(revision: Int, status: String) throws -> CodexThreadItem {
            let source: [String: Any] = [
                "id": "plan:one", "turnId": "turn:one", "turnStatus": "inProgress",
                "type": "executionPlan", "title": "Execution plan", "text": "Plan update", "status": "running",
                "executionPlan": [
                    "schemaVersion": 1, "planId": "plan:one", "revision": revision,
                    "lifecycle": "active", "updatedAt": "2026-09-24T00:00:00Z",
                    "steps": [["stepId": "step:one", "ordinal": 0, "text": "Inspect", "status": status]]
                ]
            ]
            return try JSONDecoder().decode(CodexThreadItem.self,
                from: JSONSerialization.data(withJSONObject: source))
        }
        let earlier = ChatDisplayEntry(kind: .process(turnId: "turn:one", items: [
            try planItem(revision: 1, status: "pending")
        ]))
        let later = ChatDisplayEntry(kind: .process(turnId: "turn:one", items: [
            try planItem(revision: 2, status: "completed")
        ]))
        let conversation = SessionConversationContent(
            sessionId: "session:plan-revision",
            presentationCache: SessionPresentationCache(),
            composerDraftRepository: ComposerDraftRepository()
        )
        XCTAssertEqual(earlier.id, later.id)
        XCTAssertNotEqual(conversation.appKitContentRevision(earlier, expandedTurnIds: []),
                          conversation.appKitContentRevision(later, expandedTurnIds: []))
    }

    func testStructuredPlanRevisionFormattingBenchmark() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_PLAN_BENCHMARK"] == "1" else {
            throw XCTSkip("Set CORPTIE_PLAN_BENCHMARK=1 for the 1/20/200-step formatting benchmark")
        }
        for stepCount in [1, 20, 200] {
            func makeItem(revision: Int) throws -> CodexThreadItem {
                let plan: [String: Any] = [
                    "schemaVersion": 1, "planId": "plan:benchmark", "revision": revision,
                    "lifecycle": "active", "updatedAt": "2026-09-24T00:00:00Z",
                    "steps": (0..<stepCount).map { index in [
                        "stepId": "step:\(index)", "ordinal": index,
                        "text": "Inspect source and update implementation \(index)",
                        "status": index == revision % stepCount ? "completed" : "pending"
                    ] as [String: Any] }
                ]
                let source: [String: Any] = [
                    "id": "plan:benchmark", "turnId": "turn:benchmark", "turnStatus": "inProgress",
                    "type": "executionPlan", "title": "Execution plan", "text": "Plan update",
                    "executionPlan": plan
                ]
                return try JSONDecoder().decode(CodexThreadItem.self,
                    from: JSONSerialization.data(withJSONObject: source))
            }
            let items = try [makeItem(revision: 1), makeItem(revision: 2)]
            var samples: [Double] = []
            var layoutSamples: [Double] = []
            for iteration in 0..<120 {
                let item = items[iteration % items.count]
                let start = ProcessInfo.processInfo.systemUptime
                let steps = NativeExecutionTimelineProjection.steps(for: [item])
                let text = NativeExecutionTimelineAttributedText.make(steps: steps)
                let elapsed = (ProcessInfo.processInfo.systemUptime - start) * 1_000
                XCTAssertEqual(steps.first?.plan?.steps.count, stepCount)
                XCTAssertFalse(text.string.isEmpty)
                if iteration >= 20 { samples.append(elapsed) }
                let layoutStart = ProcessInfo.processInfo.systemUptime
                let height = NativeTextKitLayout.height(of: text, width: 360)
                let layoutElapsed = (ProcessInfo.processInfo.systemUptime - layoutStart) * 1_000
                XCTAssertGreaterThan(height, 0)
                if iteration >= 20 { layoutSamples.append(layoutElapsed) }
            }
            samples.sort()
            layoutSamples.sort()
            print("PLAN_FORMAT steps=\(stepCount) n=100 p50_ms=\(samples[50]) p95_ms=\(samples[95])")
            print("PLAN_LAYOUT steps=\(stepCount) width=360 n=100 p50_ms=\(layoutSamples[50]) p95_ms=\(layoutSamples[95])")
        }
    }

    func testStructuredPlanRendersEveryStepWithoutFlatteningTheStoredModel() throws {
        let plan: [String: Any] = [
            "schemaVersion": 1, "planId": "plan:one", "revision": 3,
            "lifecycle": "active", "updatedAt": "2026-09-24T00:00:00Z",
            "explanation": "Check the current build before editing",
            "steps": (0..<200).map { index in [
                "stepId": "step:\(index)", "ordinal": index,
                "text": "Step \(index)", "status": index < 5 ? "completed" : "pending"
            ] as [String: Any] }
        ]
        let item: [String: Any] = ["id": "plan:one", "turnId": "turn:one",
            "turnStatus": "inProgress", "type": "executionPlan",
            "title": "Execution plan", "text": "Plan 5/200", "executionPlan": plan]
        let decoded = try JSONDecoder().decode(CodexThreadItem.self, from: JSONSerialization.data(withJSONObject: item))
        let projected = NativeExecutionTimelineProjection.steps(for: [decoded])
        XCTAssertEqual(projected.first?.plan?.steps.count, 200)
        let text = NativeExecutionTimelineAttributedText.make(steps: projected).string
        XCTAssertTrue(text.contains("✓  Step 0"))
        XCTAssertTrue(text.contains("○  Step 199"))
        XCTAssertTrue(text.contains("Check the current build before editing"))
    }

    func testIncrementalPlanHeightMatchesColdTextKitAcrossRevisions() throws {
        func attributedPlan(
            completed: Int, stepCount: Int, explanation: String, renamedStep: String?
        ) throws -> NSAttributedString {
            let plan: [String: Any] = [
                "schemaVersion": 1, "planId": "plan:height", "revision": completed + 1,
                "lifecycle": "active", "explanation": explanation,
                "updatedAt": "2026-09-24T00:00:00Z",
                "steps": (0..<stepCount).map { index in [
                    "stepId": "step:\(index)", "ordinal": index,
                    "text": index == 40 ? (renamedStep ?? "Inspect source file \(index)")
                        : "Inspect source file \(index)",
                    "status": index < completed ? "completed" : "pending"
                ] as [String: Any] }
            ]
            let source: [String: Any] = [
                "id": "plan:height", "turnId": "turn:height", "turnStatus": "inProgress",
                "type": "executionPlan", "title": "Execution plan", "text": "Plan update",
                "status": "running", "executionPlan": plan
            ]
            let item = try JSONDecoder().decode(CodexThreadItem.self,
                from: JSONSerialization.data(withJSONObject: source))
            return NativeExecutionTimelineAttributedText.make(
                steps: NativeExecutionTimelineProjection.steps(for: [item])
            )
        }

        let revisions: [(Int, Int, String, String?)] = [
            (0, 200, "First pass", nil),
            (1, 200, "First pass", nil),
            (2, 200, "First pass", nil),
            (3, 200, "First pass", "Inspect a longer source file and all related call sites"),
            (4, 200, "A revised explanation with an extra line\nCheck the outcome", nil),
            (5, 199, "A revised explanation with an extra line\nCheck the outcome", nil)
        ]
        for width: CGFloat in [180, 360] {
            for (completed, count, explanation, renamedStep) in revisions {
                let attributed = try attributedPlan(
                    completed: completed, stepCount: count,
                    explanation: explanation, renamedStep: renamedStep
                )
                let incremental = NativeIncrementalPlanLayoutCache.shared.height(
                    of: attributed, rowID: "test:plan-height:\(Int(width))", width: width
                )
                let cold = NativeTextKitLayout.height(of: attributed, width: width)
                XCTAssertEqual(incremental, cold, accuracy: 0.5,
                               "Plan revision \(completed) diverged at width \(width)")
            }
        }
    }

    func testIncrementalPlanHeightMatchesColdTextKitForMixedContent() throws {
        let statuses = ["pending", "inProgress", "completed", "failed", "cancelled"]
        for width: CGFloat in [125, 180, 360, 600] {
            for revision in 0..<32 {
                let count = switch revision {
                case 8, 9: 0
                case 16, 17: 1
                case 24, 25: 200
                default: 20
                }
                let explanation = switch revision % 4 {
                case 0: "先检查现状，再决定下一步。"
                case 1: "Check the state\nThen verify the result"
                case 2: ""
                default: "状态可能过期；重新检查任务与文件。\r\nDo not assume completion."
                }
                let steps: [[String: Any]] = (0..<count).map { index in
                    let text: String = switch (index + revision) % 6 {
                    case 0: "检查中文描述和较长的换行行为：\(index)"
                    case 1: "Review emoji 🧪 and combining e\u{301} marks \(index)"
                    case 2: "Inspect a very long source path /source/feature/conversation/plan/step/\(index)/details.swift"
                    case 3: "First line\nSecond line \(index)"
                    default: "Step \(index)"
                    }
                    return ["stepId": "step:\(index)", "ordinal": index, "text": text,
                            "status": statuses[(index + revision) % statuses.count]]
                }
                let source: [String: Any] = [
                    "id": "plan:mixed", "turnId": "turn:mixed", "turnStatus": "inProgress",
                    "type": "executionPlan", "title": "Execution plan", "text": "Plan update",
                    "status": revision % 7 == 0 ? "unknown" : "running",
                    "executionPlan": [
                        "schemaVersion": 1, "planId": "plan:mixed", "revision": revision + 1,
                        "lifecycle": revision % 7 == 0 ? "unknown" : "active",
                        "updatedAt": "2026-09-24T00:00:00Z", "explanation": explanation,
                        "steps": steps
                    ] as [String: Any]
                ]
                let item = try JSONDecoder().decode(CodexThreadItem.self,
                    from: JSONSerialization.data(withJSONObject: source))
                let attributed = NativeExecutionTimelineAttributedText.make(
                    steps: NativeExecutionTimelineProjection.steps(for: [item])
                )
                let incremental = NativeIncrementalPlanLayoutCache.shared.height(
                    of: attributed, rowID: "test:mixed-plan:\(Int(width))", width: width
                )
                let cold = NativeTextKitLayout.height(of: attributed, width: width)
                XCTAssertEqual(incremental, cold, accuracy: 0.5,
                               "Mixed plan revision \(revision) diverged at width \(width)")
            }
        }
    }

    func testIncrementalPlanRevisionLayoutBenchmark() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_PLAN_BENCHMARK"] == "1" else {
            throw XCTSkip("Set CORPTIE_PLAN_BENCHMARK=1 for incremental plan layout measurements")
        }
        var incrementalSamples: [Double] = []
        var coldSamples: [Double] = []
        for revision in 0..<120 {
            let source: [String: Any] = [
                "id": "plan:incremental-benchmark", "turnId": "turn:incremental-benchmark",
                "turnStatus": "inProgress", "type": "executionPlan",
                "title": "Execution plan", "text": "Plan update", "status": "running",
                "executionPlan": [
                    "schemaVersion": 1, "planId": "plan:incremental-benchmark",
                    "revision": revision + 1, "lifecycle": "active",
                    "updatedAt": "2026-09-24T00:00:00Z",
                    "steps": (0..<200).map { index in [
                        "stepId": "step:\(index)", "ordinal": index,
                        "text": "Inspect source and update implementation \(index)",
                        "status": index == revision ? "completed" : "pending"
                    ] as [String: Any] }
                ] as [String: Any]
            ]
            let item = try JSONDecoder().decode(CodexThreadItem.self,
                from: JSONSerialization.data(withJSONObject: source))
            let attributed = NativeExecutionTimelineAttributedText.make(
                steps: NativeExecutionTimelineProjection.steps(for: [item])
            )
            let incrementalStart = ProcessInfo.processInfo.systemUptime
            let incremental = NativeIncrementalPlanLayoutCache.shared.height(
                of: attributed, rowID: "benchmark:incremental-plan", width: 360
            )
            let incrementalElapsed = (ProcessInfo.processInfo.systemUptime - incrementalStart) * 1_000
            let coldStart = ProcessInfo.processInfo.systemUptime
            let cold = NativeTextKitLayout.height(of: attributed, width: 360)
            let coldElapsed = (ProcessInfo.processInfo.systemUptime - coldStart) * 1_000
            XCTAssertEqual(incremental, cold, accuracy: 0.5)
            if revision >= 20 {
                incrementalSamples.append(incrementalElapsed)
                coldSamples.append(coldElapsed)
            }
        }
        incrementalSamples.sort()
        coldSamples.sort()
        print("PLAN_INCREMENTAL steps=200 n=100 p50_ms=\(incrementalSamples[50]) p95_ms=\(incrementalSamples[95])")
        print("PLAN_COLD steps=200 n=100 p50_ms=\(coldSamples[50]) p95_ms=\(coldSamples[95])")
    }

    func testStructuredToolRendersInputAndResultAsSeparateSections() throws {
        let item: [String: Any] = ["id": "tool:one", "turnId": "turn:one",
            "turnStatus": "inProgress", "type": "commandExecution", "title": "Bash",
            "text": "pwd\n\n/tmp", "status": "completed",
            "toolExecution": ["schemaVersion": 1, "toolId": "tool:one", "name": "Bash",
                "status": "completed", "input": "pwd", "result": "/tmp"]]
        let decoded = try JSONDecoder().decode(CodexThreadItem.self, from: JSONSerialization.data(withJSONObject: item))
        let steps = NativeExecutionTimelineProjection.steps(for: [decoded])
        let text = NativeExecutionTimelineAttributedText.make(steps: steps).string
        XCTAssertTrue(text.contains("INPUT\n│  pwd"))
        XCTAssertTrue(text.contains("RESULT\n│  /tmp"))
        XCTAssertEqual(steps.first?.id, "tool:one")
    }

    func testFileChangeShowsPathAndDiffWithoutRepeatingToolInput() throws {
        let item: [String: Any] = ["id": "edit:one", "turnId": "turn:one",
            "turnStatus": "inProgress", "type": "fileChange", "title": "Edit",
            "text": "App.swift", "status": "completed",
            "toolExecution": ["schemaVersion": 1, "toolId": "edit:one", "name": "Edit",
                "status": "completed", "input": "App.swift", "result": "edited"],
            "changeSet": ["schemaVersion": 1, "truncated": false,
                "changes": [["path": "App.swift", "kind": "modify",
                    "diffPreview": "+hello", "diffTruncated": false]]]]
        let decoded = try JSONDecoder().decode(CodexThreadItem.self, from: JSONSerialization.data(withJSONObject: item))
        let text = NativeExecutionTimelineAttributedText.make(
            steps: NativeExecutionTimelineProjection.steps(for: [decoded])).string
        XCTAssertTrue(text.contains("•  App.swift"))
        XCTAssertTrue(text.contains("│  +hello"))
        XCTAssertFalse(text.contains("INPUT"))
    }

    func testAllKindsAndStatesMatchDesktopAttributedRuns() {
        let kinds: [NativeExecutionTimelineStep.Kind] = [.context, .action, .result]
        let states: [NativeExecutionTimelineStep.State] = [.running, .completed, .failed, .cancelled, .unknown]
        let steps = kinds.flatMap { kind in states.map { state in
            NativeExecutionTimelineStep(id: "\(kind)-\(state)", kind: kind, state: state,
                title: "Read source 标题", detail: "path/to/source.swift · output")
        } }
        XCTAssertTrue(NativeExecutionTimelineAttributedText.make(steps: steps)
            .isEqual(to: FrozenExecutionText.make(steps: steps)))
    }
}

@MainActor
private enum FrozenExecutionText {
    static func make(steps: [NativeExecutionTimelineStep]) -> NSAttributedString {
        let result = NSMutableAttributedString()
        for (index, step) in steps.enumerated() {
            let marker = NSMutableAttributedString(
                string: "\(step.state.marker)  ",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 10.5, weight: .bold),
                    .foregroundColor: markerColor(step.state)
                ]
            )
            result.append(marker)
            result.append(NSAttributedString(
                string: "\(L10n(step.kind.label).uppercased())  ",
                attributes: [
                    .font: NSFont.systemFont(ofSize: 8.5, weight: .bold),
                    .foregroundColor: kindColor(step.kind)
                ]
            ))
            result.append(NSAttributedString(
                string: L10n(step.title),
                attributes: [
                    .font: NSFont.systemFont(ofSize: 10.5, weight: .semibold),
                    .foregroundColor: NSColor.labelColor
                ]
            ))
            if let detail = step.detail {
                let paragraph = NSMutableParagraphStyle()
                paragraph.headIndent = 20
                paragraph.firstLineHeadIndent = 20
                paragraph.paragraphSpacingBefore = 3
                paragraph.lineBreakMode = .byCharWrapping
                result.append(NSAttributedString(
                    string: "\n│  \(detail)",
                    attributes: [
                        .font: detailFont(step.kind),
                        .foregroundColor: NSColor.secondaryLabelColor,
                        .paragraphStyle: paragraph
                    ]
                ))
            }
            if index < steps.count - 1 {
                result.append(NSAttributedString(string: "\n\n"))
            }
        }
        return result
    }

    private static func markerColor(_ state: NativeExecutionTimelineStep.State) -> NSColor {
        switch state {
        case .running: .controlAccentColor
        case .completed: .systemGreen
        case .failed: .systemRed
        case .cancelled: .secondaryLabelColor
        case .unknown: .secondaryLabelColor
        }
    }

    private static func kindColor(_ kind: NativeExecutionTimelineStep.Kind) -> NSColor {
        switch kind {
        case .context: .secondaryLabelColor
        case .action: .controlAccentColor
        case .result: .systemOrange
        }
    }

    private static func detailFont(_ kind: NativeExecutionTimelineStep.Kind) -> NSFont {
        kind == .action
            ? .monospacedSystemFont(ofSize: 9.5, weight: .regular)
            : .systemFont(ofSize: 10, weight: .regular)
    }
}
