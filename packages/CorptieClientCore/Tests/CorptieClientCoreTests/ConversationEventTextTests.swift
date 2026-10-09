import Foundation
import Testing
@testable import CorptieClientCore

struct ConversationEventTextTests {
    @Test func scheduledMessagesAndRunStatesRemainDistinct() throws {
        let json = #"{"id":"message","type":"userMessage","text":"Execute exactly this","messageOrigin":"scheduled_task","automationRunId":"run:1","automationName":"Automation","userMessageStatus":"queued"}"#
        let message = try JSONDecoder().decode(ClientMessage.self, from: Data(json.utf8))
        #expect(message.presentationKind == .userMessage)
        #expect(message.messageOrigin == "scheduled_task")
        #expect(message.text == "Execute exactly this")
        let zh = ConversationEventText(languageCode: "zh")
        #expect(zh.messageSource(name: message.automationName) == "计划任务触发 · Automation")
        #expect(zh.runStatus("cancelled") == "取消")
        #expect(zh.runStatus("completed") == "完成")
        #expect(zh.runStatus("unexpected") == "状态待确认")
    }
    @Test func labelsDoNotExposeProtocolCodes() {
        let zh = ConversationEventText(languageCode: "zh-Hans")
        let en = ConversationEventText(languageCode: "en")
        #expect(zh.eventLabel("ScheduledSessionRunQueued") == "已排队")
        #expect(en.eventLabel("ScheduledSessionRunQueued") == "Queued")
        #expect(zh.eventLabel("ScheduledSessionTaskDue") == "已触发")
        #expect(zh.eventLabel("future_event") == "计划任务事件")
        #expect(zh.reason("missing_sender_session_id") == "缺少发送会话信息。")
        #expect(!en.reason("private_internal_code").contains("private_internal_code"))
        #expect(zh.systemKind(nil) == "系统事件")
    }

    @Test func plansAreSharedAndInvalidIntervalsAreSafe() {
        let zh = ConversationEventText(languageCode: "zh")
        func plan(_ trigger: String, _ interval: Double?) -> String? {
            zh.executionPlan(trigger: trigger, runAt: nil, nextRunAt: nil, interval: interval,
                conditionInterval: nil, processInterval: nil, formatDate: { $0 })
        }
        #expect(plan("interval", 300) == "每 5 分钟执行")
        #expect(plan("interval", .infinity) == nil)
        #expect(plan("once", nil) == nil)
        #expect(plan("unknown", nil) == nil)
        #expect(plan("condition", nil) == "条件满足时执行")
    }

    @Test func decodingPreservesUserContentAndScheduleFields() throws {
        let json = #"{"id":"event","type":"automationEvent","text":"Do not translate 我写的正文","automationName":"Automation","automationTriggerType":"interval","automationIntervalSeconds":300}"#
        let message = try JSONDecoder().decode(ClientMessage.self, from: Data(json.utf8))
        #expect(message.automationName == "Automation")
        #expect(message.text == "Do not translate 我写的正文")
        #expect(message.automationIntervalSeconds == 300)
        #expect(message.automationTriggerType == "interval")
    }
}
