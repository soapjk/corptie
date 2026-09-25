import AppKit
import XCTest
@testable import CorptieMac

@MainActor
final class SharedExecutionTextTests: XCTestCase {
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
                    .foregroundColor: NSColor(calibratedRed: 0.24, green: 0.27, blue: 0.29, alpha: 1)
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
                        .foregroundColor: NSColor(calibratedRed: 0.38, green: 0.41, blue: 0.43, alpha: 1),
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
