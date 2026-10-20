import Foundation

enum ClientDetailBusinessFeedEvent: Sendable {
    case snapshot(ClientDetailBusinessDocument)
    case failure(status: Int, code: String)
    case unsupported
}

enum ClientDetailBusinessFailurePolicy {
    static func requiresManualRetry(_ code: String) -> Bool {
        ["DETAIL_CURSOR_INVALID", "DETAIL_SOURCE_CURSOR_INVALID", "DETAIL_BUSINESS_INVALID"].contains(code)
    }
}

/// Connection ownership is separate from retained display data. No idle entry
/// keeps an authenticated API factory or transport alive.
actor ClientDetailBusinessFeedPool {
    private final class Entry {
        let scope: ClientDetailBusinessScope
        let id = UUID()
        var consumers: [(UUID, AsyncStream<ClientDetailBusinessFeedEvent>.Continuation)] = []
        var producer: Task<Void, Never>?
        init(_ scope: ClientDetailBusinessScope) { self.scope = scope }
    }
    private var entries: [Entry] = []

    func subscribe(scope: ClientDetailBusinessScope, api: @escaping @Sendable () async throws -> ClientDetailAPI) -> AsyncStream<ClientDetailBusinessFeedEvent> {
        let pair = AsyncStream<ClientDetailBusinessFeedEvent>.makeStream(bufferingPolicy: .bufferingOldest(8))
        guard !Task.isCancelled else { pair.continuation.finish(); return pair.stream }
        let consumer = UUID()
        pair.continuation.onTermination = { @Sendable _ in Task { await self.remove(scope, consumer) } }
        // The Repository shares this one subscription across its window
        // leases. A remaining same-scope producer here belongs to a just-
        // cancelled Repository task whose termination callback is still queued.
        // Retire it before starting a new authenticated baseline.
        if let old = entries.first(where: { $0.scope == scope }) {
            old.producer?.cancel(); finish(old)
        }
        do {
            guard entries.count < 8 else { pair.continuation.yield(.failure(status: 429, code: "DETAIL_CONNECTION_LIMIT")); pair.continuation.finish(); return pair.stream }
            let entry = Entry(scope); entry.consumers = [(consumer, pair.continuation)]; entries.append(entry)
            entry.producer = Task { await self.run(entry, api: api) }
        }
        return pair.stream
    }

    private func run(_ entry: Entry, api: @escaping @Sendable () async throws -> ClientDetailAPI) async {
        var failures = 0
        while !Task.isCancelled, entries.contains(where: { $0 === entry }) {
            do {
                let client = try await api().nativeBusinessPolicy
                // Existing v1 SSE already begins with a complete snapshot. A
                // separate GET would repeat the entire initial business read.
                for try await document in client.businessSubscribe(sessionID: entry.scope.sessionID) {
                    try Task.checkCancellation()
                    publish(.snapshot(document), entry); failures = 0
                }
                publish(.failure(status: 503, code: "DETAIL_CONNECTION_CLOSED"), entry)
            } catch is CancellationError { return }
            catch {
                guard !Task.isCancelled else { return }
                if let error = error as? ClientServiceFailure {
                    if error.statusCode == 409 && error.code == "DETAIL_CATALOG_UNSUPPORTED" {
                        publish(.unsupported, entry); finish(entry); return
                    }
                    publish(.failure(status: error.statusCode, code: error.code), entry)
                    if [401, 403, 404].contains(error.statusCode) || ClientDetailBusinessFailurePolicy.requiresManualRetry(error.code) {
                        finish(entry); return
                    }
                } else if error is DecodingError || error is ClientDetailFailure || error is ClientDetailV2Canonical.Failure {
                    publish(.failure(status: 500, code: "DETAIL_BUSINESS_INVALID"), entry)
                    finish(entry); return
                } else { publish(.failure(status: 503, code: "DETAIL_CONNECTION_FAILED"), entry) }
            }
            failures = min(failures + 1, 4)
            do { try await Task.sleep(for: .seconds(1 << failures)) } catch { return }
        }
    }
    private func publish(_ event: ClientDetailBusinessFeedEvent, _ entry: Entry) {
        guard entries.contains(where: { $0 === entry }) else { return }
        entry.consumers.removeAll { _, continuation in
            switch continuation.yield(event) {
            case .enqueued: return false
            case .dropped, .terminated: continuation.finish(); return true
            @unknown default: continuation.finish(); return true
            }
        }
        if entry.consumers.isEmpty { entry.producer?.cancel(); entries.removeAll { $0 === entry } }
    }
    private func remove(_ scope: ClientDetailBusinessScope, _ consumer: UUID) {
        guard let entry = entries.first(where: { $0.scope == scope }) else { return }
        entry.consumers.removeAll { $0.0 == consumer }
        if entry.consumers.isEmpty { entry.producer?.cancel(); entries.removeAll { $0 === entry } }
    }
    private func finish(_ entry: Entry) {
        entries.removeAll { $0 === entry }
        for (_, continuation) in entry.consumers { continuation.finish() }
        entry.consumers = []; entry.producer = nil
    }
}
