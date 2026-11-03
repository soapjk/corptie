import XCTest
import CorptieClientCore
@testable import CorptieMac

@MainActor final class UserMessageNavigationTests: XCTestCase {
    private actor Gate {
        var pending: [String: CheckedContinuation<ClientUserMessageNavigationPage, Never>] = [:]
        func wait(_ id: String) async -> ClientUserMessageNavigationPage {
            await withCheckedContinuation { pending[id] = $0 }
        }
        func has(_ id: String) -> Bool { pending[id] != nil }
        func finish(_ id: String, _ page: ClientUserMessageNavigationPage) { pending.removeValue(forKey: id)?.resume(returning: page) }
    }
    private func page(_ prefix: String, count: Int = 128, scanned: Int = 128) -> ClientUserMessageNavigationPage {
        .init(items: (0..<count).map { .init(id: "\(prefix)-\($0)", createdAt: "2026-11-03", preview: "Message \($0)") },
            olderCursor: "older", newerCursor: nil, scannedCount: scanned)
    }
    func testDelayedOldSessionCannotOverwriteCurrentDirectory() async {
        let gate = Gate()
        let state = UserMessageNavigationState { _, id, _, _ in await gate.wait(id) }
        state.activate(baseURL: URL(string: "http://127.0.0.1:49989")!, sessionID: "a")
        let a = Task { await state.refresh() }
        while !(await gate.has("a")) { await Task.yield() }
        state.activate(baseURL: URL(string: "http://127.0.0.1:49989")!, sessionID: "b")
        XCTAssertTrue(state.groups.isEmpty)
        let b = Task { await state.refresh() }
        while !(await gate.has("b")) { await Task.yield() }
        await gate.finish("b", page("b")); await b.value
        XCTAssertEqual(state.groups.count, 32)
        XCTAssertEqual(state.groups.first?.items.first?.id, "b-127")
        await gate.finish("a", page("a")); await a.value
        XCTAssertEqual(state.page?.items.first?.id, "b-0")
        XCTAssertFalse(state.loading)
    }
    func testInactivePageRejectsPendingResultsAndDoesNotReadOnMove() async {
        let gate = Gate()
        let state = UserMessageNavigationState { _, id, _, _ in await gate.wait(id) }
        state.activate(baseURL: URL(string: "http://127.0.0.1:49989")!, sessionID: "a")
        let task = Task { await state.refresh() }
        while !(await gate.has("a")) { await Task.yield() }
        state.stop()
        await gate.finish("a", page("a")); await task.value
        XCTAssertNil(state.page)
        await state.move(cursor: "older", direction: "older")
        let pending = await gate.has("a")
        XCTAssertFalse(pending)
    }
    private actor SparseLoader {
        private var count = 0
        let produceAt: Int?
        init(produceAt: Int?) { self.produceAt = produceAt }
        func read() -> ClientUserMessageNavigationPage {
            count += 1
            let items: [ClientUserMessageNavigationPage.Item] = count == produceAt
                ? [.init(id: "real-user-message", createdAt: "2026-11-03", preview: "Real message")] : []
            return .init(items: items, olderCursor: "range-\(count)", newerCursor: nil, scannedCount: 1024)
        }
        func calls() -> Int { count }
    }
    func testSparseRangesAdvanceBeforePublishingRealMarkers() async {
        let loader = SparseLoader(produceAt: 3)
        let state = UserMessageNavigationState { _, _, _, _ in await loader.read() }
        state.activate(baseURL: URL(string: "http://127.0.0.1:49989")!, sessionID: "sparse")
        await state.refresh()
        let calls = await loader.calls()
        XCTAssertEqual(calls, 3)
        XCTAssertEqual(state.groups.first?.items.first?.id, "real-user-message")
    }
    func testSparseScanBatchRemainsBoundedAndCreatesNoFakeMarkers() async {
        let loader = SparseLoader(produceAt: nil)
        let state = UserMessageNavigationState { _, _, _, _ in await loader.read() }
        state.activate(baseURL: URL(string: "http://127.0.0.1:49989")!, sessionID: "sparse")
        await state.refresh()
        let firstBatch = await loader.calls()
        XCTAssertEqual(firstBatch, 8)
        XCTAssertTrue(state.groups.isEmpty)
        await state.refresh()
        let secondBatch = await loader.calls()
        XCTAssertEqual(secondBatch, 16)
        XCTAssertFalse(state.loading)
    }

    func testReplyPreviewIsAdditiveAndBounded() throws {
        let legacy = try JSONDecoder().decode(ClientUserMessageNavigationPage.Item.self,
            from: Data(#"{"id":"user","createdAt":"2026-11-03","preview":"Question"}"#.utf8))
        XCTAssertNil(legacy.replyPreview)
        let modern = try JSONDecoder().decode(ClientUserMessageNavigationPage.Item.self,
            from: Data(#"{"id":"user","createdAt":"2026-11-03","preview":"Question","replyPreview":"Answer"}"#.utf8))
        XCTAssertEqual(modern.replyPreview, "Answer")
        let oversized = ClientUserMessageNavigationPage(items: [.init(id: "u", createdAt: "", preview: "Q",
            replyPreview: String(repeating: "a", count: 181))], olderCursor: nil, newerCursor: nil, scannedCount: 1)
        XCTAssertThrowsError(try oversized.validated())
    }

    func testPageContractBoundsAndEmptySparsePages() throws {
        XCTAssertNoThrow(try page("a").validated())
        XCTAssertThrowsError(try page("a", count: 129).validated())
        XCTAssertThrowsError(try page("a", scanned: 1025).validated())
        let empty = ClientUserMessageNavigationPage(items: [], olderCursor: "scan-next", newerCursor: nil, scannedCount: 1024)
        XCTAssertEqual(try empty.validated().olderCursor, "scan-next")
    }
}
