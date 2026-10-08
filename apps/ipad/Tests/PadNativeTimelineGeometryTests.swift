import Foundation
import Testing
@testable import CorptieMobileState

@Suite struct PadNativeTimelineGeometryTests {
    private func geometry(offset: CGFloat, height: CGFloat = 600, content: CGFloat = 2000,
                          top: CGFloat = 0, bottom: CGFloat = 0) -> PadNativeTimelineGeometry {
        .init(contentHeight: content, viewportHeight: height, topInset: top, bottomInset: bottom, offset: offset)
    }
    @Test func bottomBounceNeverMeansHistory() {
        for offset in stride(from: 1400.0, through: 1600, by: 1) {
            let value = geometry(offset: offset)
            #expect(value.isAtBottom)
            #expect(value.remaining == 0)
            #expect(!value.showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: false))
        }
        #expect(!geometry(offset: 1399).isAtBottom)
        #expect(geometry(offset: 1399).showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: false))
    }
    @Test func keyboardAlwaysSuppressesJumpButDoesNotChangeGeometry() {
        let history = geometry(offset: 500)
        #expect(!history.isAtBottom)
        for changing in [false, true] {
            #expect(!history.showsJump(hasMessages: true, keyboardVisible: true, keyboardChanging: changing))
        }
        #expect(!history.showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: true))
        #expect(history.showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: false))
    }
    @Test func consumedChildSafeAreaIsNotAKeyboard() {
        // The resting 34pt guide can coexist with zero child safe-area insets.
        // A resting guide is irrelevant. Only actual keyboard screen frames
        // from system notifications, converted into the window, are used.
        let bounds = CGRect(x: 0, y: 0, width: 393, height: 852)
        #expect(!PadNativeTimelineGeometry.keyboardIntersectsWindow(
            frame: CGRect(x: 0, y: 852, width: 393, height: 332), bounds: bounds))
        #expect(PadNativeTimelineGeometry.keyboardIntersectsWindow(
            frame: CGRect(x: 0, y: 520, width: 393, height: 332), bounds: bounds))
        #expect(PadNativeTimelineGeometry.keyboardIntersectsWindow(
            frame: CGRect(x: 100, y: 400, width: 200, height: 200), bounds: bounds))
    }
    @Test func overlayInsetsPreserveTheNativeScrollableBottom() {
        let overlay = geometry(offset: 1540, height: 852, content: 2200, top: 60, bottom: 192)
        #expect(overlay.isAtBottom)
        #expect(overlay.maximum == 1540)
        #expect(geometry(offset: 1538, height: 852, content: 2200, top: 60, bottom: 192)
            .showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: false))
    }
    @Test func fullScreenDrawingKeepsReadingBottomAboveChromeAndKeyboard() {
        let resting = geometry(offset: 1552, height: 852, content: 2300, top: 100, bottom: 104)
        #expect(resting.isAtBottom)
        #expect(resting.maximum == 1552)
        let keyboard = geometry(offset: 1850, height: 852, content: 2300, top: 100, bottom: 402)
        #expect(keyboard.isAtBottom)
    }
    @Test func shortEmptyAndInsetContentHaveNativeBounds() {
        #expect(geometry(offset: 0, content: 200).isAtBottom)
        #expect(geometry(offset: 30, content: 200).isAtBottom)
        #expect(geometry(offset: -20, content: 200, top: 20).isAtBottom)
        #expect(geometry(offset: 1430, top: 20, bottom: 30).isAtBottom)
        #expect(!geometry(offset: 1400, top: 20, bottom: 30).isAtBottom)
        #expect(!geometry(offset: 0, height: 0).showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: false))
        #expect(!geometry(offset: 0).showsJump(hasMessages: false, keyboardVisible: false, keyboardChanging: false))
    }
    @Test func keyboardAndComposerResizeTargetIsRecomputedWithoutStalePadding() {
        for height in stride(from: 300.0, through: 700, by: 1) {
            let value = geometry(offset: 2000 - height, height: height)
            #expect(value.isAtBottom)
            let expected: CGFloat = 2000 - height
            #expect(value.maximum == expected)
        }
    }
}
