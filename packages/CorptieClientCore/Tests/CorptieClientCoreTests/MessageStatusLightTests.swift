import Testing
@testable import CorptieClientCore

struct MessageStatusLightTests {
    @Test func authoritativeLightMapping() {
        for (state, light, pulse) in [
            ("queued", UserMessageStatusPresentation.Light.orange, false),
            ("processing", .green, true), ("failed", .red, false), ("cancelled", .off, false)
        ] {
            let value = UserMessageStatusPresentation(authoritativeStatus: state, legacyStatus: nil)
            #expect(value?.light == light)
            #expect(value?.lightPulses == pulse)
        }
        #expect(UserMessageStatusPresentation(authoritativeStatus: "consumed", legacyStatus: nil) == nil)
    }
    @Test func transportLightMapping() {
        for (state, light, pulse) in [
            ("Sending", UserMessageStatusPresentation.Light.blue, true),
            ("等待重试，将自动发送", .blue, true), ("上传图片 50%", .blue, true),
            ("送达状态未确认", .purple, false), ("Sent", .purple, false),
            ("发送失败：offline", .red, false), ("已停止重试；不代表撤回", .off, false)
        ] {
            let value = UserMessageStatusPresentation(authoritativeStatus: nil,
                legacyStatus: nil, localDeliveryState: state)
            #expect(value?.light == light)
            #expect(value?.lightPulses == pulse)
        }
    }
}
