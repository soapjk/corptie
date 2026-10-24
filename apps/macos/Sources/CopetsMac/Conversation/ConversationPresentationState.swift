import AppKit
import CorptieClientCore
import CorptieConversation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

enum SessionDetailContentPhase: Equatable {
    case live
    case cached
    case loading
    case failed
    case empty
}

enum ConversationWelcomePolicy {
    /// Inspect only the empty/single-item case, never scan an existing history.
    /// The product introduction is durable history, but is not a user turn.
    static func showsWelcome(
        detail: CodexThreadDetail?, sessionID: String, isAssistant: Bool,
        isLoading: Bool, hasLoadError: Bool, hasSubmittedMessage: Bool
    ) -> Bool {
        guard let detail, !isLoading, !hasLoadError, !hasSubmittedMessage,
              detail.hasMoreHistory != true,
              (detail.historyItemsCount ?? 0) == 0 else { return false }
        if detail.items.isEmpty { return detail.turnCount == 0 }
        guard isAssistant, detail.items.count == 1, detail.turnCount <= 1,
              let item = detail.items.first else { return false }
        return item.type == "agentMessage"
            && item.id == "first-run:introduction:v1:\(sessionID)"
    }
}

func sessionDetailContentPhase(
    hasLiveDetail: Bool,
    cachedSessionID: String?,
    selectedSessionID: String,
    isLoading: Bool,
    hasError: Bool
) -> SessionDetailContentPhase {
    if hasLiveDetail { return .live }
    if cachedSessionID == selectedSessionID { return .cached }
    if isLoading { return .loading }
    if hasError { return .failed }
    return .empty
}

struct TimelineRestorationIntent: Equatable {
    private(set) var requestedAnchorRowID: String?
    private(set) var lastObservedPosition: AppKitChatTimelinePosition?
    private var isAwaitingRestoration: Bool
    private var restorationClosed = false

    init(initialPosition: AppKitChatTimelinePosition?) {
        let anchorRowID = initialPosition?.followsLatest == false
            ? initialPosition?.rowID
            : nil
        requestedAnchorRowID = anchorRowID
        lastObservedPosition = nil
        isAwaitingRestoration = anchorRowID != nil
    }

    mutating func reset(initialPosition: AppKitChatTimelinePosition?) {
        self = TimelineRestorationIntent(initialPosition: initialPosition)
    }

    mutating func offerRestoration(_ position: AppKitChatTimelinePosition) -> Bool {
        guard !restorationClosed else { return false }
        guard !position.followsLatest else { return false }
        if requestedAnchorRowID == position.rowID { return true }
        guard lastObservedPosition == nil else { return false }
        requestedAnchorRowID = position.rowID
        isAwaitingRestoration = true
        return true
    }

    mutating func observeViewport(_ position: AppKitChatTimelinePosition) {
        lastObservedPosition = position
        if !position.followsLatest {
            if position.rowID == requestedAnchorRowID {
                isAwaitingRestoration = false
            }
            return
        }
        if !isAwaitingRestoration {
            requestedAnchorRowID = nil
        }
    }

    mutating func clearAnchor() {
        restorationClosed = true
        requestedAnchorRowID = nil
        isAwaitingRestoration = false
    }
}

func nativeTimelineTimestampText(createdAt: String?) -> String {
    ConversationTimestampText.messageLabel(createdAt: createdAt)
}

typealias DetailView = SessionConversationContent
