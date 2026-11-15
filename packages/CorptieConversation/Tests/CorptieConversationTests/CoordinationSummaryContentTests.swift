import Foundation
import Testing
@testable import CorptieConversation

struct CoordinationSummaryContentTests {
    @Test func generatedHeadingsAreRemovedFromSummaryAndDecisionWithoutClassifyingProse() {
        for kind in ["summary", "decision"] {
            let content = CoordinationSummaryContent(kind: kind, text: "\n**后台汇总**\n\n开发仍未完成，**不能验收**。\n\n保留全部内容。")
            #expect(!content.text.contains("后台汇总"))
            #expect(String(content.attributed.characters) == "开发仍未完成，不能验收。\n\n保留全部内容。")
            #expect(content.attributed.runs.contains { $0.inlinePresentationIntent?.contains(.stronglyEmphasized) == true })
        }
        let receipt = CoordinationSummaryContent(kind: "receipt", text: "**后台汇总**\n\nThis is actual quoted content.")
        #expect(receipt.text.hasPrefix("**后台汇总**"))
    }
    @Test func compactPreviewAlwaysRetainsTheFullCopyableReport() {
        let long = String(repeating: "实现仍有缺口，请保留真实结果。\n\n", count: 12)
        let value = CoordinationSummaryContent(kind: "decision", text: "**后台汇总**\n\n" + long)
        #expect(value.canExpand)
        #expect(value.text == long.trimmingCharacters(in: .whitespacesAndNewlines))
        #expect(CoordinationSummaryContent.previewLines == 5)
        #expect(!CoordinationSummaryContent(kind: "summary", text: "修复完成。").canExpand)
        #expect(CoordinationSummaryContent(kind: "summary", text: "1\n2\n3\n4\n5\n6").canExpand)
        #expect(CoordinationSummaryContent.expansionID(for: "a") != CoordinationSummaryContent.expansionID(for: "b"))
    }
}
