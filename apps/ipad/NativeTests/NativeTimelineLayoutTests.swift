import XCTest
import SwiftUI
import UIKit
import CorptieClientCore
import CorptieConversation
@testable import CorptieMobile

@MainActor final class MessageImageDecodeTests: XCTestCase {
    func testLargeImageIsDownsampledWithoutChangingAspectRatio() async throws {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4096, height: 256), format: format).image { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 4096, height: 256))
        }
        let data = try XCTUnwrap(image.pngData())
        let decoded = await PadMessageImageStore.decode(data)
        let thumbnail = try XCTUnwrap(decoded)
        let bitmap = try XCTUnwrap(thumbnail.cgImage)
        XCTAssertLessThanOrEqual(bitmap.width, 1024)
        XCTAssertEqual(Double(bitmap.width) / Double(bitmap.height), 16, accuracy: 0.1)
        let invalid = await PadMessageImageStore.decode(Data("not an image".utf8))
        XCTAssertNil(invalid)
    }
}

@MainActor final class MessageMeasurementCacheTests: XCTestCase {
    private func view(_ entry: PadMessageLayout.Entry) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isScrollEnabled = false
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.attributedText = entry.attributed
        return view
    }

    func testSystemSizeIsReusedAcrossRecreatedTextViews() {
        let text = String(repeating: "Long **Markdown** with a [link](https://example.com).\n", count: 150)
        let entry = PadMessageLayout.entry(text: text, style: .agent)
        let firstView = view(entry)
        let width: CGFloat = 327.25
        let raw = firstView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        let expected = CGSize(width: min(width, ceil(raw.width)), height: ceil(raw.height))
        XCTAssertEqual(entry.size(width: width, view: firstView), expected)
        let count = entry.measurementCount
        let recreated = PadMessageLayout.entry(text: text, style: .agent)
        XCTAssertTrue(entry === recreated)
        for _ in 0..<100 {
            XCTAssertEqual(recreated.size(width: width, view: view(recreated)), expected)
        }
        XCTAssertEqual(entry.measurementCount, count)
    }

    func testFractionalWidthConfigurationAndBodyChangesInvalidate() {
        let text = "cache-input-\(UUID())\n" + String(repeating: "word ", count: 100)
        let entry = PadMessageLayout.entry(text: text, style: .agent)
        let textView = view(entry)
        _ = entry.size(width: 300.1, view: textView)
        _ = entry.size(width: 300.2, view: textView)
        XCTAssertEqual(entry.measurementCount, 2)
        textView.textContainerInset.bottom = 12
        let changed = entry.size(width: 300.2, view: textView)
        let raw = textView.sizeThatFits(CGSize(width: 300.2, height: .greatestFiniteMagnitude))
        XCTAssertEqual(changed.height, ceil(raw.height))
        XCTAssertEqual(entry.measurementCount, 3)
        textView.traitOverrides.preferredContentSizeCategory = .accessibilityExtraExtraExtraLarge
        _ = entry.size(width: 300.2, view: textView)
        XCTAssertEqual(entry.measurementCount, 4)
        textView.textContainer.lineFragmentPadding = 5
        _ = entry.size(width: 300.2, view: textView)
        XCTAssertEqual(entry.measurementCount, 5)
        XCTAssertFalse(entry === PadMessageLayout.entry(text: "different body", style: .agent))
        XCTAssertFalse(entry === PadMessageLayout.entry(text: text, style: .user))
        PadMessageLayout.removeAllCachedEntries()
        let reloaded = PadMessageLayout.entry(text: text, style: .agent)
        XCTAssertFalse(entry === reloaded)
        XCTAssertEqual(reloaded.size(width: 300.2, view: view(reloaded)),
                       entry.size(width: 300.2, view: view(entry)))
    }

    func testProposalStorageIsBoundedAndEvictedInputsRemeasureCorrectly() {
        let entry = PadMessageLayout.entry(text: "bounded \(UUID())", style: .agent)
        let textView = view(entry)
        for width in 200..<220 { _ = entry.size(width: CGFloat(width), view: textView) }
        let before = entry.measurementCount
        let result = entry.size(width: 200, view: textView)
        XCTAssertEqual(entry.measurementCount, before + 1)
        let raw = textView.sizeThatFits(CGSize(width: 200, height: CGFloat.greatestFiniteMagnitude))
        XCTAssertEqual(result, CGSize(width: min(200, ceil(raw.width)), height: ceil(raw.height)))
    }
}

/// Actual UICollectionView + hosted SwiftUI cells, not source-string assertions.
@MainActor final class NativeTimelineLayoutTests: XCTestCase {
    private var window: UIWindow!
    private var handle: PadNativeTimelineHandle!
    private var controller: PadNativeTimelineController<AnyView, AnyView>!
    private var scroll: UICollectionView!

    private func input(count: Int = 180, first: Int = 0, tailHeight: CGFloat = 120,
                       saved: PadTimelineReadingPosition? = nil, composerHeight: CGFloat = 70,
                       heightAdjustment: CGFloat = 0) -> PadNativeTimeline<AnyView, AnyView> {
        let ids = (first..<count).map { "row:\($0)" }
        let versions = Dictionary(uniqueKeysWithValues: ids.map {
            ($0, PadNativeTimelineRowVersion(decoration: $0 == ids.last ? "\(tailHeight)" : "fixed:\(heightAdjustment)"))
        })
        return .init(ids: ids, versions: versions, ready: true, savedPosition: saved,
            jumpRevision: 0, keyboard: .init(), handle: handle,
            row: { id, width in
                let index = Int(id.split(separator: ":").last!)!
                return AnyView(Text(id).frame(width: width, height: index == count - 1 ? tailHeight : CGFloat(40 + index % 7 * 35) + heightAdjustment))
            }, composer: AnyView(TextField("Native test input", text: .constant(""))
                .accessibilityIdentifier("native-layout-input").frame(height: composerHeight)),
            onScrollView: { self.scroll = $0 as? UICollectionView }, onNearTop: { _, _, _ in },
            onSave: { _ in }, onUserInteraction: {}, onVisibleFrames: { _, _ in })
    }
    private func start(count: Int = 180, saved: PadTimelineReadingPosition? = nil) async throws {
        handle = PadNativeTimelineHandle()
        controller = PadNativeTimelineController(input: input(count: count, saved: saved))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 852)
        window.rootViewController = controller
        window.makeKeyAndVisible()
        await settle()
    }
    private func settle() async {
        for _ in 0..<8 {
            window.layoutIfNeeded()
            controller.view.layoutIfNeeded()
            scroll?.layoutIfNeeded()
            try? await Task.sleep(for: .milliseconds(25))
        }
    }
    private var maximum: CGFloat {
        max(-scroll.adjustedContentInset.top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
    }
    private func assertBottom(file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(scroll.contentOffset.y, maximum, accuracy: 1, file: file, line: line)
        XCTAssertFalse(handle.showsJump, file: file, line: line)
        let last = IndexPath(item: scroll.numberOfItems(inSection: 0) - 1, section: 0)
        XCTAssertNotNil(scroll.cellForItem(at: last), "Real final cell must be realized", file: file, line: line)
        if let attributes = scroll.collectionViewLayout.layoutAttributesForItem(at: last) {
            let bottom = attributes.frame.maxY - scroll.contentOffset.y
            XCTAssertEqual(bottom, scroll.bounds.height - scroll.adjustedContentInset.bottom - 8, accuracy: 2, file: file, line: line)
        }
        XCTAssertLessThan(scroll.visibleCells.count, 30, "Keep native cell virtualization", file: file, line: line)
    }
    func testOneJumpFromHistoryRealizesTailAndHidesButton() async throws {
        try await start()
        handle.scrollbarInteraction?(true)
        scroll.setContentOffset(CGPoint(x: 0, y: 300), animated: false)
        handle.scrollbarInteraction?(false)
        await settle()
        XCTAssertTrue(handle.showsJump)
        handle.jump?()
        await settle()
        assertBottom()
    }
    func testHistoryCardPresentationGapsStayFixedDuringScrollingAndSizing() async throws {
        try await start()
        controller.scrollViewWillBeginDragging(scroll)
        scroll.setContentOffset(CGPoint(x: 0, y: 500), animated: false)
        await settle()
        let probe = HistoricalGapProbe(collection: scroll)
        probe.start()
        // Exercise newly realized heterogeneous rows and sizing corrections
        // under an ambient animation without adding card-spacing animation.
        for step in 0..<12 {
            UIView.animate(withDuration: 0.25) {
                self.controller.update(self.input(heightAdjustment: CGFloat(step % 3 * 9)))
                self.scroll.setContentOffset(CGPoint(x: 0, y: 500 + step * 53), animated: false)
                self.scroll.layoutIfNeeded()
            }
            try? await Task.sleep(for: .milliseconds(40))
        }
        controller.scrollViewDidEndDragging(scroll, willDecelerate: true)
        scroll.setContentOffset(CGPoint(x: 0, y: 1500), animated: true)
        try? await Task.sleep(for: .milliseconds(500))
        controller.scrollViewDidEndDecelerating(scroll)
        await settle()
        probe.stop()
        XCTAssertGreaterThan(probe.pairCount, 20)
        XCTAssertLessThan(probe.maximumGapError, 2, "Adjacent presentation frames must not stretch independently")
        XCTAssertLessThan(scroll.visibleCells.count, 30)
        handle.jump?()
        await settle()
        assertBottom()
    }

    func testSnapshotDuringUserScrollDoesNotRestoreOldReadingAnchor() async throws {
        try await start()
        controller.scrollViewWillBeginDragging(scroll)
        scroll.setContentOffset(CGPoint(x: 0, y: 800), animated: false)
        await settle()
        controller.update(input(first: -20))
        // The user's newer offset owns the viewport, not the snapshot anchor.
        scroll.setContentOffset(CGPoint(x: 0, y: 1250), animated: false)
        await settle()
        let offset = scroll.contentOffset.y
        scroll.setContentOffset(CGPoint(x: 0, y: offset + 100), animated: false)
        await settle()
        XCTAssertEqual(scroll.contentOffset.y, offset + 100, accuracy: 1)
        controller.scrollViewDidEndDragging(scroll, willDecelerate: false)
    }
    func testJumpInterruptsActiveThumbAndNativeAnimatedScrolling() async throws {
        try await start()
        handle.scrollbarInteraction?(true)
        scroll.setContentOffset(CGPoint(x: 0, y: 500), animated: true)
        try await Task.sleep(for: .milliseconds(40))
        handle.jump?()
        await settle()
        assertBottom()
    }
    func testBottomBounceDoesNotShowHistoryControl() async throws {
        try await start()
        handle.scrollbarInteraction?(true)
        scroll.setContentOffset(CGPoint(x: 0, y: maximum + 60), animated: false)
        await settle()
        XCTAssertFalse(handle.showsJump)
        handle.scrollbarInteraction?(false)
    }
    func testViewportResizeAndSameIDTailGrowthStayDocked() async throws {
        try await start()
        for height in [CGFloat(520), 852, 610, 852] {
            window.frame.size.height = height
            window.setNeedsLayout()
            await settle()
            assertBottom()
        }
        controller.update(input(tailHeight: 450))
        await settle()
        assertBottom()
    }
    func testHistoryBookmarkSurvivesPrependAndResize() async throws {
        let bookmark = PadTimelineReadingPosition(followsLatest: false, entryID: "row:80", minY: -25)
        try await start(saved: bookmark)
        XCTAssertEqual(handle.currentPosition?()?.followsLatest, false)
        window.frame.size.height = 600
        window.setNeedsLayout()
        await settle()
        let restored = handle.currentPosition?()
        XCTAssertEqual(restored?.entryID, "row:80")
        XCTAssertEqual(restored?.minY ?? 999, -25, accuracy: 2)
    }
    func testPrependingHistoryPreservesActualVisibleMessageOffset() async throws {
        try await start()
        for _ in 0..<3 {
            controller.update(input(first: 50))
            await settle()
            handle.scrollToEntry?("row:90")
            await settle()
            let before = try XCTUnwrap(handle.currentPosition?())
            controller.update(input(first: 0))
            await settle()
            let after = try XCTUnwrap(handle.currentPosition?())
            XCTAssertEqual(after.entryID, before.entryID)
            XCTAssertEqual(after.minY, before.minY, accuracy: 2)
        }
    }
    func testJumpDuringSnapshotUpdateCannotRestoreOldHistoryAnchor() async throws {
        try await start()
        handle.scrollToEntry?("row:60")
        await settle()
        controller.update(input(count: 181, tailHeight: 380))
        handle.jump?()
        await settle()
        assertBottom()
    }
    func testDetachedOwnerDoesNotClearReplacementControllerCommands() async throws {
        try await start()
        let old = controller
        let replacement = PadNativeTimelineController(input: input())
        window.rootViewController = replacement
        controller = replacement
        await settle()
        old?.detach()
        XCTAssertNotNil(handle.jump)
        handle.jump?()
        await settle()
        assertBottom()
    }
    func testHostedCellsDoNotRetainTheDetachedController() async throws {
        try await start()
        weak var released = controller
        controller.detach()
        window.isHidden = true
        window.rootViewController = nil
        controller = nil
        scroll = nil
        // UIKit releases the old root after the run-loop transaction commits;
        // Task.yield alone does not guarantee a run-loop turn.
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertNil(released)
    }
    func testShortConversationIsBottomAligned() async throws {
        try await start(count: 1)
        assertBottom()
    }
    func testWidthChangesReconfigureHostedCardsWithoutStaleMargins() async throws {
        try await start()
        for width in [CGFloat(768), 393, 430, 393] {
            window.frame.size.width = width
            window.setNeedsLayout()
            await settle()
            assertBottom()
            for cell in scroll.visibleCells {
                XCTAssertEqual(cell.frame.minX, PadTimelineLayoutMetrics.horizontalMargin, accuracy: 1)
                XCTAssertEqual(cell.frame.width, scroll.bounds.width - 2 * PadTimelineLayoutMetrics.horizontalMargin, accuracy: 1)
            }
        }
    }
    private func textField(in view: UIView) -> UITextField? {
        if let field = view as? UITextField { return field }
        for child in view.subviews {
            if let field = textField(in: child) { return field }
        }
        return nil
    }
    private func textView(in view: UIView) -> UITextView? {
        if let field = view as? UITextView { return field }
        for child in view.subviews {
            if let field = textView(in: child) { return field }
        }
        return nil
    }
    func testRealKeyboardCyclesAndStreamingKeepFinalCellVisibleAndDocked() async throws {
        try await start()
        let expandedHeight = scroll.bounds.height - scroll.adjustedContentInset.bottom
        for cycle in 0..<5 {
            let field = try XCTUnwrap(textField(in: controller.view))
            XCTAssertTrue(field.becomeFirstResponder())
            for _ in 0..<3 { await settle() }
            XCTAssertLessThan(scroll.bounds.height - scroll.adjustedContentInset.bottom, expandedHeight - 100,
                "The keyboard changes the readable inset, not the drawable viewport")
            XCTAssertEqual(scroll.frame.maxY, controller.view.bounds.maxY, accuracy: 1)
            XCTAssertEqual(controller.view.subviews.first(where: { $0 !== scroll })?.bounds.height ?? -1, 70, accuracy: 1,
                "The composer must not add a second keyboard safe area to its intrinsic height")
            assertBottom()
            controller.update(input(tailHeight: CGFloat(180 + cycle * 40)))
            await settle()
            assertBottom()
            window.endEditing(true)
            for _ in 0..<3 { await settle() }
            XCTAssertEqual(scroll.bounds.height - scroll.adjustedContentInset.bottom, expandedHeight, accuracy: 1)
            assertBottom()
        }
    }
    func testHistoryJumpControlIsHiddenWhileActualKeyboardIsOpen() async throws {
        try await start()
        handle.scrollToEntry?("row:60")
        await settle()
        XCTAssertTrue(handle.showsJump)
        let field = try XCTUnwrap(textField(in: controller.view))
        XCTAssertTrue(field.becomeFirstResponder())
        for _ in 0..<3 { await settle() }
        XCTAssertFalse(handle.showsJump)
        window.endEditing(true)
        for _ in 0..<3 { await settle() }
        XCTAssertTrue(handle.showsJump)
    }
    func testKeyboardAnimationDoesNotLeaveTailFloatingOrCellsMissing() async throws {
        try await start()
        let field = try XCTUnwrap(textField(in: controller.view))
        let probe = KeyboardFrameProbe(collection: scroll, root: controller.view)
        probe.start()
        XCTAssertTrue(field.becomeFirstResponder())
        for _ in 0..<4 { await settle() }
        window.endEditing(true)
        for _ in 0..<4 { await settle() }
        probe.stop()
        XCTAssertGreaterThan(probe.sampleCount, 15)
        XCTAssertEqual(probe.missingRows, 0, "No empty native cell viewport during keyboard animation")
        XCTAssertLessThan(probe.maximumDockingError, 8,
            "Presentation-layer tail and composer must travel together, not just align after the animation")
    }
    func testSwiftUINavigationAndGeometryReaderDoNotAvoidKeyboardTwice() async throws {
        handle = PadNativeTimelineHandle()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: NativeHostedParent(input: input()))
        window.makeKeyAndVisible()
        for _ in 0..<8 {
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(25))
        }
        controller = try XCTUnwrap(findNativeController(in: window.rootViewController!))
        await settle()
        let fullHeight = controller.view.bounds.height
        let field = try XCTUnwrap(textField(in: controller.view))
        XCTAssertTrue(field.becomeFirstResponder())
        for _ in 0..<3 { await settle() }
        XCTAssertEqual(controller.view.bounds.height, fullHeight, accuracy: 1,
            "SwiftUI ancestors must not shrink the native root a second time")
        XCTAssertEqual(scroll.frame.maxY, controller.view.bounds.maxY, accuracy: 1)
        XCTAssertEqual(scroll.bounds.height - scroll.adjustedContentInset.bottom,
            controller.view.keyboardLayoutGuide.layoutFrame.minY - 70, accuracy: 1)
        assertBottom()
        window.endEditing(true)
        for _ in 0..<3 { await settle() }
        assertBottom()
    }
    func testConsumedSafeAreaDoesNotPermanentlyHideHistoryButton() async throws {
        handle = PadNativeTimelineHandle()
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView: NativeHostedParent(input: input(), consumeBottom: true))
        window.makeKeyAndVisible()
        try await Task.sleep(for: .milliseconds(250))
        controller = try XCTUnwrap(findNativeController(in: window.rootViewController!))
        await settle()
        let guideHeight = controller.view.keyboardLayoutGuide.layoutFrame.height
        XCTAssertGreaterThan(guideHeight, controller.view.safeAreaInsets.bottom + 1,
            "This fixture must reproduce the previous false keyboard-height predicate")
        controller.scrollViewWillBeginDragging(scroll)
        scroll.setContentOffset(CGPoint(x: 0, y: 400), animated: false)
        await settle()
        XCTAssertTrue(handle.showsJump, "Show during an active history drag, not only after stopping")
        handle.jump?()
        await settle()
        assertBottom()
    }
    func testCellsRemainRealizedUnderFloatingHeaderAndComposer() async throws {
        try await start()
        var next = input()
        next.topOverlayHeight = 60
        controller.update(next)
        await settle()
        XCTAssertEqual(scroll.frame.minY, 0)
        XCTAssertEqual(scroll.frame.width, controller.view.bounds.width)
        XCTAssertEqual(scroll.contentInset.top, 60, accuracy: 1)
        let composer = try XCTUnwrap(controller.view.subviews.first(where: { $0 !== scroll }))
        XCTAssertEqual(scroll.contentInset.bottom, scroll.frame.maxY - composer.frame.minY, accuracy: 1)
        assertBottom()
        handle.scrollbarInteraction?(true)
        scroll.setContentOffset(CGPoint(x: 0, y: 450), animated: false)
        await settle()
        let frames = scroll.visibleCells.map { $0.frame.offsetBy(dx: 0, dy: -scroll.contentOffset.y) }
        XCTAssertTrue(frames.contains { $0.minY < 60 && $0.maxY > 0 }, "Cells are realized underneath the floating title")
        XCTAssertTrue(frames.contains { $0.maxY > composer.frame.minY && $0.minY < scroll.bounds.height },
            "Cells are realized underneath the glass input, not clipped at its top")
        handle.scrollbarInteraction?(false)
    }
    func testComposerHeightChangesKeepAnEightPointTailGap() async throws {
        try await start()
        for height in [CGFloat(170), 95, 240, 70] {
            controller.update(input(composerHeight: height))
            await settle()
            assertBottom()
            let composer = try XCTUnwrap(controller.view.subviews.first(where: { $0 !== scroll }))
            let last = IndexPath(item: scroll.numberOfItems(inSection: 0) - 1, section: 0)
            let cell = try XCTUnwrap(scroll.cellForItem(at: last))
            XCTAssertEqual(composer.frame.minY - (cell.frame.maxY - scroll.contentOffset.y), 8, accuracy: 2)
        }
    }
    func testComposerStaysOnSystemBoundaryThroughoutKeyboardAnimation() async throws {
        try await start()
        await settle()
        assertBottom()
        XCTAssertEqual(scroll.contentInset.bottom, controller.view.bounds.maxY - controller.view.keyboardLayoutGuide.layoutFrame.minY + 70, accuracy: 1)
        let probe = KeyboardFrameProbe(collection: scroll, root: controller.view)
        probe.start()
        let field = try XCTUnwrap(textField(in: controller.view))
        XCTAssertTrue(field.becomeFirstResponder())
        for _ in 0..<3 { await settle() }
        XCTAssertEqual(scroll.contentInset.bottom, controller.view.bounds.maxY - controller.view.keyboardLayoutGuide.layoutFrame.minY + 70, accuracy: 1)
        assertBottom()
        window.endEditing(true)
        for _ in 0..<3 { await settle() }
        XCTAssertEqual(scroll.contentInset.bottom, controller.view.bounds.maxY - controller.view.keyboardLayoutGuide.layoutFrame.minY + 70, accuracy: 1)
        assertBottom()
        probe.stop()
        XCTAssertEqual(probe.missingRows, 0)
        XCTAssertLessThan(probe.maximumDockingError, 8)
    }
    func testFullScreenDrawingKeepsKeyboardTransactionAligned() async throws {
        try await verifyFullScreenKeyboard(topHeight: 110)
    }
    func testTopReadingInsetKeepsKeyboardTransactionAligned() async throws {
        try await verifyFullScreenKeyboard(topHeight: 150)
    }
    func testFullScreenDrawingWithoutHeaderKeepsKeyboardTransactionAligned() async throws {
        try await verifyFullScreenKeyboard(topHeight: 0)
    }
    func testFullScreenViewportRealizesAWholeCellStartingInHomeStrip() async throws {
        try await start()
        handle.scrollToEntry?("row:90")
        await settle()
        handle.scrollbarInteraction?(true)
        let path = IndexPath(item: 90, section: 0)
        // Place a whole row in the Home strip, below the readable rectangle.
        for _ in 0..<2 {
            let attributes = try XCTUnwrap(scroll.collectionViewLayout.layoutAttributesForItem(at: path))
            scroll.setContentOffset(CGPoint(x: 0, y: attributes.frame.minY - scroll.bounds.height + 20), animated: false)
            await settle()
        }
        let cell = try XCTUnwrap(scroll.cellForItem(at: path),
            "Full-screen layout must instantiate cells in the Home strip")
        let rect = cell.convert(cell.bounds, to: window)
        XCTAssertGreaterThan(rect.minY, window.bounds.maxY - window.safeAreaInsets.bottom)
        XCTAssertLessThan(rect.minY, window.bounds.maxY)
        XCTAssertLessThan(scroll.visibleCells.count, 30)
        handle.scrollbarInteraction?(false)
    }
    private func verifyFullScreenKeyboard(topHeight: CGFloat) async throws {
        try await start()
        var next = input()
        next.topOverlayHeight = topHeight
        controller.update(next)
        await settle()
        XCTAssertEqual(scroll.frame.maxY, controller.view.bounds.maxY, accuracy: 1)
        XCTAssertEqual(scroll.contentInset.bottom, controller.view.bounds.maxY - controller.view.keyboardLayoutGuide.layoutFrame.minY + 70, accuracy: 1)
        assertBottom()
        let probe = KeyboardFrameProbe(collection: scroll, root: controller.view)
        probe.start()
        let field = try XCTUnwrap(textField(in: controller.view))
        XCTAssertTrue(field.becomeFirstResponder())
        for _ in 0..<3 { await settle() }
        XCTAssertEqual(scroll.contentInset.bottom, controller.view.bounds.maxY - controller.view.keyboardLayoutGuide.layoutFrame.minY + 70, accuracy: 1)
        assertBottom()
        window.endEditing(true)
        for _ in 0..<3 { await settle() }
        XCTAssertEqual(scroll.frame.maxY, controller.view.bounds.maxY, accuracy: 1)
        assertBottom()
        probe.stop()
        XCTAssertEqual(probe.missingRows, 0)
        XCTAssertLessThan(probe.maximumDockingError, 8)
    }
    func testActualConversationWithMarkdownShowsHistoryButtonAndDocksAboveQuickMessages() async throws {
        let suite = "native-conversation-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        // Every product-side request is intercepted locally: no account, real
        // session, LAN backend, image upload or public relay is contacted.
        let transport = BackendTransport(endpoint: try BackendEndpoint(URL(string: "http://127.0.0.1")!),
            data: { _ in throw CancellationError() }, bytes: { _ in throw CancellationError() })
        let connection = PadConnection(transportOverride: transport)
        connection.serverID = suite
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "native-fixture"
        let rows: [[String: Any]] = (0..<80).map { index in
            ["id": "actual:\(index)", "turnId": "turn:\(index)",
             "type": index % 2 == 0 ? "userMessage" : "agentMessage",
             "text": index % 2 == 0 ? "测试用户消息 \(index)" : """
             ## 实际 Markdown 卡片 \(index)
             | 项目 | 数值 | 说明 |
             | --- | ---: | --- |
             | BTC | 12345 | 多行内容自适应宽度 |
             | ETH | 678 | 验证真实消息卡片 |

             ```swift
             let value = \(index)
             ```
             正文内容用于验证列表复用、玻璃下穿透和底部避让。
             """, "presentationRole": "final_answer"]
        }
        workspace.messages = try JSONDecoder().decode([ClientMessage].self,
            from: JSONSerialization.data(withJSONObject: rows))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        window = UIWindow(windowScene: scene)
        window.rootViewController = UIHostingController(rootView:
            GeometryReader { _ in
                NavigationStack {
                    ConversationView(connection: connection, workspace: workspace,
                        sessionID: "native-fixture", messageImages: PadMessageImageStore(),
                        onBack: {}, onOpenDetail: {}, onOpenWorktrees: {})
                }
            })
        window.makeKeyAndVisible()
        for _ in 0..<12 {
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
        }
        let actual = try XCTUnwrap(findCollection(in: window))
        XCTAssertGreaterThan(actual.contentSize.height, actual.bounds.height)
        XCTAssertEqual(actual.frame.minY, 0, accuracy: 1)
        XCTAssertGreaterThan(actual.contentInset.top, 40)
        XCTAssertGreaterThan(actual.contentInset.bottom, 70)
        let windowRect = actual.convert(actual.bounds, to: window)
        XCTAssertEqual(windowRect.minY, window.bounds.minY, accuracy: 1,
            "Drawing must extend through the status-bar region, not start below it")
        let nativeRoot = try XCTUnwrap(actual.superview)
        XCTAssertEqual(nativeRoot.convert(nativeRoot.bounds, to: window).maxY, window.bounds.maxY, accuracy: 1)
        XCTAssertEqual(windowRect.maxY, window.bounds.maxY, accuracy: 1,
            "The native drawing viewport itself must reach the physical bottom")
        actual.delegate?.scrollViewWillBeginDragging?(actual)
        actual.setContentOffset(CGPoint(x: 0, y: actual.contentOffset.y - 450), animated: false)
        try await Task.sleep(for: .milliseconds(150))
        let presentation = try XCTUnwrap(actual.delegate as? PadNativeTimelinePresentationSource)
        XCTAssertTrue(presentation.presentationHandle.showsJump)
        let safe = try XCTUnwrap(window.rootViewController).view.safeAreaInsets
        let frames = actual.visibleCells.map { $0.convert($0.bounds, to: window) }
        XCTAssertGreaterThan(safe.top, 0)
        XCTAssertGreaterThan(safe.bottom, 0)
        XCTAssertTrue(frames.contains { $0.minY < safe.top && $0.maxY > window.bounds.minY },
            "A real message cell must be realized in the status-bar region")
        XCTAssertTrue(frames.contains { $0.maxY > window.bounds.maxY - safe.bottom && $0.minY < window.bounds.maxY },
            "A real message cell must be realized in the home-indicator region")
        // SwiftUI's accessibility tree is exported to XCTest UI automation,
        // not NSObject.accessibilityElementCount in this unit-test process.
        // Keep real rendered screenshots for visual verification of the arrow.
        attachConversationScreenshot(name: "actual-conversation-history")
        workspace.scrollRequest += 1
        for _ in 0..<6 {
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(40))
        }
        XCTAssertFalse(presentation.presentationHandle.showsJump)
        let maxOffset = max(-actual.adjustedContentInset.top,
            actual.contentSize.height - actual.bounds.height + actual.adjustedContentInset.bottom)
        XCTAssertEqual(actual.contentOffset.y, maxOffset, accuracy: 1)
        let last = IndexPath(item: actual.numberOfItems(inSection: 0) - 1, section: 0)
        let cell = try XCTUnwrap(actual.cellForItem(at: last))
        XCTAssertEqual(cell.frame.maxY - actual.contentOffset.y,
            actual.bounds.height - actual.contentInset.bottom - 8, accuracy: 2)
        XCTAssertLessThan(actual.visibleCells.count, 30)
        let raster = conversationScreenshot()
        attachConversationScreenshot(name: "actual-conversation-latest", image: raster)
        for messageIndex in [77, 79] {
            let entryIndex = try XCTUnwrap(workspace.displayEntries.firstIndex {
                if case .message(let message) = $0.kind { return message.id == "actual:\(messageIndex)" }
                return false
            })
            let visible = try XCTUnwrap(actual.cellForItem(at: IndexPath(item: entryIndex + 1, section: 0)))
            let rect = visible.convert(visible.bounds, to: window)
            XCTAssertGreaterThan(try pixelBrightness(raster, at: CGPoint(x: rect.midX, y: rect.midY)), 20,
                "A realized agent card must actually draw its tinted surface, not remain a blank cell")
        }
        let composerView = try XCTUnwrap(nativeRoot.subviews.first(where: { $0 !== actual }))
        let editor = try XCTUnwrap(textView(in: composerView))
        let probe = KeyboardFrameProbe(collection: actual, root: nativeRoot)
        probe.start()
        XCTAssertTrue(editor.becomeFirstResponder())
        for _ in 0..<14 {
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertFalse(presentation.presentationHandle.showsJump)
        window.endEditing(true)
        for _ in 0..<14 {
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(50))
        }
        probe.stop()
        XCTAssertGreaterThan(probe.sampleCount, 15)
        XCTAssertEqual(probe.missingRows, 0)
        XCTAssertLessThan(probe.maximumDockingError, 8,
            "Real Markdown cards and the product composer must stay aligned throughout both keyboard transitions")
    }
    private func attachConversationScreenshot(name: String, image: UIImage? = nil) {
        let image = image ?? conversationScreenshot()
        let attachment = XCTAttachment(image: image)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
    private func conversationScreenshot() -> UIImage {
        UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
    }
    private func pixelBrightness(_ image: UIImage, at point: CGPoint) throws -> Int {
        let bitmap = try XCTUnwrap(image.cgImage)
        let pixel = try XCTUnwrap(bitmap.cropping(to: CGRect(x: point.x * image.scale,
            y: point.y * image.scale, width: 1, height: 1)))
        var rgba = [UInt8](repeating: 0, count: 4)
        rgba.withUnsafeMutableBytes { bytes in
            let context = CGContext(data: bytes.baseAddress, width: 1, height: 1,
                bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(pixel, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        return rgba.prefix(3).reduce(0) { $0 + Int($1) }
    }
    private func findCollection(in view: UIView) -> UICollectionView? {
        if let collection = view as? UICollectionView { return collection }
        for child in view.subviews { if let found = findCollection(in: child) { return found } }
        return nil
    }
    private func findNativeController(in root: UIViewController) -> PadNativeTimelineController<AnyView, AnyView>? {
        if let native = root as? PadNativeTimelineController<AnyView, AnyView> { return native }
        for child in root.children {
            if let native = findNativeController(in: child) { return native }
        }
        return nil
    }
    override func tearDown() async throws {
        await MainActor.run {
            controller?.detach()
            window?.isHidden = true
            window?.rootViewController = nil
            window = nil
            controller = nil
            scroll = nil
        }
        try await super.tearDown()
    }
}

private struct NativeHostedParent: View {
    let input: PadNativeTimeline<AnyView, AnyView>
    var consumeBottom = false
    private var timeline: PadNativeTimeline<AnyView, AnyView> {
        var value = input
        value.topOverlayHeight = 60
        return value
    }
    var body: some View {
        GeometryReader { _ in
            HStack(spacing: 0) {
                NavigationStack {
                    timeline.ignoresSafeArea(.keyboard)
                        .padding(.bottom, consumeBottom ? 40 : 0)
                        .overlay(alignment: .top) { Text("Test title").frame(height: 60) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

@MainActor private final class HistoricalGapProbe: NSObject {
    private weak var collection: UICollectionView?
    private var link: CADisplayLink?
    private(set) var pairCount = 0
    private(set) var maximumGapError: CGFloat = 0
    init(collection: UICollectionView) { self.collection = collection }
    func start() {
        link = CADisplayLink(target: self, selector: #selector(sample))
        link?.add(to: .main, forMode: .common)
    }
    func stop() { link?.invalidate(); link = nil }
    @objc private func sample() {
        guard let collection else { return }
        let paths = collection.indexPathsForVisibleItems.sorted()
        for (first, second) in zip(paths, paths.dropFirst()) where second.item == first.item + 1 {
            guard let a = collection.cellForItem(at: first), let b = collection.cellForItem(at: second) else { continue }
            // Newly dequeued cells may not exist in the displayed tree yet.
            // Never mix their next-frame model coordinates with presentation
            // coordinates from the previous committed frame.
            guard let layerA = a.layer.presentation(), let layerB = b.layer.presentation() else { continue }
            let rectA = layerA.frame
            let rectB = layerB.frame
            if abs(rectB.minY - rectA.maxY - PadTimelineLayoutMetrics.rowSpacing) > 2,
               maximumGapError < 2 {
                print("gap-probe first=\(first) second=\(second) a=\(rectA) b=\(rectB) modelA=\(a.frame) modelB=\(b.frame) keysA=\(a.layer.animationKeys() ?? []) keysB=\(b.layer.animationKeys() ?? []) presentA=\(a.layer.presentation() != nil) presentB=\(b.layer.presentation() != nil) frameA=\(layerA.frame) frameB=\(layerB.frame)")
            }
            maximumGapError = max(maximumGapError,
                abs(rectB.minY - rectA.maxY - PadTimelineLayoutMetrics.rowSpacing))
            pairCount += 1
        }
    }
}

@MainActor private final class KeyboardFrameProbe: NSObject {
    private weak var collection: UICollectionView?
    private weak var root: UIView?
    private var link: CADisplayLink?
    private(set) var sampleCount = 0
    private(set) var missingRows = 0
    private(set) var maximumDockingError: CGFloat = 0
    private var diagnosticCount = 0
    init(collection: UICollectionView, root: UIView) {
        self.collection = collection
        self.root = root
    }
    func start() {
        link = CADisplayLink(target: self, selector: #selector(sample))
        link?.add(to: .main, forMode: .common)
    }
    func stop() { link?.invalidate(); link = nil }
    @objc private func sample() {
        guard let collection, let root, collection.numberOfSections > 0,
              let composer = root.subviews.first(where: { $0 !== collection }) else { return }
        sampleCount += 1
        let path = IndexPath(item: collection.numberOfItems(inSection: 0) - 1, section: 0)
        guard let cell = collection.cellForItem(at: path), !collection.visibleCells.isEmpty else {
            missingRows += 1
            return
        }
        let rowLayer = cell.layer.presentation() ?? cell.layer
        let composerLayer = composer.layer.presentation() ?? composer.layer
        let rootLayer = root.layer.presentation() ?? root.layer
        let rowRect = rowLayer.convert(rowLayer.bounds, to: rootLayer)
        let composerRect = composerLayer.convert(composerLayer.bounds, to: rootLayer)
        maximumDockingError = max(maximumDockingError,
            abs(composerRect.minY - rowRect.maxY - 8))
        if abs(composerRect.minY - rowRect.maxY - 8) > 50,
           diagnosticCount < 3 {
            diagnosticCount += 1
            print("keyboard-frame row=\(rowRect) composer=\(composerRect) modelOffset=\(collection.contentOffset) modelSize=\(collection.contentSize) cellFrame=\(cell.frame) cellPresentation=\(rowLayer.frame) cellKeys=\(cell.layer.animationKeys() ?? []) presentationBounds=\(collection.layer.presentation()?.bounds ?? .zero) collectionKeys=\(collection.layer.animationKeys() ?? []) composerKeys=\(composer.layer.animationKeys() ?? [])")
        }
    }
}
