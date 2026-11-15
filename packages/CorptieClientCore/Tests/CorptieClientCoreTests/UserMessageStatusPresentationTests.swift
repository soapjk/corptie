import Foundation
import Testing
@testable import CorptieClientCore

struct UserMessageStatusPresentationTests {
    @Test func reliableSendingDoesNotClaimManualUnconfirmedDelivery() throws {
        for state in ["已保存，等待发送", "等待网络，恢复后自动发送", "等待重试，将自动发送", "等待前一条消息处理"] {
            let value = try #require(UserMessageStatusPresentation(authoritativeStatus: nil, legacyStatus: nil, localDeliveryState: state))
            #expect(value.kind != .deliveryUnknown)
            #expect(value.detail(languageCode: "zh").contains("自动发送"))
        }
        let stopped = try #require(UserMessageStatusPresentation(authoritativeStatus: nil, legacyStatus: nil,
            localDeliveryState: "已停止重试；不代表撤回"))
        #expect(stopped.kind == .retryStopped)
        #expect(stopped.detail(languageCode: "zh").contains("不代表已撤回"))
    }
    @Test func claimedMessageShowsPreparingUntilProviderAcceptance() throws {
        let value = try #require(UserMessageStatusPresentation(authoritativeStatus: "preparing",
            legacyStatus: "running", localDeliveryState: "Sent", queuePosition: 1))
        #expect(value.kind == .preparing)
        #expect(value.queuePosition == nil)
        #expect(value.shortLabel(languageCode: "zh") == "准备中")
        #expect(value.shortLabel(languageCode: "en") == "Preparing")
        #expect(value.detail(languageCode: "zh").contains("尚未交给模型"))
        #expect(value.light != .green)
    }

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
    @Test func pauseIsExplicitAndTerminalServerStatusCannotRegressToWaiting() throws {
        let block = try JSONDecoder().decode(ClientExecutionBlock.self, from: Data(#"{"code":"VERIFICATION_BUDGET_EXHAUSTED","kind":"paused","message":"quota","instructionId":"i","sessionId":"s"}"#.utf8))
        let paused = try #require(UserMessageStatusPresentation(authoritativeStatus:"paused",legacyStatus:"queued",queuePosition:2,executionBlock:block))
        #expect(paused.kind == .processingPaused)
        #expect(paused.queuePosition == nil)
        #expect(!paused.lightPulses)
        #expect(paused.detail(languageCode:"zh").contains("验证预算已用尽"))
        #expect(paused.detail(languageCode:"zh").contains("不会自动继续"))
        #expect(paused.detail(languageCode:"en").contains("will not continue automatically"))
        let failed = try #require(UserMessageStatusPresentation(authoritativeStatus:"queued",legacyStatus:"failed",processingError:"restart interrupted",executionBlock:block))
        #expect(failed.kind == .processingFailed)
        #expect(failed.detail(languageCode:"zh").contains("不会自动恢复"))
        #expect(failed.detail(languageCode:"zh").contains("restart interrupted"))
        let cancelled = try #require(UserMessageStatusPresentation(authoritativeStatus:"queued",legacyStatus:"cancelled"))
        #expect(cancelled.kind == .cancelled)
    }

}
