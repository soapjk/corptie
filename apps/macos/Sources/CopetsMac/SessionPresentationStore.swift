import Combine
import Foundation

struct SessionDisplayProjectionRequest: Equatable, Sendable {
    let sessionID: String
    let sourceSignature: String
    let generation: Int

    func isCurrent(
        sessionID currentSessionID: String,
        sourceSignature currentSourceSignature: String,
        generation currentGeneration: Int,
        isCancelled: Bool
    ) -> Bool {
        !isCancelled
            && sessionID == currentSessionID
            && sourceSignature == currentSourceSignature
            && generation == currentGeneration
    }
}

/// One presentation authority per Session surface. It owns reusable display
/// projections and viewport positions; views only keep transient renderer state.
@MainActor
final class SessionPresentationStore: ObservableObject {
    @Published private(set) var cacheRevision = 0
    @Published private(set) var hostedSessionIDs: [String] = []

    private let cacheCapacity: Int
    private let hostCapacity: Int
    private let positionCapacity: Int
    private let positionDefaults: UserDefaults?
    private let positionDefaultsKey: String
    private var cachesBySessionID: [String: DetailDisplayCache] = [:]
    private var cacheRecency: [String] = []
    private var positionsBySessionID: [String: AppKitChatTimelinePosition] = [:]
    private var positionRecency: [String] = []
    private var positionPersistenceTask: Task<Void, Never>?
    private var preheatTasksBySessionID: [String: Task<Void, Never>] = [:]
    private var preheatTokensBySessionID: [String: UUID] = [:]

    init(
        cacheCapacity: Int = 48,
        hostCapacity: Int = 3,
        positionCapacity: Int = 128,
        positionDefaults: UserDefaults? = CorptieAppEnvironment.userDefaults,
        positionDefaultsKey: String = "sessions.timelinePositions.v1"
    ) {
        self.cacheCapacity = max(1, cacheCapacity)
        self.hostCapacity = max(1, hostCapacity)
        self.positionCapacity = max(1, positionCapacity)
        self.positionDefaults = positionDefaults
        self.positionDefaultsKey = positionDefaultsKey
        restorePersistedPositions()
    }

    /// Keeps the complete SwiftUI/AppKit timeline subtree alive for the most
    /// recently visited sessions. A warm A → B → A switch therefore reuses the
    /// same NSScrollView, row views, height cache, and viewport state.
    func activateHost(for sessionID: String) {
        guard hostedSessionIDs.last != sessionID else { return }
        hostedSessionIDs.removeAll { $0 == sessionID }
        hostedSessionIDs.append(sessionID)
        if hostedSessionIDs.count > hostCapacity {
            hostedSessionIDs.removeFirst(hostedSessionIDs.count - hostCapacity)
        }
        SessionTimelineRepository.shared.pin(Set(hostedSessionIDs))
    }

    func cache(for sessionID: String) -> DetailDisplayCache? {
        guard let cache = cachesBySessionID[sessionID] else { return nil }
        touchCache(sessionID)
        return cache
    }

    func store(_ cache: DetailDisplayCache) {
        if let current = cachesBySessionID[cache.sessionId],
           current.signature == cache.signature,
           current.sourceSignature == cache.sourceSignature,
           current.visibleMessageLimit == cache.visibleMessageLimit {
            return
        }
        cachesBySessionID[cache.sessionId] = cache
        touchCache(cache.sessionId)
        while cachesBySessionID.count > cacheCapacity, let oldest = cacheRecency.first {
            cacheRecency.removeFirst()
            cachesBySessionID[oldest] = nil
        }
        cacheRevision &+= 1
    }

    func position(for sessionID: String) -> AppKitChatTimelinePosition? {
        guard let position = positionsBySessionID[sessionID] else { return nil }
        touchPosition(sessionID)
        return position
    }

    func store(_ position: AppKitChatTimelinePosition, for sessionID: String) {
        guard positionsBySessionID[sessionID] != position else { return }
        positionsBySessionID[sessionID] = position
        touchPosition(sessionID)
        trimPositionsIfNeeded()
        schedulePositionPersistence()
    }

    func preheat(
        session: TaskSession,
        backendClient: BackendClient,
        visibleMessageLimit: Int,
        delay: Duration = .zero
    ) {
        guard cachesBySessionID[session.id] == nil,
              preheatTasksBySessionID[session.id] == nil else { return }

        let token = UUID()
        let restorationAnchorRowID = positionsBySessionID[session.id].flatMap { position in
            position.followsLatest ? nil : position.rowID
        }
        preheatTokensBySessionID[session.id] = token
        preheatTasksBySessionID[session.id] = Task { [weak self, weak backendClient] in
            guard let self, let backendClient else { return }
            defer { self.finishPreheat(sessionID: session.id, token: token) }
            if delay > .zero {
                try? await Task.sleep(for: delay)
            }
            guard !Task.isCancelled,
                  self.preheatTokensBySessionID[session.id] == token,
                  let detail = await backendClient.detailForPreheating(session) else { return }

            let cache = await Task.detached(priority: .utility) {
                makeDetailDisplayCache(
                    for: detail,
                    sessionId: session.id,
                    visibleMessageLimit: visibleMessageLimit,
                    restorationAnchorRowID: restorationAnchorRowID
                )
            }.value
            guard !Task.isCancelled,
                  self.preheatTokensBySessionID[session.id] == token else { return }
            self.store(cache)
        }
    }

    func cancelPreheats() {
        preheatTasksBySessionID.values.forEach { $0.cancel() }
        preheatTasksBySessionID.removeAll()
        preheatTokensBySessionID.removeAll()
    }

    func prune(to validSessionIDs: Set<String>) {
        for sessionID in preheatTasksBySessionID.keys where !validSessionIDs.contains(sessionID) {
            preheatTasksBySessionID[sessionID]?.cancel()
            preheatTasksBySessionID[sessionID] = nil
            preheatTokensBySessionID[sessionID] = nil
        }
        let previousCount = cachesBySessionID.count
        cachesBySessionID = cachesBySessionID.filter { validSessionIDs.contains($0.key) }
        cacheRecency.removeAll { !validSessionIDs.contains($0) }
        hostedSessionIDs.removeAll { !validSessionIDs.contains($0) }
        SessionTimelineRepository.shared.pin(Set(hostedSessionIDs))
        if cachesBySessionID.count != previousCount {
            cacheRevision &+= 1
        }
    }

    private func finishPreheat(sessionID: String, token: UUID) {
        guard preheatTokensBySessionID[sessionID] == token else { return }
        preheatTasksBySessionID[sessionID] = nil
        preheatTokensBySessionID[sessionID] = nil
    }

    private func touchCache(_ sessionID: String) {
        cacheRecency.removeAll { $0 == sessionID }
        cacheRecency.append(sessionID)
    }

    private struct PersistedPositionRecord: Codable {
        let sessionID: String
        let position: AppKitChatTimelinePosition
    }

    private func touchPosition(_ sessionID: String) {
        positionRecency.removeAll { $0 == sessionID }
        positionRecency.append(sessionID)
    }

    private func trimPositionsIfNeeded() {
        while positionsBySessionID.count > positionCapacity, let oldest = positionRecency.first {
            positionRecency.removeFirst()
            positionsBySessionID[oldest] = nil
        }
    }

    private func restorePersistedPositions() {
        guard let data = positionDefaults?.data(forKey: positionDefaultsKey),
              let records = try? JSONDecoder().decode([PersistedPositionRecord].self, from: data) else {
            return
        }
        for record in records.suffix(positionCapacity) {
            positionsBySessionID[record.sessionID] = record.position
            touchPosition(record.sessionID)
        }
    }

    private func schedulePositionPersistence() {
        positionPersistenceTask?.cancel()
        positionPersistenceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.persistPositionsNow()
        }
    }

    /// Kept internal so deterministic tests and app lifecycle hooks can flush
    /// the final debounced viewport without waiting for a timer.
    func persistPositionsNow() {
        positionPersistenceTask?.cancel()
        positionPersistenceTask = nil
        guard let positionDefaults else { return }
        let records = positionRecency.compactMap { sessionID in
            positionsBySessionID[sessionID].map {
                PersistedPositionRecord(sessionID: sessionID, position: $0)
            }
        }
        guard let data = try? JSONEncoder().encode(records) else { return }
        positionDefaults.set(data, forKey: positionDefaultsKey)
    }
}
