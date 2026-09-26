import Foundation

/// A semantic timeline position shared by desktop and mobile renderers.
/// `absoluteScrollY` is diagnostic only: restoration must use the stable row
/// identity plus its intra-row offset so changing row heights cannot move the
/// reader to unrelated content.
public struct ConversationViewportPosition: Codable, Equatable, Sendable {
    public let rowID: String
    public let offset: Double
    public let absoluteScrollY: Double
    public let followsLatest: Bool

    public init(rowID: String, offset: Double, absoluteScrollY: Double, followsLatest: Bool) {
        self.rowID = rowID
        self.offset = offset
        self.absoluteScrollY = absoluteScrollY
        self.followsLatest = followsLatest
    }
}

/// Product-level scroll intent. Platform renderers own geometry, while this
/// state decides whether tail updates follow automatically and whether the
/// jump-to-latest affordance carries an unread cue.
public struct ConversationViewportState: Equatable, Sendable {
    public private(set) var followsLatest: Bool
    public private(set) var hasNewMessagesBelow: Bool

    public init(followsLatest: Bool = true, hasNewMessagesBelow: Bool = false) {
        self.followsLatest = followsLatest
        self.hasNewMessagesBelow = followsLatest ? false : hasNewMessagesBelow
    }

    public var showsJumpToLatest: Bool { !followsLatest }

    public mutating func reset(followsLatest: Bool = true) {
        self = ConversationViewportState(followsLatest: followsLatest)
    }

    public mutating func updateFromUserViewport(isNearBottom: Bool) {
        setFollowsLatest(isNearBottom)
    }

    public mutating func setFollowsLatest(_ followsLatest: Bool) {
        self.followsLatest = followsLatest
        if followsLatest { hasNewMessagesBelow = false }
    }

    /// Underfilled timelines keep the latest edge pinned while they bootstrap
    /// history. A user-triggered prepend transfers viewport ownership to the
    /// reader and must preserve that reading position.
    public mutating func prepareForHistoryPrepend(preservingLatestFollow: Bool) {
        if !preservingLatestFollow { setFollowsLatest(false) }
    }

    /// Returns true when the renderer should keep the bottom pinned.
    @discardableResult
    public mutating func timelineTailDidChange() -> Bool {
        if followsLatest { return true }
        hasNewMessagesBelow = true
        return false
    }

    public mutating func jumpToLatest() {
        followsLatest = true
        hasNewMessagesBelow = false
    }
}
