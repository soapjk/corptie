import Combine
import Foundation

/// Observable state for exactly one provider-neutral Session timeline.
/// A host observes only its own state, so streaming in Session A cannot make
/// the retained view trees for B and C recompute.
@MainActor
final class SessionTimelineState: ObservableObject {
    let sessionID: String
    @Published private(set) var detail: CodexThreadDetail?

    init(sessionID: String, detail: CodexThreadDetail? = nil) {
        self.sessionID = sessionID
        self.detail = detail
    }

    func apply(_ detail: CodexThreadDetail) {
        guard self.detail != detail else { return }
        self.detail = detail
    }
}

/// The sole Session-indexed timeline repository on macOS. Transport code
/// publishes provider-neutral `CodexThreadDetail` snapshots here; presentation
/// code never needs to observe the global selected-detail stream.
@MainActor
final class SessionTimelineRepository {
    static let shared = SessionTimelineRepository()

    private var statesBySessionID: [String: SessionTimelineState] = [:]
    private var recency: [String] = []
    private var pinnedSessionIDs: Set<String> = []
    private let capacity: Int

    init(capacity: Int = 48) {
        self.capacity = max(1, capacity)
    }

    func state(for sessionID: String) -> SessionTimelineState {
        if let state = statesBySessionID[sessionID] {
            touch(sessionID)
            return state
        }
        let state = SessionTimelineState(sessionID: sessionID)
        statesBySessionID[sessionID] = state
        touch(sessionID)
        trimIfNeeded()
        return state
    }

    func detail(for sessionID: String) -> CodexThreadDetail? {
        guard let state = statesBySessionID[sessionID] else { return nil }
        touch(sessionID)
        return state.detail
    }

    func publish(_ detail: CodexThreadDetail, for sessionID: String) {
        state(for: sessionID).apply(detail)
        trimIfNeeded()
    }

    func remove(_ sessionID: String) {
        guard !pinnedSessionIDs.contains(sessionID) else { return }
        statesBySessionID[sessionID] = nil
        recency.removeAll { $0 == sessionID }
    }

    func pin(_ sessionIDs: Set<String>) {
        pinnedSessionIDs = sessionIDs
        trimIfNeeded()
    }

    func prune(to validSessionIDs: Set<String>) {
        statesBySessionID = statesBySessionID.filter { validSessionIDs.contains($0.key) }
        recency.removeAll { !validSessionIDs.contains($0) }
        pinnedSessionIDs.formIntersection(validSessionIDs)
    }

    private func touch(_ sessionID: String) {
        recency.removeAll { $0 == sessionID }
        recency.append(sessionID)
    }

    private func trimIfNeeded() {
        while statesBySessionID.count > capacity,
              let evictionIndex = recency.firstIndex(where: { !pinnedSessionIDs.contains($0) }) {
            let evictedSessionID = recency.remove(at: evictionIndex)
            statesBySessionID[evictedSessionID] = nil
        }
    }
}
