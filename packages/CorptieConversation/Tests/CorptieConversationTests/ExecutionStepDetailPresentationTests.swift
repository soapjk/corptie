import Foundation
import Testing
import CorptieClientCore
@testable import CorptieConversation
#if canImport(AppKit)
import AppKit
#endif

#if canImport(AppKit)
@Test @MainActor func executionTextUsesAppearanceAdaptiveSystemColors() {
    let step = ConversationExecutionStep(id: "item:appearance", kind: .action,
        state: .running, title: "Adaptive title", detail: "Adaptive detail")
    let text = ExecutionTimelineAttributedText.make(steps: [step])
    let titleRange = (text.string as NSString).range(of: "Adaptive title")
    let detailRange = (text.string as NSString).range(of: "Adaptive detail")
    let titleColor = text.attribute(.foregroundColor, at: titleRange.location, effectiveRange: nil) as? NSColor
    let detailColor = text.attribute(.foregroundColor, at: detailRange.location, effectiveRange: nil) as? NSColor
    #expect(titleColor == .labelColor)
    #expect(detailColor == .secondaryLabelColor)
}
#endif

@Test func longToolOutputIsBoundedInlineAndAvailableOnDemand() throws {
    let result = String(repeating: "output line\n", count: 80)
    let source = ["schemaVersion": 1, "toolId": "tool:one", "name": "terminal",
                  "status": "completed", "input": "run checks", "result": result] as [String: Any]
    let tool = try JSONDecoder().decode(ConversationToolExecution.self,
        from: JSONSerialization.data(withJSONObject: source))
    let step = ConversationExecutionStep(id: "item:one", kind: .action, state: .completed,
        title: "Run checks", detail: nil, tool: tool)
    let presentation = ExecutionStepDetailPresentation(step: step)
    #expect(presentation.hasOverflow)
    #expect(presentation.displayedStep.tool == nil)
    #expect((presentation.displayedStep.detail?.count ?? 0) < 250)
    #expect(ExecutionStepDetailPresentation.fullText(step).contains(result))
}

@Test func shortStructuredToolRetainsItsInlineSections() throws {
    let source = ["schemaVersion": 1, "toolId": "tool:short", "name": "search",
                  "status": "completed", "input": "needle", "result": "one match"] as [String: Any]
    let tool = try JSONDecoder().decode(ConversationToolExecution.self,
        from: JSONSerialization.data(withJSONObject: source))
    let step = ConversationExecutionStep(id: "item:short", kind: .action, state: .completed,
        title: "Search", detail: nil, tool: tool)
    let presentation = ExecutionStepDetailPresentation(step: step)
    #expect(!presentation.hasOverflow)
    #expect(presentation.displayedStep.tool == tool)
}

@Test func longDiffPreviewRemainsAvailableInFullDetails() throws {
    let diff = String(repeating: "+ added line\n", count: 60)
    let source: [String: Any] = [
        "schemaVersion": 1, "truncated": false,
        "changes": [["path": "Sources/A.swift", "kind": "modify",
                     "diffPreview": diff, "diffTruncated": false]]
    ]
    let changes = try JSONDecoder().decode(ConversationChangeSet.self,
        from: JSONSerialization.data(withJSONObject: source))
    let step = ConversationExecutionStep(id: "item:change", kind: .result, state: .completed,
        title: "Files changed", detail: nil, changeSet: changes)
    let presentation = ExecutionStepDetailPresentation(step: step)
    #expect(presentation.hasOverflow)
    #expect(presentation.displayedStep.changeSet == nil)
    #expect(presentation.displayedStep.detail?.contains("Sources/A.swift") == true)
    #expect(ExecutionStepDetailPresentation.fullText(step).contains(diff))
}

@Test func structuredToolPreviewStaysBoundedAndKeepsFullPayloadAvailable() throws {
    let longInput = String(repeating: "read source and inspect output ", count: 20)
    let source: [String: Any] = ["schemaVersion": 1, "toolId": "tool:structured",
        "name": "terminal", "status": "completed", "input": longInput,
        "result": "one\ntwo"]
    let tool = try JSONDecoder().decode(ConversationToolExecution.self,
        from: JSONSerialization.data(withJSONObject: source))
    let step = ConversationExecutionStep(id: "item:structured", kind: .action,
        state: .completed, title: "Run command", detail: nil, tool: tool)
    let summary = ExecutionStructuredStepPresentation(step: step)
    #expect(summary.rows.count == 2)
    #expect(summary.rows.map(\.label) == ["输入", "结果"])
    #expect(summary.rows.allSatisfy { $0.value.count <= 91 })
    #expect(summary.height == 62)
    #expect(summary.hasOverflow)
    #expect(ExecutionStepDetailPresentation.fullText(step).contains(longInput))
}

@Test func structuredChangesShowThreeFilesAndRetainDiffOnDemand() throws {
    let source: [String: Any] = ["schemaVersion": 1, "truncated": false,
        "changes": (0..<5).map { index in ["path": "Sources/File\(index).swift",
            "kind": index == 0 ? "delete" : "modify", "diffPreview": "+change",
            "diffTruncated": false] as [String: Any] }]
    let changes = try JSONDecoder().decode(ConversationChangeSet.self,
        from: JSONSerialization.data(withJSONObject: source))
    let step = ConversationExecutionStep(id: "item:changes", kind: .result,
        state: .completed, title: "Files changed", detail: nil, changeSet: changes)
    let summary = ExecutionStructuredStepPresentation(step: step)
    #expect(summary.rows.count == 5)
    #expect(summary.rows[1].symbol == "−")
    #expect(summary.rows.last?.value == "2 个文件")
    #expect(summary.height == 128)
    #expect(summary.hasOverflow)
    #expect(ExecutionStepDetailPresentation.fullText(step).contains("+change"))
}
