#if os(macOS)
import AppKit
import SwiftUI
import Testing
import CorptieClientCore
@testable import CorptieConversation

@MainActor @Suite(.serialized)
struct CoordinationProgressLayoutTests {
    private func progress(count: Int = 3, summary: String = "", title: String = "恢复测试", state: String = "running", reason: String = "") throws -> ClientCoordinationProgress {
        let items = (0..<count).map { ["assignmentId":"item:\($0)", "title":title, "state":state, "summary":summary, "reason":reason, "updatedAt":""] }
        return try JSONDecoder().decode(ClientCoordinationProgress.self, from: JSONSerialization.data(withJSONObject: [
            "version":1,"batchId":"batch:test","parentSessionId":"session:test","revision":1,"updatedAt":"",
            "counts":[:],"total":count,"items":items,"hasMore":false,"focus":"","decision":""
        ]))
    }
    private func height(_ value: ClientCoordinationProgress, width: CGFloat = 600) -> CGFloat {
        let host = NSHostingView(rootView: CoordinationProgressCard(progress: value, openSession: { _ in }).frame(width: width))
        host.layoutSubtreeIfNeeded()
        return host.fittingSize.height
    }
    @Test func threePlainRowsShrinkAndHiddenRowsNeverReserveSpace() throws {
        let three = height(try progress())
        #expect(three > 70 && three < 180)
        #expect(abs(height(try progress(count: 100)) - height(try progress(count: 4))) < 1)
        #expect(abs(height(try progress(summary: " \n ")) - three) < 1)
    }
    @Test func narrowCardGrowsForActualText() throws {
        let short = height(try progress(count: 1), width: 280)
        let wrapped = height(try progress(count: 1, summary: "实际进展" + String(repeating: "较长的进展说明", count: 15), title: String(repeating: "恢复测试", count: 12)), width: 280)
        #expect(wrapped > short)
        #expect(wrapped < 200)
    }
    @Test func blockingReasonAndReviewStateRemainDistinct() throws {
        let item = try #require(progress(count: 1, summary: "旧进度", state: "blocked", reason: "需要提供工作区").items.first)
        #expect(item.previewSummary == "需要提供工作区")
        #expect(item.statusTitle == "受阻")
        #expect(try progress(count: 1, state: "needs_review").items.first?.statusTitle == "待审查")
        #expect(try progress(count: 1, state: "future").items.first?.statusTitle == "状态待确认")
    }
}
#endif
