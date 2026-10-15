import Foundation
import CryptoKit
import Observation
import OSLog

public struct ClientQuickMessage: Codable, Equatable, Identifiable, Sendable {
    public static let maximumRecommendations = 8
    public let id: String
    public let text: String
    public let scope: String
    public let count: Int

    public init(id: String, text: String, scope: String, count: Int) {
        self.id = id; self.text = text; self.scope = scope; self.count = count
    }

    public static let defaults: [Self] = ["继续", "开始开发", "给我一个完整方案"].map {
        Self(id: "default:\($0)", text: $0, scope: "default", count: 0)
    }
}

/// A small, non-observed last-good snapshot, isolated by host and Task. Reads
/// use bounded snapshots rather than transcript scans or per-chip observation.
@MainActor
public final class ClientQuickMessageCache {
    public static let shared = ClientQuickMessageCache()
    private let defaults: UserDefaults
    private let maximumScopes: Int
    private let indexKey = "quickMessageSnapshots.v1.index"
    private var keys: [String]
    private var resident: [String: [ClientQuickMessage]] = [:]
    @MainActor @Observable fileprivate final class Signal { var revision = 0 }
    private var signals: [String: Signal] = [:]
    private var signalHosts: [String: String] = [:]
    private struct Flight {
        let id: UUID
        let task: Task<ClientQuickMessageRecommendations, Error>
        var waiters: Set<UUID> = []
    }
    private var flights: [String: Flight] = [:]
    public var inFlightCount: Int { flights.count }
    public func read(scope: String,
                     load: @escaping @MainActor @Sendable () async throws -> ClientQuickMessageRecommendations) async throws -> ClientQuickMessageRecommendations {
        try Task.checkCancellation()
        if let flight = flights[scope] { return try await wait(for: flight, scope: scope) }
        guard flights.count < 32 else { throw URLError(.resourceUnavailable) }
        let id = UUID()
        let task = Task { @MainActor in
            let result = try await load()
            try Task.checkCancellation()
            return try result.validated()
        }
        flights[scope] = Flight(id: id, task: task)
        defer { if flights[scope]?.id == id { flights.removeValue(forKey: scope) } }
        return try await wait(for: flights[scope]!, scope: scope)
    }

    private func wait(for flight: Flight, scope: String) async throws -> ClientQuickMessageRecommendations {
        let waiter = UUID()
        flights[scope]?.waiters.insert(waiter)
        defer { releaseWaiter(waiter, scope: scope, flightID: flight.id) }
        return try await withTaskCancellationHandler {
            let result = try await flight.task.value
            try Task.checkCancellation()
            return result
        } onCancel: {
            Task { @MainActor [weak self] in self?.releaseWaiter(waiter, scope: scope, flightID: flight.id) }
        }
    }

    private func releaseWaiter(_ waiter: UUID, scope: String, flightID: UUID) {
        guard flights[scope]?.id == flightID else { return }
        flights[scope]?.waiters.remove(waiter)
        if flights[scope]?.waiters.isEmpty == true {
            flights.removeValue(forKey: scope)?.task.cancel()
        }
    }

    /// Bounded, foreground-owned recovery. Invalidations fence stale responses,
    /// including transports that ignore cancellation. No polling/timers survive callers.
    public func readRefreshing(scope: String,
        pause: @escaping @MainActor @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        load: @escaping @MainActor @Sendable () async throws -> ClientQuickMessageRecommendations
    ) async throws -> ClientQuickMessageRecommendations {
        for attempt in 0..<3 {
            try Task.checkCancellation()
            let expectedRevision = revision(for: scope)
            do {
                let result = try await read(scope: scope, load: load)
                try Task.checkCancellation()
                guard revision(for: scope) == expectedRevision else { throw CancellationError() }
                if result.preparationStatus == "building" { throw URLError(.resourceUnavailable) }
                return result
            } catch {
                try Task.checkCancellation()
                guard attempt < 2, let network = error as? URLError,
                    [.timedOut, .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost,
                     .cannotFindHost, .resourceUnavailable].contains(network.code) else { throw error }
                try await pause(.seconds(attempt == 0 ? 1 : 2))
            }
        }
        throw URLError(.resourceUnavailable)
    }

    /// Only this Scope's readers observe its signal; cache reads/writes do not
    /// invalidate every composer or start a request for each streaming token.
    public func revision(for scope: String, host: String? = nil) -> Int {
        if let host { signalHosts[scope] = host }
        return signal(for: scope).revision
    }
    private func signal(for scope: String) -> Signal {
        if let value = signals[scope] { return value }
        if signals.count >= maximumScopes, let oldest = signals.keys.first {
            signals.removeValue(forKey: oldest); signalHosts.removeValue(forKey: oldest)
        }
        let value = Signal(); signals[scope] = value
        return value
    }
    public func invalidate(host: String, taskID: String?, sessionID: String) {
        let scope = Self.scope(host: host, taskID: taskID, sessionID: sessionID)
        flights.removeValue(forKey: scope)?.task.cancel()
        signal(for: scope).revision &+= 1
    }
    public func connectionRecovered() {
        for flight in flights.values { flight.task.cancel() }
        flights.removeAll()
        for signal in signals.values { signal.revision &+= 1 }
    }

    public func commonChanged(host: String) {
        for scope in signals.keys where signalHosts[scope] == host {
            flights.removeValue(forKey: scope)?.task.cancel()
            signals[scope]?.revision &+= 1
        }
    }

    public init(defaults: UserDefaults = .standard, maximumScopes: Int = 128) {
        self.defaults = defaults
        self.maximumScopes = max(1, maximumScopes)
        keys = defaults.stringArray(forKey: indexKey) ?? []
        while keys.count > self.maximumScopes {
            defaults.removeObject(forKey: keys.removeFirst())
        }
    }

    public static func scope(host: String, taskID: String?, sessionID: String) -> String {
        let identity = [host, taskID == nil ? "session" : "task", taskID ?? sessionID]
        let encoded = (try? JSONEncoder().encode(identity)) ?? Data()
        return "quickMessageSnapshots.v1." + SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined()
    }

    public func items(for scope: String) -> [ClientQuickMessage] {
        if let items = resident[scope] { return items }
        guard keys.contains(scope), let data = defaults.data(forKey: scope),
              let items = try? JSONDecoder().decode([ClientQuickMessage].self, from: data) else {
            return ClientQuickMessage.defaults
        }
        let normalized = Self.normalized(items)
        resident[scope] = normalized
        return normalized
    }

    @discardableResult
    public func remember(_ items: [ClientQuickMessage], for scope: String) -> [ClientQuickMessage] {
        // A successful refresh replaces the snapshot. Network failures never
        // call this method, so they still retain the last good recommendations.
        let normalized = Self.normalized(items)
        let changed = resident[scope] != normalized
        resident[scope] = normalized
        if changed, let data = try? JSONEncoder().encode(normalized) { defaults.set(data, forKey: scope) }
        keys.removeAll { $0 == scope }
        keys.append(scope)
        while keys.count > maximumScopes {
            let evicted = keys.removeFirst()
            resident.removeValue(forKey: evicted)
            defaults.removeObject(forKey: evicted)
        }
        defaults.set(keys, forKey: indexKey)
        return normalized
    }

    private static func normalized(_ items: [ClientQuickMessage]) -> [ClientQuickMessage] {
        var seen = Set<String>()
        let learned = items.filter { item in
            item.scope != "default" && !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                && seen.insert(item.text.lowercased()).inserted
        }
        var result = Array(learned.prefix(ClientQuickMessage.maximumRecommendations))
        for item in ClientQuickMessage.defaults where result.count < ClientQuickMessage.maximumRecommendations {
            if seen.insert(item.text.lowercased()).inserted { result.append(item) }
        }
        return result
    }
}

public struct ClientQuickMessageRecommendations: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let taskId: String?
    public let items: [ClientQuickMessage]
    public var preparationStatus: String? = nil

    public func validated() throws -> Self {
        guard schemaVersion == 1, items.count <= ClientQuickMessage.maximumRecommendations else {
            throw ClientConnectionError.invalidResponse
        }
        return self
    }
}

/// A product-level invalidation contains identifiers only, never message text
/// or Provider events. Opt-in on the device stream keeps older decoders safe.
public struct ClientQuickMessageInvalidation: Codable, Sendable {
    public let schemaVersion: Int
    public let sessionId: String
    public let taskId: String?
    public var commonChanged: Bool? = nil
    public func validated() throws -> Self {
        guard schemaVersion == 1, !sessionId.isEmpty, sessionId.utf8.count <= 512 else {
            throw ClientConnectionError.invalidResponse
        }
        return self
    }
    public static func decodeEnvelope(_ data: Data) throws -> Self {
        struct Envelope: Decodable { let payload: ClientQuickMessageInvalidation }
        return try JSONDecoder().decode(Envelope.self, from: data).payload.validated()
    }
}

public enum ClientQuickMessageDiagnostics {
    private static let log = Logger(subsystem: "com.corptie.client", category: "QuickMessages")
    public static func failure(_ error: Error) {
        guard !(error is CancellationError), (error as? URLError)?.code != .cancelled else { return }
        // Never log request URLs, credentials, recommendations or user text.
        log.error("Recommendation refresh failed; retaining cache. errorType=\(String(reflecting: type(of: error)), privacy: .public)")
    }
}
