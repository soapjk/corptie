import Foundation
import OSLog

enum CloudRelaySendPriority: Int, Sendable {
    case control, interactive, background

    static func response(to request: URLRequest) -> Self {
        let path = request.url?.path ?? ""
        if request.httpMethod != "GET" || path.contains("/commands/") || path.hasSuffix("/me") { return .control }
        if path.hasSuffix("/messages") || path.hasSuffix("/images") || path.contains("/inspector") { return .background }
        return .interactive
    }
}

/// One writer owns sealing + sending. Prioritization happens before encryption
/// so authenticated sequence numbers always retain their wire order.
actor CloudRelaySendScheduler {
    private struct Entry {
        let id: UUID
        let priority: CloudRelaySendPriority
        let bytes: Int
        let operation: @Sendable () async throws -> Void
        let continuation: CheckedContinuation<Void, Error>
    }
    private var queue: [Entry] = []
    private var queuedBytes = 0
    private var writing = false
    private var closed = false
    private var wakeup: Task<Void, Never>?
    private var nextBackgroundAt = ContinuousClock.now
    private var foregroundStreak = 0
    private var lastLog = ContinuousClock.now
    private var sentBytes = 0
    private static let log = Logger(subsystem: "com.corptie.connection", category: "RelaySendScheduler")
    private let maximumQueuedBytes: Int
    private let backgroundBytesPerSecond: Double
    var pendingCount: Int { queue.count }

    init(maximumQueuedBytes: Int = 512 * 1024, backgroundBytesPerSecond: Double = 64 * 1024) {
        self.maximumQueuedBytes = max(1, maximumQueuedBytes)
        self.backgroundBytesPerSecond = max(1, backgroundBytesPerSecond)
    }

    func send(bytes: Int, priority: CloudRelaySendPriority,
              operation: @escaping @Sendable () async throws -> Void) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                guard !closed else { continuation.resume(throwing: CloudRelayTransportError.disconnected); return }
                // Background producers cannot consume the control reserve.
                let limit = priority == .background ? maximumQueuedBytes * 3 / 4 : maximumQueuedBytes
                let countLimit = priority == .background ? 192 : 256
                guard bytes >= 0, bytes <= limit - queuedBytes, queue.count < countLimit else {
                    continuation.resume(throwing: CloudRelayTransportError.responseTooLarge); return
                }
                queue.append(Entry(id: id, priority: priority, bytes: bytes, operation: operation, continuation: continuation))
                queuedBytes += bytes
                startWriter()
            }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    private func cancel(_ id: UUID) {
        guard let index = queue.firstIndex(where: { $0.id == id }) else { return }
        let entry = queue.remove(at: index)
        queuedBytes -= entry.bytes
        entry.continuation.resume(throwing: CancellationError())
    }

    func close() {
        closed = true
        wakeup?.cancel(); wakeup = nil
        let abandoned = queue
        queue.removeAll(); queuedBytes = 0
        for entry in abandoned { entry.continuation.resume(throwing: CloudRelayTransportError.disconnected) }
    }

    private func startWriter() {
        guard !writing, !closed, !queue.isEmpty else { return }
        let now = ContinuousClock.now
        let background = queue.firstIndex(where: { $0.priority == .background })
        let foreground = queue.indices.filter { queue[$0].priority != .background }
            .min { queue[$0].priority.rawValue < queue[$1].priority.rawValue }
        let index: Int
        if let background, now >= nextBackgroundAt,
           foreground == nil || (foregroundStreak >= 8 && !queue.contains(where: { $0.priority == .control })) {
            index = background
        } else if let foreground {
            index = foreground
        } else {
            guard wakeup == nil else { return }
            let delay = now.duration(to: nextBackgroundAt)
            wakeup = Task {
                do { try await Task.sleep(for: delay) } catch { return }
                self.wakeup = nil
                self.startWriter()
            }
            return
        }
        let entry = queue.remove(at: index)
        queuedBytes -= entry.bytes
        if entry.priority == .background {
            foregroundStreak = 0
            nextBackgroundAt = now.advanced(by: .seconds(Double(entry.bytes) / backgroundBytesPerSecond))
        } else { foregroundStreak += 1 }
        writing = true
        Task {
            do { try await entry.operation(); entry.continuation.resume() }
            catch { entry.continuation.resume(throwing: error) }
            self.sentBytes += entry.bytes
            if self.lastLog.duration(to: .now) >= .seconds(10) {
                Self.log.info("Relay writer: attemptedBytes=\(self.sentBytes) queuedBytes=\(self.queuedBytes) pending=\(self.queue.count)")
                self.sentBytes = 0
                self.lastLog = .now
            }
            self.writing = false
            self.startWriter()
        }
    }
}
