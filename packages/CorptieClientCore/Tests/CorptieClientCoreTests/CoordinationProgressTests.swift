import Foundation
import Testing
@testable import CorptieClientCore

@Suite("Coordination progress contract")
struct CoordinationProgressTests {
    @Test func decodesPreparedPreviewWithStableAssignmentIdentity() throws {
        let data = Data(#"{"version":1,"batchId":"batch:one","parentSessionId":"logical:parent","revision":4,"updatedAt":"2026-11-04T00:00:00Z","counts":{"needs_review":1},"total":5,"items":[{"assignmentId":"assignment:a","taskId":"task:child","sessionId":"logical:child","title":"认证接口","state":"needs_review","summary":"待核实交付","reason":"","reportMessageId":"message:one","updatedAt":"2026-11-04T00:00:00Z"}],"hasMore":true,"focus":"等待集成","decision":""}"#.utf8)
        let progress = try JSONDecoder().decode(ClientCoordinationProgress.self, from: data)
        #expect(progress.items[0].id == "assignment:a")
        #expect(progress.items[0].state == "needs_review")
        #expect(progress.total == 5)
        #expect(progress.hasMore)
        #expect(try JSONDecoder().decode(ClientCoordinationProgress.self, from: JSONEncoder().encode(progress)) == progress)
    }
}

@Suite("Progress native integration")
struct CoordinationProgressNativeTests {
    private func document(version: Int = 1) -> Data {
        Data("""
        {"protocolVersion":1,"catalog":"native-business-v1","documentId":"detail:parent","sessionId":"logical:parent","generation":"one","revision":"one","cards":[{"id":"coordination-progress","kind":"coordinationProgress","version":\(version),"revision":"1","loadState":"ready","actions":[],"nextCursor":null,"data":{"version":1,"batchId":"batch:one","parentSessionId":"logical:parent","revision":1,"updatedAt":"2026-11-04T00:00:00Z","counts":{"needs_review":1},"total":1,"items":[{"assignmentId":"one","taskId":"task:child","sessionId":"logical:child","title":"Child","state":"needs_review","summary":"","reason":"","reportMessageId":null,"updatedAt":"2026-11-04T00:00:00Z"}],"hasMore":false,"focus":"","decision":""}}],"order":["coordination-progress"]}
        """.utf8)
    }
    @Test func sharedDetailPolicyDisplaysProgressForTaskContext() throws {
        let value = try ClientDetailBusinessDocument.decode(document())
        let card = try #require(value.cards.first)
        #expect(ClientDetailCardPolicy.isVisible(card, context: .init(sessionKind: "worker", taskID: "task:parent", workID: "work:one")))
        guard case .coordinationProgress(let progress) = card.payload else { Issue.record("Progress payload missing"); return }
        #expect(progress.items[0].state == "needs_review")
        #expect(progress.items[0].statusTitle == "待审查")
    }
    @Test func futureCardVersionDoesNotBreakTheDocument() throws {
        let value = try ClientDetailBusinessDocument.decode(document(version: 2))
        guard case .unsupported = value.cards[0].payload else { Issue.record("Future card must be unsupported"); return }
    }
}

@Suite("Coordination stage presentation")
struct CoordinationStageTests {
    @Test func followupBlockKeepsPreviousCompletionSeparate() throws {
        let data = Data(#"{"assignmentId":"one","taskId":"child","sessionId":"session","title":"模块","state":"blocked","phase":"shadow","previousExecutionStatus":"completed","summary":"","reason":"影子处理失败","reportMessageId":null,"updatedAt":"now"}"#.utf8)
        let item = try JSONDecoder().decode(ClientCoordinationProgressItem.self, from: data)
        #expect(item.statusTitle == "后续派发受阻")
        #expect(item.previousExecutionTitle == "上一轮执行已结束，后续指令尚未送达。")
        #expect(item.previewSummary == "影子处理失败")
        var delivery = item
        delivery.phase = "delivery"
        #expect(delivery.statusTitle == "交付受阻")
        #expect(delivery.previousExecutionTitle == nil)
        delivery.phase = "reclamation"
        #expect(delivery.statusTitle == "回收受阻")
    }
}
