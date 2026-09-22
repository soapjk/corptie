import CoreGraphics
import AppKit
import QuartzCore
import XCTest
@testable import CorptieMac

@MainActor
final class ActivityStatusTextTests: XCTestCase {
    func testSharedRendererReusesLayersAndStopsAnimationForTerminalOrReducedMotion() throws {
        let view = ActivityStatusLayerView(frame: CGRect(x: 0, y: 0, width: 140, height: 14))
        view.configure(text: "Running command", isActive: true, fontSize: 9, reduceMotion: false)
        let root = try XCTUnwrap(view.layer)
        let layers = try XCTUnwrap(root.sublayers)
        XCTAssertEqual(layers.count, 2)
        let mask = try XCTUnwrap(layers[0].mask as? CATextLayer)
        let text = try XCTUnwrap(mask.string as? NSAttributedString)
        for _ in 0..<1000 {
            view.configure(text: "Running command", isActive: true, fontSize: 9, reduceMotion: false)
        }
        XCTAssertTrue((mask.string as? NSAttributedString) === text, "Unchanged updates must not remeasure text")
        XCTAssertTrue(root.sublayers?[0] === layers[0])
        XCTAssertTrue(root.sublayers?[1] === layers[1])
        XCTAssertEqual(layers[1].animationKeys()?.count, 1)
        XCTAssertEqual(root.speed, 0, "Detached views must pause compositor work")
        view.configure(text: "Running command", isActive: true, fontSize: 9, reduceMotion: true)
        XCTAssertTrue(layers[1].isHidden)
        XCTAssertNil(layers[1].animationKeys())
        view.configure(text: "Finished", isActive: false, fontSize: 9, reduceMotion: false)
        XCTAssertTrue(layers[1].isHidden)
        XCTAssertNil(layers[1].animationKeys())
        XCTAssertEqual((mask.string as? NSAttributedString)?.string, "Finished")
        XCTAssertEqual(view.accessibilityLabel(), "Finished")
    }

    func testSharedActivityPerformanceAgainstFrozenDesktopRenderer() throws {
        guard ProcessInfo.processInfo.environment["CORPTIE_ACTIVITY_AB"] == "1" else {
            throw XCTSkip("Opt-in desktop activity renderer benchmark")
        }
        let legacy = LegacyActivityStatusLayerView(frame: CGRect(x: 0, y: 0, width: 140, height: 14))
        let shared = ActivityStatusLayerView(frame: legacy.frame)
        var oldSamples: [Double] = []
        var newSamples: [Double] = []
        func measure(_ body: () -> Void) -> Double {
            let start = CACurrentMediaTime()
            body()
            return (CACurrentMediaTime() - start) * 1000
        }
        for batch in 0..<80 {
            var old = 0.0
            var new = 0.0
            let oldRun = {
                old = measure {
                    for revision in 0..<100 {
                        legacy.configure(text: "Running command \(batch)-\(revision)",
                            isActive: true, fontSize: 9, reduceMotion: false)
                        legacy.layoutSubtreeIfNeeded()
                    }
                }
            }
            let newRun = {
                new = measure {
                    for revision in 0..<100 {
                        shared.configure(text: "Running command \(batch)-\(revision)",
                            isActive: true, fontSize: 9, reduceMotion: false)
                        shared.layoutSubtreeIfNeeded()
                    }
                }
            }
            if batch.isMultiple(of: 2) { oldRun(); newRun() } else { newRun(); oldRun() }
            XCTAssertEqual(shared.intrinsicContentSize, legacy.intrinsicContentSize)
            if batch >= 20 { oldSamples.append(old); newSamples.append(new) }
        }
        let oldP95 = oldSamples.sorted()[56]
        let newP95 = newSamples.sorted()[56]
        print("ACTIVITY_AB batch=100 native_p95=\(oldP95) shared_p95=\(newP95)")
        XCTAssertLessThanOrEqual(newP95, oldP95 * 1.5 + 0.5)
    }

    func testTerminalAuthoritativeDetailClearsStaleStartingActivity() {
        XCTAssertNil(BackendClient.reconciledActivityStatus(
            authoritativeStatus: .complete,
            authoritativeActivityStatus: nil,
            fallbackActivityStatus: "Starting Codex"
        ))
    }

    func testRunningAuthoritativeDetailMayRetainLastKnownActivity() {
        XCTAssertEqual(BackendClient.reconciledActivityStatus(
            authoritativeStatus: .running,
            authoritativeActivityStatus: nil,
            fallbackActivityStatus: "Running command"
        ), "Running command")
    }

    func testWideParentProposalCannotStretchStatusPastItsTextWidth() {
        let fitted = ActivityStatusText.fittedSize(
            proposedWidth: 900,
            proposedHeight: 40,
            intrinsicSize: CGSize(width: 84, height: 13)
        )

        XCTAssertEqual(fitted, CGSize(width: 84, height: 13))
    }

    func testNarrowParentProposalCompressesStatusInsteadOfExpandingTheRow() {
        let fitted = ActivityStatusText.fittedSize(
            proposedWidth: 48,
            proposedHeight: 40,
            intrinsicSize: CGSize(width: 84, height: 13)
        )

        XCTAssertEqual(fitted, CGSize(width: 48, height: 13))
    }

    func testUnboundedProposalUsesIntrinsicTextSize() {
        let fitted = ActivityStatusText.fittedSize(
            proposedWidth: .infinity,
            proposedHeight: nil,
            intrinsicSize: CGSize(width: 84, height: 13)
        )

        XCTAssertEqual(fitted, CGSize(width: 84, height: 13))
    }
}
