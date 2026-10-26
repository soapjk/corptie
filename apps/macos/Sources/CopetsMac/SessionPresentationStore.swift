import Combine
import Foundation
import CorptieClientCore

struct SessionDisplayProjectionRequest: Equatable, Sendable {
    let sessionID: String
    let sourceSignature: String
    let generation: Int

    func isCurrent(sessionID currentSessionID: String, sourceSignature currentSourceSignature: String, generation currentGeneration: Int, isCancelled: Bool) -> Bool {
        !isCancelled && sessionID == currentSessionID
            && sourceSignature == currentSourceSignature && generation == currentGeneration
    }
}

/// Explicit render inputs for value-only native rows. Width/image geometry
/// belong to the existing layout cache; row construction does not measure them.
struct PreparedRowsContext: Equatable {
    let signature: String
    let sourceSignature: String
    let entryIDs: [String]
    let entryItems: [[CodexThreadItem]]
    let expandedTurnIDs: Set<String>
    let localeID: String
    let languageCode: String
    let isWorkspaceCard: Bool
    let sessionTitle: String?
    let workingDirectory: String?
    let allowsFork: Bool
    let forkUnavailableReason: String?
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
    private struct PreparedRows {
        let sessionID: String
        let context: PreparedRowsContext
        let rows: [AppKitChatTimelineRow]
    }
    // Independent, deliberately smaller than the display-cache capacity.
    // Each retained projection also has a strict source/row budget below.
    private var preparedRows: [PreparedRows] = []
    var preparedRowsCount: Int { preparedRows.count }

    func preparedRows(for sessionID: String, context: PreparedRowsContext) -> [AppKitChatTimelineRow]? {
        guard let index = preparedRows.firstIndex(where: { $0.sessionID == sessionID && $0.context == context }) else { return nil }
        let entry = preparedRows.remove(at: index)
        preparedRows.append(entry)
        return entry.rows
    }

    func storePreparedRows(_ rows: [AppKitChatTimelineRow], for sessionID: String,
                           context: PreparedRowsContext, sourceItems: [CodexThreadItem]) {
        invalidatePreparedRows(for: sessionID)
        guard rows.count <= 256, sourceItems.count <= 2_000,
              !rows.contains(where: { $0.processState == .running }) else { return }
        var entryLength = 0
        var entryCount = 0
        for items in context.entryItems {
            entryCount += items.count
            guard entryCount <= 2_000 else { return }
            for item in items {
                entryLength += item.text.utf16.count
                guard entryLength <= 250_000 else { return }
            }
        }
        var sourceLength = 0
        for item in sourceItems {
            sourceLength += item.text.utf16.count
            guard sourceLength <= 250_000 else { return }
        }
        preparedRows.append(PreparedRows(sessionID: sessionID, context: context, rows: rows))
        while preparedRows.count > 3 {
            let index = preparedRows.firstIndex { !pinnedSessionIDs.contains($0.sessionID) } ?? 0
            preparedRows.remove(at: index)
        }
    }

    func invalidatePreparedRows(for sessionID: String) {
        preparedRows.removeAll { $0.sessionID == sessionID }
    }

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
        invalidatePreparedRows(for: cache.sessionId)
        caches[cache.sessionId] = cache
        states[cache.sessionId]?.cache = cache
        touch(cache.sessionId)
        while caches.count > capacity,
              let evictionIndex = recency.firstIndex(where: { !pinnedSessionIDs.contains($0) }) {
            let oldest = recency.remove(at: evictionIndex)
            invalidatePreparedRows(for: oldest)
            caches[oldest] = nil
            states[oldest]?.cache = nil
        }
        cacheRevision &+= 1
    }

    func prune(to validSessionIDs: Set<String>) {
        let previousCount = caches.count
        preparedRows.removeAll { !validSessionIDs.contains($0.sessionID) }
        caches = caches.filter { validSessionIDs.contains($0.key) }
        recency.removeAll { !validSessionIDs.contains($0) }
        states = states.filter { validSessionIDs.contains($0.key) }
        pinnedSessionIDs.formIntersection(validSessionIDs)
        if caches.count != previousCount { cacheRevision &+= 1 }
    }

    func pin(_ sessionIDs: Set<String>) {
        pinnedSessionIDs = sessionIDs
        trimIfNeeded()
    }

    func setPinned(_ pinned: Bool, for sessionID: String) {
        if pinned { pinnedSessionIDs.insert(sessionID) }
        else { pinnedSessionIDs.remove(sessionID); trimIfNeeded() }
    }

    private func trimIfNeeded() {
        while caches.count > capacity,
              let evictionIndex = recency.firstIndex(where: { !pinnedSessionIDs.contains($0) }) {
            let evicted = recency.remove(at: evictionIndex)
            invalidatePreparedRows(for: evicted)
            caches[evicted] = nil
            states[evicted]?.cache = nil
        }
    }

    private func touch(_ sessionID: String) {
        recency.removeAll { $0 == sessionID }
        recency.append(sessionID)
    }
}
