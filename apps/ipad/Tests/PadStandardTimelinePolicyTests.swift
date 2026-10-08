import Foundation
import Testing
@testable import CorptieMobileState

struct PadStandardTimelinePolicyTests {
    @Test func bottomBounceWithoutGeometryCallbackKeepsFollowingThroughKeyboardChange() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction(bottom: true)
        // Bottom remains true, so Equatable geometry emits no new callback.
        #expect(policy.followsLatest)
        policy.observeBottom(false, keyboardChanging: true)
        policy.endInteraction(bottom: false, keyboardChanging: true)
        #expect(policy.followsLatest)
    }
    @Test func manuallyReachingBottomRestoresFollowingDuringKeyboardTransition() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction(bottom: false)
        #expect(!policy.followsLatest)
        policy.observeBottom(true, keyboardChanging: true)
        #expect(policy.followsLatest)
        policy.endInteraction(bottom: true, keyboardChanging: true)
        #expect(policy.followsLatest)
    }
    @Test func idleBottomRestoresFollowingEvenWithoutFinalGeometryCallback() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction(bottom: false)
        policy.endInteraction(bottom: true, keyboardChanging: true)
        #expect(policy.followsLatest)
    }
    @Test func explicitJumpSurvivesLateGeometryAndIdleCallbacks() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction(bottom: false)
        policy.jump()
        policy.observeBottom(false, keyboardChanging: false)
        policy.endInteraction(bottom: false)
        #expect(policy.followsLatest)
        policy.observeBottom(true, keyboardChanging: false)
        #expect(policy.followsLatest && policy.atBottom)
    }
    @Test func lateBottomGeometryResumesFollowingAfterIdle() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction()
        policy.observeBottom(false, keyboardChanging: false)
        policy.endInteraction()
        #expect(!policy.followsLatest)
        policy.observeBottom(true, keyboardChanging: false)
        #expect(policy.followsLatest)
        policy.contentChanged()
        policy.observeBottom(false, keyboardChanging: false)
        #expect(policy.followsLatest && !policy.unreadBelow)
    }
    @Test func idleUsesCurrentGeometryAndCannotOverrideExplicitJump() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction()
        policy.observeBottom(false, keyboardChanging: false)
        policy.endInteraction(bottom: true)
        #expect(policy.followsLatest && policy.atBottom)
        policy.jump()
        policy.endInteraction(bottom: false)
        #expect(policy.followsLatest)
    }
    @Test func keyboardIntermediateGeometryDoesNotChangeReadingIntent() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction()
        policy.observeBottom(true, keyboardChanging: false)
        policy.observeBottom(false, keyboardChanging: true)
        policy.endInteraction(bottom: false, keyboardChanging: true)
        #expect(policy.followsLatest)
        policy.observeBottom(true, keyboardChanging: false)
        #expect(policy.followsLatest)
        policy.beginInteraction()
        policy.endInteraction(bottom: false)
        policy.observeBottom(true, keyboardChanging: true)
        #expect(!policy.followsLatest)
    }
    @Test func restoringHistoryDoesNotResumeFollowingOnTemporaryBottomGeometry() {
        var policy = PadStandardTimelinePolicy()
        policy.begin(saved: .init(followsLatest: false, entryID: "old", minY: 0))
        policy.observeBottom(true, keyboardChanging: false)
        #expect(!policy.followsLatest)
        policy.restored()
        policy.observeBottom(false, keyboardChanging: false)
        policy.contentChanged()
        #expect(!policy.followsLatest && policy.unreadBelow)
    }
    @Test func historyIsNotPulledByNewMessagesAndExplicitJumpOverridesIt() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction()
        policy.observeBottom(false, keyboardChanging: false)
        policy.contentChanged()
        #expect(!policy.followsLatest && policy.unreadBelow)
        #expect(policy.showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: false))
        policy.jump()
        #expect(policy.followsLatest && !policy.interacting && !policy.unreadBelow)
        policy.observeBottom(true, keyboardChanging: false)
        #expect(!policy.showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: false))
    }
    @Test func keyboardChangesDoNotChangeReadingIntent() {
        var policy = PadStandardTimelinePolicy()
        policy.observeBottom(false, keyboardChanging: true)
        #expect(policy.followsLatest)
        #expect(!policy.showsJump(hasMessages: true, keyboardVisible: true, keyboardChanging: false))
        #expect(!policy.showsJump(hasMessages: true, keyboardVisible: false, keyboardChanging: true))
    }
    @Test func bottomTouchPreservesFollowingAndLeavingBottomSuspendsIt() {
        var policy = PadStandardTimelinePolicy()
        policy.beginInteraction()
        #expect(policy.followsLatest)
        policy.observeBottom(false, keyboardChanging: false)
        #expect(!policy.followsLatest)
        policy.observeBottom(true, keyboardChanging: false)
        policy.endInteraction()
        #expect(policy.followsLatest)
        policy.beginInteraction(); policy.observeBottom(false, keyboardChanging: false)
        policy.jump(); policy.endInteraction()
        #expect(policy.followsLatest, "An idle callback must not cancel an explicit jump")
    }
    @Test func systemVisibleBoundaryAndBounceDetermineBottom() {
        #expect(!PadStandardTimelinePolicy.bottomReached(visibleBottom: 700, contentHeight: 1000))
        #expect(PadStandardTimelinePolicy.bottomReached(visibleBottom: 1000, contentHeight: 1000))
        #expect(PadStandardTimelinePolicy.bottomReached(visibleBottom: 1040, contentHeight: 1000))
        #expect(!PadStandardTimelinePolicy.bottomReached(visibleBottom: .infinity, contentHeight: 1000))
    }
    @Test func restoringIsCancelledByUserInteraction() {
        var policy = PadStandardTimelinePolicy()
        policy.begin(saved: .init(followsLatest: false, entryID: "history", minY: -50))
        #expect(policy.restoring && !policy.followsLatest)
        policy.beginInteraction()
        #expect(!policy.restoring)
    }
    @Test func bookmarkAlignmentUsesLocalRowGeometryNotGlobalEstimatedOffset() {
        let anchor = PadStandardTimelinePolicy.restorationAnchor(minY: -50, viewportHeight: 600, rowHeight: 200)
        #expect(anchor == -0.125)
        #expect(PadStandardTimelinePolicy.restorationAnchor(minY: 0, viewportHeight: 600, rowHeight: 600) == nil)
    }
}
