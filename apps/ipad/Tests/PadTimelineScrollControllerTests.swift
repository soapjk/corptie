import Testing
@testable import CorptieMobileState

@Suite struct PadTimelineScrollControllerTests {
    @Test func jumpCannotBeRevokedByOldIdleOrPrepend() {
        var state = PadTimelineScrollController()
        state.beginUserScroll()
        #expect(!state.followsLatest)
        state.jumpToLatest()
        state.setFollowsLatest(false)
        state.prepareForHistoryPrepend(preservingLatestFollow: false)
        #expect(state.isJumping)
        #expect(state.followsLatest)
        state.confirmLatest()
        #expect(state.mode == .followingLatest)
    }
    @Test func newGestureOverridesJumpAndRestore() {
        var state = PadTimelineScrollController()
        state.jumpToLatest()
        state.beginUserScroll()
        state.confirmLatest()
        #expect(state.mode == .readingHistory)
        state.beginRestore()
        state.beginUserScroll()
        state.finishRestore()
        #expect(state.mode == .readingHistory)
    }
    @Test func restoringIsNotOverriddenByGeometryOrNewMessages() {
        var state = PadTimelineScrollController()
        state.beginRestore()
        state.setFollowsLatest(true)
        let shouldFollow = state.timelineTailDidChange()
        #expect(!shouldFollow)
        #expect(state.mode == .restoring)
        state.finishRestore()
        #expect(state.mode == .readingHistory)
        #expect(state.hasNewMessagesBelow)
    }
    @Test func physicalBottomAloneControlsButtonDuringEveryMode() {
        for _ in 0..<100 {
            #expect(PadTimelineJumpPresentation.showsButton(hasMessages: true, atBottom: false))
            #expect(!PadTimelineJumpPresentation.showsButton(hasMessages: true, atBottom: true))
            #expect(!PadTimelineJumpPresentation.showsButton(hasMessages: false, atBottom: false))
        }
    }
    @Test func bottomToleranceIsNotAnEntireMessageGutterAndBounceIsAtBottom() {
        func geometry(_ offset: Double) -> PadTimelineBottomGeometry {
            .init(contentHeight: 2000, viewportHeight: 500, topInset: 0, bottomInset: 0, offset: offset)
        }
        #expect(geometry(1500).isNearBottom)
        #expect(geometry(1498).isNearBottom)
        #expect(!geometry(1497).isNearBottom)
        #expect(!geometry(1470).isNearBottom)
        #expect(geometry(1520).isNearBottom)
    }
}
