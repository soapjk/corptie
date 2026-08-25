import Combine
import Foundation

struct SessionDisplayProjectionRequest: Equatable, Sendable {
    let sessionID: String
    let sourceSignature: String
    let generation: Int

    func isCurrent(sessionID currentSessionID: String, sourceSignature currentSourceSignature: String, generation currentGeneration: Int, isCancelled: Bool) -> Bool {
        !isCancelled && sessionID == currentSessionID
            && sourceSignature == currentSourceSignature && generation == currentGeneration
    }
}

@MainActor
final class SessionPresentationState: ObservableObject {
    @Published fileprivate(set) var cache: DetailDisplayCache?
    init(cache: DetailDisplayCache?) { self.cache = cache }
}

/// Bounded provider-neutral display projection cache. Selection, viewport,
/// supplementary data, and commands deliberately have separate owners.
@MainActor
final class SessionPresentationCache: ObservableObject {
    static let shared = SessionPresentationCache()

    private(set) var cacheRevision = 0
    private let capacity: Int
    private var caches: [String: DetailDisplayCache] = [:]
    private var recency: [String] = []
    private var states: [String: SessionPresentationState] = [:]
    private var pinnedSessionIDs: Set<String> = []

    init(capacity: Int = 48) { self.capacity = max(1, capacity) }

    func cache(for sessionID: String) -> DetailDisplayCache? {
        guard let value = caches[sessionID] else { return nil }
        touch(sessionID)
        return value
    }

    func state(for sessionID: String) -> SessionPresentationState {
        if let value = states[sessionID] { return value }
        let value = SessionPresentationState(cache: caches[sessionID])
        states[sessionID] = value
        return value
    }

    func store(_ cache: DetailDisplayCache) {
        if let current = caches[cache.sessionId],
           current.signature == cache.signature,
           current.sourceSignature == cache.sourceSignature,
           current.visibleMessageLimit == cache.visibleMessageLimit { return }
        caches[cache.sessionId] = cache
        states[cache.sessionId]?.cache = cache
        touch(cache.sessionId)
        while caches.count > capacity,
              let evictionIndex = recency.firstIndex(where: { !pinnedSessionIDs.contains($0) }) {
            let oldest = recency.remove(at: evictionIndex)
            caches[oldest] = nil
            states[oldest]?.cache = nil
        }
        cacheRevision &+= 1
    }

    func prune(to validSessionIDs: Set<String>) {
        let previousCount = caches.count
        caches = caches.filter { validSessionIDs.contains($0.key) }
        recency.removeAll { !validSessionIDs.contains($0) }
        states = states.filter { validSessionIDs.contains($0.key) }
        pinnedSessionIDs.formIntersection(validSessionIDs)
        if caches.count != previousCount { cacheRevision &+= 1 }
    }

    func pin(_ sessionIDs: Set<String>) {
        pinnedSessionIDs = sessionIDs
        while caches.count > capacity,
              let evictionIndex = recency.firstIndex(where: { !pinnedSessionIDs.contains($0) }) {
            let evicted = recency.remove(at: evictionIndex)
            caches[evicted] = nil
            states[evicted]?.cache = nil
        }
    }

    private func touch(_ sessionID: String) {
        recency.removeAll { $0 == sessionID }
        recency.append(sessionID)
    }
}
