import Combine
import Foundation

extension Notification.Name {
    static let captureSessionTimelinePositions = Notification.Name("captureSessionTimelinePositions")
    static let persistSessionTimelinePositions = Notification.Name("persistSessionTimelinePositions")
}

/// Sole semantic viewport owner for a Session surface. SQLite retains every
/// visited Session; only the in-memory hot set and rollback JSON are bounded.
@MainActor
final class SessionViewportController: ObservableObject {
    static let shared = SessionViewportController()

    private struct PersistedRecord: Codable {
        let sessionID: String
        let position: AppKitChatTimelinePosition
        let savedAtMilliseconds: Int64?
    }

    @Published private var hydrationRevision: UInt64 = 0
    private let hotCapacity: Int
    private let defaults: UserDefaults?
    private let defaultsKey: String
    private let repository: SessionTimelinePositionRepository?
    private var positions: [String: AppKitChatTimelinePosition] = [:]
    private var timestamps: [String: Int64] = [:]
    private var recency: [String] = []
    private var pendingRepositoryWrites: [String: (AppKitChatTimelinePosition, Int64)] = [:]
    private var loads: [String: Task<Void, Never>] = [:]
    private var persistenceTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    init(hotCapacity: Int = 256, defaults: UserDefaults? = CorptieAppEnvironment.userDefaults, defaultsKey: String = "sessions.timelinePositions.v1", repository: SessionTimelinePositionRepository? = nil) {
        self.hotCapacity = max(1, hotCapacity)
        self.defaults = defaults
        self.defaultsKey = defaultsKey
        let usesApplicationStorage = defaults === CorptieAppEnvironment.userDefaults
            && defaultsKey == "sessions.timelinePositions.v1"
        self.repository = repository ?? (usesApplicationStorage ? SessionTimelinePositionRepository.shared : nil)
        restoreCompatibilityRecords()
        migrateCompatibilityRecords()
        NotificationCenter.default.publisher(for: .persistSessionTimelinePositions)
            .sink { [weak self] _ in self?.persistNow() }
            .store(in: &cancellables)
    }

    func position(for sessionID: String) -> AppKitChatTimelinePosition? { positions[sessionID] }

    func hydrate(_ sessionID: String) {
        guard positions[sessionID] == nil, loads[sessionID] == nil, let repository else { return }
        loads[sessionID] = Task { @MainActor [weak self] in
            let record = try? await repository.load(sessionID: sessionID)
            guard let self else { return }
            defer { self.loads[sessionID] = nil }
            guard let record, record.savedAtMilliseconds >= (self.timestamps[sessionID] ?? -1) else { return }
            self.positions[sessionID] = record.position
            self.timestamps[sessionID] = record.savedAtMilliseconds
            self.touch(sessionID)
            self.trimHotCache()
            // Hydration can supply the initial semantic anchor after a cold
            // selection, so publish exactly once. Gesture-driven stores never
            // invalidate the SwiftUI tree or compete with AppKit scrolling.
            self.hydrationRevision &+= 1
        }
    }

    func store(_ position: AppKitChatTimelinePosition, for sessionID: String) {
        guard positions[sessionID] != position else { return }
        let timestamp = max(Int64(Date().timeIntervalSince1970 * 1_000), (timestamps[sessionID] ?? -1) + 1)
        positions[sessionID] = position
        timestamps[sessionID] = timestamp
        touch(sessionID)
        trimHotCache()
        if repository != nil { pendingRepositoryWrites[sessionID] = (position, timestamp) }
        schedulePersistence()
    }

    func persistNow() {
        persistenceTask?.cancel()
        persistenceTask = nil
        if let repository, !pendingRepositoryWrites.isEmpty {
            let writes = pendingRepositoryWrites
            pendingRepositoryWrites.removeAll(keepingCapacity: true)
            Task {
                for (sessionID, (position, timestamp)) in writes {
                    try? await repository.upsert(position, for: sessionID, savedAtMilliseconds: timestamp)
                }
            }
        }
        if let defaults {
            let records = recency.compactMap { sessionID in
                positions[sessionID].map { PersistedRecord(sessionID: sessionID, position: $0, savedAtMilliseconds: timestamps[sessionID]) }
            }
            if let data = try? JSONEncoder().encode(records) {
                defaults.set(data, forKey: defaultsKey)
            }
        }
    }

    private func restoreCompatibilityRecords() {
        guard let data = defaults?.data(forKey: defaultsKey), let records = try? JSONDecoder().decode([PersistedRecord].self, from: data) else { return }
        for record in records.suffix(hotCapacity) {
            positions[record.sessionID] = record.position
            timestamps[record.sessionID] = record.savedAtMilliseconds ?? 0
            touch(record.sessionID)
        }
    }

    private func migrateCompatibilityRecords() {
        guard let repository else { return }
        let records = positions.map { ($0.key, $0.value, timestamps[$0.key] ?? 0) }
        Task {
            for (sessionID, position, timestamp) in records {
                try? await repository.upsert(position, for: sessionID, savedAtMilliseconds: timestamp)
            }
        }
    }

    private func touch(_ sessionID: String) {
        recency.removeAll { $0 == sessionID }
        recency.append(sessionID)
    }

    private func trimHotCache() {
        while positions.count > hotCapacity, let oldest = recency.first {
            recency.removeFirst()
            positions[oldest] = nil
            timestamps[oldest] = nil
        }
    }

    private func schedulePersistence() {
        guard persistenceTask == nil else { return }
        persistenceTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            self?.persistNow()
        }
    }
}
