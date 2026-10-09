import Foundation

enum TimelineAnchorWindowLoadResult: Equatable {
    case found
    case missing
    case stale
    case unavailable
}

/// Owns bounded anchor/history requests and per-Session loading state.
@MainActor
final class SessionTimelineHistoryController: ObservableObject {
    @Published private(set) var earlierHistoryLoadStateBySessionID: [String: EarlierHistoryLoadState] = [:]
    private static let historyPageSize = 200
    private var timelineWindowLoadSessionIDs = Set<String>()
    private var earlierHistoryLoadSessionIDs = Set<String>()
    private let baseURL: URL
    private let selection: SessionSelectionController
    private let sessionForID: (String) -> TaskSession?
    private let detailForSession: (String) -> CodexThreadDetail?
    private let publishSessionDetail: (CodexThreadDetail, String) -> Void
    private let requestTimelineWindow: (URL) async throws -> SessionTimelineWindowResponse
    private let requestEarlierHistoryPage: (URL) async throws -> SessionHistoryResponse

    init(baseURL: URL, selection: SessionSelectionController,
         sessionForID: @escaping (String) -> TaskSession?,
         detailForSession: @escaping (String) -> CodexThreadDetail?,
         publishSessionDetail: @escaping (CodexThreadDetail, String) -> Void,
         requestTimelineWindow: @escaping (URL) async throws -> SessionTimelineWindowResponse = { url in
             let (data, response) = try await URLSession.shared.data(from: url)
             guard let httpResponse = response as? HTTPURLResponse,
                   httpResponse.statusCode == 200 else {
                 throw URLError(.badServerResponse)
             }
             return try await Task.detached(priority: .userInitiated) {
                 try JSONDecoder().decode(SessionTimelineWindowResponse.self, from: data)
             }.value
         },
         requestEarlierHistoryPage: @escaping (URL) async throws -> SessionHistoryResponse) {
        self.baseURL = baseURL
        self.selection = selection
        self.sessionForID = sessionForID
        self.detailForSession = detailForSession
        self.publishSessionDetail = publishSessionDetail
        self.requestTimelineWindow = requestTimelineWindow
        self.requestEarlierHistoryPage = requestEarlierHistoryPage
    }

    nonisolated static func historyPageRequestIsCurrent(
        sessionID: String, expectedSelectionGeneration: UInt64?,
        currentSessionID: String?, currentSelectionGeneration: UInt64
    ) -> Bool {
        currentSessionID == sessionID
            && (expectedSelectionGeneration == nil
                || expectedSelectionGeneration == currentSelectionGeneration)
    }

    func loadTimelineWindow(
        for session: TaskSession,
        anchorRowID: String,
        expectedSelectionGeneration: UInt64?
    ) async -> TimelineAnchorWindowLoadResult {
        let anchorKind: String
        let anchorID: String
        if anchorRowID.hasPrefix("message:") {
            anchorKind = "item"
            anchorID = String(anchorRowID.dropFirst("message:".count))
        } else if anchorRowID.hasPrefix("process:") {
            anchorKind = "turn"
            anchorID = String(anchorRowID.dropFirst("process:".count))
        } else {
            return .missing
        }
        guard !anchorID.isEmpty,
              (expectedSelectionGeneration == nil || Self.historyPageRequestIsCurrent(
                  sessionID: session.id,
                  expectedSelectionGeneration: expectedSelectionGeneration,
                  currentSessionID: selection.selectedSessionID,
                  currentSelectionGeneration: selection.generation
              )),
              let liveSession = sessionForID(session.id),
              SessionTimelineBindingReconciler.sameRoute(liveSession, session),
              let current = detailForSession(session.id),
              current.id == (session.external?.threadId ?? session.id),
              timelineWindowLoadSessionIDs.insert(session.id).inserted else {
            return .stale
        }
        let threadID = current.id
        defer { timelineWindowLoadSessionIDs.remove(session.id) }

        do {
            var components = URLComponents(
                url: baseURL.appending(path: "sessions/\(session.id)/timeline/window"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [
                URLQueryItem(name: "anchorKind", value: anchorKind),
                URLQueryItem(name: "anchor", value: anchorID),
                URLQueryItem(name: "before", value: "40"),
                URLQueryItem(name: "after", value: "40")
            ]
            guard let url = components?.url else { return .unavailable }
            let window = try await requestTimelineWindow(url)
            guard (expectedSelectionGeneration == nil || Self.historyPageRequestIsCurrent(
                      sessionID: session.id,
                      expectedSelectionGeneration: expectedSelectionGeneration,
                      currentSessionID: selection.selectedSessionID,
                      currentSelectionGeneration: selection.generation
                  )),
                  let liveSession = sessionForID(session.id),
                  SessionTimelineBindingReconciler.sameRoute(liveSession, session),
                  let latest = detailForSession(session.id),
                  latest.id == threadID else {
                return .stale
            }
            guard window.anchor.status == "found" else { return .missing }
            let mergedItems = SessionHistoryPageMerger.mergeAnchorWindow(
                window.items,
                with: latest.items
            )
            let merged = CodexThreadDetail(
                id: latest.id,
                title: latest.title,
                status: latest.status,
                source: latest.source,
                connectionStatus: latest.connectionStatus,
                currentModel: latest.currentModel,
                currentReasoningLevel: latest.currentReasoningLevel,
                activityStatus: latest.activityStatus,
                cwd: latest.cwd,
                createdAt: latest.createdAt,
                updatedAt: latest.updatedAt,
                canSend: latest.canSend,
                sendUnavailableReason: latest.sendUnavailableReason,
                capabilities: latest.capabilities,
                turnCount: latest.turnCount,
                items: mergedItems,
                lastAgentMessageSequence: latest.lastAgentMessageSequence,
                hasMoreHistory: window.hasEarlier,
                historyItemsCount: latest.historyItemsCount,
                actions: latest.actions
            )
            publishSessionDetail(merged, session.id)
            return .found
        } catch is CancellationError {
            return .stale
        } catch {
            return .unavailable
        }
    }

    func earlierHistoryLoadState(for sessionID: String) -> EarlierHistoryLoadState {
        earlierHistoryLoadStateBySessionID[sessionID] ?? .idle
    }

    private func setEarlierHistoryLoadState(
        _ state: EarlierHistoryLoadState,
        for sessionID: String
    ) {
        var states = earlierHistoryLoadStateBySessionID
        states[sessionID] = state
        earlierHistoryLoadStateBySessionID = states
    }

    @discardableResult
    func loadEarlierMessages(
        for session: TaskSession,
        expectedSelectionGeneration: UInt64? = nil
    ) async -> EarlierHistoryLoadState {
        let threadId = session.external?.threadId ?? session.id
        guard (expectedSelectionGeneration == nil || Self.historyPageRequestIsCurrent(
                  sessionID: session.id,
                  expectedSelectionGeneration: expectedSelectionGeneration,
                  currentSessionID: selection.selectedSessionID,
                  currentSelectionGeneration: selection.generation
              )),
              let liveSession = sessionForID(session.id),
              SessionTimelineBindingReconciler.sameRoute(liveSession, session),
              let current = detailForSession(session.id),
              current.id == threadId,
              let oldest = current.items.first else {
            return earlierHistoryLoadState(for: session.id)
        }
        guard current.hasMoreHistory == true else {
            setEarlierHistoryLoadState(.exhausted, for: session.id)
            return .exhausted
        }
        guard earlierHistoryLoadSessionIDs.insert(session.id).inserted else {
            return earlierHistoryLoadState(for: session.id)
        }
        setEarlierHistoryLoadState(.loading, for: session.id)
        defer { earlierHistoryLoadSessionIDs.remove(session.id) }

        do {
            var components = URLComponents(
                url: baseURL.appending(path: "sessions/\(session.id)/history"),
                resolvingAgainstBaseURL: false
            )
            components?.queryItems = [
                URLQueryItem(name: "before", value: oldest.id),
                URLQueryItem(name: "limit", value: String(Self.historyPageSize))
            ]
            guard let url = components?.url else {
                throw BackendError.message("Could not build history request.")
            }
            let page = try await requestEarlierHistoryPage(url)
            if page.items.isEmpty && page.hasMoreHistory == true {
                throw BackendError.message(L10n("The history page did not advance."))
            }

            guard (expectedSelectionGeneration == nil || Self.historyPageRequestIsCurrent(
                      sessionID: session.id,
                      expectedSelectionGeneration: expectedSelectionGeneration,
                      currentSessionID: selection.selectedSessionID,
                      currentSelectionGeneration: selection.generation
                  )),
                  let liveSession = sessionForID(session.id),
                  SessionTimelineBindingReconciler.sameRoute(liveSession, session),
                  let current = detailForSession(session.id),
                  current.id == threadId else {
                setEarlierHistoryLoadState(.idle, for: session.id)
                return .idle
            }
            guard let mergedItems = SessionHistoryPageMerger.prepend(
                pageItems: page.items,
                to: current.items,
                requestedBeforeID: oldest.id
            ) else {
                setEarlierHistoryLoadState(.idle, for: session.id)
                return .idle
            }
            if page.hasMoreHistory == true,
               mergedItems.count == current.items.count {
                throw BackendError.message(L10n("The history page did not advance."))
            }
            let merged = CodexThreadDetail(
                id: current.id,
                title: current.title,
                status: current.status,
                source: current.source,
                connectionStatus: current.connectionStatus,
                currentModel: current.currentModel,
                currentReasoningLevel: current.currentReasoningLevel,
                activityStatus: current.activityStatus,
                cwd: current.cwd,
                createdAt: current.createdAt,
                updatedAt: current.updatedAt,
                canSend: current.canSend,
                sendUnavailableReason: current.sendUnavailableReason,
                capabilities: current.capabilities,
                turnCount: current.turnCount,
                items: mergedItems,
                lastAgentMessageSequence: current.lastAgentMessageSequence,
                hasMoreHistory: page.hasMoreHistory,
                historyItemsCount: page.historyItemsCount,
                actions: current.actions
            )
            publishSessionDetail(merged, session.id)
            let nextState: EarlierHistoryLoadState = page.hasMoreHistory == true ? .idle : .exhausted
            setEarlierHistoryLoadState(nextState, for: session.id)
            return nextState
        } catch is CancellationError {
            setEarlierHistoryLoadState(.idle, for: session.id)
            return .idle
        } catch {
            let state = EarlierHistoryLoadState.failed(error.localizedDescription)
            setEarlierHistoryLoadState(state, for: session.id)
            return state
        }
    }
}
