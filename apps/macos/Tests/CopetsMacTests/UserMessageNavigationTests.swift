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
    func testPageContractBoundsAndEmptySparsePages() throws {
        XCTAssertNoThrow(try page("a").validated())
        XCTAssertThrowsError(try page("a", count: 129).validated())
        XCTAssertThrowsError(try page("a", scanned: 1025).validated())
        let empty = ClientUserMessageNavigationPage(items: [], olderCursor: "scan-next", newerCursor: nil, scannedCount: 1024)
        XCTAssertEqual(try empty.validated().olderCursor, "scan-next")
    }
}
