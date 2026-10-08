import XCTest
import SwiftUI
import UIKit
@testable import CorptieMobile

/// Native layout checks supplement, but never replace, real finger UI tests.
@MainActor final class StandardTimelineLayoutTests: XCTestCase {
    private var window: UIWindow!
    private var host: UIHostingController<PadStandardTimeline<AnyView, AnyView>>!
    private var scroll: UIScrollView?
    private var handle = PadNativeTimelineHandle()
    private var frames: [String: CGRect] = [:]
    private func input(count: Int = 180, height: CGFloat = 120,
                       saved: PadTimelineReadingPosition? = nil) -> PadNativeTimeline<AnyView, AnyView> {
        .init(ids: (0..<count).map { "row:\($0)" }, versions: [:], ready: true,
            savedPosition: saved, jumpRevision: 0, keyboard: .init(), handle: handle,
            row: { id, width in
                let index = Int(id.split(separator: ":").last!)!
                return AnyView(Text(id).frame(width: width,
                    height: index == count - 1 ? height : CGFloat(40 + index % 7 * 35)))
            }, composer: AnyView(Text("Composer").frame(height: 70)),
            onScrollView: { self.scroll = $0 }, onNearTop: { _, _, _ in }, onSave: { _ in },
            onUserInteraction: {}, onVisibleFrames: { frames, _ in self.frames = frames })
    }
    private func start() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        host = UIHostingController(rootView: PadStandardTimeline(input: input(), contentRevision: 1))
        window = UIWindow(windowScene: scene)
        window.rootViewController = host
        window.makeKeyAndVisible()
        await settle()
        XCTAssertNotNil(scroll, "Passive attachment must discover the real system scroll view")
    }
    private func settle() async {
        for _ in 0..<12 {
            window.layoutIfNeeded(); host.view.layoutIfNeeded()
            try? await Task.sleep(for: .milliseconds(25))
        }
    }
    private func assertBottom(file: StaticString = #filePath, line: UInt = #line) throws {
        let scroll = try XCTUnwrap(scroll)
        let maximum = max(-scroll.adjustedContentInset.top,
            scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        XCTAssertEqual(scroll.contentOffset.y, maximum, accuracy: 2, file: file, line: line)
        XCTAssertFalse(handle.showsJump, file: file, line: line)
        XCTAssertNotNil(frames["row:179"], "Actual tail must be realized", file: file, line: line)
        if let tail = frames["row:179"] {
            let readingHeight = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
            XCTAssertEqual(tail.maxY + 8, readingHeight, accuracy: 2,
                "The actual card, not only estimated content size, must dock", file: file, line: line)
        }
    }
    func testInitialAndOneExplicitJumpUseRealSystemBottom() async throws {
        try await start(); try assertBottom()
        // A system ScrollPosition request is a valid native layout check.
        // Direct setContentOffset is not a real SwiftUI finger interaction.
        handle.scrollToEntry?("row:10")
        await settle()
        XCTAssertTrue(handle.showsJump)
        handle.jump?(); await settle(); try assertBottom()
    }
    func testTailGrowthAndViewportResizeRemainAtBottom() async throws {
        try await start()
        host.rootView = PadStandardTimeline(input: input(height: 260), contentRevision: 2)
        await settle(); try assertBottom()
        for height in [CGFloat(520), 852] {
            window.frame.size.height = height
            await settle(); try assertBottom()
        }
    }
    func testThumbReadingIntentAllowsHistoryWithoutSizeChangeFollowing() async throws {
        try await start()
        handle.scrollbarInteraction?(true)
        await settle()
        handle.scrollToOffset?(500)
        await settle()
        XCTAssertTrue(handle.showsJump)
        handle.scrollbarInteraction?(false)
        handle.jump?(); await settle(); try assertBottom()
    }
    func testExplicitJumpInterruptsInFlightNativeScrollingWithoutWaiting() async throws {
        try await start()
        handle.scrollToEntry?("row:10"); await settle()
        let scroll = try XCTUnwrap(scroll)
        let start = scroll.contentOffset.y
        let target = start + 600
        scroll.setContentOffset(CGPoint(x: 0, y: target), animated: true)
        try await Task.sleep(for: .milliseconds(40))
        XCTAssertGreaterThan(scroll.contentOffset.y, start, "Exercise actual in-flight native motion")
        XCTAssertLessThan(scroll.contentOffset.y, target, "Jump must occur before motion finishes")
        handle.jump?()
        await settle(); try assertBottom()
        // A stale native animation must not move the viewport back to history.
        try await Task.sleep(for: .milliseconds(400))
        try assertBottom()
        XCTAssertTrue(scroll.panGestureRecognizer.isEnabled)
    }
    func testLocalRowBookmarkSurvivesNewHostingTree() async throws {
        try await start()
        handle.scrollToEntry?("row:120"); await settle()
        let bookmark = try XCTUnwrap(handle.currentPosition?())
        let id = try XCTUnwrap(bookmark.entryID)
        XCTAssertFalse(bookmark.followsLatest)
        let y = try XCTUnwrap(frames[id]).minY
        host = UIHostingController(rootView: PadStandardTimeline(input: input(saved: bookmark), contentRevision: 1))
        window.rootViewController = host
        await settle()
        XCTAssertEqual(try XCTUnwrap(frames[id]).minY, y, accuracy: 3)
        XCTAssertTrue(handle.showsJump)
    }
    override func tearDown() {
        window?.isHidden = true; window?.rootViewController = nil
        window = nil; host = nil; scroll = nil; frames = [:]
        super.tearDown()
    }
}
