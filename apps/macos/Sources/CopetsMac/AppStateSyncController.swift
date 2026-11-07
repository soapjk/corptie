import Foundation
import CorptieClientCore

enum StateStreamLivenessPolicy {
    // Backend emits a heartbeat every 15 seconds. Two missed heartbeats plus a
    // small scheduling margin is enough to declare the transport unavailable;
    // retaining a stale `running` Session longer makes a dead Worker look busy.
    static let inactivityTimeout: TimeInterval = 35

    static func hasExpired(
        lastActivityAt: Date,
        now: Date = Date(),
        timeout: TimeInterval = inactivityTimeout
    ) -> Bool {
        now.timeIntervalSince(lastActivityAt) >= timeout
    }
}

/// Decode on a dedicated serial executor; only typed, Sendable values cross
/// back to the main actor that owns AppStateStore.
actor StateStreamDecoder {
    enum Frame: Sendable {
        case snapshot(StateSnapshotEnvelope)
        case changes(StateChangeSetEnvelope)
        case ignored
    }
    private let decoder: JSONDecoder = {
        let value = JSONDecoder()
        value.keyDecodingStrategy = .convertFromSnakeCase
        return value
    }()
    func decodeSnapshot(_ data: Data) throws -> StateSnapshotEnvelope {
        try decoder.decode(StateSnapshotEnvelope.self, from: data)
    }
    func decodeFrame(name: String, data: String) throws -> Frame {
        guard let bytes = data.data(using: .utf8), !bytes.isEmpty else { return .ignored }
        switch name {
        case "state-snapshot": return .snapshot(try decodeSnapshot(bytes))
        case "state-change-set": return .changes(try decoder.decode(StateChangeSetEnvelope.self, from: bytes))
        default: return .ignored
        }
    }
}

@MainActor
final class AppStateSyncController {
    static let shared = AppStateSyncController()

    private let store: AppStateStore
    private let baseURL: URL
    private let transport: BackendTransport
    private let artifactsChanged: () -> Void
    private let decoder = StateStreamDecoder()
    private var streamTask: Task<Void, Never>?
    private var streamWatchdogTask: Task<Void, Never>?
    private var streamGeneration: UInt64 = 0
    private var streamLastActivityAt = Date()
    private var snapshotRequestGeneration: UInt64 = 0
    private var backgroundActivity: NSObjectProtocol?
    private var snapshotTask: Task<Void, Never>?
    private var snapshotMinimumRevision: Int64 = 0
    private var processingGeneration: UInt64?

    init(store: AppStateStore = .shared, baseURL: URL = CorptieAppEnvironment.backendBaseURL,
         transport: BackendTransport = CorptieAppEnvironment.backendTransport,
         artifactsChanged: @escaping () -> Void = { ArtifactAPIClient.shared.refreshLoadedCollectionsAfterExternalChange() }) {
        self.store = store; self.baseURL = baseURL; self.transport = transport
        self.artifactsChanged = artifactsChanged
    }

    var isProcessingEvents: Bool { processingGeneration == streamGeneration || snapshotTask != nil }

    func start() {
        guard streamTask == nil else { return }
        beginBackgroundActivityIfNeeded()
        restartStream(refreshSnapshotFirst: true)
    }

    /// Foreground activation is a liveness hint, not a correctness trigger.
    /// Preserve a healthy stream so clicking the window cannot be what makes a
    /// backend Session reach terminal state. Only a missing/stale stream gets a
    /// snapshot-backed recovery.
    func recoverAfterActivation(now: Date = Date()) {
        guard streamTask != nil else {
            start()
            return
        }
        guard !isProcessingEvents, StateStreamLivenessPolicy.hasExpired(
            lastActivityAt: streamLastActivityAt,
            now: now
        ) else { return }
        restartStream(refreshSnapshotFirst: true)
    }

    func recoverAfterWake() {
        beginBackgroundActivityIfNeeded()
        restartStream(refreshSnapshotFirst: true)
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        streamWatchdogTask?.cancel()
        streamWatchdogTask = nil
        streamGeneration &+= 1
        cancelSnapshotRefresh()
        processingGeneration = nil
        if let backgroundActivity {
            ProcessInfo.processInfo.endActivity(backgroundActivity)
            self.backgroundActivity = nil
        }
    }

    private func cancelSnapshotRefresh() {
        snapshotRequestGeneration &+= 1
        snapshotTask?.cancel(); snapshotTask = nil
        snapshotMinimumRevision = 0
    }

    func refreshSnapshot(minimumRevision: Int64 = 0) async {
        guard ChatTimelineFeatureFlags.current.fixtureMode == .disabled, !Task.isCancelled else { return }
        snapshotMinimumRevision = max(snapshotMinimumRevision, minimumRevision)
        if let snapshotTask { await snapshotTask.value; return }
        snapshotRequestGeneration &+= 1
        let requestGeneration = snapshotRequestGeneration
        let task = Task { [weak self] in
            guard let self else { return }
            await self.loadSnapshot(requestGeneration: requestGeneration)
        }
        snapshotTask = task
        await task.value
    }

    private func loadSnapshot(requestGeneration: UInt64) async {
        defer {
            if requestGeneration == snapshotRequestGeneration {
                snapshotTask = nil
                snapshotMinimumRevision = 0
            }
        }
        do {
            // At most one follow-up if a newer gap arrives during the first read.
            // A persistently stale backend must not create a tight recovery loop.
            for _ in 0..<2 {
                try Task.checkCancellation()
                let (data, response) = try await transport.data(for:
                    URLRequest(url: baseURL.appending(path: "state/snapshot")))
                try Self.requireSuccess(response)
                let snapshot = try await decoder.decodeSnapshot(data)
                guard !Task.isCancelled, requestGeneration == snapshotRequestGeneration else { return }
                if case .applied = store.apply(snapshot: snapshot) { artifactsChanged() }
                if store.revision >= snapshotMinimumRevision { return }
            }
            store.reportSyncError("State snapshot has not reached the required revision.")
        } catch {
            guard !Task.isCancelled, requestGeneration == snapshotRequestGeneration else { return }
            store.reportSyncError(Self.syncErrorMessage(error))
        }
    }

    func hydrateSession(_ id: String) async -> TaskSession? {
        if let session = sessionMatchingPendingSelection(id, in: store.sessions) { return session }
        await refreshSnapshot()
        return sessionMatchingPendingSelection(id, in: store.sessions)
    }

    private func restartStream(refreshSnapshotFirst: Bool) {
        guard ChatTimelineFeatureFlags.current.fixtureMode == .disabled else { return }
        beginBackgroundActivityIfNeeded()
        streamTask?.cancel()
        streamWatchdogTask?.cancel()
        cancelSnapshotRefresh()
        processingGeneration = nil
        streamGeneration &+= 1
        let generation = streamGeneration
        streamLastActivityAt = Date()

        streamTask = Task { [weak self] in
            guard let self else { return }
            if refreshSnapshotFirst { await refreshSnapshot() }
            guard !Task.isCancelled, generation == streamGeneration else { return }
            streamLastActivityAt = Date()
            while !Task.isCancelled, generation == streamGeneration {
                await consumeStream(generation: generation)
                guard !Task.isCancelled, generation == streamGeneration else { return }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        streamWatchdogTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled, let self, generation == self.streamGeneration else { return }
                guard !self.isProcessingEvents,
                      StateStreamLivenessPolicy.hasExpired(lastActivityAt: self.streamLastActivityAt) else {
                    continue
                }
                self.store.reportSyncError("Session state stream stopped receiving heartbeats.")
                self.restartStream(refreshSnapshotFirst: true)
                return
            }
        }
    }

    private func beginBackgroundActivityIfNeeded() {
        guard backgroundActivity == nil else { return }
        backgroundActivity = ProcessInfo.processInfo.beginActivity(
            options: [.background],
            reason: "Keep Corptie Session state and completion notifications current"
        )
    }

    private func consumeStream(generation: UInt64) async {
        do {
            var components = URLComponents(
                url: baseURL.appending(path: "state/events"),
                resolvingAgainstBaseURL: false
            )!
            components.queryItems = [URLQueryItem(name: "after", value: String(store.revision))]
            var request = URLRequest(url: components.url!)
            request.timeoutInterval = .infinity
            let (bytes, response) = try await transport.bytes(for: request)
            try Self.requireSuccess(response)
            guard generation == streamGeneration else { return }
            store.reportStateStreamConnected()
            streamLastActivityAt = Date()
            for try await event in ServerSentEventStream.events(from: bytes) {
                guard !Task.isCancelled, generation == streamGeneration else { return }
                streamLastActivityAt = Date()
                if event.isComment { continue }
                guard await processFrame(event, generation: generation) else { return }
            }
        } catch {
            guard !Task.isCancelled, generation == streamGeneration else { return }
            store.reportSyncError(Self.syncErrorMessage(error))
        }
    }

    private func processFrame(_ event: ServerSentEvent, generation: UInt64) async -> Bool {
        processingGeneration = generation
        defer {
            if processingGeneration == generation { processingGeneration = nil }
            if generation == streamGeneration { streamLastActivityAt = Date() }
        }
        return await applyFrame(eventName: event.name, data: event.data, generation: generation)
    }

    private func applyFrame(eventName: String, data: String, generation: UInt64) async -> Bool {
        do {
            let frame = try await decoder.decodeFrame(name: eventName, data: data)
            guard !Task.isCancelled, generation == streamGeneration else { return false }
            switch frame {
            case .snapshot(let snapshot):
                if case .applied = store.apply(snapshot: snapshot) { artifactsChanged() }
            case .changes(let changes):
                let result = store.apply(changeSet: changes)
                if !changes.artifactInvalidations.orEmpty.isEmpty, result == .applied { artifactsChanged() }
                if case .revisionGap = result {
                    await refreshSnapshot(minimumRevision: changes.revision)
                    return !Task.isCancelled && generation == streamGeneration && store.revision >= changes.revision
                }
            case .ignored: break
            }
            return true
        } catch {
            guard !Task.isCancelled, generation == streamGeneration else { return false }
            store.reportSyncError(Self.syncErrorMessage(error))
            await refreshSnapshot()
            // Reopen from the durable Store revision after repairing malformed input.
            return false
        }
    }

    static func syncErrorMessage(_ error: Error) -> String {
        switch error {
        case let DecodingError.keyNotFound(key, context):
            return "状态数据缺少字段 \(codingPath(context.codingPath + [key]))：\(context.debugDescription)"
        case let DecodingError.typeMismatch(_, context):
            return "状态数据字段类型错误 \(codingPath(context.codingPath))：\(context.debugDescription)"
        case let DecodingError.valueNotFound(_, context):
            return "状态数据缺少必需值 \(codingPath(context.codingPath))：\(context.debugDescription)"
        case let DecodingError.dataCorrupted(context):
            return "状态数据格式错误 \(codingPath(context.codingPath))：\(context.debugDescription)"
        default:
            return error.localizedDescription
        }
    }

    private static func codingPath(_ path: [any CodingKey]) -> String {
        let rendered = path.map { key in
            key.intValue.map { "[\($0)]" } ?? key.stringValue
        }.joined(separator: ".")
        return rendered.isEmpty ? "<root>" : rendered.replacingOccurrences(of: ".[", with: "[")
    }

    private static func requireSuccess(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }
}

private extension Optional where Wrapped == [String] {
    var orEmpty: [String] { self ?? [] }
}
