import Foundation

/// One authenticated logical scope shares one connection across Detail windows.
/// All cached state is released with the final consumer, including credentials.
actor ClientDetailSubscriptionPool {
    static let shared = ClientDetailSubscriptionPool()
    private struct Entry {
        let generation: UUID
        let sessionID: String
        var consumers: [UUID: AsyncThrowingStream<ClientDetailEvent, Error>.Continuation]
        var latest: ClientDetailDocument?
        var v2State: ClientDetailV2State?
        var legacy = false
        var producer: Task<Void, Never>?
    }
    private var entries: [String: Entry] = [:]
    private let retryDelay: @Sendable (Int) async throws -> Void
    init(retryDelay: @escaping @Sendable (Int) async throws -> Void = { failures in
        try await Task.sleep(for: .milliseconds(min(15_000, 500 * (1 << min(failures, 5)))))
    }) { self.retryDelay = retryDelay }

    func subscribe(scope: String, sessionID: String, api: @escaping @Sendable () async throws -> ClientDetailAPI) -> AsyncThrowingStream<ClientDetailEvent, Error> {
        let (stream, continuation) = AsyncThrowingStream<ClientDetailEvent, Error>.makeStream(bufferingPolicy: .bufferingOldest(16))
        let consumer = UUID()
        continuation.onTermination = { @Sendable _ in Task { await self.remove(scope: scope, consumer: consumer) } }
        if var entry = entries[scope] {
            guard entry.sessionID == sessionID else { continuation.finish(throwing: ClientDetailFailure.wrongScope); return stream }
            guard entry.consumers.count < 8 else { continuation.finish(throwing: ClientDetailFailure.limit); return stream }
            if let latest = entry.latest { continuation.yield(.snapshot(latest)) }
            entry.consumers[consumer] = continuation; entries[scope] = entry
        } else {
            guard entries.count < 8 else { continuation.finish(throwing: ClientDetailFailure.limit); return stream }
            let generation = UUID()
            entries[scope] = Entry(generation: generation, sessionID: sessionID, consumers: [consumer: continuation])
            let producer = Task {
                await self.run(scope: scope, sessionID: sessionID, generation: generation, api: api)
            }
            entries[scope]?.producer = producer
        }
        return stream
    }

    private func run(scope: String, sessionID: String, generation: UUID,
                     api: @escaping @Sendable () async throws -> ClientDetailAPI) async {
        var failures = 0
        while !Task.isCancelled, entries[scope]?.generation == generation {
            do {
                // Reacquire authenticated transport on reconnect; do not retain
                // an expired bearer/relay instance in a detached retry loop.
                let client = try await api()
                guard let entry = entries[scope], entry.generation == generation else { return }
                if entry.legacy {
                    for try await event in client.subscribe(sessionID: sessionID) {
                        try Task.checkCancellation(); try publish(event, scope: scope, generation: generation); failures = 0
                    }
                } else {
                    for try await state in client.v2.subscribe(sessionID: sessionID, resume: entry.v2State) {
                        try Task.checkCancellation(); try publishV2(state, scope: scope, generation: generation); failures = 0
                    }
                }
            } catch {
                guard !Task.isCancelled, entries[scope]?.generation == generation else { return }
                if entries[scope]?.legacy == false, ClientDetailAPI.canFallbackToV1(error) {
                    entries[scope]?.legacy = true; entries[scope]?.v2State = nil; continue
                }
                if ClientDetailAPI.isAccessFailure(error) {
                    finish(scope: scope, generation: generation, error: error); return
                }
                if error is DecodingError || error is ClientDetailV2Canonical.Failure || error is ClientDetailFailure {
                    // Keep the rendered last-good document but request a fresh
                    // baseline after a protocol gap/corruption. No blind replay.
                    entries[scope]?.v2State = nil
                }
            }
            guard !Task.isCancelled, entries[scope]?.generation == generation else { return }
            failures = min(failures + 1, 5)
            do { try await retryDelay(failures) } catch { return }
        }
    }

    private func publishV2(_ state: ClientDetailV2State, scope: String, generation: UUID) throws {
        guard let entry = entries[scope], entry.generation == generation else { return }
        if let previous = entry.v2State {
            guard previous.documentId == state.documentId, previous.sessionId == state.sessionId else { throw ClientDetailFailure.wrongScope }
            // A ready/identical snapshot updates no view and reuses its cache.
            if previous == state { return }
        }
        let document = try state.renderingDocument(previous: entry.v2State, document: entry.latest)
        try publish(.snapshot(document), scope: scope, generation: generation)
        if entries[scope]?.generation == generation { entries[scope]?.v2State = state }
    }

    private func publish(_ event: ClientDetailEvent, scope: String, generation: UUID) throws {
        guard var entry = entries[scope], entry.generation == generation else { return }
        switch event {
        case .snapshot(let document):
            try document.validate()
            entry.latest = try entry.latest?.accepting(document) ?? document
        case .patch(let patch):
            guard let previous = entry.latest else { throw ClientDetailFailure.revisionGap }
            entry.latest = try previous.applying(patch)
        }
        for (id, continuation) in entry.consumers {
            switch continuation.yield(event) {
            case .dropped:
                continuation.finish(throwing: ClientDetailFailure.bufferOverflow); entry.consumers.removeValue(forKey: id)
            case .terminated: entry.consumers.removeValue(forKey: id)
            case .enqueued: break
            @unknown default: continuation.finish(throwing: ClientDetailFailure.bufferOverflow); entry.consumers.removeValue(forKey: id)
            }
        }
        if entry.consumers.isEmpty { entry.producer?.cancel(); entries.removeValue(forKey: scope) }
        else { entries[scope] = entry }
    }
    private func remove(scope: String, consumer: UUID) {
        guard var entry = entries[scope] else { return }
        entry.consumers.removeValue(forKey: consumer)
        if entry.consumers.isEmpty { entry.producer?.cancel(); entries.removeValue(forKey: scope) }
        else { entries[scope] = entry }
    }
    private func finish(scope: String, generation: UUID, error: Error?) {
        guard let entry = entries[scope], entry.generation == generation else { return }
        entries.removeValue(forKey: scope)
        for continuation in entry.consumers.values { continuation.finish(throwing: error) }
    }
}
