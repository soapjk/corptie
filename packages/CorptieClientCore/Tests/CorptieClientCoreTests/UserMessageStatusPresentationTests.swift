import Testing
@testable import CorptieClientCore

struct UserMessageStatusPresentationTests {
    @Test func authoritativeProcessingOverridesTransportReceipt() throws {
        let status = try #require(UserMessageStatusPresentation(
            authoritativeStatus: "processing", legacyStatus: "queued",
            localDeliveryState: "Sent", queuePosition: 3
        ))
        #expect(status.kind == .processing)
        #expect(status.queuePosition == nil)
        #expect(status.shortLabel(languageCode: "zh") == "处理中")
    }

    @Test func queuePositionIsDetailOnlyAndCompletionHasNoBadge() throws {
        let queued = try #require(UserMessageStatusPresentation(
            authoritativeStatus: "queued", legacyStatus: nil, queuePosition: 3
        ))
        #expect(queued.shortLabel(languageCode: "zh") == "排队中")
        #expect(queued.detail(languageCode: "zh").contains("第 3 位"))
        #expect(UserMessageStatusPresentation(
            authoritativeStatus: "consumed", legacyStatus: "running", localDeliveryState: "Sent"
        ) == nil)
    }

    @Test func failureAndUnknownDeliveryRemainDistinctAndVisible() throws {
        let deliveryFailure = try #require(UserMessageStatusPresentation(
            authoritativeStatus: nil, legacyStatus: nil, localDeliveryState: "发送失败：网络断开"
        ))
        #expect(deliveryFailure.kind == .deliveryFailed)
        #expect(deliveryFailure.detail(languageCode: "zh").contains("网络断开"))
        let processingFailure = try #require(UserMessageStatusPresentation(
            authoritativeStatus: "failed", legacyStatus: nil,
            localDeliveryState: "Sent", processingError: "Provider unavailable"
        ))
        #expect(processingFailure.kind == .processingFailed)
        #expect(processingFailure.detail(languageCode: "en").contains("Provider unavailable"))
        let unknown = try #require(UserMessageStatusPresentation(
            authoritativeStatus: "future-state", legacyStatus: "running", localDeliveryState: "Sent"
        ))
        #expect(unknown.kind == .deliveryUnknown)
        #expect(unknown.detail(languageCode: "en").contains("not be resent automatically"))
    }

    @Test func legacyStateStillWorksForOlderBackends() throws {
        let status = try #require(UserMessageStatusPresentation(
            authoritativeStatus: nil, legacyStatus: "running"
        ))
        #expect(status.kind == .processing)
    }
}
