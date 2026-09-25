import Foundation
import Testing
import CorptieClientCore
@testable import CorptieConversation

@Test func displayedMessagePrefersTheBackendProjectionOnBothClients() {
    let chart = "```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"Projected\",\"data\":[{\"label\":\"A\",\"value\":2}]}\n```"
    let displayed = ConversationMessageDisplayText.resolve(text: "Raw text",
        presentationText: "\n\(chart)\n", title: "Title", type: "agentMessage")
    #expect(displayed == chart)
    #expect(ConversationChartBlocks.parse(displayed).contains {
        if case .chart = $0 { true } else { false }
    })
}

@Test func displayedMessageFallsBackWithoutDiscardingTheRawPayload() {
    #expect(ConversationMessageDisplayText.resolve(text: "  Raw answer  ",
        presentationText: "  ", title: "Title", type: "agentMessage") == "Raw answer")
    #expect(ConversationMessageDisplayText.resolve(text: "", presentationText: nil,
        title: "Title", type: "agentMessage") == "Title")
    #expect(ConversationMessageDisplayText.resolve(text: "", presentationText: nil,
        title: nil, type: "agentMessage") == "agentMessage")
}

@Test func copyingInlineChartKeepsTheOriginalFence() {
    let raw = "Before\n```corptie-chart\n{\"version\":1,\"type\":\"bar\",\"title\":\"A\",\"data\":[{\"label\":\"B\",\"value\":2}]}\n```\nAfter"
    #expect(ConversationMessageDisplayText.copyText(type: "agentMessage",
        authoritativeText: raw, displayedText: "A rendered chart") == raw)
    #expect(ConversationMessageDisplayText.copyText(type: "userMessage",
        authoritativeText: "private raw", displayedText: "safe presentation") == "safe presentation")
    #expect(ConversationMessageDisplayText.copyText(type: "agentMessage",
        authoritativeText: raw, presentationText: "Safe chart summary",
        displayedText: "Safe chart summary") == "Safe chart summary")
}

@Test func mobileMessageDecodesThreeInlineChartsInOneAuthoritativeReply() throws {
    let raw = """
    前文
    ```corptie-chart
    {"version":1,"type":"bar","title":"比较","data":[{"label":"甲","value":2}]}
    ```
    中段
    ```corptie-chart
    {"version":1,"type":"line","title":"趋势","data":[{"x":1,"value":2}]}
    ```
    继续
    ```corptie-chart
    {"version":1,"type":"pie","title":"占比","data":[{"label":"甲","value":2}]}
    ```
    后文
    """
    let payload: [String: Any] = ["id": "agent:charts", "type": "agentMessage", "text": raw,
        "images": [["managedPath": "managed:chart-image", "fileName": "image.png"]]]
    let message = try JSONDecoder().decode(ClientMessage.self,
        from: JSONSerialization.data(withJSONObject: payload))
    let displayed = ConversationMessageDisplayText.resolve(text: message.text,
        presentationText: message.presentationText, title: message.title, type: message.type)
    #expect(displayed == raw)
    let blocks = ConversationChartBlocks.parseLocated(displayed, messageID: message.id)
    let kinds = blocks.compactMap { block -> ConversationChartSpec.Kind? in
        if case .chart(let spec, _) = block.content { return spec.kind }
        return nil
    }
    #expect(kinds == [.bar, .line, .pie])
    #expect(blocks.count == 7)
    #expect(message.images.first?.managedPath == "managed:chart-image")
    #expect(ConversationMessageDisplayText.copyText(type: message.type,
        authoritativeText: message.text, displayedText: displayed) == raw)
}
