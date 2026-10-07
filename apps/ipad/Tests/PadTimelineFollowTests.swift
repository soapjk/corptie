import Foundation
import Testing
import CorptieClientCore
@testable import CorptieMobileState

@Suite struct PadTimelineFollowTests {
    @Test func insetOccludedBottomCannotBeMistakenForLatest() {
        let before = PadTimelineBottomGeometry(contentHeight: 2000, viewportHeight: 800,
            topInset: 0, bottomInset: 250, offset: 1200)
        // visibleRect.maxY == contentHeight was the old false positive.
        #expect(!before.isNearBottom)
        #expect(before.maximumOffset == 1450)
        let after = PadTimelineBottomGeometry(contentHeight: 2000, viewportHeight: 800,
            topInset: 0, bottomInset: 250, offset: 1450)
        #expect(after.isNearBottom)
        #expect(after.tailIsDocked(rowBottom: 525))
        #expect(!after.tailIsDocked(rowBottom: 300))
        #expect(!after.tailIsDocked(rowBottom: nil))
    }

    @Test func keyboardDismissalAndComposerCollapseRequireNewBottom() {
        let keyboard = PadTimelineBottomGeometry(contentHeight: 2000, viewportHeight: 500,
            topInset: 0, bottomInset: 100, offset: 1600)
        #expect(keyboard.isNearBottom)
        #expect(keyboard.tailIsDocked(rowBottom: 375))
        let expanded = PadTimelineBottomGeometry(contentHeight: 2000, viewportHeight: 800,
            topInset: 0, bottomInset: 100, offset: 1600)
        #expect(!expanded.isNearBottom)
        #expect(!expanded.tailIsDocked(rowBottom: 375))
        let corrected = PadTimelineBottomGeometry(contentHeight: 2000, viewportHeight: 800,
            topInset: 0, bottomInset: 100, offset: 1300)
        #expect(corrected.isNearBottom)
        #expect(corrected.tailIsDocked(rowBottom: 675))
    }

    @Test func shortContentStillRequiresBottomAlignedRealRow() {
        let short = PadTimelineBottomGeometry(contentHeight: 200, viewportHeight: 700,
            topInset: 400, bottomInset: 100, offset: -400)
        #expect(short.isNearBottom)
        #expect(short.tailIsDocked(rowBottom: 575))
        #expect(!short.tailIsDocked(rowBottom: 175))
        #expect(!short.tailIsDocked(rowBottom: .nan))
    }

    @Test func scrollbarDragIsRelativeAndClampedIncludingContentInsets() {
        let geometry = PadTimelineScrollbarGeometry(contentHeight: 2000, viewportHeight: 500,
            topInset: 20, bottomInset: 30, trackHeight: 400, offset: 300)
        #expect(geometry.isScrollable)
        #expect(geometry.minimumOffset == -20)
        #expect(geometry.maximumOffset == 1530)
        #expect(geometry.offset(start: 300, translation: 0) == 300)
        #expect(geometry.offset(start: 300, translation: 10000) == 1530)
        #expect(geometry.offset(start: 300, translation: -10000) == -20)
        #expect(geometry.offset(start: 300, translation: 10) > 300)
        let short = PadTimelineScrollbarGeometry(contentHeight: 100, viewportHeight: 500,
            topInset: 0, bottomInset: 0, trackHeight: 400, offset: 0)
        #expect(!short.isScrollable)
        #expect(short.offset(start: 0, translation: 100) == 0)
    }

    @Test func messageScrollbarUsesOnlyThumbPanAndDoesNotObserveSwiftUIOffsetState() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/CorptieMobileApp.swift"), encoding: .utf8)
        let indicator = try #require(source.range(of: "private struct TimelineDragOnlyScrollbar:"))
        let end = try #require(source.range(of: "private struct TimelineTailVisibilityModifier:"))
        let implementation = String(source[indicator.lowerBound..<end.lowerBound])
        #expect(implementation.contains("UIPanGestureRecognizer"))
        #expect(implementation.contains("thumb.frame.insetBy(dx: -20, dy: 0).contains(point)"))
        #expect(!implementation.contains("UITapGestureRecognizer"))
        #expect(!implementation.contains("@State"))
        #expect(implementation.contains("observations.removeAll()"))
        #expect(implementation.contains("dragGeometry = nil\n                pan.isEnabled = false"))
        #expect(source.contains(".scrollIndicators(.hidden)"))
    }

    @Test func idleKeyboardAndContentGrowthNeverExitFollowing() {
        var gesture = PadTimelineFollowGesture()
        var viewport = ConversationViewportState()
        // An idle geometry change is not a gesture, even if new content has
        // moved the physical bottom away from the previous viewport.
        #expect(gesture.finish(isNearBottom: false) == nil)
        for _ in 0..<100 {
            let follows = viewport.timelineTailDidChange()
            #expect(follows)
        }
        #expect(viewport.followsLatest)
        #expect(!viewport.showsJumpToLatest)
    }

    @Test func dragAndDecelerationOwnViewportUntilIdle() {
        var gesture = PadTimelineFollowGesture()
        gesture.beginInteraction()
        #expect(gesture.isInteracting)
        // No end event at the start of deceleration: ownership remains held.
        #expect(gesture.isInteracting)
        #expect(gesture.finish(isNearBottom: false) == false)
        #expect(!gesture.isInteracting)
        #expect(gesture.finish(isNearBottom: true) == nil)
    }

    @Test func returningToBottomRestoresStreamingFollow() {
        var gesture = PadTimelineFollowGesture()
        var viewport = ConversationViewportState(followsLatest: false)
        let beforeDrag = viewport.timelineTailDidChange()
        #expect(!beforeDrag)
        #expect(viewport.hasNewMessagesBelow)
        gesture.beginInteraction()
        if let follows = gesture.finish(isNearBottom: true) { viewport.setFollowsLatest(follows) }
        let afterDrag = viewport.timelineTailDidChange()
        #expect(afterDrag)
        #expect(!viewport.hasNewMessagesBelow)
    }

    @Test func explicitJumpInvalidatesInterruptedDragCompletion() {
        var gesture = PadTimelineFollowGesture()
        gesture.beginInteraction()
        gesture.reset()
        #expect(gesture.finish(isNearBottom: false) == nil)
        #expect(!gesture.isInteracting)
    }

    @Test func visibleOldRowOrTransparentSentinelCannotConfirmLatest() {
        #expect(!PadTimelineJumpPolicy.placementConfirmed(lastEntryID: "new",
            visibleEntryIDs: ["old", "latest"], nearBottom: true))
        #expect(!PadTimelineJumpPolicy.placementConfirmed(lastEntryID: "new",
            visibleEntryIDs: ["new"], nearBottom: false))
        #expect(PadTimelineJumpPolicy.placementConfirmed(lastEntryID: "new",
            visibleEntryIDs: ["new"], nearBottom: true))
    }

    @Test func visibilityAuditDistinguishesEmptyDataMissingRowsAndBadOffset() {
        let audit = PadTimelineVisibilityAudit()
        #expect(audit.transition(entryCount: 0, visibleCount: 0, offset: 0, minimum: 0, maximum: 100) == .emptyData)
        #expect(audit.transition(entryCount: 5, visibleCount: 0, offset: 50, minimum: 0, maximum: 100) == .missingRows)
        #expect(audit.transition(entryCount: 5, visibleCount: 1, offset: 50, minimum: 0, maximum: 100) == .visible)
        #expect(audit.transition(entryCount: 5, visibleCount: 0, offset: 120, minimum: 0, maximum: 100) == .outOfBounds)
        #expect(audit.transition(entryCount: 5, visibleCount: 0, offset: 120, minimum: 0, maximum: 100) == nil)
    }

    @Test func visibilityLoggingIsBoundedAcrossRepeatedBlankRecovery() {
        let audit = PadTimelineVisibilityAudit()
        var count = 0
        for index in 0..<1_000 {
            if audit.transition(entryCount: 2, visibleCount: index % 2,
                offset: 20, minimum: 0, maximum: 100) != nil { count += 1 }
        }
        #expect(count == 20)
        #expect((0..<1_000).filter { _ in audit.shouldLogPlacementEvent() }.count == 100)
    }

    @Test @MainActor func localPlaceholderChangesDrivePresentationRevision() {
        let name = "corptie-follow-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:follow"
        let before = workspace.tailDisplayRevision
        workspace.outgoingMessages["session:follow"] = [ClientMessage(id: "local", text: "hello")]
        #expect(workspace.tailDisplayRevision > before)
        let appended = workspace.tailDisplayRevision
        workspace.outgoingMessages["session:follow"] = [ClientMessage(id: "local", text: "longer hello")]
        #expect(workspace.tailDisplayRevision > appended)
        #expect(workspace.displayEntries.last?.id != nil)
    }

    @Test @MainActor func prependingHistoryDoesNotPretendNewTailContentArrived() {
        let name = "corptie-follow-history-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defer { defaults.removePersistentDomain(forName: name) }
        let workspace = PadWorkspace(defaults: defaults)
        workspace.selection = "session:history"
        workspace.messages = [ClientMessage(id: "latest", text: "current")]
        let before = workspace.tailDisplayRevision
        workspace.messages.insert(ClientMessage(id: "earlier", text: "history"), at: 0)
        #expect(workspace.tailDisplayRevision == before)
        workspace.messages[1] = ClientMessage(id: "latest", text: "current grows")
        #expect(workspace.tailDisplayRevision > before)
    }
}
