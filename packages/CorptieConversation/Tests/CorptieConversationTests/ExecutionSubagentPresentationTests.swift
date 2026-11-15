import Foundation
import Testing
import CorptieClientCore
@testable import CorptieConversation

struct ExecutionSubagentPresentationTests {
    private func message(_ id: Int, event: String = "interacted", status: String = "unknown") throws -> ClientMessage {
        let value: [String: Any] = ["id": "event:\(id)", "turnId": "turn", "type": "subAgentActivity",
            "text": "", "turnStatus": "inProgress", "subagentActivity": ["schemaVersion": 1,
                "activityId": "event:\(id)", "childId": "child", "name": "审查布局",
                "event": event, "status": status]]
        return try JSONDecoder().decode(ClientMessage.self, from: JSONSerialization.data(withJSONObject: value))
    }

    @Test func localizedLifecycleDoesNotInventRunningOrSuccess() throws {
        let started = try message(0, event: "started", status: "running")
        let failed = try message(1, event: "completed", status: "failed")
        let followup = try message(2)
        let completed = try message(3, event: "completed", status: "completed")
        let stopped = try message(4, event: "completed", status: "cancelled")
        for (items, zhStatus, enStatus) in [([started], "进行中", "Running"),
            ([started, failed], "失败", "Failed"),
            ([started, failed, followup], "状态待确认", "Status unconfirmed"),
            ([started, completed], "已完成", "Completed"),
            ([started, stopped], "已停止", "Stopped")] {
            let step = try #require(ConversationExecutionProjection.steps(for: items).first)
            let zh = try #require(ExecutionSubagentPresentation(step: step, languageCode: "zh-Hans"))
            let en = try #require(ExecutionSubagentPresentation(step: step, languageCode: "en"))
            #expect(zh.name == "审查布局")
            #expect(zh.kindLabel == "子 Agent")
            #expect(zh.status == zhStatus)
            #expect(en.status == enStatus)
            #expect(zh.activities.last?.status == zhStatus)
        }
        let failure = try #require(ConversationExecutionProjection.steps(for: [failed]).first)
        let card = try #require(ExecutionSubagentPresentation(step: failure, languageCode: "zh"))
        #expect(card.activities.last?.event == "执行结束")
        #expect(card.activities.last?.status == "失败")
    }

    @Test func inlineHistoryIsBoundedAndFullDetailsRetainEarlierEvents() throws {
        let items = [try message(0, event: "started", status: "running")]
            + (try (1...1000).map { try message($0) })
        let step = try #require(ConversationExecutionProjection.steps(for: items + [items.last!]).first)
        let card = try #require(ExecutionSubagentPresentation(step: step, languageCode: "zh"))
        #expect(card.activities.count == 8)
        #expect(card.activities.first?.id == "event:993")
        #expect(card.activities.last?.id == "event:1000")
        #expect(card.hiddenCount == 993)
        #expect(ExecutionStepDetailPresentation(step: step).hasOverflow)
        let full = ExecutionSubagentPresentation.fullText(step: step, languageCode: "zh")
        #expect(full.contains("已启动 · 进行中"))
        #expect(full.components(separatedBy: "已发送后续指令").count - 1 == 1000)
        #expect(!full.contains("child"))
    }

    @Test func ordinaryToolsRetainTheirExistingRenderer() {
        let step = ConversationExecutionStep(id: "tool", kind: .action, state: .running,
            title: "Search", detail: nil)
        #expect(ExecutionSubagentPresentation(step: step, languageCode: "zh") == nil)
    }
}
