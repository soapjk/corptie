import Foundation

extension BackendClient {
    func selectionGenerationToken(for sessionID: String) -> UInt64? {
        sessionSelectionController.selectedSessionID == sessionID
            ? sessionSelectionController.generation
            : nil
    }

    nonisolated static func historyPageRequestIsCurrent(
        sessionID: String,
        expectedSelectionGeneration: UInt64?,
        currentSessionID: String?,
        currentSelectionGeneration: UInt64
    ) -> Bool {
        SessionTimelineHistoryController.historyPageRequestIsCurrent(
            sessionID: sessionID,
            expectedSelectionGeneration: expectedSelectionGeneration,
            currentSessionID: currentSessionID,
            currentSelectionGeneration: currentSelectionGeneration
        )
    }

    func loadTimelineWindow(
        for session: TaskSession, anchorRowID: String, expectedSelectionGeneration: UInt64
    ) async -> TimelineAnchorWindowLoadResult {
        await timelineHistoryController.loadTimelineWindow(
            for: session, anchorRowID: anchorRowID,
            expectedSelectionGeneration: expectedSelectionGeneration
        )
    }

    func earlierHistoryLoadState(for sessionID: String) -> EarlierHistoryLoadState {
        timelineHistoryController.earlierHistoryLoadState(for: sessionID)
    }

    static func requestEarlierHistoryPage(
        at url: URL,
        urlSession: URLSession = .shared,
        timeoutInterval: TimeInterval = 15
    ) async throws -> SessionHistoryResponse {
        try await SessionTimelineReadAPI.requestEarlierHistoryPage(
            at: url, urlSession: urlSession, timeoutInterval: timeoutInterval,
            errorMessage: { Self.errorMessage(from: $0) }
        )
    }

    @discardableResult
    func loadEarlierMessages(
        for session: TaskSession, expectedSelectionGeneration: UInt64? = nil
    ) async -> EarlierHistoryLoadState {
        await timelineHistoryController.loadEarlierMessages(
            for: session, expectedSelectionGeneration: expectedSelectionGeneration
        )
    }
}
