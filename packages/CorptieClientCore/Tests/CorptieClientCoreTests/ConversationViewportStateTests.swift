import Foundation
import Testing
@testable import CorptieClientCore

@Suite("Conversation viewport state")
struct ConversationViewportStateTests {
    @Test func followingReaderPinsTailWithoutShowingJumpButton() {
        var state = ConversationViewportState()
        let shouldFollow = state.timelineTailDidChange()
        #expect(shouldFollow)
        #expect(state.followsLatest)
        #expect(!state.showsJumpToLatest)
        #expect(!state.hasNewMessagesBelow)
    }

    @Test func readerLeavingBottomOwnsPositionAndReceivesUnreadCue() {
        var state = ConversationViewportState()
        state.updateFromUserViewport(isNearBottom: false)
        let shouldFollow = state.timelineTailDidChange()
        #expect(!shouldFollow)
        #expect(state.showsJumpToLatest)
        #expect(state.hasNewMessagesBelow)
    }

    @Test func jumpToLatestClearsUnreadCueAndRestoresFollowing() {
        var state = ConversationViewportState(followsLatest: false, hasNewMessagesBelow: true)
        state.jumpToLatest()
        #expect(state.followsLatest)
        #expect(!state.showsJumpToLatest)
        #expect(!state.hasNewMessagesBelow)
    }

    @Test func historyPrependSeparatesUserReadingFromUnderfilledBootstrap() {
        var reading = ConversationViewportState()
        reading.prepareForHistoryPrepend(preservingLatestFollow: false)
        #expect(!reading.followsLatest)
        #expect(reading.showsJumpToLatest)

        var underfilled = ConversationViewportState()
        underfilled.prepareForHistoryPrepend(preservingLatestFollow: true)
        #expect(underfilled.followsLatest)
        #expect(!underfilled.showsJumpToLatest)
    }

    @Test func semanticPositionRoundTripsWithoutLosingRowOffset() throws {
        let position = ConversationViewportPosition(
            rowID: "message:stable", offset: 23.5, absoluteScrollY: 812, followsLatest: false
        )
        let data = try JSONEncoder().encode(position)
        #expect(try JSONDecoder().decode(ConversationViewportPosition.self, from: data) == position)
    }
}
