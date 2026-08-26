import Combine
import Foundation

extension Notification.Name {
    static let captureSessionTimelinePositions = Notification.Name("captureSessionTimelinePositions")
}

/// Sole semantic viewport owner for a Session surface. SQLite retains every
/// visited Session while the in-memory hot set remains bounded.
@MainActor
final class SessionViewportController: ObservableObject {
    static let shared = SessionViewportController()

    @Published private var hydrationRevision: UInt64 = 0
    private let hotCapacity: Int
    private let repository: SessionTimelinePositionRepository?
    private var positions: [String: AppKitChatTimelinePosition] = [:]
    private var timestamps: [String: Int64] = [:]
    private var recency: [String] = []
    private var pendingRepositoryWrites: [String: (AppKitChatTimelinePosition, Int64)] = [:]
    private var loads: [String: Task<Void, Never>] = [:]
    private var persistenceTask: Task<Void, Never>?

    init(
        hotCapacity: Int = 256,
        repository: SessionTimelinePositionRepository? = SessionTimelinePositionRepository.shared
    ) {
        self.hotCapacity = max(1, hotCapacity)
        self.repository = repository
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
        Task { [weak self] in await self?.flush() }
    }

    /// AppKit delivers the final viewport capture synchronously during
    /// `applicationWillTerminate`. Drain the already captured values before
    /// returning so the process cannot exit between scheduling and SQLite.
    /// This bounded wait is termination-only; gesture-time stores remain fully
    /// asynchronous and never block the main actor.
    @discardableResult
    func persistSynchronouslyForTermination(timeout: TimeInterval = 2) -> Bool {
        persistenceTask?.cancel()
        persistenceTask = nil
        guard let repository, !pendingRepositoryWrites.isEmpty else { return true }
        let writes = pendingRepositoryWrites
        pendingRepositoryWrites.removeAll(keepingCapacity: true)
        let completed = DispatchSemaphore(value: 0)
        Task.detached(priority: .userInitiated) {
            for (sessionID, (position, timestamp)) in writes {
                try? await repository.upsert(
                    position,
                    for: sessionID,
                    savedAtMilliseconds: timestamp
                )
            }
            try? await repository.flush()
            completed.signal()
        }
        return completed.wait(timeout: .now() + max(0, timeout)) == .success
    }

    func flush() async {
        persistenceTask?.cancel()
        persistenceTask = nil
        if let repository, !pendingRepositoryWrites.isEmpty {
            let writes = pendingRepositoryWrites
            pendingRepositoryWrites.removeAll(keepingCapacity: true)
            for (sessionID, (position, timestamp)) in writes {
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
            await self?.flush()
        }
    }
}
