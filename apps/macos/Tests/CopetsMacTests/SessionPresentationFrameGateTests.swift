import AppKit
import XCTest
@testable import CorptieMac

@MainActor final class SessionPresentationFrameGateTests: XCTestCase {
    private final class Visibility { var value = false }
    func testNativeDrawMustPrecedeTheTwoRefreshTimestamps() async {
        let view = NSView()
        let gate = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        var delivered = false
        gate.arm(view: view, afterNativeDraw: true) { _ in delivered = true }
        gate.runLoopDidCommit()
        gate.displayTick(timestamp: 1); gate.displayTick(timestamp: 2)
        await drainMainQueue()
        XCTAssertFalse(delivered)
        gate.nativeDrawPrepared(at: 4)
        gate.displayTick(timestamp: 5); gate.displayTick(timestamp: 6); gate.displayTick(timestamp: 7)
        await drainMainQueue()
        XCTAssertFalse(delivered, "A commit before the target draw must not qualify that draw")
        gate.runLoopDidCommit()
        gate.displayTick(timestamp: 3); gate.displayTick(timestamp: 4); gate.displayTick(timestamp: 5)
        await drainMainQueue()
        XCTAssertFalse(delivered, "A pre-draw refresh is not a post-draw display opportunity")
        gate.displayTick(timestamp: 6)
        await drainMainQueue()
        XCTAssertFalse(delivered, "Leave two refresh intervals for the native opening page and compositor")
        gate.displayTick(timestamp: 7)
        await drainMainQueue()
        XCTAssertTrue(delivered)
    }
    func testNativeWarmGateCanRequireAnAdditionalRefreshInterval() async {
        let view = NSView()
        let gate = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        var delivered = false
        gate.arm(view: view, afterNativeDraw: true, minimumRefreshIntervals: 3) { _ in delivered = true }
        gate.nativeDrawPrepared(at: 1); gate.runLoopDidCommit()
        gate.displayTick(timestamp: 2); gate.displayTick(timestamp: 3); gate.displayTick(timestamp: 4)
        await drainMainQueue()
        XCTAssertFalse(delivered)
        gate.displayTick(timestamp: 5); await drainMainQueue()
        XCTAssertTrue(delivered)
    }

    func testCommitAndTwoDistinctTicksPrecedeDeferredDelivery() async {
        let view = NSView()
        let gate = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        var outcomes: [SessionPresentationFrameGate.Outcome] = []
        XCTAssertTrue(gate.arm(view: view) { outcomes.append($0) })
        gate.displayTick(timestamp: 1)
        gate.displayTick(timestamp: 2)
        await drainMainQueue()
        XCTAssertTrue(outcomes.isEmpty)
        gate.runLoopDidCommit()
        gate.displayTick(timestamp: 3)
        gate.displayTick(timestamp: 3)
        await drainMainQueue()
        XCTAssertTrue(outcomes.isEmpty)
        gate.displayTick(timestamp: 4)
        XCTAssertTrue(outcomes.isEmpty, "Do not perform activation inside a display-link callback")
        await drainMainQueue()
        XCTAssertEqual(outcomes, [.displayOpportunity])
        XCTAssertFalse(gate.isArmed)
        gate.timeoutExpired()
        XCTAssertEqual(outcomes.count, 1)
    }

    func testSupersededQueuedDeliveryCannotActivateNewRequest() async {
        let view = NSView()
        let gate = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        var old = 0, next = 0
        gate.arm(view: view) { _ in old += 1 }
        gate.runLoopDidCommit(); gate.displayTick(timestamp: 1); gate.displayTick(timestamp: 2)
        gate.arm(view: view) { _ in next += 1 }
        await drainMainQueue()
        XCTAssertEqual(old, 0); XCTAssertEqual(next, 0)
        XCTAssertTrue(gate.isArmed)
        gate.runLoopDidCommit(); gate.displayTick(timestamp: 3); gate.displayTick(timestamp: 4)
        await drainMainQueue()
        XCTAssertEqual(next, 1)
    }

    func testHiddenTargetCannotActivateAndCanRearmWhenVisible() async {
        let view = NSView()
        let visible = Visibility()
        let gate = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in visible.value })
        var outcomes: [SessionPresentationFrameGate.Outcome] = []
        XCTAssertFalse(gate.arm(view: view) { outcomes.append($0) })
        visible.value = true
        XCTAssertTrue(gate.arm(view: view) { outcomes.append($0) })
        gate.runLoopDidCommit(); gate.displayTick(timestamp: 1); gate.displayTick(timestamp: 2)
        visible.value = false
        await drainMainQueue()
        XCTAssertTrue(outcomes.isEmpty); XCTAssertFalse(gate.isArmed)
        visible.value = true
        gate.arm(view: view) { outcomes.append($0) }
        gate.timeoutExpired()
        XCTAssertEqual(outcomes, [.timedOut], "Timeout restores usability without claiming a display opportunity")
    }

    func testCancelAndReleasedTargetNeverDeliver() async {
        var view: NSView? = NSView()
        let gate = SessionPresentationFrameGate(automaticallySchedules: false, isVisible: { _ in true })
        var delivered = false
        gate.arm(view: view!) { _ in delivered = true }
        gate.runLoopDidCommit(); gate.displayTick(timestamp: 1); gate.displayTick(timestamp: 2)
        gate.cancel()
        await drainMainQueue()
        XCTAssertFalse(delivered)
        gate.arm(view: view!) { _ in delivered = true }
        view = nil
        gate.timeoutExpired()
        XCTAssertFalse(delivered); XCTAssertFalse(gate.isArmed)
    }

    func testActualDisplaySourceCompletesOrReportsTimeoutAndReleasesGate() async throws {
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 300),
                              styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let view = NSView(frame: window.contentView!.bounds)
        window.contentView = view
        window.orderFront(nil)
        defer { window.close() }
        // XCTest windows can be occluded on the host; override only that OS
        // visibility input. Exercise the real display-link and run-loop sources.
        var gate: SessionPresentationFrameGate? = SessionPresentationFrameGate(isVisible: { $0.window != nil })
        weak var released = gate
        let finished = expectation(description: "display opportunity or explicitly identified timeout")
        var count = 0
        gate?.arm(view: view) { _ in count += 1; finished.fulfill() }
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertEqual(count, 1)
        XCTAssertFalse(try XCTUnwrap(gate).isArmed)
        gate = nil
        XCTAssertNil(released, "A live display-link target must not retain the gate")
    }

    private func drainMainQueue() async {
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}
