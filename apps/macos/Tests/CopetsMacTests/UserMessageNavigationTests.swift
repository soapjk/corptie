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
                ? (0..<6).reversed().map { .init(id: $0 == 0 ? "real-user-message" : "real-user-message-\($0)",
                    createdAt: "2026-11-03", preview: "Real message") } : []
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

    private actor PageFeed {
        var value = ClientUserMessageNavigationPage(items: [], olderCursor: nil, newerCursor: nil, scannedCount: 0)
        func set(_ next: ClientUserMessageNavigationPage) { value = next }
        func read() -> ClientUserMessageNavigationPage { value }
    }
    func testShortHistoryHidesUntilSixUsersAndHidesAgainAfterDeletion() async {
        let feed = PageFeed()
        let state = UserMessageNavigationState { _, _, _, _ in await feed.read() }
        state.activate(baseURL: URL(string: "http://127.0.0.1:49989")!, sessionID: "short")
        for count in [0, 1, 5, 6, 5] {
            let items = (0..<count).map { ClientUserMessageNavigationPage.Item(id: "u-\($0)", createdAt: "", preview: "Question") }
            await feed.set(.init(items: items, olderCursor: nil, newerCursor: nil, scannedCount: count))
            await state.refresh()
            XCTAssertEqual(state.showsNavigation, count >= 6)
        }
    }
    func testThresholdUsesDistinctUsersAcrossFullHistoryPages() async {
        func items(_ ids: [String]) -> [ClientUserMessageNavigationPage.Item] {
            ids.map { .init(id: $0, createdAt: "", preview: "Question") }
        }
        let first = ClientUserMessageNavigationPage(items: items(["a", "b"]), olderCursor: "older-a", newerCursor: nil, scannedCount: 1024)
        let second = ClientUserMessageNavigationPage(items: items(["b", "c"]), olderCursor: "older-b", newerCursor: "newer-a", scannedCount: 1024)
        let third = ClientUserMessageNavigationPage(items: items(["d", "e", "f"]), olderCursor: nil, newerCursor: "newer-b", scannedCount: 3)
        let state = UserMessageNavigationState { _, _, cursor, _ in
            cursor == nil ? first : (cursor == "older-a" ? second : third)
        }
        state.activate(baseURL: URL(string: "http://127.0.0.1:49989")!, sessionID: "paged")
        await state.refresh()
        XCTAssertTrue(state.showsNavigation)
        XCTAssertEqual(state.page?.items.count, 3, "A small historical page must not hide a known long conversation")
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

@MainActor final class UserMessageNavigationHoverTests: XCTestCase {
    private actor DwellGate {
        var delays: [Duration] = []
        var pending: [CheckedContinuation<Void, Never>] = []
        func wait(_ delay: Duration) async {
            delays.append(delay)
            await withCheckedContinuation { pending.append($0) }
        }
        func count() -> Int { delays.count }
        func firstDelay() -> Duration? { delays.first }
        func release() { if !pending.isEmpty { pending.removeFirst().resume() } }
    }
    private func group(_ id: String, ordinal: Int = 0) -> UserMessageNavigationGroup {
        .init(items: [.init(id: id, createdAt: "", preview: "Question")], ordinal: ordinal)
    }
    private func queued(_ gate: DwellGate, _ count: Int) async {
        for _ in 0..<1000 {
            if await gate.count() >= count { return }
            await Task.yield()
        }
        XCTFail("Dwell task was not queued")
    }
    private func settle() async { for _ in 0..<20 { await Task.yield() } }

    func testDwellIs600MillisecondsAndPassingPointerCannotOpenLater() async {
        let gate = DwellGate()
        let hover = UserMessageNavigationHover { await gate.wait($0) }
        let item = group("a")
        hover.enter(item)
        await queued(gate, 1)
        let delay = await gate.firstDelay()
        XCTAssertEqual(delay, .milliseconds(600))
        XCTAssertNil(hover.preview)
        hover.leave(item); hover.leaveRail()
        await gate.release(); await settle()
        XCTAssertNil(hover.preview, "A cancelled dwell must not reopen after pointer exit")
    }
    func testCompletedDwellShowsPreviewAndExitClearsAllEmphasis() async {
        let gate = DwellGate()
        let hover = UserMessageNavigationHover { await gate.wait($0) }
        let item = group("a", ordinal: 3)
        hover.enter(item); await queued(gate, 1)
        await gate.release(); await settle()
        XCTAssertEqual(hover.preview?.ordinal, 3)
        hover.leave(item); hover.leaveRail(); await settle()
        XCTAssertNil(hover.preview, "Idle markers derive no emphasized index after exit")
    }
    func testMovingBetweenMarkersRestartsDwellAndDiscardsOldCompletion() async {
        let gate = DwellGate()
        let hover = UserMessageNavigationHover { await gate.wait($0) }
        let a = group("a"), b = group("b", ordinal: 1)
        hover.enter(a); await queued(gate, 1)
        hover.leave(a); hover.enter(b); await queued(gate, 2)
        await gate.release(); await settle()
        XCTAssertNil(hover.preview)
        await gate.release(); await settle()
        XCTAssertEqual(hover.preview?.id, "b")
        hover.close()
        XCTAssertNil(hover.preview)
    }
    func testSourceToPreviewTransferAndImmediatePanelExit() async {
        let hover = UserMessageNavigationHover()
        let item = group("a")
        hover.showImmediately(item)
        hover.leaveRail()
        hover.panelHover(true)
        await settle()
        XCTAssertEqual(hover.preview?.id, "a")
        hover.panelHover(false); await settle()
        XCTAssertNil(hover.preview)
    }
    func testExplicitClickDoesNotWaitForDwell() {
        let hover = UserMessageNavigationHover()
        hover.showImmediately(group("clicked"))
        XCTAssertEqual(hover.preview?.id, "clicked")
        hover.close()
    }
}
