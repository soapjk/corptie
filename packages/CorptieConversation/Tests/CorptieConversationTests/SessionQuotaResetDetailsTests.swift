import Foundation
import SwiftUI
import Testing
@testable import CorptieConversation
#if os(macOS)
import AppKit
#endif

@Suite struct SessionQuotaResetDetailsTests {
    #if os(macOS)
    @MainActor @Test func fixedPopoverHasIdenticalSizeInEveryRefreshState() {
        var sizes: [CGSize] = []
        for state in [SessionQuotaResetDetails.Verification.loading, .idle, .failed] {
            let view = SessionQuotaResetDetails(verification: state, loadingText: "正在刷新",
                failureText: "刷新失败", resetText: "套餐重置：10月8日 10:30",
                bankedText: "已存额度重置：剩余 3 次", expiryText: "过期时间：10月9日 10:30",
                refreshedText: "已刷新", fixedWidth: 280, rowHeight: 16)
            let host = NSHostingView(rootView: view)
            sizes.append(host.fittingSize)
        }
        #expect(sizes.count == 3)
        #expect(sizes.allSatisfy { abs($0.width - 280) < 1 && abs($0.height - 105) < 1 })
    }
    #endif
}
