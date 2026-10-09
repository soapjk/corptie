#if os(macOS)
import AppKit
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor
struct MessageStatusBadgeLayoutTests {
    @Test func statusChangesDoNotResizeMessage() {
        let states: [String?] = [nil, "Sending", "Sent", "等待重试，将自动发送",
            "送达状态未确认", "发送失败：测试", "上传图片 50%"]
        let sizes = states.map { state in
            let status = UserMessageStatusPresentation(authoritativeStatus: nil,
                legacyStatus: nil, localDeliveryState: state)
            let host = NSHostingView(rootView: MessageTextCard(messageID: "layout-test",
                role: .user, timestamp: "", showsActions: false, actionsAlwaysVisible: false,
                cardWidth: 160, status: status, copy: {}) {
                    Text("测试消息").frame(height: 20)
                })
            return host.fittingSize
        }
        for size in sizes { #expect(size == sizes[0]) }
        #expect(sizes[0].height == 40)
    }
}
#endif
